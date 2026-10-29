/**
 * A bounded batch of whole-call simulations, one per synthetic persona, in its
 * own process (never inside the 4311 dev server: this changes process-wide
 * state, the record store, the harness config, the lead store and the
 * calling flag).
 *
 *   tsx scripts/simulate-personas.ts [--personas all|id,id] [--limit N] [--repeat N]
 *       [--agent live|tree] [--lead model|scripted] [--prompt-setup ID] [--tree full|stub|PATH]
 *       [--decision azure|jev-mock] [--max-turns N] [--max-model-asks N] [--batch-key KEY]
 *
 * Defaults: every persona, once, the agent speaking its live words on Azure
 * gpt-live-1 (text mode), the persona played by gpt-5.6-terra, the full tree,
 * the Azure decision model and live judge on gpt-5.6-luna.
 *
 * `--agent tree --lead scripted --decision jev-mock` is the no-model dry run:
 * the agent speaks the tree's template lines. It is a check of the runner, not
 * of the agent, and the batch records it as such.
 *
 * Each run is written as soon as it finishes (data/simulations/<batch key>/runs.jsonl),
 * and a run that fails is recorded with its code; the batch goes on. Progress
 * goes to the console and batch.json. Cancel with Control-C or by creating the
 * file CANCEL in the batch directory: the call in progress ends "cancelled",
 * and no further call starts.
 *
 * Exit codes: 0 done, 1 failed, 2 Azure is not configured, 3 cancelled.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getHarnessConfig, resetHarnessConfig, setAiCallingEnabled } from "../src/config.js";
import { getDecisionRegistry } from "../src/decision/registry.js";
import { placeOutboundAttempts } from "../src/decision/outbound-attempts.js";
import { loadTree } from "../src/decision/tree.js";
import { FULL_TREE_FILE, STUB_TREE_FILE } from "../src/decision/tree-source.js";
import { getPromptSetupRegistry } from "../src/behaviour/prompt/setups.js";
import { CallHarness } from "../src/harness/call-harness.js";
import { getModuleRegistry } from "../src/modules/registry.js";
import { installLiveJudge } from "../src/server/live-judge-wiring.js";
import { mockLeadStore } from "../src/store/lead-store-seam.js";
import { getLead, resetLeadStore, seedLead } from "../src/store/lead-store.js";
import { recordStore } from "../src/trace/records.js";
import type { SimulatedLead } from "../src/judging/offline/types.js";
import { ScriptedSimulatedLead } from "../src/judging/offline/simulated-lead.js";
import { gradeWholeCall, runWholeCall } from "../src/judging/offline/whole-call.js";
import { batchClockFor, buildPersonaCase, loadPersonaFile, withoutDialAgreement, type PersonaCase } from "../src/simulator/persona.js";
import { LiveWordsPostCallJudge, mergeOpening } from "../src/simulator/grade-live.js";
import { gradePersonaCall } from "../src/simulator/persona-grade.js";
import type { SimPersona } from "../src/simulator/persona.js";
import { PersonaModelLead, PERSONA_LEAD_MAX_TOKENS } from "../src/simulator/persona-lead.js";
import { buildAzureJsonClient, DEFAULT_DEPLOYMENTS, roleSettings, withRetry, type ModelSettings } from "../src/simulator/models.js";
import { runLiveWholeCall, type LiveWholeCallRun } from "../src/simulator/live-text-session.js";
import type { JsonModelClient } from "../src/connectors/json-client.js";
import { realSocketFactory, setVoiceDeps } from "../src/server/voice/manager.js";

type Item = { id: string; persona: SimPersona };

interface Args {
  personas: "all" | string[];
  limit?: number;
  repeat: number;
  agent: "live" | "tree";
  lead: "model" | "scripted";
  promptSetup?: string;
  tree: string;
  decision: "azure" | "jev-mock";
  maxTurns: number;
  maxModelAsks: number;
  batchKey?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { personas: "all", repeat: 1, agent: "live", lead: "model", tree: "full", decision: "azure", maxTurns: 25, maxModelAsks: 2000 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const v = argv[i + 1];
    if (!v) throw new Error("bad_arguments");
    if (flag === "--personas") a.personas = v === "all" ? "all" : v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--limit") a.limit = Number(v);
    else if (flag === "--repeat") a.repeat = Number(v);
    else if (flag === "--agent" && (v === "live" || v === "tree")) a.agent = v;
    else if (flag === "--lead" && (v === "model" || v === "scripted")) a.lead = v;
    else if (flag === "--prompt-setup") a.promptSetup = v;
    else if (flag === "--tree") a.tree = v;
    else if (flag === "--decision" && (v === "azure" || v === "jev-mock")) a.decision = v;
    else if (flag === "--max-turns") a.maxTurns = Number(v);
    else if (flag === "--max-model-asks") a.maxModelAsks = Number(v);
    else if (flag === "--batch-key" && /^[a-z0-9_-]{1,80}$/.test(v)) a.batchKey = v;
    else throw new Error("bad_arguments");
  }
  for (const n of [a.repeat, a.maxTurns, a.maxModelAsks, a.limit ?? 1]) if (!Number.isInteger(n) || n < 1) throw new Error("bad_number");
  if (a.maxTurns > 25) throw new Error("turn_cap_is_25");
  return a;
}

/** An error's message only when it is one of our fixed codes; anything else could carry a path or a value. */
function fixedCode(err: unknown): string {
  return err instanceof Error && /^[a-z0-9_:.-]+$/i.test(err.message) ? err.message : "unknown";
}

function treeFileOf(choice: string): string {
  return choice === "full" ? FULL_TREE_FILE : choice === "stub" ? STUB_TREE_FILE : choice;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function harnessCommit(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

/** Counts every model ask the lead makes, and stops the batch at the cap. */
function capped(client: JsonModelClient, cap: number, count: { asks: number }): JsonModelClient {
  return {
    askJson<T>(ask: Parameters<JsonModelClient["askJson"]>[0]): Promise<T> {
      if (count.asks >= cap) return Promise.reject(new Error("model_ask_cap_reached"));
      count.asks += 1;
      return client.askJson<T>(ask);
    },
  };
}

/** Every numeric value in an object, by its dotted path ("usage.output_tokens"). Strings are never kept. */
function numericLeaves(value: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof value === "number" && Number.isFinite(value)) out[prefix] = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (k !== "type") numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

async function placeMissedCalls(harness: CallHarness, c: PersonaCase, clockIso: string): Promise<void> {
  if (c.missedAttempts === 0) return;
  const results = await placeOutboundAttempts(harness, c.leadId, {
    idempotencyKey: `missed-${c.leadId}`,
    scheduledReason: "text_agreed_callback",
    outcomes: ["no_answer", "no_answer"],
    agent: "decision_tree",
  });
  const missed = results.filter((r) => r.status === "not_answered").length;
  if (missed !== 2) throw new Error(`missed_calls_not_placed:${missed}`);
  // The live prompt and the tree must agree on the two calls the lead saw.
  const lead = getLead(c.leadId)!;
  if (lead.briefing) {
    lead.briefing.missedOutboundCalls = [
      { at: new Date(Date.parse(clockIso) - 26 * 3600 * 1000).toISOString(), simulated: false },
      { at: new Date(Date.parse(clockIso) - 2 * 3600 * 1000).toISOString(), simulated: false },
    ];
    seedLead(lead);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const file = loadPersonaFile();
  const wanted = args.personas === "all" ? file.personas : [...new Set(args.personas)].map((id) => file.personas.find((p) => p.id === id) ?? Promise.reject(new Error(`unknown_persona:${id}`)));
  let items: Item[] = (await Promise.all(wanted)).map((persona) => ({ id: persona.id, persona }));
  items = items.slice(0, args.limit ?? Number.MAX_SAFE_INTEGER);

  const needsAzure = args.lead === "model" || args.agent === "live" || args.decision === "azure";
  let client: (JsonModelClient & { retries: () => number }) | undefined;
  const asks = { asks: 0 };
  if (args.lead === "model") {
    try {
      client = withRetry(buildAzureJsonClient());
    } catch (err) {
      console.error(`Azure is not configured for the simulator (${fixedCode(err)}). Nothing was sent.`);
      return 2;
    }
  }

  const clock = batchClockFor(file.today);
  const treeFile = treeFileOf(args.tree);
  const treeBytes = readFileSync(treeFile);
  const tree = loadTree(JSON.parse(treeBytes.toString("utf8")));
  const { commit, dirty } = harnessCommit();
  const startedAt = new Date().toISOString();
  const batchKey = args.batchKey ?? `personas-${startedAt.replace(/[:.]/g, "-").toLowerCase()}`;
  const dir = join(process.cwd(), "data", "simulations", batchKey);
  mkdirSync(dir, { recursive: true });
  recordStore.setDir(join(dir, "records"));
  resetHarnessConfig();
  resetLeadStore();
  setAiCallingEnabled(getHarnessConfig().agencyId, true);

  if (args.decision === "azure") {
    try {
      installLiveJudge();
    } catch (err) {
      console.error(`The Azure decision model is not available (${fixedCode(err)}). Nothing was sent.`);
      return 2;
    }
  }
  const decisionModule = getDecisionRegistry().selectedModuleId();
  const promptSetupId = args.promptSetup ?? getPromptSetupRegistry().selectedId();
  const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree });
  // Every live session goes through this wrapper: it keeps Azure's session.usage.updated counts (numbers only, never
  // content) for the run, and with SIM_SOCKET_TYPES=1 prints the event types when the session closes.
  let sessionUsage: Record<string, number> = {};
  setVoiceDeps({
    socketFactory: async (url, apiKey) => {
      const socket = await realSocketFactory(url, apiKey);
      const got: Record<string, number> = {};
      const sent: Record<string, number> = {};
      sessionUsage = {};
      const parse = (raw: string): { type?: unknown } & Record<string, unknown> => {
        try {
          return JSON.parse(raw) as { type?: unknown } & Record<string, unknown>;
        } catch {
          return { type: "unparsed" };
        }
      };
      socket.onMessage((raw) => {
        const msg = parse(raw);
        const type = String(msg.type ?? "unknown");
        got[type] = (got[type] ?? 0) + 1;
        if (type === "session.usage.updated") sessionUsage = numericLeaves(msg);
      });
      if (process.env.SIM_SOCKET_TYPES === "1") socket.onClose(() => console.log(`socket types received ${JSON.stringify(got)} sent ${JSON.stringify(sent)}`));
      return {
        ...socket,
        send: (d: string) => {
          const type = String(parse(d).type ?? "unknown");
          sent[type] = (sent[type] ?? 0) + 1;
          socket.send(d);
        },
      };
    },
  });

  const modelSettings: ModelSettings = {
    ...(args.lead === "model" ? { lead: roleSettings(DEFAULT_DEPLOYMENTS.lead, PERSONA_LEAD_MAX_TOKENS) } : {}),
    ...(args.decision === "azure" ? { decision: roleSettings(DEFAULT_DEPLOYMENTS.decision), judge: roleSettings(DEFAULT_DEPLOYMENTS.decision) } : {}),
  };
  const config = {
    batchKey,
    kind: "persona_whole_call",
    agent: args.agent,
    lead: args.lead,
    personaFile: file.path,
    personaFileSha256: file.sha256,
    personaToday: file.today,
    clockNow: clock.iso,
    treeFile,
    treeFileSha256: sha256(treeBytes),
    treeId: tree.id,
    treeVersion: tree.version,
    decisionRouterId: "decision_model",
    decisionModule,
    judgeEnabled: args.decision === "azure",
    promptSetupId: args.agent === "live" ? promptSetupId : null,
    modelSettings,
    repeat: args.repeat,
    maxTurns: args.maxTurns,
    maxModelAsks: args.maxModelAsks,
    harnessCommit: commit,
    harnessDirty: dirty,
    needsAzure,
  };
  const progress = {
    requested: items.length * args.repeat,
    done: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    personaPassed: 0,
    // Counted separately, so one failure never hides the others.
    endings: { best: 0, acceptable: 0, mismatched: 0, not_reached: 0, unmapped: 0 } as Record<string, number>,
    gatedActionMismatches: 0,
    mustNotMismatches: 0,
    enforcementPassed: 0,
    failuresByRule: {} as Record<string, number>,
    endedBy: {} as Record<string, number>,
    extraction: {} as Record<string, Record<string, number>>,
    /** graded, interrupted (cut short by the transport or a cancel), language_not_graded (Spanish or mixed). */
    buckets: {} as Record<string, number>,
    /** Persona checks no evidence could settle, summed over graded calls. */
    notSettled: 0,
  };
  const writeBatch = (status: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, "batch.json"), `${JSON.stringify({ ...config, status, startedAt, progress, modelAsks: asks.asks, modelRetries: client?.retries() ?? 0, ...extra }, null, 2)}\n`);
  writeBatch("running");

  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  const cancelled = () => abort.signal.aborted || existsSync(join(dir, "CANCEL"));
  const poll = setInterval(() => cancelled() && abort.abort(), 1000);
  poll.unref();

  console.log(`batch ${batchKey}: ${progress.requested} calls, agent ${args.agent}, lead ${args.lead}, decision ${decisionModule}, tree ${tree.id}`);
  outer: for (let repeat = 0; repeat < args.repeat; repeat += 1) {
    for (const [index, item] of items.entries()) {
      if (cancelled()) break outer;
      const itemIndex = repeat * items.length + index;
      const base: Record<string, unknown> = { itemIndex, repeatIndex: repeat, personaId: item.id, situation: item.persona.situation, language: item.persona.persona.language ?? "en" };
      const startedRun = Date.now();
      try {
        const persona = item.persona;
        const c = buildPersonaCase(persona, { agencyId: getHarnessConfig().agencyId, today: file.today });
        // Each repeat is its own lead, so the attempt limit and the duplicate guard do not carry over.
        if (repeat > 0) {
          const suffix = `-r${repeat}`;
          c.leadId = c.lead.id = `${c.leadId.slice(0, 60 - suffix.length)}${suffix}`;
        }
        seedLead(structuredClone(c.lead));
        await placeMissedCalls(harness, c, clock.iso);
        seedLead(withoutDialAgreement(getLead(c.leadId)!));
        sessionUsage = {};
        const lead: SimulatedLead =
          args.lead === "scripted"
            ? new ScriptedSimulatedLead(c.facts, { maxLeadTurns: args.maxTurns })
            : new PersonaModelLead({ client: capped(client!, args.maxModelAsks, asks), persona, facts: c.facts, rules: file.leadRules, maxLeadTurns: args.maxTurns });
        let run: Pick<LiveWholeCallRun, "status" | "recordId" | "endedBy" | "leadTurns" | "transcript" | "events" | "record" | "blockedReason" | "failureCode"> &
          Partial<Pick<LiveWholeCallRun, "ran" | "replyLatenciesMs" | "sessionEndReason" | "reminders" | "interrupted" | "lateFragments" | "silenceWaitsMs" | "silenceWaitLimitHits" | "speechChunks">>;
        if (args.agent === "live") {
          run = await runLiveWholeCall({ lead, harness, leadId: c.leadId, direction: c.direction, maxTurns: args.maxTurns, signal: abort.signal, setup: { orchestratorId: "direct", voicePathId: "azure_gpt_live", promptSetupId } });
        } else {
          run = await runWholeCall({ lead, harness, leadId: c.leadId, direction: c.direction, maxTurns: args.maxTurns });
        }
        const line: Record<string, unknown> = {
          ...base,
          direction: c.direction,
          leadRecord: c.record.kind,
          missedAttempts: c.missedAttempts,
          languageSupported: c.languageSupported,
          status: run.status,
          recordId: run.recordId,
          endedBy: run.endedBy,
          leadTurns: run.leadTurns,
          ran: run.ran,
          replyLatenciesMs: run.replyLatenciesMs,
          sessionEndReason: run.sessionEndReason,
          reminders: run.reminders,
          silenceWaitsMs: run.silenceWaitsMs,
          silenceWaitLimitHits: run.silenceWaitLimitHits,
          speechChunks: run.speechChunks,
          liveUsage: args.agent === "live" && Object.keys(sessionUsage).length ? sessionUsage : undefined,
          durationMs: Date.now() - startedRun,
        };
        if (run.status === "completed") {
          // Live words: the opening is every agent line before the caller first speaks, and the disclosure is judged by meaning.
          const live = args.agent === "live";
          const grade = await gradeWholeCall({
            record: run.record,
            events: run.events,
            transcript: live ? mergeOpening(run.transcript) : run.transcript,
            direction: c.direction,
            facts: c.facts,
            ...(live ? { postCallJudge: new LiveWordsPostCallJudge() } : {}),
          });
          line.grade = grade;
          line.transcript = run.transcript.map((t) => ({ role: t.role, text: t.text }));
          line.filed = run.events.filter((e) => e.type === "disposition").map((e) => String(e.data.value)).at(-1);
          line.interrupted = run.interrupted === true;
          line.lateFragments = run.lateFragments;
          progress.completed += 1;
          // Calls cut short by the transport or a cancel, and languages the gates cannot read, are counted
          // apart: they are not verdicts on the agent. Real calls carry no persona expectations.
          const bucket = run.interrupted ? "interrupted" : !c.languageSupported ? "language_not_graded" : "graded";
          line.bucket = bucket;
          progress.buckets[bucket] = (progress.buckets[bucket] ?? 0) + 1;
          if (bucket === "graded") {
            const personaGrade = gradePersonaCall(persona, run.events, grade, { leadHungUp: run.endedBy === "lead_hung_up" });
            progress.notSettled += personaGrade.notSettled;
            line.personaGrade = personaGrade;
            if (personaGrade.passed) progress.personaPassed += 1;
            progress.endings[personaGrade.disposition.result] = (progress.endings[personaGrade.disposition.result] ?? 0) + 1;
            progress.gatedActionMismatches += personaGrade.gatedActions.filter((g) => g.result === "mismatched").length;
            progress.mustNotMismatches += personaGrade.mustNot.filter((m) => m.result === "mismatched").length;
          }
          if (bucket === "graded" && grade.enforcementPassed) progress.enforcementPassed += 1;
          if (bucket === "graded") for (const r of grade.enforcement) if (!r.passed) progress.failuresByRule[r.rule] = (progress.failuresByRule[r.rule] ?? 0) + 1;
          progress.endedBy[String(run.endedBy)] = (progress.endedBy[String(run.endedBy)] ?? 0) + 1;
        } else if (run.status === "blocked") {
          line.blockedReason = run.blockedReason;
          progress.blocked += 1;
        } else {
          line.failureCode = run.failureCode;
          progress.failed += 1;
        }
        appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(line)}\n`);
        const pg = line.personaGrade as { passed: boolean; disposition: { result: string; filed?: string } } | undefined;
        console.log(
          `${progress.done + 1} of ${progress.requested} ${item.id}: ${run.status}` +
            (run.status === "completed" ? `, ${run.leadTurns} lead turns, ended by ${run.endedBy}, filed ${line.filed ?? "none"}` + (pg ? ` (${pg.disposition.result}), persona ${pg.passed ? "passed" : "failed"}` : `, enforcement ${(line.grade as { enforcementPassed: boolean }).enforcementPassed ? "passed" : "failed"}`) : ` (${run.blockedReason ?? run.failureCode})`) +
            `, ${Math.round((Date.now() - startedRun) / 1000)} seconds`,
        );
      } catch (err) {
        const code = err instanceof Error && /^[a-z0-9_:.-]+$/i.test(err.message) ? err.message : "unknown";
        progress.failed += 1;
        appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify({ ...base, status: "failed", failureCode: code, durationMs: Date.now() - startedRun })}\n`);
        console.log(`${progress.done + 1} of ${progress.requested} ${item.id}: failed (${code})`);
        if (code === "model_ask_cap_reached") {
          progress.done += 1;
          writeBatch("failed", { finishedAt: new Date().toISOString(), stopReason: code });
          return 1;
        }
      }
      progress.done += 1;
      writeBatch("running");
    }
  }
  const status = cancelled() ? "cancelled" : "completed";
  writeBatch(status, { finishedAt: new Date().toISOString() });
  console.log(
    `batch ${batchKey} ${status}: ${progress.done} of ${progress.requested} done, completed ${progress.completed}, blocked ${progress.blocked}, failed ${progress.failed}, persona passed ${progress.personaPassed} of ${progress.buckets.graded ?? 0} graded; model asks ${asks.asks}`,
  );
  console.log(
    `buckets ${JSON.stringify(progress.buckets)}; endings (graded) ${JSON.stringify(progress.endings)}; checks not settled ${progress.notSettled}; ended by ${JSON.stringify(progress.endedBy)}; ` +
      `enforcement passed ${progress.enforcementPassed} of ${progress.buckets.graded ?? 0} graded; ` +
      `failures by rule ${JSON.stringify(progress.failuresByRule)}; gated-action mismatches ${progress.gatedActionMismatches}; must-not mismatches ${progress.mustNotMismatches}`,
  );
  console.log(`written to ${dir}`);
  return status === "cancelled" ? 3 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  const message = err instanceof Error && /^[a-z0-9_:.-]+$/i.test(err.message) ? err.message : "unknown";
  console.error(`simulate-personas failed: ${message}`);
  process.exitCode = 1;
}
