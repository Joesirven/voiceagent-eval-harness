/**
 * Writes simulation rows into the harness database (voice_harness.sim_*).
 *
 * Rows reach psql the way src/setups/run-sink.ts sends them: one dollar-quoted
 * JSON literal with a random tag, read back with jsonb_populate_record(set).
 * Every value travels inside that literal; the SQL text around it holds only
 * table names and column names taken from the allow-lists in sim-rows.ts, so a
 * row key or value can never become SQL.
 *
 * Idempotent by design:
 * - sim_lead_facts: insert, on conflict do nothing, read the id back;
 * - sim_batch: upsert by batch_key; cancel_requested is sticky (never cleared by an upsert);
 * - sim_run: upsert keyed (batch_id, lead_facts_id, repeat_index, attempt), so a repeat run is idempotent;
 * - sim_turn: the run's lines are replaced in one transaction (delete, insert);
 * - sim_turn_eval: insert, on conflict do nothing on its unique key.
 *
 * The content rule and the shape checks (sim-rows.ts) run on every row before any
 * SQL is sent, so a refused write never even opens a database connection.
 *
 * PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
 * The writer does not refuse a real-call row for carrying text; it refuses only a real-call
 * row whose text has no known redaction_method ("not_redacted" is a known one).
 *
 * Counters: items_done is completed plus blocked plus failed items. writeWholeCallBatch
 * checks the batch row's counts against the runs it writes and writes a progress row (status
 * running) after every item.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPsqlRunner, loadLocalPostgres, type SqlRunner } from "../../setups/local-postgres.js";
import {
  BATCH_COLUMNS,
  BATCH_KEY,
  LEAD_FACTS_COLUMNS,
  RUN_COLUMNS,
  TURN_COLUMNS,
  TURN_EVAL_COLUMNS,
  SimWriteError,
  harnessVersion,
  validateBatchRow,
  validateLeadFactsRow,
  validateRunRow,
  validateTurnEvalRow,
  validateTurnRow,
  type GitRunner,
  type SimBatchRow,
  type SimLeadFactsRow,
  type SimRunRow,
  type SimTurnEvalRow,
  type SimTurnRow,
} from "./sim-rows.js";

export { SimWriteError } from "./sim-rows.js";

const SCHEMA = "voice_harness";
const T_FACTS = `${SCHEMA}.sim_lead_facts`;
const T_BATCH = `${SCHEMA}.sim_batch`;
const T_RUN = `${SCHEMA}.sim_run`;
const T_TURN = `${SCHEMA}.sim_turn`;
const T_EVAL = `${SCHEMA}.sim_turn_eval`;

/** Wraps JSON text in a dollar-quoted literal whose tag cannot occur inside it. */
function jsonLiteral(value: unknown): string {
  const text = JSON.stringify(value);
  let tag: string;
  do tag = `j${randomBytes(6).toString("hex")}`;
  while (text.includes(`$${tag}$`));
  return `$${tag}$${text}$${tag}$::jsonb`;
}

/** The columns present in any of the rows, in the allow-list's order. Unknown keys were refused earlier. */
function columnsOf(rows: ReadonlyArray<object>, allowed: readonly string[]): string[] {
  const present = new Set<string>();
  for (const row of rows) for (const [k, v] of Object.entries(row)) if (v !== undefined) present.add(k);
  return allowed.filter((c) => present.has(c));
}

/** Drops undefined values so the literal holds only what is set. */
function plain<T extends object>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

const quoted = (cols: readonly string[]) => cols.map((c) => `"${c}"`).join(", ");

export interface SimWriterDeps {
  /** Default: loadLocalPostgres() and createPsqlRunner(). Created on first use. */
  runner?: SqlRunner;
  /** Runs git in the repository. Default: execFileSync("git"). */
  git?: GitRunner;
  now?: () => Date;
}

export interface WholeCallItemWrite {
  leadFacts: SimLeadFactsRow;
  run: Omit<SimRunRow, "batch_id" | "lead_facts_id">;
  turns: Array<Omit<SimTurnRow, "run_id">>;
}

export interface WholeCallBatchWrite {
  batch: SimBatchRow;
  items: WholeCallItemWrite[];
}

export interface WholeCallBatchResult {
  batchId: string;
  runIds: string[];
  leadFactsIds: string[];
  turnsWritten: number;
}

export interface TurnEvalBatchWrite {
  batch: SimBatchRow;
  evals: Array<Omit<SimTurnEvalRow, "batch_id">>;
}

/** What a runner needs to decide whether to go on. */
export interface BatchControl {
  id: string;
  cancelRequested: boolean;
  status: string;
}

export interface TurnEvalBatchResult {
  batchId: string;
  inserted: number;
}

function defaultGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export class SimWriter {
  private runner: SqlRunner | undefined;
  private readonly git: GitRunner;
  private readonly now: () => Date;

  constructor(deps: SimWriterDeps = {}) {
    this.runner = deps.runner;
    this.git = deps.git ?? defaultGit;
    this.now = deps.now ?? (() => new Date());
  }

  /** The commit and cleanliness to put on a batch row. */
  harnessVersion() {
    return harnessVersion(this.git);
  }

  private async send(sql: string): Promise<Record<string, unknown>> {
    let answer: unknown;
    try {
      this.runner ??= createPsqlRunner(loadLocalPostgres());
      answer = await this.runner.json(sql);
    } catch (err) {
      // Only a fixed code leaves the writer: error text can quote SQL and so row data.
      const code = err instanceof Error && /^[a-z][a-z0-9_:]{0,79}$/.test(err.message) ? err.message : "sim_write_failed";
      throw new SimWriteError(code);
    }
    if (!answer || typeof answer !== "object") throw new SimWriteError("sim_write_unreadable_answer");
    return answer as Record<string, unknown>;
  }

  private async idFrom(sql: string): Promise<string> {
    const id = (await this.send(sql)).id;
    if (typeof id !== "string") throw new SimWriteError("sim_write_no_id");
    return id;
  }

  /** Inserts the facts unless the same extraction exists; returns the id either way. Fact columns are never updated. */
  async upsertLeadFacts(row: SimLeadFactsRow): Promise<string> {
    validateLeadFactsRow(row);
    const cols = quoted(columnsOf([row], LEAD_FACTS_COLUMNS));
    return this.idFrom(
      `with input as (select ${jsonLiteral(plain(row))} as j), ` +
        `ins as (insert into ${T_FACTS} (${cols}) select ${cols} from jsonb_populate_record(null::${T_FACTS}, (select j from input)) ` +
        `on conflict on constraint sim_lead_facts_one_per_extraction do nothing returning id) ` +
        `select json_build_object('id', coalesce((select id from ins), (select f.id from ${T_FACTS} f, input i ` +
        `where f.source_call_origin = i.j->>'source_call_origin' and f.source_call_table = i.j->>'source_call_table' ` +
        `and f.source_call_key = i.j->>'source_call_key' and f.extractor_id = i.j->>'extractor_id' ` +
        `and f.extractor_version = i.j->>'extractor_version' and f.facts_sha256 = i.j->>'facts_sha256')));`,
    );
  }

  /** Inserts the batch, or updates the one with the same batch_key (resuming). Kind, start time and commit stay as first written. */
  async upsertBatch(given: SimBatchRow): Promise<string> {
    // A cancelled batch was requested to stop by definition; the database refuses the row otherwise.
    const row: SimBatchRow = given.status === "cancelled" ? ({ ...given, cancel_requested: true } as SimBatchRow) : given;
    validateBatchRow(row);
    const all = columnsOf([row], BATCH_COLUMNS);
    const keep = new Set(["batch_key", "kind", "started_at", "harness_commit", "harness_dirty"]);
    // Cancellation is sticky: a later upsert (progress, the final row) can set cancel_requested but never clear it.
    const sets = all
      .filter((c) => !keep.has(c))
      .map((c) => (c === "cancel_requested" ? `"cancel_requested" = ${T_BATCH}.cancel_requested or excluded.cancel_requested` : `"${c}" = excluded."${c}"`))
      .join(", ");
    return this.idFrom(
      `with input as (select ${jsonLiteral(plain(row))} as j), ` +
        `up as (insert into ${T_BATCH} (${quoted(all)}) select ${quoted(all)} from jsonb_populate_record(null::${T_BATCH}, (select j from input)) ` +
        `on conflict (batch_key) do update set ${sets} returning id) select json_build_object('id', (select id from up));`,
    );
  }

  /** Reads the cancel flag and status of a batch by its key; null when there is no such batch. */
  async readBatchControl(batchKey: string): Promise<BatchControl | null> {
    if (typeof batchKey !== "string" || !BATCH_KEY.test(batchKey)) throw new SimWriteError("sim_bad_batch_key");
    const answer = await this.send(
      `with input as (select ${jsonLiteral({ batch_key: batchKey })} as j) ` +
        `select json_build_object('found', b.id is not null, 'id', b.id, 'cancelRequested', b.cancel_requested, 'status', b.status) ` +
        `from input i left join ${T_BATCH} b on b.batch_key = i.j->>'batch_key';`,
    );
    if (answer.found !== true) return null;
    if (typeof answer.id !== "string" || typeof answer.cancelRequested !== "boolean" || typeof answer.status !== "string") throw new SimWriteError("sim_write_unreadable_answer");
    return { id: answer.id, cancelRequested: answer.cancelRequested, status: answer.status };
  }

  /** Asks a running batch to stop. Returns whether a row changed: false when the batch is missing or no longer running. */
  async requestCancel(batchKey: string): Promise<boolean> {
    if (typeof batchKey !== "string" || !BATCH_KEY.test(batchKey)) throw new SimWriteError("sim_bad_batch_key");
    const answer = await this.send(
      `with input as (select ${jsonLiteral({ batch_key: batchKey, at: this.now().toISOString() })} as j), ` +
        `up as (update ${T_BATCH} set cancel_requested = true, updated_at = (select (j->>'at')::timestamptz from input) ` +
        `where batch_key = (select j->>'batch_key' from input) and status = 'running' returning id) ` +
        `select json_build_object('changed', (select count(*) from up));`,
    );
    return Number(answer.changed) > 0;
  }

  /** Inserts the run, or updates the one with the same (batch, lead facts, repeat index, attempt). */
  async upsertRun(row: SimRunRow): Promise<string> {
    validateRunRow(row);
    const all = columnsOf([row], RUN_COLUMNS);
    const keys = new Set(["batch_id", "lead_facts_id", "repeat_index", "attempt"]);
    const sets = all.filter((c) => !keys.has(c)).map((c) => `"${c}" = excluded."${c}"`).join(", ");
    return this.idFrom(
      `with input as (select ${jsonLiteral(plain(row))} as j), ` +
        `up as (insert into ${T_RUN} (${quoted(all)}) select ${quoted(all)} from jsonb_populate_record(null::${T_RUN}, (select j from input)) ` +
        `on conflict (batch_id, lead_facts_id, repeat_index, attempt) do update set ${sets} returning id) select json_build_object('id', (select id from up));`,
    );
  }

  /** Replaces all lines of a run in one transaction. Returns how many lines the run has afterwards. */
  async replaceTurns(runId: string, turns: Array<Omit<SimTurnRow, "run_id">>): Promise<number> {
    const rows = turns.map((t) => {
      validateTurnRow(t);
      return plain({ ...t, run_id: runId });
    });
    const cols = quoted(columnsOf(rows.length > 0 ? rows : [{ run_id: runId }], TURN_COLUMNS));
    const idOnly = `with input as (select ${jsonLiteral({ run_id: runId })} as j) `;
    const where = `run_id = (select (j->>'run_id')::uuid from input)`;
    // One script, one transaction: psql stops at the first error and the open transaction is rolled back.
    const answer = await this.send(
      `begin; ` +
        `${idOnly}delete from ${T_TURN} where ${where}; ` +
        `with input as (select ${jsonLiteral(rows)} as j) insert into ${T_TURN} (${cols}) select ${cols} from jsonb_populate_recordset(null::${T_TURN}, (select j from input)); ` +
        `${idOnly}select json_build_object('count', (select count(*) from ${T_TURN} where ${where})); ` +
        `commit;`,
    );
    return Number(answer.count);
  }

  /** Inserts judgements; one that exists already (same batch, call and turn) is left alone. Returns how many were new. */
  async insertTurnEvals(batchId: string, evals: Array<Omit<SimTurnEvalRow, "batch_id">>): Promise<number> {
    if (evals.length === 0) return 0;
    const rows = evals.map((e) => {
      validateTurnEvalRow(e);
      return plain({ ...e, batch_id: batchId });
    });
    const cols = quoted(columnsOf(rows, TURN_EVAL_COLUMNS));
    const answer = await this.send(
      `with input as (select ${jsonLiteral(rows)} as j), ` +
        `ins as (insert into ${T_EVAL} (${cols}) select ${cols} from jsonb_populate_recordset(null::${T_EVAL}, (select j from input)) ` +
        `on conflict on constraint sim_turn_eval_one_per_turn do nothing returning id) select json_build_object('inserted', (select count(*) from ins));`,
    );
    return Number(answer.inserted);
  }

  /**
   * Writes a whole-call batch. Every row is checked first, so a refused batch
   * sends no SQL at all. The batch is written as running, the items follow, and
   * the final batch row last; a failure part-way marks the batch failed.
   */
  async writeWholeCallBatch(write: WholeCallBatchWrite): Promise<WholeCallBatchResult> {
    if (write.batch.kind !== "whole_call") throw new SimWriteError("sim_bad_batch_kind");
    validateBatchRow(write.batch);
    for (const item of write.items) {
      validateLeadFactsRow(item.leadFacts);
      validateRunRow(item.run);
      if (item.run.content_origin !== item.leadFacts.content_origin) throw new SimWriteError("sim_content_origin_mismatch");
      for (const turn of item.turns) validateTurnRow(turn);
    }
    // items_done counts completed plus blocked plus failed runs; the batch row must agree with the runs it comes with.
    const tally = { completed: 0, blocked: 0, failed: 0 };
    const counts = { completed: 0, blocked: 0, failed: 0 };
    for (const item of write.items) tally[item.run.status] += 1;
    if (
      write.batch.items_done !== tally.completed + tally.blocked + tally.failed ||
      write.batch.items_blocked !== tally.blocked ||
      write.batch.items_failed !== tally.failed
    ) {
      throw new SimWriteError("sim_batch_counts_disagree_with_runs");
    }
    const progress = (): SimBatchRow =>
      ({
        ...write.batch,
        status: "running",
        finished_at: null,
        items_done: counts.completed + counts.blocked + counts.failed,
        items_blocked: counts.blocked,
        items_failed: counts.failed,
        updated_at: this.now().toISOString(),
      }) as SimBatchRow;
    const batchId = await this.upsertBatch(progress());
    const result: WholeCallBatchResult = { batchId, runIds: [], leadFactsIds: [], turnsWritten: 0 };
    try {
      for (const item of write.items) {
        const leadFactsId = await this.upsertLeadFacts(item.leadFacts);
        const runId = await this.upsertRun({ ...item.run, batch_id: batchId, lead_facts_id: leadFactsId });
        result.turnsWritten += await this.replaceTurns(runId, item.turns);
        result.leadFactsIds.push(leadFactsId);
        result.runIds.push(runId);
        counts[item.run.status] += 1;
        await this.upsertBatch(progress());
      }
    } catch (err) {
      const { items_done, items_blocked, items_failed } = progress();
      await this.markFailed({ ...write.batch, items_done, items_blocked, items_failed } as SimBatchRow);
      throw err;
    }
    if (write.batch.status !== "running") await this.upsertBatch(write.batch);
    return result;
  }

  /** Writes a turn-level batch; same order and refusal rules as writeWholeCallBatch. */
  async writeTurnEvalBatch(write: TurnEvalBatchWrite): Promise<TurnEvalBatchResult> {
    if (write.batch.kind !== "turn_eval") throw new SimWriteError("sim_bad_batch_kind");
    validateBatchRow(write.batch);
    for (const e of write.evals) validateTurnEvalRow(e);
    // A turn-judging item is a call: items_done is the judged calls plus the blocked plus the failed.
    if (write.batch.items_done !== (write.batch.items_judged ?? 0) + write.batch.items_blocked + write.batch.items_failed) {
      throw new SimWriteError("sim_batch_counts_disagree_with_runs");
    }
    const running: SimBatchRow = { ...write.batch, status: "running", finished_at: null } as SimBatchRow;
    const batchId = await this.upsertBatch(running);
    let inserted: number;
    try {
      inserted = await this.insertTurnEvals(batchId, write.evals);
    } catch (err) {
      await this.markFailed(write.batch);
      throw err;
    }
    if (write.batch.status !== "running") await this.upsertBatch(write.batch);
    return { batchId, inserted };
  }

  private async markFailed(batch: SimBatchRow): Promise<void> {
    try {
      const at = this.now().toISOString();
      await this.upsertBatch({ ...batch, status: "failed", finished_at: at < batch.started_at ? batch.started_at : at, updated_at: at } as SimBatchRow);
    } catch {
      // The original failure is the one worth reporting.
    }
  }
}
