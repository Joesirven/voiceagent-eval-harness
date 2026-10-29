/**
 * Where run rows go. The built-in sink uses a local Postgres database.
 *
 * Every sink writes only the columns listed in RUN_COLUMNS, so a row key can
 * never become SQL.
 */

import { randomBytes } from "node:crypto";
import type { DbClient, Row } from "../store/database-client.js";
import { createPsqlRunner, loadLocalPostgres, type LocalPostgresTarget, type SqlRunner } from "./local-postgres.js";

export const RUN_TABLE = "harness_run";
/** The table in the local harness database. */
export const HARNESS_RUN_TABLE = "voice_harness.harness_run";

/** Every column the writer may set. The database sets id, created_at and updated_at defaults itself. */
export const RUN_COLUMNS = [
  "record_id", "call_id", "kind", "lead_id", "agency_id", "direction", "attempt_number", "attempt_status", "block_reason",
  "is_test_run", "setup_name", "voice_module_id", "decision_module_id", "prompt_setup_id", "persona_id", "setup_snapshot",
  "started_at", "ended_at", "outcome_status", "disposition", "outcome", "transcript", "trace", "judge_verdicts", "judge_score",
  "handoff_note", "updated_at",
] as const;
const ALLOWED = new Set<string>(RUN_COLUMNS);
const RECORD_ID = /^[\w-]{1,120}$/;

export interface RunSink {
  /** Adds the row unless one with this record id exists. True when a row was added. */
  insertIgnore(row: Row): Promise<boolean>;
  /** Replaces the given columns on the existing row. */
  update(recordId: string, patch: Row): Promise<void>;
}

export class RestRunSink implements RunSink {
  constructor(private readonly db: DbClient) {}
  async insertIgnore(row: Row): Promise<boolean> {
    return (await this.db.insert(RUN_TABLE, row, { ignoreDuplicatesOn: "record_id" })).length === 1;
  }
  async update(recordId: string, patch: Row): Promise<void> {
    await this.db.update(RUN_TABLE, { record_id: recordId }, patch);
  }
}

function columnsOf(row: Row): string[] {
  const keys = Object.keys(row);
  const bad = keys.find((k) => !ALLOWED.has(k));
  if (bad) throw new Error("run_row_has_unknown_column");
  return keys;
}

/** Wraps JSON text in a dollar-quoted literal whose tag cannot occur inside it. */
function jsonLiteral(value: unknown): string {
  const text = JSON.stringify(value);
  let tag: string;
  do tag = `j${randomBytes(6).toString("hex")}`;
  while (text.includes(`$${tag}$`));
  return `$${tag}$${text}$${tag}$::jsonb`;
}

export class LocalPostgresRunSink implements RunSink {
  constructor(private readonly runner: SqlRunner) {}

  async insertIgnore(row: Row): Promise<boolean> {
    const cols = columnsOf(row).map((c) => `"${c}"`).join(", ");
    const answer = await this.runner.json(
      `with r as (insert into ${HARNESS_RUN_TABLE} (${cols}) select ${cols} from jsonb_populate_record(null::${HARNESS_RUN_TABLE}, ${jsonLiteral(row)}) on conflict (record_id) do nothing returning record_id) select coalesce(json_agg(r), '[]'::json) from r;`,
    );
    return Array.isArray(answer) && answer.length === 1;
  }

  async update(recordId: string, patch: Row): Promise<void> {
    if (!RECORD_ID.test(recordId)) throw new Error("run_bad_record_id");
    const cols = columnsOf(patch).map((c) => `"${c}"`).join(", ");
    await this.runner.json(
      `with r as (update ${HARNESS_RUN_TABLE} set (${cols}) = (select ${cols} from jsonb_populate_record(null::${HARNESS_RUN_TABLE}, ${jsonLiteral(patch)})) where record_id = '${recordId}' returning record_id) select coalesce(json_agg(r), '[]'::json) from r;`,
    );
  }
}

export interface DefaultRunSinkDeps {
  env: Record<string, string | undefined>;
  load: (env: Record<string, string | undefined>) => LocalPostgresTarget;
  runner: (target: LocalPostgresTarget) => SqlRunner;
}

/**
 * The sink for this process: the configured loopback database.
 */
export function defaultRunSink(deps: Partial<DefaultRunSinkDeps> = {}): RunSink {
  const env = deps.env ?? process.env;
  const target = (deps.load ?? ((e) => loadLocalPostgres(e)))(env);
  return new LocalPostgresRunSink((deps.runner ?? ((t) => createPsqlRunner(t)))(target));
}
