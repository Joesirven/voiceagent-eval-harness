/**
 * Apply, check and smoke-test the harness database on the same machine.
 * The target is checked by `loadLocalPostgres` (an allow-list that accepts
 * loopback hosts only) and handed to psql as libpq environment
 * variables, never as an argument.
 *
 *   tsx scripts/harness-db.ts up supabase/harness/<file>.sql
 *   tsx scripts/harness-db.ts verify   read-only: tables, row security, grants, policies, row counts
 *   tsx scripts/harness-db.ts smoke    writes one synthetic run through the default run sink, reads it back, deletes it
 *   tsx scripts/harness-db.ts check    the call_lead_facts and prototype-view rules (migrations 005 to 007), probed
 *                                      with synthetic rows inside one transaction that is always rolled back
 *
 * Nothing printed holds a row's content.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPsqlRunner, harnessDbKind, loadLocalPostgres } from "../src/setups/local-postgres.js";
import { HARNESS_RUN_TABLE, defaultRunSink } from "../src/setups/run-sink.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../supabase/harness");

const VERIFY_SQL = `
begin transaction read only;
select n.nspname as schema, c.relname as name, c.relkind as kind, c.relrowsecurity as row_security, c.relforcerowsecurity as forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where (n.nspname = 'voice_harness' or c.relname = 'harness_run') and c.relkind in ('r', 'v')
 order by 1, 2;
select table_schema, table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where (table_schema = 'voice_harness' or table_name = 'harness_run')
   and grantee in ('anon', 'authenticated', 'PUBLIC', 'service_role')
 group by 1, 2, 3 order by 1, 2, 3;
select r.rolname as role,
       case when to_regnamespace('voice_harness') is null then null
            else has_schema_privilege(r.rolname, 'voice_harness', 'USAGE') end as voice_harness_usage
  from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1;
select schemaname, tablename, policyname, roles from pg_policies
 where schemaname = 'voice_harness' or tablename = 'harness_run' order by 1, 2;
-- Row counts only for the tables that exist, so a partly applied database still reports.
select t as "table", (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', t), false, true, '')))[1]::text::bigint as rows
  from unnest(array['voice_harness.harness_run', 'voice_harness.call_transcript', 'voice_harness.transcript_turn', 'voice_harness.call_lead_facts', 'public.harness_run']) t
 where to_regclass(t) is not null;
-- Needs migration 005. Links from lead facts to a transcript run that is no longer current, or missing while a current run exists.
select count(*) filter (where f.call_transcript_id is not null and not t.is_current) as facts_links_not_current,
       count(*) filter (where f.call_transcript_id is null and exists (
         select 1 from voice_harness.call_transcript c
          where c.source = f.source and c.call_key = f.call_id and c.call_project_ref = f.call_project_ref and c.is_current)) as facts_links_missing
  from voice_harness.call_lead_facts f left join voice_harness.call_transcript t on t.id = f.call_transcript_id;
commit;
`;

/**
 * Each probe must be refused with its own SQLSTATE; anything else raises and fails the check.
 * Synthetic rows only, and the transaction is rolled back whatever happens.
 */
const CHECK_SQL = `
begin;
do $$
declare
  t1 uuid; t2 uuid; c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); f1 uuid; state text;
begin
  insert into voice_harness.call_transcript (source, quo_call_id, call_project_ref, eval_ready_reason, pipeline_version, diarization_method, processing_started_at)
    values ('quo', c1, 'source_primary', 'harness-db check', 'harness-db-check', 'none', now()) returning id into t1;
  insert into voice_harness.call_transcript (source, quo_call_id, call_project_ref, eval_ready_reason, pipeline_version, diarization_method, processing_started_at)
    values ('quo', c2, 'source_primary', 'harness-db check', 'harness-db-check', 'none', now()) returning id into t2;
  insert into voice_harness.call_lead_facts (source, call_id, call_project_ref, source_call_key, call_transcript_id, facts_status, read_at, loader_version)
    values ('quo', c1, 'source_primary', 'check-' || c1, t1, 'no_lead', now(), 'harness-db-check') returning id into f1;

  -- A link to another call's transcript: foreign key, 23503.
  begin update voice_harness.call_lead_facts set call_transcript_id = t2 where id = f1; raise exception 'not refused: link to another call';
  exception when foreign_key_violation then null; end;
  -- A link to a run that is not current: the trigger, 23514.
  update voice_harness.call_transcript set is_current = false where id = t1;
  begin update voice_harness.call_lead_facts set call_transcript_id = t1 where id = f1; raise exception 'not refused: link to a run that is not current';
  exception when check_violation then null; end;
  update voice_harness.call_transcript set is_current = true where id = t1;
  -- A missing source key: 23502. A duplicate source key: 23505.
  begin update voice_harness.call_lead_facts set source_call_key = null where id = f1; raise exception 'not refused: missing source key';
  exception when not_null_violation then null; end;
  begin
    insert into voice_harness.call_lead_facts (source, call_id, call_project_ref, source_call_key, facts_status, read_at, loader_version)
      values ('quo', c2, 'source_primary', 'check-' || c1, 'no_lead', now(), 'harness-db-check');
    raise exception 'not refused: duplicate source key';
  exception when unique_violation then null; end;
  -- A no_lead row carrying a value: 23514.
  begin
    insert into voice_harness.call_lead_facts (source, call_id, call_project_ref, source_call_key, facts_status, trade, read_at, loader_version)
      values ('quo', c2, 'source_primary', 'check-' || c2, 'no_lead', 'roofing', now(), 'harness-db-check');
    raise exception 'not refused: a value on a row without a lead';
  exception when check_violation then null; end;
  -- Deleting the transcript keeps the facts row and clears only its link.
  delete from voice_harness.call_transcript where id = t1;
  if (select call_transcript_id from voice_harness.call_lead_facts where id = f1) is not null then raise exception 'link not cleared on delete'; end if;
  -- Only service_role among the API roles may read the prototype view and the facts.
  if has_table_privilege('anon', 'voice_harness.transcript_turn_prototype', 'select') or has_table_privilege('authenticated', 'voice_harness.transcript_turn_prototype', 'select')
     or has_table_privilege('anon', 'voice_harness.call_lead_facts', 'select') or has_table_privilege('authenticated', 'voice_harness.call_lead_facts', 'select') then
    raise exception 'anon or authenticated can read';
  end if;
  if not has_table_privilege('service_role', 'voice_harness.transcript_turn_prototype', 'select') then raise exception 'service_role cannot read the prototype view'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'voice_harness' and tablename = 'call_lead_facts' and policyname = 'service_role_all') then
    raise exception 'call_lead_facts has no service_role_all policy';
  end if;
  raise notice 'harness-db check: every probe refused as expected';
end $$;
rollback;
`;

function psql(target: ReturnType<typeof loadLocalPostgres>, args: string[], input?: string): number {
  const run = spawnSync("psql", ["--no-psqlrc", "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    env: { PATH: process.env.PATH ?? "", ...target.libpqEnv },
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
  });
  return run.status ?? 1;
}

async function smoke(target: ReturnType<typeof loadLocalPostgres>): Promise<number> {
  const runner = createPsqlRunner(target);
  // The same sink the run writer uses, so this checks the real write path.
  const sink = defaultRunSink({ env: process.env, load: () => target, runner: () => runner });
  const recordId = `harness-db-smoke-${randomUUID()}`;
  const row = {
    record_id: recordId,
    kind: "call",
    lead_id: "synthetic-harness-db-smoke",
    direction: "inbound",
    attempt_status: "answered",
    setup_name: "smoke",
    setup_snapshot: { synthetic: true },
    started_at: new Date().toISOString(),
    transcript: [{ role: "caller", text: "Synthetic smoke line." }],
  };
  let first = false, second = true, left: unknown;
  let back: { rows: number; disposition: string | null; transcript_lines: number | null; test_run_tag: string | null } | undefined;
  try {
    first = await sink.insertIgnore(row);
    second = await sink.insertIgnore(row);
    await sink.update(recordId, { disposition: "smoke_checked", updated_at: new Date().toISOString() });
    back = (await runner.json(
      `select json_build_object('rows', count(*), 'disposition', max(disposition), 'transcript_lines', max(jsonb_array_length(transcript)), 'test_run_tag', max(test_run_tag)) from ${HARNESS_RUN_TABLE} where record_id = '${recordId}';`,
    )) as typeof back;
  } finally {
    // The synthetic row never stays behind, whatever failed above.
    await runner.json(`with d as (delete from ${HARNESS_RUN_TABLE} where record_id = '${recordId}' returning 1) select count(*) from d;`);
    left = await runner.json(`select count(*) from ${HARNESS_RUN_TABLE} where record_id = '${recordId}';`);
  }
  console.log(JSON.stringify({ recordId, inserted: first, duplicateIgnored: !second, readBack: back, leftAfterDelete: left }));
  const ok =
    first && !second && back?.rows === 1 && back.disposition === "smoke_checked" && back.transcript_lines === 1 &&
    back.test_run_tag === "voice-harness-test" && left === 0;
  console.log(ok ? "smoke passed" : "smoke FAILED");
  return ok ? 0 : 1;
}

/** The migration file, only if it really sits in this repository's supabase/harness directory. */
function migrationInRepository(file: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(resolve(file));
  } catch {
    return undefined;
  }
  const rel = relative(realpathSync(MIGRATIONS_DIR), real);
  if (rel.startsWith("..") || rel.includes(sep) || !/^\d{3}_[a-z0-9_]+\.sql$/.test(rel)) return undefined;
  // 001 is the older proposal for an external database (a table in public); never the harness database.
  if (rel.startsWith("001_")) return undefined;
  return real;
}

async function main(): Promise<number> {
  const [command, file] = process.argv.slice(2);
  if (!command || !["up", "verify", "smoke", "check"].includes(command)) {
    console.error("usage: harness-db.ts up <supabase/harness/file.sql> | verify | smoke | check");
    return 2;
  }
  let target;
  try {
    target = loadLocalPostgres();
  } catch (err) {
    // Our own error codes carry no secrets.
    console.error(`refused: ${err instanceof Error ? err.message : "unknown"}`);
    return 1;
  }
  // The host that passed the allow-list, not just the kind that was asked for.
  console.log(`database=${harnessDbKind()} host=${target.libpqEnv.PGHOST} tls=${target.libpqEnv.PGSSLMODE} command=${command}`);
  if (command === "up") {
    const path = file ? migrationInRepository(file) : undefined;
    if (!path) {
      console.error("refused: 'up' needs a NNN_name.sql file inside this repository's supabase/harness directory");
      return 2;
    }
    return psql(target, ["-f", path]);
  }
  if (command === "verify") return psql(target, ["-f", "-"], VERIFY_SQL);
  if (command === "check") return psql(target, ["-f", "-"], CHECK_SQL);
  return smoke(target);
}

main().then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(`failed: ${err instanceof Error ? err.message : "unknown"}`);
    process.exitCode = 1;
  },
);
