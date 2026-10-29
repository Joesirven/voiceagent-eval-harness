import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { resetJudges } from "../../src/judge/index.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import type { SqlRunner } from "../../src/setups/local-postgres.js";
import { ClaudeSimulatedLead } from "../../src/judging/offline/claude-lead.js";
import type { ClaudeJsonClient } from "../../src/judging/offline/claude.js";
import { ScriptedSimulatedLead, SCRIPTED_LEAD_DEFAULTS } from "../../src/judging/offline/simulated-lead.js";
import {
  assertCallIdWritable,
  buildWholeCallBatchWrite,
  canonicalJson,
  factsFileExtractor,
  factsSha256,
  fixtureSourceRef,
  harnessVersion,
  leadFactsRow,
  leadRecordExtractor,
  personaSourceRef,
  turnEvalBatchRow,
  turnEvalRow,
  wholeCallBatchRow,
  type SimBatchRow,
  type SimLeadFactsRow,
  type SimRunRow,
  type SimTurnEvalRow,
  type SimTurnRow,
  type WholeCallBatchConfig,
} from "../../src/judging/offline/sim-rows.js";
import { createPsqlRunner } from "../../src/setups/local-postgres.js";
import { SimWriteError, SimWriter } from "../../src/judging/offline/sim-writer.js";
import { MAX_TURN_CAP, type LeadFacts, type PastCall, type SimulatedLead } from "../../src/judging/offline/types.js";
import { gradeWholeCall, runWholeCall } from "../../src/judging/offline/whole-call.js";
import { baseLead } from "../helpers/fixtures.js";
import {
  buildWholeCallDatabaseWrite,
  contentOriginOf,
  parseArgs as parseWholeCallArgs,
  writeWholeCallBatchToDatabase,
  type GradedItem,
  type WholeCallBatchContext,
} from "../../scripts/judges-whole-call.js";

const HARNESS = { harness_commit: "a".repeat(40), harness_dirty: false };
const T0 = new Date("2026-10-20T12:00:00.000Z");
const T1 = new Date("2026-10-20T12:05:00.000Z");
const BATCH_KEY = "whole-call-2026-10-20T12-00-00-000Z";
const SHA = "b".repeat(64);

const FACTS: LeadFacts = {
  sourceCallId: "fixture:roofer-one",
  businessType: "roofing",
  renewalDate: "2026-12-14",
  annualPayroll: "280,000 dollars",
  employeeCount: 6,
  currentCarrier: "Redwood Mutual",
  language: "English",
  objections: ["I'm busy right now."],
};

/* ------------------------------------------------------------ fake database */

const LITERAL = /\$(j[0-9a-f]{12})\$([\s\S]*?)\$\1\$/g;
const literalsOf = (sql: string): unknown[] => [...sql.matchAll(LITERAL)].map((m) => JSON.parse(m[2]!));
const withoutLiterals = (sql: string): string => sql.replace(LITERAL, "<literal>");

/** Records every statement and answers like the database would, for the five tables. */
class FakeSimDb implements SqlRunner {
  statements: string[] = [];
  facts = new Map<string, string>();
  batches = new Map<string, { id: string; row: Record<string, unknown> }>();
  runs = new Map<string, { id: string; row: Record<string, unknown> }>();
  turns = new Map<string, Array<Record<string, unknown>>>();
  evals = new Map<string, Record<string, unknown>>();
  failWhen: ((sql: string) => boolean) | undefined;
  private next = 0;
  private id(): string {
    this.next += 1;
    return `00000000-0000-4000-8000-${String(this.next).padStart(12, "0")}`;
  }

  async json(sql: string): Promise<unknown> {
    this.statements.push(sql);
    if (this.failWhen?.(sql)) throw new Error("local_db_error");
    const lits = literalsOf(sql);
    if (/update voice_harness\.sim_batch set cancel_requested = true/.test(sql)) {
      const { batch_key: key } = lits[0] as { batch_key: string };
      const found = this.batches.get(key);
      if (!found || found.row.status !== "running") return { changed: 0 };
      found.row.cancel_requested = true;
      return { changed: 1 };
    }
    if (/left join voice_harness\.sim_batch/.test(sql)) {
      const found = this.batches.get((lits[0] as { batch_key: string }).batch_key);
      if (!found) return { found: false, id: null, cancelRequested: null, status: null };
      return { found: true, id: found.id, cancelRequested: found.row.cancel_requested, status: found.row.status };
    }
    const into = /insert into voice_harness\.(\w+)/.exec(sql)?.[1];
    if (into === "sim_lead_facts") {
      const row = lits[0] as Record<string, unknown>;
      // The database check sim_lead_facts_past_call_known.
      if (row.source_call_table !== "fixture" && (row.past_call_source == null || row.attribution == null)) throw new Error("local_db_error");
      const key = ["source_call_origin", "source_call_table", "source_call_key", "extractor_id", "extractor_version", "facts_sha256"].map((c) => row[c]).join("|");
      if (!this.facts.has(key)) this.facts.set(key, this.id());
      return { id: this.facts.get(key) };
    }
    if (into === "sim_batch") {
      const row = lits[0] as Record<string, unknown>;
      const key = row.batch_key as string;
      // The database check sim_batch_cancelled_was_requested is on the proposed row, before the conflict is resolved.
      if (row.status === "cancelled" && row.cancel_requested !== true) throw new Error("local_db_error");
      const old = this.batches.get(key);
      // The database keeps these as first written, and cancel_requested = old or new (sticky).
      const kept = old ? { kind: old.row.kind, started_at: old.row.started_at, harness_commit: old.row.harness_commit } : {};
      if (old && /"cancel_requested" = voice_harness\.sim_batch\.cancel_requested or excluded\.cancel_requested/.test(sql)) {
        (kept as Record<string, unknown>).cancel_requested = old.row.cancel_requested === true || row.cancel_requested === true;
      }
      const entry = { id: old?.id ?? this.id(), row: { ...(old?.row ?? {}), ...row, ...kept } };
      this.batches.set(key, entry);
      return { id: entry.id };
    }
    if (into === "sim_run") {
      const row = lits[0] as Record<string, unknown>;
      const key = [row.batch_id, row.lead_facts_id, row.repeat_index, row.attempt].join("|");
      const old = this.runs.get(key);
      const entry = { id: old?.id ?? this.id(), row: { ...(old?.row ?? {}), ...row } };
      this.runs.set(key, entry);
      return { id: entry.id };
    }
    if (into === "sim_turn") {
      const runId = (lits[0] as { run_id: string }).run_id;
      this.turns.set(runId, lits[1] as Array<Record<string, unknown>>);
      return { count: this.turns.get(runId)!.length };
    }
    if (into === "sim_turn_eval") {
      let inserted = 0;
      for (const row of lits[0] as Array<Record<string, unknown>>) {
        const key = [row.batch_id, row.source_call_origin, row.source_call_table, row.source_call_key, row.turn_index].join("|");
        if (!this.evals.has(key)) {
          this.evals.set(key, row);
          inserted += 1;
        }
      }
      return { inserted };
    }
    throw new Error("fake_db_unknown_statement");
  }
}

const writerOn = (db: FakeSimDb) => new SimWriter({ runner: db, git: () => "", now: () => T1 });

/* -------------------------------------------------------------- row helpers */

const config: WholeCallBatchConfig = { limit: 2, lead: "scripted", direction: "inbound", maxTurns: 25, factsFileSha256: SHA };

function facts(i: number): SimLeadFactsRow {
  return leadFactsRow({
    facts: { ...FACTS, sourceCallId: `fixture:roofer-${i}` },
    contentOrigin: "synthetic_fixture",
    extractor: factsFileExtractor(SHA),
    extractedAt: T0,
  });
}

/** Facts with no text at all, for the tests of a real-call row without text. */
function textlessFacts(): SimLeadFactsRow {
  return leadFactsRow({
    facts: { sourceCallId: "fixture:empty", objections: [] },
    contentOrigin: "synthetic_fixture",
    extractor: factsFileExtractor(SHA),
    extractedAt: T0,
  });
}

function runRow(i: number, over: Partial<SimRunRow> = {}): Omit<SimRunRow, "batch_id" | "lead_facts_id"> {
  return {
    item_index: i,
    attempt: 1,
    repeat_index: 0,
    record_id: `call_abc${i}`,
    record_id_origin: "harness_process",
    trace_ref: `call_abc${i}.jsonl`,
    first_record_seq: 1,
    last_record_seq: 9,
    lead_id: `whole-call-lead-${i + 1}`,
    lead_id_origin: "synthetic_fixture",
    content_origin: "synthetic_fixture",
    direction: "inbound",
    clock_now: T0.toISOString(),
    simulator: "scripted",
    simulator_model: null,
    simulator_effort: null,
    simulator_max_tokens: null,
    scripted_preferred_time: SCRIPTED_LEAD_DEFAULTS.preferredTime,
    scripted_objection_after_turns: 3,
    scripted_objection_spacing: 3,
    turn_cap: 25,
    tree_source: "tree_file",
    tree_choice_id: null,
    tree_id: "t",
    tree_version: "1",
    tree_file_sha256: SHA,
    decision_module_id: null,
    decision_model_kind: null,
    orchestrator_id: null,
    voice_path_id: null,
    voice_module_id: null,
    dialogue_model: null,
    prompt_setup_id: null,
    decision_router_id: null,
    decision_model: null,
    judge_enabled: null,
    judge_model: null,
    persona_file_sha256: null,
    seed: null,
    model_settings: {},
    status: "completed",
    blocked_reason: null,
    failure_code: null,
    ended_by: "agent_ended",
    lead_turns: 3,
    caller_lines: 3,
    renewal_date_confirmed: false,
    payroll_captured: false,
    employee_count_captured: false,
    booked: false,
    enforcement: [],
    enforcement_passed: true,
    judge_verdicts: [],
    judge_score: null,
    started_at: T0.toISOString(),
    ended_at: T1.toISOString(),
    agent_reply_latency_ms_median: null,
    agent_reply_latency_ms_max: null,
    input_tokens: null,
    output_tokens: null,
    cost_in_dollars: null,
    updated_at: T1.toISOString(),
    ...over,
  };
}

const turnRows = (n: number, text = "Hello, this is made up.") =>
  Array.from({ length: n }, (_, i) => ({
    content_origin: "synthetic_fixture" as const,
    line_index: i,
    turn_index: i === 0 ? -1 : i,
    role: (i % 2 === 0 ? "agent" : "caller") as "agent" | "caller",
    spoken: true,
    said_at: T0.toISOString(),
    record_seq: i + 1,
    agent_reply_latency_ms: null,
    text_redacted: text,
    redaction_method: null,
  }));

function batchWrite(itemCount: number, turnsPerItem = 3, status: "completed" | "running" = "completed") {
  return {
    batch: wholeCallBatchRow({
      batchKey: BATCH_KEY,
      harness: HARNESS,
      startedAt: T0,
      finishedAt: status === "running" ? null : T1,
      status,
      itemsRequested: itemCount,
      itemsFound: itemCount,
      itemsCompleted: itemCount,
      itemsBlocked: 0,
      itemsFailed: 0,
      config: { ...config },
    }),
    items: Array.from({ length: itemCount }, (_, i) => ({ leadFacts: facts(i), run: runRow(i), turns: turnRows(turnsPerItem) })),
  };
}

const evalRow = (turnIndex: number, over: Partial<Omit<SimTurnEvalRow, "batch_id">> = {}): Omit<SimTurnEvalRow, "batch_id"> =>
  turnEvalRow({
    judgement: { callId: "fixture:eval-one", turnIndex, agentReply: "a", producerReply: "b", picks: ["first", "second"], verdict: "better" },
    pastCall: { source: "dialer", attribution: "track", cleanTurns: undefined, sourceRowId: undefined },
    contentOrigin: "synthetic_fixture",
    sourceOrigin: "synthetic_fixture",
    agent: { id: "agent-x", model: null, effort: null, systemPromptSha256: SHA, systemPromptIsPlaceholder: true },
    judge: { id: "judge-x", model: null, effort: null, rubricSha256: SHA },
    judgedAt: T1,
    ...over,
  });

const turnBatch = (status: "completed" | "running" = "completed") =>
  turnEvalBatchRow({
    batchKey: "turns-2026-10-20T12-00-00-000Z",
    harness: HARNESS,
    startedAt: T0,
    finishedAt: status === "running" ? null : T1,
    status,
    itemsRequested: 1,
    itemsFound: 1,
    itemsJudged: 1,
    itemsBlocked: 0,
    itemsFailed: 0,
    config: { limit: 1, callCount: 1, turnsPerCall: 3, minPriorTurns: 2, minWords: 4, systemPromptIsPlaceholder: true, pastCallSourceId: "dev-database" },
  });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SimWriteError);
    return (err as SimWriteError).code;
  }
  throw new Error("expected a refusal");
}

/* ------------------------------------------------------------- writer paths */

describe("writer: insert, duplicates, resume, replace", () => {
  it("writes a batch as running, then the items, then the final batch row", async () => {
    const db = new FakeSimDb();
    const result = await writerOn(db).writeWholeCallBatch(batchWrite(2));
    expect(result.runIds).toHaveLength(2);
    expect(result.turnsWritten).toBe(6);
    expect(db.facts.size).toBe(2);
    expect(db.runs.size).toBe(2);
    expect(db.turns.size).toBe(2);
    const kinds = db.statements.map((s) => /(?:insert into|delete from) voice_harness\.(\w+)/.exec(s)?.[1]);
    expect(kinds[0]).toBe("sim_batch");
    expect(kinds.at(-1)).toBe("sim_batch");
    expect(db.statements[0]).toMatch(/on conflict \(batch_key\) do update/);
    expect(literalsOf(db.statements[0]!)[0]).toMatchObject({ status: "running", finished_at: null });
    expect(db.batches.get(BATCH_KEY)!.row).toMatchObject({ status: "completed", finished_at: T1.toISOString() });
  });

  it("uses the conflict clauses of the design", async () => {
    const db = new FakeSimDb();
    await writerOn(db).writeWholeCallBatch(batchWrite(1));
    const all = db.statements.join("\n");
    expect(all).toMatch(/on conflict on constraint sim_lead_facts_one_per_extraction do nothing/);
    expect(all).toMatch(/on conflict \(batch_id, lead_facts_id, repeat_index, attempt\) do update/);
    expect(db.statements.find((s) => s.includes("delete from voice_harness.sim_turn"))).toMatch(/^begin; .*commit;$/s);
    const sets = /do update set (.*) returning/.exec(db.statements.find((s) => s.includes("insert into voice_harness.sim_run"))!)![1]!;
    expect(sets).not.toMatch(/"batch_id"|"lead_facts_id"|"repeat_index"|"attempt"/);
  });

  it("ignores a duplicate: the same batch twice leaves one of everything with the same ids", async () => {
    const db = new FakeSimDb();
    const first = await writerOn(db).writeWholeCallBatch(batchWrite(2));
    const second = await writerOn(db).writeWholeCallBatch(batchWrite(2));
    expect(second).toEqual(first);
    expect([db.facts.size, db.runs.size, db.batches.size, db.turns.size]).toEqual([2, 2, 1, 2]);
  });

  it("resumes a batch that failed part-way without doubling anything", async () => {
    const db = new FakeSimDb();
    let runInserts = 0;
    db.failWhen = (sql) => sql.includes("insert into voice_harness.sim_run") && ++runInserts === 2;
    expect(await refusal(writerOn(db).writeWholeCallBatch(batchWrite(3)))).toBe("local_db_error");
    expect(db.batches.get(BATCH_KEY)!.row.status).toBe("failed");
    expect(db.runs.size).toBe(1);
    db.failWhen = undefined;
    await writerOn(db).writeWholeCallBatch(batchWrite(3));
    expect(db.runs.size).toBe(3);
    expect(db.facts.size).toBe(3);
    expect(db.batches.size).toBe(1);
    expect(db.batches.get(BATCH_KEY)!.row.status).toBe("completed");
  });

  it("replaces a run's lines: a rewrite with fewer lines leaves only the new ones", async () => {
    const db = new FakeSimDb();
    const writer = writerOn(db);
    await writer.writeWholeCallBatch(batchWrite(1, 4));
    const runId = [...db.turns.keys()][0]!;
    expect(db.turns.get(runId)).toHaveLength(4);
    await writer.writeWholeCallBatch(batchWrite(1, 2));
    expect(db.turns.get(runId)).toHaveLength(2);
    expect(db.turns.size).toBe(1);
  });

  it("inserts turn judgements once: a repeat is ignored", async () => {
    const db = new FakeSimDb();
    const write = { batch: turnBatch(), evals: [evalRow(3), evalRow(5)] };
    expect((await writerOn(db).writeTurnEvalBatch(write)).inserted).toBe(2);
    expect((await writerOn(db).writeTurnEvalBatch(write)).inserted).toBe(0);
    expect(db.evals.size).toBe(2);
    expect(db.statements.join("\n")).toMatch(/on conflict on constraint sim_turn_eval_one_per_turn do nothing/);
    expect(Object.keys(literalsOf(db.statements[1]!)[0] as object[])).toHaveLength(2);
    const row = (literalsOf(db.statements[1]!)[0] as Array<Record<string, unknown>>)[0]!;
    expect(row).not.toHaveProperty("verdict");
    expect(row).not.toHaveProperty("consistent");
    expect(row).toMatchObject({ pick_agent_first: "first", pick_producer_first: "second" });
  });

  it("only a code leaves the writer when the database fails", async () => {
    const db = new FakeSimDb();
    db.failWhen = () => {
      throw new Error("password=hunter2 near \"roofing\"");
    };
    expect(await refusal(writerOn(db).upsertBatch(batchWrite(1).batch))).toBe("sim_write_failed");
  });
});

/* -------------------------------------------------------------- turn cap */

describe("the turn cap", () => {
  it("is refused in the writer above 25, before any SQL", async () => {
    const db = new FakeSimDb();
    const write = batchWrite(1);
    write.items[0]!.run.turn_cap = 26;
    expect(await refusal(writerOn(db).writeWholeCallBatch(write))).toBe("sim_turn_cap_above_25");
    const big = batchWrite(1);
    (big.batch.config as WholeCallBatchConfig).maxTurns = 26;
    expect(await refusal(writerOn(db).writeWholeCallBatch(big))).toBe("sim_turn_cap_above_25");
    expect(db.statements).toEqual([]);
  });

  it("is refused by the whole-call script argument parser", () => {
    expect(() => parseWholeCallArgs(["--max-turns", "26"])).toThrow("max_turns_above_25");
    expect(parseWholeCallArgs(["--max-turns", "25"]).maxTurns).toBe(25);
    expect(parseWholeCallArgs([]).writeDb).toBe(false);
    expect(parseWholeCallArgs(["--write-db", "--lead", "scripted"])).toMatchObject({ writeDb: true, lead: "scripted" });
    expect(parseWholeCallArgs([]).lead).toBe("model");
    expect(parseWholeCallArgs(["--lead", "model"]).lead).toBe("model");
    expect(() => parseWholeCallArgs(["--lead", "claude"])).toThrow("bad_arguments");
    expect(parseWholeCallArgs(["--facts-file", "f.json", "--facts-origin", "synthetic_fixture"]).factsOrigin).toBe("synthetic_fixture");
    expect(() => parseWholeCallArgs(["--facts-origin", "synthetic_fixture"])).toThrow("bad_arguments");
  });

  it("is clamped by the scripted lead and the model lead", async () => {
    const scripted = new ScriptedSimulatedLead(FACTS, { maxLeadTurns: 99 });
    let lines = 0;
    while ((await scripted.next("Okay?")) !== null) lines += 1;
    expect(lines).toBe(MAX_TURN_CAP);

    const client: ClaudeJsonClient = { askJson: async <T,>() => ({ line: "Okay.", hang_up: false }) as T };
    const model = new ClaudeSimulatedLead({ client, facts: FACTS, maxLeadTurns: 99 });
    lines = 0;
    while ((await model.next("Hello?")) !== null) lines += 1;
    expect(lines).toBe(MAX_TURN_CAP);
  });
});

describe("runWholeCall", () => {
  beforeEach(() => {
    recordStore.setDir(mkdtempSync(join(tmpdir(), "sim-writer-test-")));
    traceBus.reset();
    resetHarnessConfig();
    resetModuleRegistry();
    resetDecisionRegistry();
    resetJudges();
    process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE;
    resetActiveTree();
    resetLeadStore();
    clearCallLogs();
    setAiCallingEnabled("agency-demo", true);
    seedLead(baseLead());
  });
  const harness = () => new CallHarness({ now: () => new Date("2026-10-15T14:00:00.000Z") }, mockLeadStore, getModuleRegistry());

  it("clamps maxTurns to 25 even when asked for more", async () => {
    let asked = 0;
    const endless: SimulatedLead = {
      facts: FACTS,
      next: async () => {
        asked += 1;
        return "Okay, go on.";
      },
    };
    const run = await runWholeCall({ lead: endless, harness: harness(), leadId: "lead-1", direction: "inbound", maxTurns: 40 });
    expect(run.leadTurns).toBeLessThanOrEqual(MAX_TURN_CAP);
    expect(asked).toBeLessThanOrEqual(MAX_TURN_CAP + 1);
    if (run.endedBy === "turn_limit") expect(run.leadTurns).toBe(MAX_TURN_CAP);
  });

  it("a real run becomes rows that the writer accepts", async () => {
    const lead = new ScriptedSimulatedLead(FACTS, { maxLeadTurns: 6 });
    const run = await runWholeCall({ lead, harness: harness(), leadId: "lead-1", direction: "inbound", maxTurns: 6 });
    const grade = await gradeWholeCall({ record: run.record, facts: FACTS });
    const write = buildWholeCallBatchWrite({
      batch: { batchKey: BATCH_KEY, harness: HARNESS, startedAt: T0, finishedAt: T1, status: "completed", itemsRequested: 1, itemsFound: 1, config },
      items: [
        {
          leadFacts: facts(0),
          run: {
            itemIndex: 0,
            leadId: "whole-call-lead-1",
            leadIdOrigin: "synthetic_fixture",
            contentOrigin: "synthetic_fixture",
            direction: "inbound",
            turnCap: 6,
            clockNow: T0,
            simulator: { kind: "scripted", ...SCRIPTED_LEAD_DEFAULTS },
            tree: { source: "active", id: "stub", version: "1", choiceId: "stub" },
            run,
            grade,
            updatedAt: T1,
          },
        },
      ],
    });
    const item = write.items[0]!;
    expect(item.run).toMatchObject({ status: "completed", trace_ref: `${run.recordId}.jsonl`, lead_turns: run.leadTurns, caller_lines: grade.turns });
    expect(item.run.record_id).toMatch(/^call_[a-z0-9]{1,40}$/);
    expect(item.run.first_record_seq).toBe(run.events[0]!.recordSeq);
    expect(item.turns).toHaveLength(run.transcript.length);
    expect(item.turns[0]).toMatchObject({ line_index: 0, text_redacted: run.transcript[0]!.text });
    const db = new FakeSimDb();
    await writerOn(db).writeWholeCallBatch(write);
    expect(db.runs.size).toBe(1);
    expect([...db.runs.values()][0]!.row).toMatchObject({ simulator: "scripted", scripted_objection_after_turns: 3 });
  });

  it("a blocked start becomes a blocked row with no outcome", async () => {
    setAiCallingEnabled("agency-demo", false);
    const run = await runWholeCall({ lead: new ScriptedSimulatedLead(FACTS), harness: harness(), leadId: "lead-1", direction: "inbound" });
    const { items } = buildWholeCallBatchWrite({
      batch: { batchKey: BATCH_KEY, harness: HARNESS, startedAt: T0, finishedAt: T1, status: "completed", itemsRequested: 1, itemsFound: 1, config },
      items: [
        {
          leadFacts: facts(0),
          run: {
            itemIndex: 0,
            leadId: "whole-call-lead-1",
            leadIdOrigin: "synthetic_fixture",
            contentOrigin: "synthetic_fixture",
            direction: "inbound",
            turnCap: 25,
            clockNow: T0,
            simulator: { kind: "model", model: "m", effort: "low", maxTokens: 1000 },
            tree: { source: "tree_file", id: "t", version: "1", fileSha256: SHA },
            run,
            updatedAt: T1,
          },
        },
      ],
    });
    expect(items[0]!.run).toMatchObject({ status: "blocked", blocked_reason: "ai_calling_disabled", ended_by: null, lead_turns: 0, booked: null, simulator_model: "m" });
    const blockedBatch = { ...batchWrite(1).batch, items_done: 1, items_blocked: 1 } as SimBatchRow;
    await writerOn(new FakeSimDb()).writeWholeCallBatch({ batch: blockedBatch, items: items.map((i) => ({ ...i })) });
  });
});

/* ------------------------------------------------------------ content rule */

const REAL_UUID = "11111111-1111-4111-8111-111111111111";

/** Real-call facts built the way the whole-call script builds them. */
function realFacts(over: Partial<Parameters<typeof leadFactsRow>[0]> = {}, facts: Partial<LeadFacts> = {}): SimLeadFactsRow {
  return leadFactsRow({
    facts: { ...FACTS, sourceCallId: REAL_UUID, ...facts },
    contentOrigin: "real_call",
    extractor: { id: "model-one", version: `${"a".repeat(40)}:some-model:low`, model: "some-model", effort: "low" },
    extractedAt: T0,
    realSource: { origin: "source_secondary", rowId: null, pastCall: { source: "dialer", attribution: "track" } },
    ...over,
  });
}
const realRunRow = (i: number, over: Partial<SimRunRow> = {}) => runRow(i, { content_origin: "real_call", ...over });

describe("the content rule", () => {
  // PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  it("accepts a real-call row that carries text when it says not_redacted", async () => {
    const db = new FakeSimDb();
    const writer = writerOn(db);
    const facts0 = realFacts({ redactionMethod: "not_redacted" });
    expect(facts0).toMatchObject({ content_origin: "real_call", persona_origin: "real_call", persona_id: null, redaction_method: "not_redacted", trade_redacted: null });
    await writer.upsertLeadFacts(facts0);
    const turn = { ...turnRows(1)[0]!, content_origin: "real_call" as const, redaction_method: "not_redacted" as const };
    await writer.replaceTurns("00000000-0000-4000-8000-000000000001", [turn]);
    const reply = { ...evalRow(3), content_origin: "real_call" as const, agent_reply_redacted: "hello", redaction_method: "harness_redact_text_v1" as const };
    const real = realEval(reply);
    expect(await writer.insertTurnEvals("00000000-0000-4000-8000-000000000001", [real])).toBe(1);
  });

  it("defaults a real-call row with text to not_redacted, and a row without text to no method", () => {
    expect(realFacts().redaction_method).toBe("not_redacted");
    expect(realFacts({}, { businessType: undefined, renewalDate: undefined, annualPayroll: undefined, currentCarrier: undefined, objections: [] }).redaction_method).toBeNull();
    expect(facts(0).redaction_method).toBeNull();
  });

  it("refuses real-call text with no redaction method, or an unknown one, as unknown, before any SQL", async () => {
    const db = new FakeSimDb();
    const noMethod = { ...realFacts(), redaction_method: null };
    expect(await refusal(writerOn(db).upsertLeadFacts(noMethod))).toBe("sim_redaction_method_unknown");
    const unknown = { ...realFacts(), redaction_method: "masked_by_hand" } as unknown as SimLeadFactsRow;
    expect(await refusal(writerOn(db).upsertLeadFacts(unknown))).toBe("sim_redaction_method_unknown");
    const turn = { ...turnRows(1)[0]!, content_origin: "real_call" as const, redaction_method: null };
    expect(await refusal(writerOn(db).replaceTurns("00000000-0000-4000-8000-000000000001", [turn]))).toBe("sim_redaction_method_unknown");
    const evalWithText = realEval({ ...evalRow(3), agent_reply_redacted: "hello", redaction_method: null });
    expect(await refusal(writerOn(db).insertTurnEvals("00000000-0000-4000-8000-000000000001", [evalWithText]))).toBe("sim_redaction_method_unknown");
    expect(db.statements).toEqual([]);
  });

  it("accepts real-call rows without any text: facts, turn judgements, and a run on real-call facts", async () => {
    const db = new FakeSimDb();
    const noText = realFacts({}, { businessType: undefined, renewalDate: undefined, annualPayroll: undefined, currentCarrier: undefined, objections: [], language: undefined });
    expect(noText.redaction_method).toBeNull();
    const plainEval = realEval(evalRow(3));
    expect(plainEval).toMatchObject({ agent_reply_redacted: null, producer_reply_redacted: null, redaction_method: null });
    const batch = turnEvalBatchRow({
      batchKey: "turns-2026-10-20T12-00-00-000Z", harness: HARNESS, startedAt: T0, finishedAt: T1, status: "completed",
      itemsRequested: 1, itemsFound: 1, itemsJudged: 1, itemsBlocked: 0, itemsFailed: 1,
      failures: [{ source_call_origin: "source_secondary", source_call_table: "dialer", source_call_key: REAL_UUID, turn_index: null, code: "x" }],
      config: { limit: 1, callCount: 1, turnsPerCall: 3, minPriorTurns: 2, minWords: 4, systemPromptIsPlaceholder: true, pastCallSourceId: "dev-database" },
    });
    expect((await writerOn(db).writeTurnEvalBatch({ batch, evals: [plainEval] })).inserted).toBe(1);
    const write = batchWrite(1);
    write.items[0] = { leadFacts: noText, run: realRunRow(0), turns: [] };
    await writerOn(db).writeWholeCallBatch(write);
    expect(db.runs.size).toBe(1);
    expect([...db.runs.values()][0]!.row).toMatchObject({ content_origin: "real_call" });
  });

  it("stores a turn judgement's replies only when the caller passes them, with the method", () => {
    const base = {
      judgement: { callId: REAL_UUID, turnIndex: 3, agentReply: "a", producerReply: "b", picks: ["first", "second"] as ["first", "second"], verdict: "better" as const },
      pastCall: undefined, contentOrigin: "real_call" as const, sourceOrigin: "source_secondary" as const,
      agent: { id: "agent-x", model: null, effort: null, systemPromptSha256: SHA, systemPromptIsPlaceholder: true },
      judge: { id: "judge-x", model: null, effort: null, rubricSha256: SHA }, judgedAt: T1,
    };
    expect(turnEvalRow(base)).toMatchObject({ agent_reply_redacted: null, redaction_method: null });
    expect(turnEvalRow({ ...base, replyText: { agentReply: "A", producerReply: "B", redactionMethod: "harness_redact_text_v1" } })).toMatchObject({
      agent_reply_redacted: "A", producer_reply_redacted: "B", redaction_method: "harness_redact_text_v1",
    });
  });

  it("refuses an unstated origin, a real source labelled synthetic, and a real source with a bad key", async () => {
    const db = new FakeSimDb();
    const unstated = { ...facts(0), content_origin: undefined } as unknown as SimLeadFactsRow;
    expect(await refusal(writerOn(db).upsertLeadFacts(unstated))).toBe("sim_content_origin_unstated");
    const dressedUp = { ...facts(0), source_call_origin: "source_secondary", source_call_table: "dialer", source_call_key: REAL_UUID } as unknown as SimLeadFactsRow;
    expect(await refusal(writerOn(db).upsertLeadFacts(dressedUp))).toBe("sim_source_not_synthetic");
    const badKey = { ...realFacts(), source_call_key: "fixture:roofer-one" } as SimLeadFactsRow;
    expect(await refusal(writerOn(db).upsertLeadFacts(badKey))).toBe("sim_source_not_real_call");
    const lead = { ...batchWrite(1).items[0]!.run, lead_id_origin: "source_secondary" } as unknown as SimRunRow;
    expect(await refusal(writerOn(db).upsertRun({ ...lead, batch_id: "x", lead_facts_id: "y" }))).toBe("sim_source_not_synthetic");
    expect(db.statements).toEqual([]);
  });

  it("never builds a synthetic reference from a real-looking key", () => {
    expect(() => fixtureSourceRef(REAL_UUID)).toThrow("sim_source_not_synthetic");
    expect(() => fixtureSourceRef("quo:abc")).toThrow("sim_source_not_synthetic");
    expect(() => fixtureSourceRef("   ")).toThrow("sim_source_not_synthetic");
    expect(fixtureSourceRef("Roofer One!").source_call_key).toBe("fixture:roofer-one");
    expect(fixtureSourceRef("fixture:abc").source_call_key).toBe("fixture:abc");
    expect(() => fixtureSourceRef("persona-x")).toThrow("sim_persona_ties");
  });

  it("refuses without opening a connection: no database credentials are read", async () => {
    const noMethod = { ...realFacts(), redaction_method: null };
    expect(await refusal(new SimWriter().upsertLeadFacts(noMethod))).toBe("sim_redaction_method_unknown");
  });

  it("refuses a column that is not on the allow-list", async () => {
    const db = new FakeSimDb();
    const hostile = { ...facts(0), "x) select 1; --": "boom" } as unknown as SimLeadFactsRow;
    expect(await refusal(writerOn(db).upsertLeadFacts(hostile))).toBe("sim_row_has_unknown_column");
    expect(db.statements).toEqual([]);
  });
});

function realEval(row: Omit<SimTurnEvalRow, "batch_id">): Omit<SimTurnEvalRow, "batch_id"> {
  return {
    ...row,
    source_call_origin: "source_secondary",
    source_call_table: "dialer",
    source_call_key: REAL_UUID,
    source_call_row_id: null,
    content_origin: "real_call",
  };
}

/* -------------------------------------------------- setup, personas, repeats */

describe("the agent setup, reproducibility and model settings", () => {
  const setup = {
    orchestratorId: "pipecat" as const, voicePathId: "azure_gpt_live", voiceModuleId: "azure-gpt-live", dialogueModel: "gpt-live-1",
    promptSetupId: "setup:default", decisionRouterId: "pipecat_classifier" as const, decisionModel: "gpt-5.6-terra", judgeEnabled: true,
    judgeModel: "gpt-5.6-judge", personaFileSha256: SHA, seed: "seed-1",
    modelSettings: { agent: { deployment: "gpt-live-1", temperature: 0.7, max_output_tokens: null, seed: 4 }, lead: { deployment: "gpt-5.6-terra" } },
  };
  const withSetup = (over: Partial<SimRunRow>) => ({ ...runRow(0), ...over });

  it("stores nulls and an empty object when no setup is passed, and the values when it is", async () => {
    const run = await (async () => {
      const lead = new ScriptedSimulatedLead(FACTS, { maxLeadTurns: 2 });
      recordStore.setDir(mkdtempSync(join(tmpdir(), "sim-writer-test-")));
      resetHarnessConfig(); resetModuleRegistry(); resetDecisionRegistry(); resetJudges(); resetLeadStore(); clearCallLogs();
      process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE; resetActiveTree();
      setAiCallingEnabled("agency-demo", true); seedLead(baseLead());
      return runWholeCall({ lead, harness: new CallHarness({ now: () => new Date("2026-10-15T14:00:00.000Z") }, mockLeadStore, getModuleRegistry()), leadId: "lead-1", direction: "inbound", maxTurns: 2 });
    })();
    const input = { itemIndex: 0, leadId: "whole-call-lead-1", leadIdOrigin: "synthetic_fixture" as const, contentOrigin: "synthetic_fixture" as const, direction: "inbound" as const, turnCap: 2,
      clockNow: T0, simulator: { kind: "model" as const, model: "gpt-5.6-terra" }, tree: { source: "active" as const, id: "stub", version: "1", choiceId: "stub", fileSha256: SHA }, run, updatedAt: T1 };
    const batchInput = { batchKey: BATCH_KEY, harness: HARNESS, startedAt: T0, finishedAt: T1, status: "completed" as const, itemsRequested: 1, itemsFound: 1, config };
    const plain = buildWholeCallBatchWrite({ batch: batchInput, items: [{ leadFacts: facts(0), run: input }] });
    expect(plain.items[0]!.run).toMatchObject({
      orchestrator_id: null, voice_path_id: null, dialogue_model: null, decision_router_id: null, judge_enabled: null, seed: null, persona_file_sha256: null,
      model_settings: {}, repeat_index: 0, simulator: "model", simulator_model: "gpt-5.6-terra", simulator_effort: null, simulator_max_tokens: null, tree_file_sha256: SHA, tree_source: "active",
    });
    const full = buildWholeCallBatchWrite({ batch: batchInput, items: [{ leadFacts: facts(0), run: { ...input, setup, repeatIndex: 2 } }] });
    expect(full.items[0]!.run).toMatchObject({
      orchestrator_id: "pipecat", voice_path_id: "azure_gpt_live", voice_module_id: "azure-gpt-live", dialogue_model: "gpt-live-1", prompt_setup_id: "setup:default",
      decision_router_id: "pipecat_classifier", decision_model: "gpt-5.6-terra", judge_enabled: true, judge_model: "gpt-5.6-judge", persona_file_sha256: SHA, seed: "seed-1", repeat_index: 2,
    });
    const db = new FakeSimDb();
    await writerOn(db).writeWholeCallBatch(full);
    expect([...db.runs.values()][0]!.row).toMatchObject({ model_settings: setup.modelSettings, repeat_index: 2 });
  });

  it("refuses each bad setup value before any SQL", async () => {
    const db = new FakeSimDb();
    const bad: Array<[Partial<SimRunRow>, string]> = [
      [{ orchestrator_id: "both" as never }, "sim_bad_orchestrator_id"],
      [{ decision_router_id: "router" as never }, "sim_bad_decision_router_id"],
      [{ voice_path_id: "has space" }, "sim_bad_voice_path_id"],
      [{ voice_module_id: "" }, "sim_bad_voice_module_id"],
      [{ dialogue_model: "a;b" }, "sim_bad_dialogue_model"],
      [{ prompt_setup_id: "x y" }, "sim_bad_prompt_setup_id"],
      [{ decision_model: "x y" }, "sim_bad_decision_model"],
      [{ judge_model: "x y" }, "sim_bad_judge_model"],
      [{ judge_enabled: "yes" as never }, "sim_bad_judge_enabled"],
      [{ persona_file_sha256: "abc" }, "sim_bad_persona_file_sha256"],
      [{ tree_file_sha256: "ABC" }, "sim_bad_tree_file_sha256"],
      [{ seed: "a b" }, "sim_bad_seed"],
      [{ repeat_index: -1 }, "sim_bad_repeat_index"],
      [{ simulator: "claude" as never }, "sim_bad_simulator"],
      [{ tree_source: "tree_file", tree_file_sha256: null }, "sim_bad_tree_file_sha256"],
      [{ model_settings: { extra: { deployment: "x" } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: { deployment: "x", stray: 1 } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: { temperature: "hot" } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: { deployment: 5 } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: { max_output_tokens: 1.5 } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: { seed: "x" } } as never }, "sim_bad_model_settings"],
      [{ model_settings: { agent: [{ deployment: "x" }] } as never }, "sim_bad_model_settings"],
      [{ model_settings: [] as never }, "sim_bad_model_settings"],
    ];
    for (const [over, code] of bad) {
      expect(await refusal(writerOn(db).upsertRun({ ...withSetup(over), batch_id: "x", lead_facts_id: "y" }) ), JSON.stringify(over)).toBe(code);
    }
    expect(db.statements).toEqual([]);
  });

  it("repeat 0 and repeat 1 of the same lead facts coexist, and a duplicate of either is an upsert", async () => {
    const db = new FakeSimDb();
    const writer = writerOn(db);
    const batchId = await writer.upsertBatch(batchWrite(1).batch);
    const factsId = await writer.upsertLeadFacts(facts(0));
    const a = await writer.upsertRun({ ...runRow(0), batch_id: batchId, lead_facts_id: factsId });
    const b = await writer.upsertRun({ ...runRow(0, { repeat_index: 1, record_id: "call_rep1" }), batch_id: batchId, lead_facts_id: factsId });
    const a2 = await writer.upsertRun({ ...runRow(0), batch_id: batchId, lead_facts_id: factsId });
    const b2 = await writer.upsertRun({ ...runRow(0, { repeat_index: 1, record_id: "call_rep1" }), batch_id: batchId, lead_facts_id: factsId });
    expect(a).not.toBe(b);
    expect([a2, b2]).toEqual([a, b]);
    expect(db.runs.size).toBe(2);
  });
});

describe("personas and the lead-record extractor", () => {
  const persona = (id = "roofer-one", over: Partial<Parameters<typeof leadFactsRow>[0]> = {}) =>
    leadFactsRow({ facts: { ...FACTS, sourceCallId: "anything" }, contentOrigin: "synthetic_fixture", personaOrigin: "synthetic_persona", personaId: id, extractor: factsFileExtractor(SHA), extractedAt: T0, ...over });

  it("defaults the persona origin from the content origin and builds the persona reference", () => {
    expect(facts(0)).toMatchObject({ persona_origin: "fixture", persona_id: null });
    expect(realFacts()).toMatchObject({ persona_origin: "real_call", persona_id: null });
    expect(persona()).toMatchObject({ persona_origin: "synthetic_persona", persona_id: "roofer-one", source_call_origin: "synthetic_fixture", source_call_table: "fixture", source_call_key: "fixture:persona-roofer-one", content_origin: "synthetic_fixture" });
    expect(personaSourceRef("a-1").source_call_key).toBe("fixture:persona-a-1");
    expect(() => personaSourceRef("Bad Id")).toThrow("sim_persona_ties");
    expect(() => leadFactsRow({ facts: FACTS, contentOrigin: "synthetic_fixture", personaOrigin: "synthetic_persona", extractor: factsFileExtractor(SHA), extractedAt: T0 })).toThrow("sim_persona_ties");
  });

  it("accepts a persona, and one persona has separate facts per extractor", async () => {
    const db = new FakeSimDb();
    const a = await writerOn(db).upsertLeadFacts(persona());
    const b = await writerOn(db).upsertLeadFacts(persona("roofer-one", { extractor: { id: "model-one", version: `${"a".repeat(40)}:m:low`, model: "m", effort: "low" } }));
    const again = await writerOn(db).upsertLeadFacts(persona());
    expect(a).not.toBe(b);
    expect(again).toBe(a);
  });

  it("refuses every broken tie, before any SQL", async () => {
    const db = new FakeSimDb();
    const w = writerOn(db);
    const base = persona();
    const cases: Array<[SimLeadFactsRow, string]> = [
      [{ ...base, persona_id: null }, "sim_persona_ties"],
      [{ ...base, persona_id: "roofer-two" }, "sim_persona_ties"],
      [{ ...base, source_call_key: "fixture:roofer-one" }, "sim_persona_ties"],
      [{ ...facts(0), persona_origin: "synthetic_persona", persona_id: "roofer-0" }, "sim_persona_ties"],
      [{ ...facts(0), source_call_key: "fixture:persona-x" }, "sim_persona_ties"],
      [{ ...facts(0), persona_id: "x" }, "sim_persona_ties"],
      [{ ...facts(0), persona_origin: "real_call" }, "sim_persona_ties"],
      [{ ...realFacts(), persona_origin: "fixture" }, "sim_persona_ties"],
      [{ ...realFacts(), persona_origin: "synthetic_persona", persona_id: "x" }, "sim_persona_ties"],
      [{ ...base, persona_id: "Roofer", source_call_key: "fixture:persona-Roofer" }, "sim_source_not_synthetic"],
      [{ ...facts(0), persona_origin: "invented" } as unknown as SimLeadFactsRow, "sim_persona_origin_unstated"],
    ];
    for (const [row, code] of cases) expect(await refusal(w.upsertLeadFacts(row)), JSON.stringify([row.persona_origin, row.persona_id, row.source_call_key])).toBe(code);
    expect(db.statements).toEqual([]);
  });

  it("accepts the lead-record extractor only with a key, no model, real-call content", async () => {
    const db = new FakeSimDb();
    const v = { harness_commit: "c".repeat(40), harness_dirty: true };
    const key = `dialer:source_secondary:${REAL_UUID}`;
    const ex = leadRecordExtractor(v, "lead-loader.v1", key);
    expect(ex).toMatchObject({ id: "lead-record", version: `${"c".repeat(40)}-dirty:lead-loader.v1`, model: null, effort: null });
    const row = realFacts({ extractor: ex, redactionMethod: "not_redacted" }, { trade: "roofing" });
    expect(row).toMatchObject({ source_lead_facts_key: key, trade_redacted: "roofing", extractor_model: null });
    await writerOn(db).upsertLeadFacts(row);
    const bads: Array<[Partial<SimLeadFactsRow>, string]> = [
      [{ source_lead_facts_key: null }, "sim_bad_extractor"],
      [{ source_lead_facts_key: "not a key" }, "sim_bad_extractor"],
      [{ source_lead_facts_key: "dialer:somewhere:abc" }, "sim_bad_extractor"],
      [{ extractor_model: "m" }, "sim_bad_extractor"],
      [{ extractor_effort: "low" }, "sim_bad_extractor"],
      [{ extractor_version: SHA }, "sim_bad_extractor"],
      [{ extractor_version: `${"c".repeat(40)}:has space` }, "sim_bad_extractor"],
    ];
    for (const [over, code] of bads) expect(await refusal(writerOn(db).upsertLeadFacts({ ...row, ...over } as SimLeadFactsRow)), JSON.stringify(over)).toBe(code);
    expect(await refusal(writerOn(db).upsertLeadFacts({ ...facts(0), source_lead_facts_key: key }))).toBe("sim_bad_extractor");
    const fixtureFromRecord = { ...facts(0), extractor_id: "lead-record", extractor_version: `${"c".repeat(40)}:loader`, source_lead_facts_key: key };
    expect(await refusal(writerOn(db).upsertLeadFacts(fixtureFromRecord))).toBe("sim_persona_ties");
  });

  it("includes the trade in the facts hash and the stored columns", () => {
    expect(factsSha256({ ...FACTS, trade: "roofing" })).not.toBe(factsSha256(FACTS));
    expect(facts(0)).toHaveProperty("trade_redacted", null);
  });
});

/* ------------------------------------------------- cancellation and counters */

describe("sticky cancellation, readBatchControl, requestCancel", () => {
  it("reads nothing for an unknown batch and validates the key before any SQL", async () => {
    const db = new FakeSimDb();
    expect(await writerOn(db).readBatchControl(BATCH_KEY)).toBeNull();
    expect(await writerOn(db).requestCancel(BATCH_KEY)).toBe(false);
    const before = db.statements.length;
    expect(await refusal(writerOn(db).readBatchControl("whole-call-x"))).toBe("sim_bad_batch_key");
    expect(await refusal(writerOn(db).requestCancel("x'; drop table y; --"))).toBe("sim_bad_batch_key");
    expect(db.statements.length).toBe(before);
  });

  it("sets cancel_requested only while running, and a later progress or final write keeps it set", async () => {
    const db = new FakeSimDb();
    const w = writerOn(db);
    await w.upsertBatch(batchWrite(1, 3, "running").batch);
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: false, status: "running" });
    expect(await w.requestCancel(BATCH_KEY)).toBe(true);
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "running" });
    // A progress write that says cancel_requested false does not clear it.
    await w.upsertBatch({ ...batchWrite(1, 3, "running").batch, cancel_requested: false } as SimBatchRow);
    expect((await w.readBatchControl(BATCH_KEY))!.cancelRequested).toBe(true);
    // Neither does the whole write that follows.
    await w.writeWholeCallBatch(batchWrite(2));
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "completed" });
    // Once finished, a cancel changes nothing.
    expect(await w.requestCancel(BATCH_KEY)).toBe(false);
    expect(db.statements.join("\n")).toMatch(/"cancel_requested" = voice_harness\.sim_batch\.cancel_requested or excluded\.cancel_requested/);
  });
});

describe("items_done counts completed plus blocked plus failed", () => {
  it("builds the batch counts from the runs", () => {
    const mk = (status: "completed" | "blocked" | "failed") => ({ leadFacts: facts(0), run: {} as never, status });
    void mk;
    const row = wholeCallBatchRow({ batchKey: BATCH_KEY, harness: HARNESS, startedAt: T0, finishedAt: T1, status: "completed", itemsRequested: 6, itemsFound: 6, itemsCompleted: 3, itemsBlocked: 2, itemsFailed: 1, config });
    expect(row).toMatchObject({ items_done: 6, items_blocked: 2, items_failed: 1 });
    const turn = turnBatch();
    expect(turn).toMatchObject({ items_done: 1, items_judged: 1 });
  });

  it("writes progress after every item and refuses a batch row whose counts disagree with its runs", async () => {
    const db = new FakeSimDb();
    const write = batchWrite(3);
    write.items[1]!.run = { ...write.items[1]!.run, status: "blocked", blocked_reason: "ai_calling_disabled", ended_by: null, lead_turns: 0, booked: null, renewal_date_confirmed: null, payroll_captured: null, employee_count_captured: null };
    const wrong = { ...write, batch: { ...write.batch, items_done: 3, items_blocked: 0 } as SimBatchRow };
    expect(await refusal(writerOn(db).writeWholeCallBatch(wrong))).toBe("sim_batch_counts_disagree_with_runs");
    expect(db.statements).toEqual([]);
    const right = { ...write, batch: { ...write.batch, items_done: 3, items_blocked: 1 } as SimBatchRow };
    await writerOn(db).writeWholeCallBatch(right);
    const batchWrites = db.statements.filter((s) => s.includes("insert into voice_harness.sim_batch")).map((s) => literalsOf(s)[0] as Record<string, unknown>);
    expect(batchWrites.map((b) => b.items_done)).toEqual([0, 1, 2, 3, 3]);
    expect(batchWrites.map((b) => b.status)).toEqual(["running", "running", "running", "running", "completed"]);
    expect(batchWrites.at(-1)).toMatchObject({ items_blocked: 1, items_failed: 0 });
  });

  it("marks a batch that fails part-way with the counts so far", async () => {
    const db = new FakeSimDb();
    let runInserts = 0;
    db.failWhen = (sql) => sql.includes("insert into voice_harness.sim_run") && ++runInserts === 3;
    await refusal(writerOn(db).writeWholeCallBatch(batchWrite(3)));
    expect(db.batches.get(BATCH_KEY)!.row).toMatchObject({ status: "failed", items_done: 2 });
  });
});

/* -------------------------------------------------------- SQL composition */

describe("what the SQL contains", () => {
  it("holds no row value outside a dollar-quoted literal", async () => {
    const db = new FakeSimDb();
    const nasty = "'; drop table voice_harness.sim_run; -- $$ $j0123456789ab$ \\u0000 \"";
    const write = batchWrite(1);
    write.items[0]!.leadFacts = leadFactsRow({
      facts: { ...FACTS, sourceCallId: "fixture:nasty", businessType: nasty, objections: [nasty] },
      contentOrigin: "synthetic_fixture",
      extractor: factsFileExtractor(SHA),
      extractedAt: T0,
    });
    write.items[0]!.turns = turnRows(2, nasty);
    await writerOn(db).writeWholeCallBatch(write);
    await writerOn(db).writeTurnEvalBatch({ batch: turnBatch(), evals: [evalRow(3)] });
    expect(db.statements.length).toBeGreaterThan(5);
    for (const sql of db.statements) {
      const outside = withoutLiterals(sql);
      expect(outside).not.toMatch(/drop table|roofing|Redwood|fixture:|call_abc|whole-call|made up/);
      expect(outside).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(outside).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      // Every name that is not a keyword comes from the fixed lists: identifiers are quoted or schema-qualified.
      expect(outside).not.toContain("$$");
      expect(outside).not.toMatch(/\$j[0-9a-f]{12}\$/);
    }
    // The nasty text arrived intact inside its literal, and each literal uses a tag that cannot occur in it.
    const facts0 = literalsOf(db.statements.find((s) => s.includes("insert into voice_harness.sim_lead_facts"))!)[0] as { business_type_redacted: string };
    expect(facts0.business_type_redacted).toBe(nasty);
    for (const sql of db.statements) for (const m of sql.matchAll(LITERAL)) expect(m[2]).not.toContain(`$${m[1]}$`);
  });

  it("uses a different random tag each time", async () => {
    const db = new FakeSimDb();
    await writerOn(db).upsertBatch(batchWrite(1).batch);
    await writerOn(db).upsertBatch(batchWrite(1).batch);
    const tags = db.statements.map((s) => /\$(j[0-9a-f]{12})\$/.exec(s)![1]);
    expect(new Set(tags).size).toBe(2);
  });
});

/* ------------------------------------------------------------ small helpers */

describe("facts hash and harness version", () => {
  it("hashes the canonical JSON of the stored fact columns, whatever the key order", () => {
    const a: LeadFacts = { sourceCallId: "x", businessType: "roofing", employeeCount: 3, objections: ["a", "b"] };
    const b: LeadFacts = { objections: ["a", "b"], employeeCount: 3, sourceCallId: "y", businessType: "roofing" };
    expect(factsSha256(a)).toBe(factsSha256(b));
    expect(factsSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(factsSha256({ ...a, objections: ["b", "a"] })).not.toBe(factsSha256(a));
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
  });

  it("reads the commit and the dirty flag from git", () => {
    const sha = "c".repeat(40);
    expect(harnessVersion((args) => (args[0] === "rev-parse" ? `${sha}\n` : ""))).toEqual({ harness_commit: sha, harness_dirty: false });
    expect(harnessVersion((args) => (args[0] === "rev-parse" ? sha : " M src/x.ts\n"))).toEqual({ harness_commit: sha, harness_dirty: true });
    expect(() => harnessVersion(() => { throw new Error("no git"); })).toThrow("sim_git_unavailable");
    expect(() => harnessVersion(() => "not a sha")).toThrow("sim_git_unavailable");
  });

  it("stores a facts file by the hash of the file, with no model", () => {
    const row = facts(0);
    expect(row).toMatchObject({ extractor_id: "facts-file", extractor_version: SHA, extractor_model: null, extractor_effort: null, source_call_origin: "synthetic_fixture", source_call_table: "fixture" });
    expect(row.facts_sha256).toBe(factsSha256({ ...FACTS, sourceCallId: "fixture:roofer-0" }));
  });
});

describe("a real-call row says which past call table and labelling it came from", () => {
  it("refuses a real-call fact row with no past call source or attribution, before any SQL", async () => {
    const db = new FakeSimDb();
    const bare = realFacts({ realSource: { origin: "source_secondary", rowId: null } });
    expect(bare).toMatchObject({ past_call_source: null, attribution: null });
    expect(await refusal(writerOn(db).upsertLeadFacts(bare))).toBe("sim_past_call_unknown");
    expect(await refusal(writerOn(db).upsertLeadFacts({ ...realFacts(), attribution: null }))).toBe("sim_past_call_unknown");
    expect(db.statements).toEqual([]);
    await writerOn(db).upsertLeadFacts(realFacts());
    expect(db.statements).toHaveLength(1);
  });

  it("checks that a call id has a shape the writer accepts, per content origin", () => {
    expect(() => assertCallIdWritable(REAL_UUID, "real_call")).not.toThrow();
    expect(() => assertCallIdWritable("quo:AC123abc", "real_call")).not.toThrow();
    expect(() => assertCallIdWritable("not a real id!", "real_call")).toThrow("sim_source_not_real_call");
    expect(() => assertCallIdWritable("fixture:roofer-one", "real_call")).toThrow("sim_source_not_real_call");
    expect(() => assertCallIdWritable("fixture:roofer-one", "synthetic_fixture")).not.toThrow();
    expect(() => assertCallIdWritable(REAL_UUID, "synthetic_fixture")).toThrow("sim_source_not_synthetic");
  });
});

const GIT = (args: string[]) => (args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "");
const STAMP = "2026-10-20T12-00-00-000Z";
const gitWriter = (db: FakeSimDb) => new SimWriter({ runner: db, git: GIT, now: () => T1 });

describe("the whole-call script's database step", () => {
  beforeEach(() => {
    recordStore.setDir(mkdtempSync(join(tmpdir(), "sim-writer-test-")));
    traceBus.reset();
    resetHarnessConfig();
    resetModuleRegistry();
    resetDecisionRegistry();
    resetJudges();
    process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE;
    resetActiveTree();
    resetLeadStore();
    clearCallLogs();
    setAiCallingEnabled("agency-demo", true);
    seedLead(baseLead());
  });

  async function gradedItem(callId: string, pastCall?: PastCall): Promise<GradedItem> {
    const facts: LeadFacts = { ...FACTS, sourceCallId: callId };
    const harness = new CallHarness({ now: () => new Date("2026-10-15T14:00:00.000Z") }, mockLeadStore, getModuleRegistry());
    const run = await runWholeCall({ lead: new ScriptedSimulatedLead(facts, { maxLeadTurns: 4 }), harness, leadId: "lead-1", direction: "inbound", maxTurns: 4 });
    const grade = await gradeWholeCall({ record: run.record, facts });
    return { facts, pastCall, leadId: "whole-call-lead-1", itemIndex: 0, run, grade };
  }
  const context = (graded: GradedItem[], over: Partial<WholeCallBatchContext> = {}): WholeCallBatchContext => ({
    graded, requested: graded.length, found: graded.length, stamp: STAMP, startedAt: T0, clockNow: T0, ...over,
  });
  const dialerCall = (callId: string, over: Partial<PastCall> = {}): PastCall => ({ callId, source: "dialer", attribution: "track", turns: [], ...over });

  it("a past call keeps its table and labelling: the written row is accepted and says diarized", async () => {
    const args = parseWholeCallArgs(["--write-db", "--lead", "scripted"]);
    const item = await gradedItem(REAL_UUID, dialerCall(REAL_UUID, { source: "diarized", attribution: "diarized" }));
    const write = buildWholeCallDatabaseWrite(args, context([item], { pastCallsText: "[]" }), { harness_commit: "a".repeat(40), harness_dirty: false });
    expect(write.items[0]!.leadFacts).toMatchObject({
      content_origin: "real_call", persona_origin: "real_call", source_call_table: "dialer", source_call_key: REAL_UUID,
      past_call_source: "diarized", attribution: "diarized", redaction_method: "not_redacted",
    });
    expect(write.items[0]!.run).toMatchObject({ content_origin: "real_call" });
    expect(write.items[0]!.turns.length).toBeGreaterThan(0);
    for (const t of write.items[0]!.turns) expect(t).toMatchObject({ content_origin: "real_call", redaction_method: t.text_redacted ? "not_redacted" : null });
    expect(write.batch.config).toMatchObject({ pastCallsFileSha256: expect.any(String) });
    const db = new FakeSimDb();
    const code = await writeWholeCallBatchToDatabase(args, context([item]), () => gitWriter(db));
    expect(code).toBe(0);
    expect(db.runs.size).toBe(1);
    expect([...db.batches.values()][0]!.row).toMatchObject({ kind: "whole_call", status: "completed", items_done: 1 });
  });

  it("a Quo past call keeps its row id and a facts file is recorded by the shape of the id, unverified", async () => {
    const quo = await gradedItem("quo:AC123abc", dialerCall("quo:AC123abc", { source: "quo", attribution: "unverified", sourceRowId: "44444444-4444-4444-8444-444444444444" }));
    const args = parseWholeCallArgs(["--write-db", "--lead", "scripted"]);
    const v = { harness_commit: "a".repeat(40), harness_dirty: false };
    expect(buildWholeCallDatabaseWrite(args, context([quo]), v).items[0]!.leadFacts).toMatchObject({
      source_call_table: "quo", source_call_key: "AC123abc", source_call_row_id: "44444444-4444-4444-8444-444444444444", past_call_source: "quo", attribution: "unverified",
    });
    const fileArgs = parseWholeCallArgs(["--write-db", "--lead", "scripted", "--facts-file", "f.json"]);
    expect(contentOriginOf(fileArgs)).toBe("real_call");
    const dialerFile = await gradedItem(REAL_UUID);
    const quoFile = await gradedItem("quo:AC999");
    const rows = buildWholeCallDatabaseWrite(fileArgs, context([dialerFile, quoFile], { factsText: "[]" }), v).items.map((i) => i.leadFacts);
    expect(rows[0]).toMatchObject({ extractor_id: "facts-file", source_call_table: "dialer", past_call_source: "dialer", attribution: "unverified", redaction_method: "not_redacted" });
    expect(rows[1]).toMatchObject({ source_call_table: "quo", past_call_source: "quo", attribution: "unverified" });
    // Every one of these rows passes the writer's checks.
    const db = new FakeSimDb();
    expect(await writeWholeCallBatchToDatabase(fileArgs, context([dialerFile, { ...quoFile, itemIndex: 1 }], { factsText: "[]" }), () => gitWriter(db))).toBe(0);
  });

  it("extracted facts are labelled not_redacted: the stored values are model output", async () => {
    const args = parseWholeCallArgs(["--write-db", "--lead", "scripted"]);
    const item = await gradedItem(REAL_UUID, dialerCall(REAL_UUID));
    const row = buildWholeCallDatabaseWrite(args, context([item]), { harness_commit: "a".repeat(40), harness_dirty: false }).items[0]!.leadFacts;
    expect(row.redaction_method).toBe("not_redacted");
    expect(row.extractor_id).toMatch(/^claude-fact-extractor:/);
  });

  it("a facts file stated as synthetic is written as made-up content with no real source", async () => {
    const args = parseWholeCallArgs(["--write-db", "--lead", "scripted", "--facts-file", "f.json", "--facts-origin", "synthetic_fixture"]);
    expect(contentOriginOf(args)).toBe("synthetic_fixture");
    const item = await gradedItem("fixture:roofer-one");
    const write = buildWholeCallDatabaseWrite(args, context([item], { factsText: "[]" }), { harness_commit: "a".repeat(40), harness_dirty: false });
    expect(write.items[0]!.leadFacts).toMatchObject({ content_origin: "synthetic_fixture", persona_origin: "fixture", source_call_table: "fixture", past_call_source: null, redaction_method: null });
    for (const t of write.items[0]!.turns) expect(t.content_origin).toBe("synthetic_fixture");
    const db = new FakeSimDb();
    expect(await writeWholeCallBatchToDatabase(args, context([item], { factsText: "[]" }), () => gitWriter(db))).toBe(0);
  });

  it("without --write-db no writer is ever constructed, and a refused write exits 3", async () => {
    const item = await gradedItem(REAL_UUID, dialerCall(REAL_UUID));
    let made = 0;
    const make = () => {
      made += 1;
      return gitWriter(new FakeSimDb());
    };
    expect(await writeWholeCallBatchToDatabase(parseWholeCallArgs(["--lead", "scripted"]), context([item]), make)).toBe(0);
    expect(made).toBe(0);
    const failing = new FakeSimDb();
    failing.failWhen = () => true;
    expect(await writeWholeCallBatchToDatabase(parseWholeCallArgs(["--write-db", "--lead", "scripted"]), context([item]), () => gitWriter(failing))).toBe(3);
  });
});

describe("a cancelled batch can be finished with the builders", () => {
  const finalRow = (status: "cancelled" | "completed") =>
    wholeCallBatchRow({ batchKey: BATCH_KEY, harness: HARNESS, startedAt: T0, finishedAt: T1, status, itemsRequested: 3, itemsFound: 3, itemsCompleted: 1, itemsBlocked: 0, itemsFailed: 0, config });

  it("the builder sets cancel_requested for a cancelled row, and only then", () => {
    expect(finalRow("cancelled").cancel_requested).toBe(true);
    expect(finalRow("completed").cancel_requested).toBe(false);
  });

  it("a runner that honours a cancel request writes the final cancelled row", async () => {
    const db = new FakeSimDb();
    const w = writerOn(db);
    await w.upsertBatch(batchWrite(1, 3, "running").batch);
    expect(await w.requestCancel(BATCH_KEY)).toBe(true);
    await w.upsertBatch(finalRow("cancelled"));
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "cancelled" });
    // A hand-built cancelled row that forgot the flag is corrected by the writer, not refused by the database.
    const other = new FakeSimDb();
    await writerOn(other).upsertBatch({ ...finalRow("cancelled"), cancel_requested: false });
    expect(await writerOn(other).readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "cancelled" });
  });
});

/* --------------------------------------------- the real writer SQL on a real database */

// With VOICE_HARNESS_TEST_THROWAWAY_PORT naming an empty throwaway Postgres on this machine's loopback address that already holds
// 002, 003 and 004 (the migration test applies them), the writer's own SQL runs through psql, exactly as it does against the harness project.
const throwawayPort = process.env.VOICE_HARNESS_TEST_THROWAWAY_PORT;
describe.skipIf(!throwawayPort)("writer: the real SQL on a throwaway database", () => {
  const real = () =>
    new SimWriter({
      git: () => "a".repeat(40) + "\n",
      runner: createPsqlRunner({
        libpqEnv: { PGHOST: "127.0.0.1", PGPORT: String(throwawayPort), PGUSER: "postgres", PGDATABASE: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "10" },
      }),
    });
  const count = async (table: string) => {
    const runner = createPsqlRunner({
      libpqEnv: { PGHOST: "127.0.0.1", PGPORT: String(throwawayPort), PGUSER: "postgres", PGDATABASE: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "10" },
    });
    return Number(await runner.json(`select count(*) from voice_harness.${table};`));
  };

  it("writes, repeats (no doubles), resumes, replaces turns, and cleans up", async () => {
    const first = await real().writeWholeCallBatch(batchWrite(2, 3));
    const again = await real().writeWholeCallBatch(batchWrite(2, 5));
    expect(again.batchId).toBe(first.batchId);
    expect(again.runIds).toEqual(first.runIds);
    expect(again.leadFactsIds).toEqual(first.leadFactsIds);
    expect(await count("sim_batch")).toBeGreaterThanOrEqual(1);
    expect(await count("sim_run")).toBe(2);
    expect(await count("sim_turn")).toBe(10);
    const turnBatchWrite = { batch: turnBatch(), evals: [evalRow(3), evalRow(5)] };
    expect((await real().writeTurnEvalBatch(turnBatchWrite)).inserted).toBe(2);
    expect((await real().writeTurnEvalBatch(turnBatchWrite)).inserted).toBe(0);
    expect(await count("sim_turn_eval")).toBe(2);
    // Synthetic rows only; remove them (the cascade takes runs, turns and evaluations).
    const runner = createPsqlRunner({
      libpqEnv: { PGHOST: "127.0.0.1", PGPORT: String(throwawayPort), PGUSER: "postgres", PGDATABASE: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "10" },
    });
    await runner.json(`with d as (delete from voice_harness.sim_batch returning 1) select count(*) from d;`);
    await runner.json(`with d as (delete from voice_harness.sim_lead_facts returning 1) select count(*) from d;`);
    for (const table of ["sim_batch", "sim_run", "sim_turn", "sim_turn_eval", "sim_lead_facts"]) expect(await count(table), table).toBe(0);
  });

  it("real engine: repeats, personas, real-call rows with and without text, sticky cancellation, counters", async () => {
    const runner = createPsqlRunner({
      libpqEnv: { PGHOST: "127.0.0.1", PGPORT: String(throwawayPort), PGUSER: "postgres", PGDATABASE: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "10" },
    });
    const w = real();
    const v = { harness_commit: "a".repeat(40), harness_dirty: false };
    void v;
    // A persona with separate facts per extractor, and a repeat of the same persona in the same batch.
    const personaFacts = leadFactsRow({ facts: { ...FACTS, sourceCallId: "x" }, contentOrigin: "synthetic_fixture", personaOrigin: "synthetic_persona", personaId: "roofer-one", extractor: factsFileExtractor(SHA), extractedAt: T0 });
    const personaByModel = leadFactsRow({ facts: { ...FACTS, sourceCallId: "x" }, contentOrigin: "synthetic_fixture", personaOrigin: "synthetic_persona", personaId: "roofer-one", extractor: { id: "model-one", version: `${"a".repeat(40)}:m:low`, model: "m", effort: "low" }, extractedAt: T0 });
    const batchId = await w.upsertBatch(batchWrite(2, 1, "running").batch);
    const f1 = await w.upsertLeadFacts(personaFacts);
    const f2 = await w.upsertLeadFacts(personaByModel);
    expect(f1).not.toBe(f2);
    const full = { ...runRow(0), orchestrator_id: "pipecat" as const, decision_router_id: "pipecat_classifier" as const, dialogue_model: "gpt-live-1", judge_enabled: true, seed: "s1",
      model_settings: { agent: { deployment: "gpt-live-1", temperature: 0.5, max_output_tokens: null, seed: 3 } }, persona_file_sha256: SHA };
    const r0 = await w.upsertRun({ ...full, batch_id: batchId, lead_facts_id: f1 });
    const r1 = await w.upsertRun({ ...full, repeat_index: 1, record_id: "call_rep1", trace_ref: "call_rep1.jsonl", batch_id: batchId, lead_facts_id: f1 });
    expect(r1).not.toBe(r0);
    expect(await w.upsertRun({ ...full, batch_id: batchId, lead_facts_id: f1 })).toBe(r0);
    expect(await w.upsertRun({ ...full, repeat_index: 1, record_id: "call_rep1", trace_ref: "call_rep1.jsonl", batch_id: batchId, lead_facts_id: f1 })).toBe(r1);
    expect(Number(await runner.json(`select count(*) from voice_harness.sim_run where batch_id = '${batchId}';`))).toBe(2);
    expect(await runner.json(`select json_build_object('x', (select model_settings->'agent'->>'seed' from voice_harness.sim_run where id = '${r1}'));`)).toEqual({ x: "3" });
    // The database refuses what the writer would, if the writer is bypassed.
    expect(await refusal(w.upsertRun({ ...full, record_id: "call_bad1", trace_ref: "call_bad1.jsonl", repeat_index: -1, batch_id: batchId, lead_facts_id: f1 }))).toBe("sim_bad_repeat_index");

    // Real-call rows: text with not_redacted, then none.
    const withText = realFacts({ redactionMethod: "not_redacted" }, { trade: "roofing" });
    const noText = realFacts({}, { sourceCallId: "22222222-2222-4222-8222-222222222222", businessType: undefined, renewalDate: undefined, annualPayroll: undefined, currentCarrier: undefined, objections: [], language: undefined });
    const rf1 = await w.upsertLeadFacts(withText);
    const rf2 = await w.upsertLeadFacts(noText);
    const rr1 = await w.upsertRun({ ...realRunRow(0, { record_id: "call_real1", trace_ref: "call_real1.jsonl", attempt: 3 }), batch_id: batchId, lead_facts_id: rf1 });
    await w.replaceTurns(rr1, [{ ...turnRows(1)[0]!, content_origin: "real_call", redaction_method: "not_redacted" } as Omit<SimTurnRow, "run_id">]);
    const rr2 = await w.upsertRun({ ...realRunRow(1, { record_id: "call_real2", trace_ref: "call_real2.jsonl", attempt: 4 }), batch_id: batchId, lead_facts_id: rf2 });
    await w.replaceTurns(rr2, [{ ...turnRows(1)[0]!, content_origin: "real_call", text_redacted: null, redaction_method: null }]);
    expect(Number(await runner.json(`select count(*) from voice_harness.sim_turn where content_origin = 'real_call';`))).toBe(2);
    // Bypassing the writer: the database itself refuses real-call text with no method.
    await expect(runner.json(`insert into voice_harness.sim_turn (run_id, content_origin, line_index, turn_index, role, spoken, said_at, text_redacted) values ('${rr1}', 'real_call', 9, 0, 'caller', true, now(), 'words') returning 1;`)).rejects.toBeDefined();

    // Real-call turn judgements with and without replies.
    const evBatch = turnBatch();
    const evals = [realEval(evalRow(3)), { ...realEval(evalRow(4)), agent_reply_redacted: "hi", producer_reply_redacted: "hello", redaction_method: "harness_redact_text_v1" as const }];
    expect((await w.writeTurnEvalBatch({ batch: evBatch, evals })).inserted).toBe(2);

    // Sticky cancellation and the counters.
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: false, status: "running" });
    expect(await w.requestCancel(BATCH_KEY)).toBe(true);
    await w.upsertBatch({ ...batchWrite(2, 1, "running").batch, cancel_requested: false } as SimBatchRow);
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "running" });
    const last = batchWrite(2, 2);
    last.items.forEach((item, i) => Object.assign(item.run, { record_id: `call_last${i}`, trace_ref: `call_last${i}.jsonl` }));
    const finished = await w.writeWholeCallBatch(last);
    expect(finished.batchId).toBe(batchId);
    expect(await w.readBatchControl(BATCH_KEY)).toMatchObject({ cancelRequested: true, status: "completed" });
    expect(await w.requestCancel(BATCH_KEY)).toBe(false);
    expect(await w.readBatchControl("whole-call-2020-01-01T00-00-00-000Z")).toBeNull();
    expect(await runner.json(`select json_build_object('d', items_done, 'b', items_blocked, 'f', items_failed) from voice_harness.sim_batch where id = '${batchId}';`)).toEqual({ d: 2, b: 0, f: 0 });

    await runner.json(`with d as (delete from voice_harness.sim_batch returning 1) select count(*) from d;`);
    await runner.json(`with d as (delete from voice_harness.sim_lead_facts returning 1) select count(*) from d;`);
    for (const table of ["sim_batch", "sim_run", "sim_turn", "sim_turn_eval", "sim_lead_facts"]) expect(await count(table), table).toBe(0);
  });

  it("real engine: the whole-call script's real-call item is accepted, and a cancelled batch can be finished", async () => {
    const runner = createPsqlRunner({
      libpqEnv: { PGHOST: "127.0.0.1", PGPORT: String(throwawayPort), PGUSER: "postgres", PGDATABASE: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "10" },
    });
    // The script's own row builder, on a real run of the harness, written through the script's own database step.
    recordStore.setDir(mkdtempSync(join(tmpdir(), "sim-writer-test-")));
    traceBus.reset();
    resetHarnessConfig();
    resetModuleRegistry();
    resetDecisionRegistry();
    resetJudges();
    process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE;
    resetActiveTree();
    resetLeadStore();
    clearCallLogs();
    setAiCallingEnabled("agency-demo", true);
    seedLead(baseLead());
    const harness = new CallHarness({ now: () => new Date("2026-10-15T14:00:00.000Z") }, mockLeadStore, getModuleRegistry());
    const pastCalls: PastCall[] = [
      { callId: REAL_UUID, source: "diarized", attribution: "diarized", turns: [] },
      { callId: "quo:AC123abc", source: "quo", attribution: "unverified", sourceRowId: "44444444-4444-4444-8444-444444444444", turns: [] },
    ];
    const graded: GradedItem[] = [];
    for (const [index, pastCall] of pastCalls.entries()) {
      const facts: LeadFacts = { ...FACTS, sourceCallId: pastCall.callId };
      const run = await runWholeCall({ lead: new ScriptedSimulatedLead(facts, { maxLeadTurns: 4 }), harness, leadId: "lead-1", direction: "inbound", maxTurns: 4 });
      const grade = await gradeWholeCall({ record: run.record, facts });
      graded.push({ facts, pastCall, leadId: `whole-call-lead-${index + 1}`, itemIndex: index, run, grade });
      seedLead(baseLead());
    }
    const args = parseWholeCallArgs(["--write-db", "--lead", "scripted", "--max-turns", "4"]);
    const ctx: WholeCallBatchContext = { graded, requested: 2, found: 2, stamp: "2026-10-21T09-00-00-000Z", startedAt: T0, clockNow: T0 };
    expect(await writeWholeCallBatchToDatabase(args, ctx, real)).toBe(0);
    expect(await runner.json(`select json_build_object('n', count(*), 'src', string_agg(past_call_source || '/' || attribution, ',' order by past_call_source)) from voice_harness.sim_lead_facts;`)).toEqual({ n: 2, src: "diarized/diarized,quo/unverified" });
    expect(await runner.json(`select json_build_object('s', status, 'd', items_done) from voice_harness.sim_batch where batch_key = 'whole-call-2026-10-21T09-00-00-000Z';`)).toEqual({ s: "completed", d: 2 });

    // A cancel request, then the final row built by the builders with status cancelled.
    const w = real();
    const key = "whole-call-2026-10-21T10-00-00-000Z";
    const running = wholeCallBatchRow({ batchKey: key, harness: HARNESS, startedAt: T0, finishedAt: null, status: "running", itemsRequested: 3, itemsFound: 3, itemsCompleted: 1, itemsBlocked: 0, itemsFailed: 0, config });
    await w.upsertBatch(running);
    expect(await w.requestCancel(key)).toBe(true);
    await w.upsertBatch(wholeCallBatchRow({ batchKey: key, harness: HARNESS, startedAt: T0, finishedAt: T1, status: "cancelled", itemsRequested: 3, itemsFound: 3, itemsCompleted: 1, itemsBlocked: 0, itemsFailed: 0, config }));
    expect(await w.readBatchControl(key)).toMatchObject({ cancelRequested: true, status: "cancelled" });
    // Even a cancelled row with the flag left false is accepted.
    const key2 = "whole-call-2026-10-21T11-00-00-000Z";
    await w.upsertBatch({ ...running, batch_key: key2, status: "cancelled", finished_at: T1.toISOString(), cancel_requested: false } as SimBatchRow);
    expect(await w.readBatchControl(key2)).toMatchObject({ cancelRequested: true, status: "cancelled" });
    // Bypassing the writer: the database itself refuses the row without the flag.
    await expect(runner.json(`insert into voice_harness.sim_batch (batch_key, kind, status, cancel_requested) values ('whole-call-2026-10-21T12-00-00-000Z', 'whole_call', 'cancelled', false) returning 1;`)).rejects.toBeDefined();
    // Bypassing the writer: the database refuses a real-call fact row with no past call source.
    await expect(runner.json(`insert into voice_harness.sim_lead_facts (source_call_origin, source_call_table, source_call_key, persona_origin, extractor_id, extractor_version, facts_sha256, content_origin, objections_redacted, extracted_at) values ('source_secondary', 'dialer', '${REAL_UUID}', 'real_call', 'x', 'y', '${SHA}', 'real_call', '[]', now()) returning 1;`)).rejects.toBeDefined();

    await runner.json(`with d as (delete from voice_harness.sim_batch returning 1) select count(*) from d;`);
    await runner.json(`with d as (delete from voice_harness.sim_lead_facts returning 1) select count(*) from d;`);
    for (const table of ["sim_batch", "sim_run", "sim_turn", "sim_turn_eval", "sim_lead_facts"]) expect(await count(table), table).toBe(0);
  });
});
