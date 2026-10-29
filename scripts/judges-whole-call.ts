/**
 * Whole-call judging of the agent with a simulated lead.
 *
 *   tsx scripts/judges-whole-call.ts [--limit N] [--past-calls-file PATH | --facts-file PATH]
 *                                    [--lead model|scripted] [--direction inbound|outbound]
 *                                    [--tree PATH] [--max-turns N]
 *                                    [--write-db] [--facts-origin synthetic_fixture|real_call]
 *
 * For each past call in a supplied JSON file, Claude extracts the lead's facts, a simulated
 * lead is built from them, a full call is played through the harness against
 * the agent, and the call is graded: outcome (renewal date confirmed, payroll
 * and employee count captured, booked) taken from what the harness did, and
 * enforcement from the post-call judge plus the transcript gates.
 *
 * --facts-file skips the past calls: a JSON array of lead facts. --lead model
 * (the default) plays the lead with a model; --lead scripted plays it without one. --tree PATH plays against another decision
 * tree; the default is the active tree, and with the stub tree the payroll,
 * employee count and renewal date can never be captured, so those totals read
 * zero by construction.
 *
 * The simulated calls run on the in-memory lead store with a synthetic lead, and
 * their records go under the output directory, so nothing reaches the
 * external systems and nothing lands in data/records. Results go to
 * data/judges/whole-call-<timestamp>/ (data/ is git-ignored). Prints counts only.
 *
 * Models go through the configured model connector.
 *
 * --max-turns is refused above 25 (the database caps a call at 25 lead lines).
 *
 * --write-db (off by default) also writes the batch to the harness database
 * (voice_harness.sim_*), after the local files are written, so a database
 * failure never loses them. Facts count as made-up only with --facts-file
 * together with --facts-origin synthetic_fixture, a flag the operator sets and
 * nothing guesses (persona_origin "fixture"); anything else is real call content
 * (persona_origin "real_call") and is written too. Redaction is recorded
 * honestly: the transcript lines of a real-call run, the facts of a real-call
 * facts file, and facts extracted from past calls are all recorded as
 * not_redacted. (Each turn was pattern-redacted, harness_redact_text_v1, before
 * the extraction model saw it, but the stored fact values are the model's own
 * output, so no redaction guarantee is claimed for them.) Each fact row of a real
 * call also records the past call table and the speaker labelling of its source
 * call (diarized, dialer or quo; track, diarized or unverified). A facts file
 * knows neither, so its rows are recorded as dialer or quo by the shape of the
 * id, with unverified labelling. With --write-db, every call id is checked before
 * the first model call, so a bad id costs no model spend.
 * PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
 * Nothing here refuses a real-call write; the setup of the run (orchestrator,
 * dialogue model and so on) is passed to buildWholeCallBatchWrite by another
 * thread and is stored as null here. items_done counts completed plus blocked
 * plus failed calls.
 *
 * Exit codes: 0 done, 1 failed, 2 the Gateway key is missing, 3 done locally
 * but the database write failed or was refused.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHarnessConfig, resetHarnessConfig, setAiCallingEnabled } from "../src/config.js";
import { loadTree, type DecisionTree } from "../src/decision/tree.js";
import { loadActiveTree, selectedDecisionTreeId } from "../src/decision/tree-source.js";
import { CallHarness } from "../src/harness/call-harness.js";
import { getModuleRegistry } from "../src/modules/registry.js";
import { mockLeadStore } from "../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../src/store/lead-store.js";
import { recordStore } from "../src/trace/records.js";
import type { ClaudeJsonClient } from "../src/judging/offline/claude.js";
import { buildJudgeJsonClient, GATEWAY_KEY_MISSING_MESSAGE } from "../src/judging/offline/connector-client.js";
import {
  ClaudeFactExtractor,
  ClaudeSimulatedLead,
  CLAUDE_LEAD_DEFAULT_EFFORT,
  CLAUDE_LEAD_MAX_TOKENS,
  SONNET_MODEL,
} from "../src/judging/offline/claude-lead.js";
import { InMemoryPastCalls } from "../src/judging/offline/mocks.js";
import { SCRIPTED_LEAD_DEFAULTS, ScriptedSimulatedLead } from "../src/judging/offline/simulated-lead.js";
import {
  assertCallIdWritable,
  buildWholeCallBatchWrite,
  factsFileExtractor,
  leadFactsRow,
  modelExtractorVersion,
  sha256Hex,
  type ContentOrigin,
  type HarnessVersion,
  type SimulatorInfo,
  type TreeInfo,
  type WholeCallItemInput,
} from "../src/judging/offline/sim-rows.js";
import { SimWriter } from "../src/judging/offline/sim-writer.js";
import { MAX_TURN_CAP, type LeadFacts, type PastCall, type PastCallSource, type SimulatedLead } from "../src/judging/offline/types.js";
import { OPUS_MODEL } from "../src/judging/offline/claude.js";
import { gradeWholeCall, runWholeCall, totalsOf, type WholeCallGrade, type WholeCallRun } from "../src/judging/offline/whole-call.js";

export interface Args {
  limit: number;
  pastCallsFile?: string;
  factsFile?: string;
  lead: "model" | "scripted";
  direction: "inbound" | "outbound";
  treeFile?: string;
  maxTurns: number;
  /** Also write the batch to the harness database. Off by default. */
  writeDb: boolean;
  /** What the operator states about the facts file. Never guessed. */
  factsOrigin?: ContentOrigin;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 5, lead: "model", direction: "inbound", maxTurns: MAX_TURN_CAP, writeDb: false };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === "--write-db") {
      args.writeDb = true;
      i -= 1;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error("bad_arguments");
    if (flag === "--limit") args.limit = Number(value);
    else if (flag === "--past-calls-file") args.pastCallsFile = value;
    else if (flag === "--facts-file") args.factsFile = value;
    else if (flag === "--lead" && (value === "model" || value === "scripted")) args.lead = value;
    else if (flag === "--direction" && (value === "inbound" || value === "outbound")) args.direction = value;
    else if (flag === "--tree") args.treeFile = value;
    else if (flag === "--max-turns") args.maxTurns = Number(value);
    else if (flag === "--facts-origin" && (value === "synthetic_fixture" || value === "real_call")) args.factsOrigin = value;
    else throw new Error("bad_arguments");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("bad_limit");
  if (!Number.isInteger(args.maxTurns) || args.maxTurns < 1) throw new Error("bad_max_turns");
  if (args.maxTurns > MAX_TURN_CAP) throw new Error("max_turns_above_25");
  if (args.pastCallsFile && args.factsFile) throw new Error("bad_arguments");
  if (args.factsOrigin && !args.factsFile) throw new Error("bad_arguments");
  return args;
}

/** A made-up lead the harness can call. Nothing about it comes from a past call. */
function syntheticLead(id: string) {
  const at = "2026-10-01T12:00:00.000Z";
  return {
    id,
    agencyId: getHarnessConfig().agencyId,
    name: "Jordan Example",
    phone: "+15550100",
    timezone: "America/New_York",
    smsConsentAt: at,
    voiceConsentAt: at,
    artificialVoiceConsent: { at, basis: "lead_written" as const },
    textAgreementAt: at,
    scheduledOutboundAt: at,
    dncStatus: "clear" as const,
    priorCallSummaries: [],
    quoteFields: {},
    handoffNotes: [],
    messages: [],
    bookings: [],
  };
}

/** Today at 14:00 UTC, which is inside the calling window in New York all year. */
function windowClock() {
  const day = new Date().toISOString().slice(0, 10);
  return { now: () => new Date(`${day}T14:00:00.000Z`) };
}

function summaryMarkdown(meta: { requested: number; found: number; blocked: number; grades: WholeCallGrade[]; lead: string; tree: string }): string {
  const t = totalsOf(meta.grades);
  const failed = Object.entries(t.failuresByRule).map(([rule, n]) => `| ${rule} | ${n} of ${t.calls} |`);
  return [
    "# Whole-call judging",
    "",
    `Calls requested: ${meta.requested}. Found: ${meta.found}. Blocked at the start: ${meta.blocked}. Graded: ${t.calls}. Lead: ${meta.lead}. Tree: ${meta.tree}.`,
    "",
    "| Outcome | Calls |",
    "|---|---|",
    `| renewal date confirmed | ${t.renewalDateConfirmed} of ${t.calls} |`,
    `| payroll captured | ${t.payrollCaptured} of ${t.calls} |`,
    `| employee count captured | ${t.employeeCountCaptured} of ${t.calls} |`,
    `| booked | ${t.booked} of ${t.calls} |`,
    `| every enforcement rule passed | ${t.enforcementPassed} of ${t.calls} |`,
    "",
    "Enforcement rules that failed:",
    "",
    ...(failed.length > 0 ? ["| Rule | Calls |", "|---|---|", ...failed] : ["None."]),
    "",
    `Rules this grading does not check: ${meta.grades[0]?.rulesNotChecked.length ?? 0}. They are listed in each result line.`,
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // The Gateway key first, when any model is needed: without it nothing else is worth touching.
  const needsClaude = args.lead === "model" || !args.factsFile;
  let claude: ClaudeJsonClient | undefined;
  if (needsClaude) {
    try {
      claude = buildJudgeJsonClient();
    } catch (err) {
      console.error(`${GATEWAY_KEY_MISSING_MESSAGE} ${err instanceof Error ? err.message : "unknown"}`);
      return 2;
    }
  }

  // Facts: from a file, or extracted from the past calls.
  let facts: LeadFacts[];
  /** The past call each facts entry was extracted from; absent for a facts file. */
  const pastCallOf: Array<PastCall | undefined> = [];
  let requested: number;
  let factsText: string | undefined;
  let pastCallsText: string | undefined;
  if (args.factsFile) {
    factsText = readFileSync(args.factsFile, "utf8");
    facts = (JSON.parse(factsText) as LeadFacts[]).slice(0, args.limit);
    requested = facts.length;
    if (args.writeDb) for (const f of facts) assertCallIdWritable(f.sourceCallId, contentOriginOf(args));
  } else {
    if (!args.pastCallsFile) throw new Error("past_calls_file_required");
    pastCallsText = readFileSync(args.pastCallsFile, "utf8");
    const source: PastCallSource = new InMemoryPastCalls(JSON.parse(pastCallsText) as PastCall[]);
    const ids = await source.listCallIds(args.limit);
    requested = ids.length;
    // Before any model spend: every id must have a shape the database accepts for this content.
    if (args.writeDb) for (const id of ids) assertCallIdWritable(id, contentOriginOf(args));
    const extractor = new ClaudeFactExtractor({ client: claude! });
    facts = [];
    for (const id of ids) {
      const call = await source.getCall(id);
      if (!call) continue;
      facts.push(await extractor.extract(call));
      pastCallOf.push(call);
      console.log(`extracted facts ${facts.length} of ${ids.length}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(process.cwd(), "data", "judges", `whole-call-${stamp}`);
  mkdirSync(dir, { recursive: true });
  // Simulated calls write their records here, not into the harness's own records directory.
  recordStore.setDir(join(dir, "records"));
  resetHarnessConfig();
  resetLeadStore();
  setAiCallingEnabled(getHarnessConfig().agencyId, true);

  const clock = windowClock();
  const clockNow = clock.now();
  const treeText = args.treeFile ? readFileSync(args.treeFile, "utf8") : undefined;
  const tree = treeText ? loadTree(JSON.parse(treeText)) : undefined;
  const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), tree ? { tree } : {});

  const grades: WholeCallGrade[] = [];
  const graded: GradedItem[] = [];
  const startedAt = new Date();
  const lines: string[] = [];
  let blocked = 0;
  for (const [index, f] of facts.entries()) {
    const leadId = `whole-call-lead-${index + 1}`;
    seedLead(syntheticLead(leadId));
    const lead: SimulatedLead =
      args.lead === "scripted"
        ? new ScriptedSimulatedLead(f, { maxLeadTurns: args.maxTurns })
        : new ClaudeSimulatedLead({ client: claude!, facts: f, maxLeadTurns: args.maxTurns });
    const run = await runWholeCall({ lead, harness, leadId, direction: args.direction, maxTurns: args.maxTurns });
    if (run.status === "blocked") {
      blocked += 1;
      graded.push({ facts: f, pastCall: pastCallOf[index], leadId, itemIndex: index, run });
      lines.push(JSON.stringify({ sourceCallId: f.sourceCallId, status: "blocked", blockedReason: run.blockedReason }));
      console.log(`call ${index + 1} of ${facts.length}: blocked at the start`);
      continue;
    }
    const grade = await gradeWholeCall({ record: run.record, events: run.events, transcript: run.transcript, direction: args.direction, facts: f });
    grades.push(grade);
    graded.push({ facts: f, pastCall: pastCallOf[index], leadId, itemIndex: index, run, grade });
    lines.push(JSON.stringify({ facts: f, status: "graded", recordId: run.recordId, endedBy: run.endedBy, grade }));
    console.log(
      `call ${index + 1} of ${facts.length}: ${run.leadTurns} lead turns, ended by ${run.endedBy}, ` +
        `booked=${grade.outcome.booked}, enforcement ${grade.enforcementPassed ? "passed" : "failed"}`,
    );
  }

  writeFileSync(join(dir, "results.jsonl"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  writeFileSync(
    join(dir, "summary.md"),
    summaryMarkdown({ requested, found: facts.length, blocked, grades, lead: args.lead, tree: tree?.id ?? "active tree" }),
  );
  const t = totalsOf(grades);
  console.log(
    `calls requested=${requested} found=${facts.length} blocked=${blocked} graded=${t.calls}; ` +
      `renewal date confirmed ${t.renewalDateConfirmed} of ${t.calls}, payroll ${t.payrollCaptured} of ${t.calls}, ` +
      `employee count ${t.employeeCountCaptured} of ${t.calls}, booked ${t.booked} of ${t.calls}, ` +
      `enforcement passed ${t.enforcementPassed} of ${t.calls}`,
  );
  console.log(`written to ${dir}`);

  return writeWholeCallBatchToDatabase(args, {
    graded,
    requested,
    found: facts.length,
    factsText,
    pastCallsText,
    treeText,
    tree,
    stamp,
    startedAt,
    clockNow,
  });
}

/** One call of the batch with what the database rows need to know about it. */
export interface GradedItem {
  facts: LeadFacts;
  /** The past call the facts were extracted from; absent for a facts file. */
  pastCall?: PastCall;
  leadId: string;
  itemIndex: number;
  run: WholeCallRun;
  grade?: WholeCallGrade;
}

/** Synthetic only when the operator says so about a facts file. Everything else is real call content. */
export function contentOriginOf(args: Pick<Args, "factsFile" | "factsOrigin">): ContentOrigin {
  return args.factsFile && args.factsOrigin === "synthetic_fixture" ? "synthetic_fixture" : "real_call";
}

/** What the database write needs from a finished run. */
export interface WholeCallBatchContext {
  graded: GradedItem[];
  requested: number;
  found: number;
  factsText?: string;
  pastCallsText?: string;
  diarizedText?: string;
  treeText?: string;
  tree?: Pick<DecisionTree, "id" | "version">;
  stamp: string;
  startedAt: Date;
  clockNow: Date;
}

/** The rows of one whole-call batch, built from a finished run. Pure apart from reading the active tree. */
export function buildWholeCallDatabaseWrite(args: Args, ctx: WholeCallBatchContext, harnessVer: HarnessVersion) {
  const extractorId = `claude-fact-extractor:${OPUS_MODEL}`;
  // Synthetic only when the operator says so about a facts file. Everything else is real call content.
  // PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  const contentOrigin = contentOriginOf(args);
  const simulator: SimulatorInfo =
    args.lead === "scripted"
      ? { kind: "scripted", ...SCRIPTED_LEAD_DEFAULTS }
      : { kind: "model", model: SONNET_MODEL, effort: CLAUDE_LEAD_DEFAULT_EFFORT, maxTokens: CLAUDE_LEAD_MAX_TOKENS };
  const treeInfo: TreeInfo = ctx.tree
    ? { source: "tree_file", id: ctx.tree.id, version: ctx.tree.version, fileSha256: sha256Hex(ctx.treeText!) }
    : (() => {
        const active = loadActiveTree();
        return { source: "active" as const, id: active.id, version: active.version, choiceId: selectedDecisionTreeId() };
      })();
  const extractedAt = new Date();
  const items: WholeCallItemInput[] = ctx.graded.map((g) => ({
    leadFacts: leadFactsRow({
      facts: g.facts,
      contentOrigin,
      extractor: ctx.factsText
        ? factsFileExtractor(sha256Hex(ctx.factsText))
        : { id: extractorId, version: modelExtractorVersion(harnessVer, OPUS_MODEL, "medium"), model: OPUS_MODEL, effort: "medium" },
      extractedAt,
      // A synthetic fixture has no real source. A real call carries the past call table and track labelling it was read
      // with; a facts file read none, so it is recorded the way turn judging records an unread call: by the shape of the
      // id, with unverified labelling.
      realSource: {
        origin: "source_secondary",
        rowId: g.pastCall?.sourceRowId ?? null,
        pastCall: g.pastCall ?? { source: g.facts.sourceCallId.startsWith("quo:") ? "quo" : "dialer", attribution: "unverified" },
      },
      // The stored values are model output (or a facts file's own text), not text that went through redactText, so the
      // default label not_redacted applies even though the extractor saw pattern-redacted turns.
      // PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
    }),
    run: {
      itemIndex: g.itemIndex,
      leadId: g.leadId,
      leadIdOrigin: "synthetic_fixture",
      contentOrigin,
      direction: args.direction,
      turnCap: args.maxTurns,
      clockNow: ctx.clockNow,
      simulator,
      tree: treeInfo,
      run: g.run,
      grade: g.grade,
      updatedAt: new Date(),
    },
  }));
  const write = buildWholeCallBatchWrite({
    batch: {
      batchKey: `whole-call-${ctx.stamp}`,
      harness: harnessVer,
      startedAt: ctx.startedAt,
      finishedAt: new Date(),
      status: "completed",
      itemsRequested: ctx.requested,
      itemsFound: ctx.found,
      config: {
        limit: args.limit,
        lead: args.lead,
        direction: args.direction,
        maxTurns: args.maxTurns,
        ...(ctx.pastCallsText ? { pastCallsFileSha256: sha256Hex(ctx.pastCallsText) } : {}),
        ...(ctx.factsText ? { factsFileSha256: sha256Hex(ctx.factsText) } : {}),
        ...(ctx.treeText ? { treeFileSha256: sha256Hex(ctx.treeText) } : {}),
        ...(ctx.diarizedText ? { diarizedConfigSha256: sha256Hex(ctx.diarizedText) } : {}),
      },
    },
    items,
  });
  return write;
}

/**
 * The --write-db step. Without --write-db it returns 0 and never calls makeWriter, so nothing database-related is
 * constructed on the default path. The local files are already on disk; a refusal or a database failure only changes
 * the exit code (3).
 */
export async function writeWholeCallBatchToDatabase(args: Args, ctx: WholeCallBatchContext, makeWriter: () => SimWriter = () => new SimWriter()): Promise<number> {
  if (!args.writeDb) return 0;
  try {
    const writer = makeWriter();
    const harnessVer = writer.harnessVersion();
    const write = buildWholeCallDatabaseWrite(args, ctx, harnessVer);
    const written = await writer.writeWholeCallBatch(write);
    console.log(`database: batch written with ${written.runIds.length} runs and ${written.turnsWritten} transcript lines`);
    return 0;
  } catch (err) {
    console.error(`database write not done: ${err instanceof Error && /^[a-z0-9_:]+$/.test(err.message) ? err.message : "sim_write_failed"}; local results are kept`);
    return 3;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    // Our own error codes carry no secrets; anything else is reduced to a fixed label.
    const message = err instanceof Error && /^[a-z0-9_:]+$/.test(err.message) ? err.message : "unknown";
    console.error(`judges-whole-call failed: ${message}`);
    process.exitCode = 1;
  }
}
