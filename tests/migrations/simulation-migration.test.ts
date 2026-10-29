/**
 * supabase/harness/004_simulation.sql applied, after 002 and 003, to a throwaway
 * local Postgres: a temporary data directory on a free loopback port, started
 * and removed by this test. No inherited PG* variable is passed on, so this can
 * never reach a shared database. Skipped when psql, initdb or pg_ctl is missing.
 * With VOICE_HARNESS_TEST_THROWAWAY_PORT (an empty throwaway server on loopback, for example PGlite behind its socket server) this test
 * applies the migrations there. The writer test in tests/scenarios/sim-writer.test.ts reads the same variable but expects 002, 003 and 004 already
 * applied and no other rows, so run the two files one after the other (--no-file-parallelism), on a fresh server for each.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN_DIRS = ["/opt/homebrew/bin", ...(process.env.PATH ?? "").split(":")];
function findTool(name: string): string | undefined {
  for (const dir of BIN_DIRS) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}
const PSQL = findTool("psql");
const INITDB = findTool("initdb");
const PG_CTL = findTool("pg_ctl");
// initdb needs the server program "postgres" in its own directory; a client-only install (libpq) has none.
const SERVER = INITDB && existsSync(join(dirname(realpathSync(INITDB)), "postgres")) ? join(dirname(realpathSync(INITDB)), "postgres") : undefined;
// An empty throwaway server already running on this machine's loopback address (for example PGlite, a WebAssembly Postgres,
// behind its socket server) may be named by port; this test then creates and fills schema voice_harness in it.
const externalPort = Number(process.env.VOICE_HARNESS_TEST_THROWAWAY_PORT ?? "") || 0;
const toolsMissing = !PSQL || (!externalPort && (!INITDB || !PG_CTL || !SERVER));
// Set VOICE_HARNESS_REQUIRE_DATABASE_TEST=1 where a Postgres server is expected: a missing server then fails the run instead of skipping.
const requireDatabase = process.env.VOICE_HARNESS_REQUIRE_DATABASE_TEST === "1";
if (toolsMissing && requireDatabase) {
  throw new Error(
    `simulation migration database test required but not runnable: psql=${PSQL}, initdb=${INITDB}, pg_ctl=${PG_CTL}, postgres=${SERVER}`,
  );
}
if (toolsMissing) {
  console.warn(
    `simulation migration database test skipped: needs psql, initdb, pg_ctl and the postgres server program together (psql=${PSQL}, initdb=${INITDB}, pg_ctl=${PG_CTL}, postgres=${SERVER})`,
  );
}

const MIGRATIONS = resolve(__dirname, "../../supabase/harness");
const TABLES = ["sim_lead_facts", "sim_batch", "sim_run", "sim_turn", "sim_turn_eval"];

// Environment without any inherited database setting.
const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG")));

let dataDir = "";
let socketDir = "";
let port = 0;
let started = false;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const chosen = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(chosen));
    });
  });
}

interface Result { ok: boolean; out: string; err: string }
function psql(args: string[], input?: string): Result {
  const run = spawnSync(PSQL!, ["-X", "-q", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...args], {
    env: cleanEnv,
    input,
    encoding: "utf8",
  });
  return { ok: run.status === 0, out: run.stdout, err: run.stderr };
}
// "reset role" first: a server that shares one session across connections (PGlite behind its socket server) would otherwise keep a role set by an earlier statement.
const sql = (text: string): Result => psql(["-f", "-"], `reset role;\n${text}`);
const file = (name: string): Result => psql(["-f", join(MIGRATIONS, name)]);

function expectRejected(text: string, constraint: RegExp): void {
  const result = sql(text);
  expect(result.ok, `expected a rejection, got: ${result.out}`).toBe(false);
  expect(result.err).toMatch(constraint);
}

const HEX64 = "a".repeat(64);
const HEX40 = "b".repeat(40);
const LEAD_FACTS = "00000000-0000-4000-8000-000000000001";
const BATCH = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const TURN_BATCH = "00000000-0000-4000-8000-000000000004";
const REAL_UUID = "11111111-1111-4111-8111-111111111111";
const REAL_LEAD_FACTS = "00000000-0000-4000-8000-0000000000c1";
const REAL_RUN = "00000000-0000-4000-8000-0000000000c2";
const REAL_RUN_NO_TEXT = "00000000-0000-4000-8000-0000000000c3";

/** An insert built from column name to SQL literal; `over` replaces or adds columns, and a value of undefined removes one. */
function insertInto(table: string, defaults: Record<string, string>, over: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string> = { ...defaults };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return `insert into voice_harness.${table} (${Object.keys(merged).join(", ")}) values (${Object.values(merged).join(", ")});`;
}

const FACTS_DEFAULTS: Record<string, string> = {
  id: `'${LEAD_FACTS}'`,
  source_call_origin: "'synthetic_fixture'",
  source_call_table: "'fixture'",
  source_call_key: "'fixture:lead-one'",
  persona_origin: "'fixture'",
  extractor_id: "'facts-file'",
  extractor_version: `'${HEX64}'`,
  facts_sha256: `'${HEX64}'`,
  content_origin: "'synthetic_fixture'",
  extracted_at: "now()",
};
const REAL_FACTS_DEFAULTS: Record<string, string> = {
  id: `'${REAL_LEAD_FACTS}'`,
  source_call_origin: "'source_primary'",
  source_call_table: "'dialer'",
  source_call_key: `'${REAL_UUID}'`,
  persona_origin: "'real_call'",
  past_call_source: "'dialer'",
  attribution: "'track'",
  extractor_id: "'model-one'",
  extractor_version: `'${HEX40}:some-model:low'`,
  extractor_model: "'some-model'",
  extractor_effort: "'low'",
  facts_sha256: `'${"c".repeat(64)}'`,
  content_origin: "'real_call'",
  extracted_at: "now()",
};
const factsInsert = (over: Record<string, string | undefined> = {}) => insertInto("sim_lead_facts", FACTS_DEFAULTS, over);
const realFactsInsert = (over: Record<string, string | undefined> = {}) => insertInto("sim_lead_facts", REAL_FACTS_DEFAULTS, over);
const leadFactsInsert = () => factsInsert();
const batchInsert = (id: string, key: string, kind: string, config: string) => `
  insert into voice_harness.sim_batch (id, batch_key, kind, config, harness_commit, harness_dirty)
  values ('${id}', '${key}', '${kind}', '${config}', '${HEX40}', false);`;
const RUN_DEFAULTS: Record<string, string> = {
  id: `'${RUN}'`,
  batch_id: `'${BATCH}'`,
  attempt: "1",
  item_index: "0",
  record_id: "'call_abc123'",
  trace_ref: "'call_abc123.jsonl'",
  lead_id: "'whole-call-lead-1'",
  lead_id_origin: "'synthetic_fixture'",
  lead_facts_id: `'${LEAD_FACTS}'`,
  content_origin: "'synthetic_fixture'",
  direction: "'inbound'",
  clock_now: "now()",
  simulator: "'scripted'",
  scripted_preferred_time: "'tomorrow morning'",
  scripted_objection_after_turns: "2",
  scripted_objection_spacing: "3",
  turn_cap: "25",
  tree_source: "'active'",
  tree_choice_id: "'fixture'",
  tree_id: "'tree-one'",
  tree_version: "'v1'",
  status: "'completed'",
  ended_by: "'agent_ended'",
  lead_turns: "3",
};
const runInsert = (over: Record<string, string | undefined> = {}) => insertInto("sim_run", RUN_DEFAULTS, over);
const runAs = (id: string, record: string, over: Record<string, string | undefined> = {}) =>
  runInsert({ id: `'${id}'`, record_id: `'${record}'`, trace_ref: `'${record}.jsonl'`, ...over });
const turnInsert = (line = 0, contentOrigin = "synthetic_fixture", over: Record<string, string | undefined> = {}) =>
  insertInto(
    "sim_turn",
    {
      run_id: `'${RUN}'`,
      content_origin: `'${contentOrigin}'`,
      line_index: String(line),
      turn_index: "0",
      role: "'caller'",
      spoken: "true",
      said_at: "now()",
      text_redacted: "'made up words'",
    },
    over,
  );
const turnEvalInsert = (over: Record<string, string | undefined> = {}) =>
  insertInto(
    "sim_turn_eval",
    {
      batch_id: `'${TURN_BATCH}'`,
      source_call_origin: "'synthetic_fixture'",
      source_call_table: "'fixture'",
      source_call_key: "'fixture:turn-one'",
      past_call_source: "'diarized'",
      attribution: "'track'",
      turn_index: "1",
      call_had_clean_turns: "true",
      agent_id: "'agent-one'",
      agent_system_prompt_sha256: `'${HEX64}'`,
      agent_system_prompt_is_placeholder: "true",
      judge_id: "'judge-one'",
      judge_rubric_sha256: `'${HEX64}'`,
      pick_agent_first: "'first'",
      pick_producer_first: "'second'",
      content_origin: "'synthetic_fixture'",
      judged_at: "now()",
    },
    over,
  );

describe.skipIf(toolsMissing)("004_simulation.sql on a throwaway local Postgres", () => {
  beforeAll(async () => {
    if (externalPort) {
      port = externalPort;
      return;
    }
    dataDir = mkdtempSync(join(tmpdir(), "sim-mig-data-"));
    socketDir = mkdtempSync(join(tmpdir(), "sim-mig-sock-"));
    port = await freePort();
    const init = spawnSync(INITDB!, ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { env: cleanEnv, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const start = spawnSync(
      PG_CTL!,
      ["-D", dataDir, "-w", "-l", join(dataDir, "server.log"), "-o", `-c listen_addresses=127.0.0.1 -p ${port} -c unix_socket_directories=${socketDir} -c fsync=off`, "start"],
      { env: cleanEnv, encoding: "utf8" },
    );
    expect(start.status, start.stderr + start.stdout).toBe(0);
    started = true;
  }, 120_000);

  afterAll(() => {
    if (started) spawnSync(PG_CTL!, ["-D", dataDir, "-m", "immediate", "-w", "stop"], { env: cleanEnv, encoding: "utf8" });
    for (const dir of [dataDir, socketDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("applies 002, 003 and 004 in order, and 004 a second time", () => {
    for (const name of ["002_harness_run.sql", "003_voice_harness_cleaned_transcripts.sql", "004_simulation.sql", "004_simulation.sql"]) {
      const result = file(name);
      expect(result.ok, `${name}: ${result.err}`).toBe(true);
    }
    const count = sql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'voice_harness' and c.relname like 'sim\\_%' and c.relkind = 'r';`);
    expect(count.out.trim()).toBe("5");
  });

  it("inserts a synthetic row in each table and generates the verdict", () => {
    const script = [
      leadFactsInsert(),
      batchInsert(BATCH, "whole-call-2026-10-20T10-00-00-000Z", "whole_call", '{"limit":1,"lead":"scripted","direction":"inbound","maxTurns":25}'),
      batchInsert(TURN_BATCH, "turns-2026-10-20T10-00-00-000Z", "turn_eval", '{"limit":1,"callCount":1,"turnsPerCall":2,"pastCallSourceId":"dev-database"}'),
      runInsert(),
      turnInsert(0),
      turnEvalInsert(),
    ].join("\n");
    const result = sql(script);
    expect(result.ok, result.err).toBe(true);
    // sim_batch holds the whole-call batch and the turn-evaluation batch.
    for (const table of TABLES) {
      expect(sql(`select count(*) from voice_harness.${table};`).out.trim(), table).toBe(table === "sim_batch" ? "2" : "1");
    }
    expect(sql("select verdict || ',' || consistent from voice_harness.sim_turn_eval;").out.trim()).toBe("better,true");
  });

  // PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  it("accepts real_call text labelled not_redacted, rejects it with no method or an unknown one, and accepts real_call rows without text", () => {
    const wrap = (...statements: string[]) => statements.join("\n");
    // Facts: text with not_redacted is accepted.
    let result = sql(realFactsInsert({ business_type_redacted: "'a roofer'", objections_redacted: "array['too busy']", redaction_method: "'not_redacted'" }));
    expect(result.ok, result.err).toBe(true);
    // Facts: text with no method is rejected; with an unknown method is rejected.
    const another = (n: number, over: Record<string, string | undefined>) =>
      realFactsInsert({ id: `'00000000-0000-4000-8000-0000000000c${n}'`, source_call_key: `'${REAL_UUID.slice(0, -1)}${n}'`, ...over });
    expectRejected(another(4, { trade_redacted: "'roofing'" }), /sim_lead_facts_real_call_text_is_redacted/);
    expectRejected(another(5, { objections_redacted: "array['x']" }), /sim_lead_facts_real_call_text_is_redacted/);
    expectRejected(another(6, { trade_redacted: "'roofing'", redaction_method: "'masked_by_hand'" }), /redaction_method/);
    // Facts without text, no method: accepted (a number and a letters-only language are not text).
    result = sql(another(7, { employee_count: "6", language: "'English'" }));
    expect(result.ok, result.err).toBe(true);
    // The two accepted fact rows: the second has the trade column in the same table.
    result = sql(another(8, { trade_redacted: "'plumbing'", redaction_method: "'harness_redact_text_v1'" }));
    expect(result.ok, result.err).toBe(true);

    // A real-call run on real-call facts is accepted (picks and counts need no text), with text lines labelled not_redacted.
    const realRun = (id: string, record: string, attempt: number) =>
      runAs(id, record, { lead_facts_id: `'${REAL_LEAD_FACTS}'`, content_origin: "'real_call'", attempt: String(attempt) });
    result = sql(wrap(realRun(REAL_RUN, "call_real1", 7), realRun(REAL_RUN_NO_TEXT, "call_real2", 8)));
    expect(result.ok, result.err).toBe(true);
    const realTurn = (line: number, runId: string, over: Record<string, string | undefined>) =>
      turnInsert(line, "real_call", { run_id: `'${runId}'`, ...over });
    result = sql(wrap(
      realTurn(0, REAL_RUN, { text_redacted: "'Jane Doe at Acme said hello'", redaction_method: "'not_redacted'" }),
      realTurn(1, REAL_RUN, { text_redacted: "'hi'", redaction_method: "'harness_redact_text_v1'" }),
      realTurn(0, REAL_RUN_NO_TEXT, { text_redacted: undefined }),
    ));
    expect(result.ok, result.err).toBe(true);
    expectRejected(realTurn(2, REAL_RUN, { text_redacted: "'some words'" }), /sim_turn_real_call_text_is_redacted/);
    expectRejected(realTurn(3, REAL_RUN, { text_redacted: "'some words'", redaction_method: "'unknown_method'" }), /redaction_method/);
    // A made-up run may not hang on real-call facts, nor the other way round.
    expectRejected(runAs("00000000-0000-4000-8000-0000000000c9", "call_mix1", { lead_facts_id: `'${REAL_LEAD_FACTS}'` }), /sim_run_lead_facts_fk/);

    // Turn judgements: replies with not_redacted accepted; replies with no method rejected; no replies and no method accepted.
    const realEval = (n: number, over: Record<string, string | undefined>) =>
      turnEvalInsert({
        source_call_origin: "'source_primary'",
        source_call_table: "'dialer'",
        source_call_key: `'${REAL_UUID.slice(0, -1)}${n}'`,
        content_origin: "'real_call'",
        ...over,
      });
    result = sql(wrap(
      realEval(1, { agent_reply_redacted: "'Hello Jane'", producer_reply_redacted: "'Hi Jane'", redaction_method: "'not_redacted'" }),
      realEval(2, {}),
    ));
    expect(result.ok, result.err).toBe(true);
    expectRejected(realEval(3, { agent_reply_redacted: "'Hello Jane'" }), /sim_turn_eval_real_call_text_is_redacted/);
    expectRejected(realEval(4, { producer_reply_redacted: "'Hi'", redaction_method: "'unknown_method'" }), /redaction_method/);

    // Clean up the real-call rows so the later tests see the synthetic ones only.
    result = sql(`delete from voice_harness.sim_turn_eval where content_origin = 'real_call';
      delete from voice_harness.sim_run where content_origin = 'real_call';
      delete from voice_harness.sim_lead_facts where content_origin = 'real_call';`);
    expect(result.ok, result.err).toBe(true);
    for (const table of TABLES) {
      expect(sql(`select count(*) from voice_harness.${table};`).out.trim(), table).toBe(table === "sim_batch" ? "2" : "1");
    }
  });

  it("rejects turn_cap 26 and accepts 25", () => {
    expectRejected(runAs("00000000-0000-4000-8000-0000000000a2", "call_cap26", { turn_cap: "26" }), /turn_cap/);
    const ok = sql(runAs("00000000-0000-4000-8000-0000000000a3", "call_cap25", { attempt: "2", turn_cap: "25" }));
    expect(ok.ok, ok.err).toBe(true);
  });

  it("accepts the agent setup, reproducibility and model settings columns, and checks their shapes", () => {
    const set = (assignments: string) => `update voice_harness.sim_run set ${assignments} where id = '${RUN}';`;
    const full = set(`orchestrator_id = 'pipecat', voice_path_id = 'azure_gpt_live', voice_module_id = 'azure-gpt-live',
      dialogue_model = 'gpt-live-1', prompt_setup_id = 'setup:default/1', decision_router_id = 'pipecat_classifier',
      decision_model = 'gpt-5.6-terra', judge_enabled = true, judge_model = 'gpt-5.6-judge', persona_file_sha256 = '${HEX64}',
      tree_file_sha256 = '${HEX64}', seed = 'seed-42',
      model_settings = '{"agent":{"deployment":"gpt-live-1","temperature":0.7,"max_output_tokens":null,"seed":42},"lead":{"deployment":"gpt-5.6-terra"},"decision":{},"judge":{"temperature":null},"extractor":{"max_output_tokens":800}}'::jsonb`);
    const accepted = sql(full);
    expect(accepted.ok, accepted.err).toBe(true);
    expect(sql(`select orchestrator_id || ',' || decision_router_id || ',' || tree_source || ',' || repeat_index from voice_harness.sim_run where id = '${RUN}';`).out.trim()).toBe("pipecat,pipecat_classifier,active,0");
    for (const router of ["decision_model", "pipecat_flows"]) expect(sql(set(`decision_router_id = '${router}'`)).ok).toBe(true);
    expect(sql(set("orchestrator_id = 'direct', model_settings = '{}'::jsonb, judge_enabled = null")).ok).toBe(true);
    // Each shape check refuses its bad value.
    expectRejected(set("orchestrator_id = 'both'"), /orchestrator_id/);
    expectRejected(set("decision_router_id = 'router'"), /decision_router_id/);
    expectRejected(set("voice_path_id = 'has spaces'"), /voice_path_id/);
    expectRejected(set("voice_module_id = ''"), /voice_module_id/);
    expectRejected(set("dialogue_model = 'a;b'"), /dialogue_model/);
    expectRejected(set("prompt_setup_id = 'x y'"), /prompt_setup_id/);
    expectRejected(set("decision_model = 'x y'"), /decision_model/);
    expectRejected(set("judge_model = 'x y'"), /judge_model/);
    expectRejected(set("persona_file_sha256 = 'abc'"), /persona_file_sha256/);
    expectRejected(set("tree_file_sha256 = 'ABC'"), /tree_file_sha256/);
    expectRejected(set("seed = 'has a space'"), /seed/);
    expectRejected(set("repeat_index = -1"), /repeat_index/);
    // model_settings: key names and value types.
    const settings = (json: string) => set(`model_settings = '${json}'::jsonb`);
    for (const bad of [
      '{"extra":{"deployment":"x"}}',
      '{"agent":{"deployment":"x","stray":1}}',
      '{"agent":{"temperature":"hot"}}',
      '{"agent":{"deployment":5}}',
      '{"agent":{"deployment":"has spaces"}}',
      '{"agent":{"max_output_tokens":1.5}}',
      '{"agent":{"max_output_tokens":"many"}}',
      '{"agent":{"seed":"x"}}',
      '{"agent":{"seed":2.5}}',
      '{"agent":[{"deployment":"x"}]}',
      '{"agent":"gpt-live-1"}',
      '{"agent":null}',
      '[]',
      '"text"',
    ]) {
      expectRejected(settings(bad), /sim_run_model_settings_shape/);
    }
    // The tree file hash is required for a --tree file and optional for the active tree.
    expectRejected(set("tree_source = 'tree_file', tree_choice_id = null, tree_file_sha256 = null"), /sim_run_tree_shape/);
    expect(sql(set("tree_file_sha256 = null")).ok).toBe(true);
    // The lead is a model or a script, nothing else, and a model needs its deployment.
    expectRejected(set("simulator = 'claude'"), /simulator/);
    expectRejected(set("simulator = 'model'"), /sim_run_simulator_shape/);
    const model = runAs("00000000-0000-4000-8000-0000000000a4", "call_model1", {
      attempt: "3",
      simulator: "'model'",
      simulator_model: "'gpt-5.6-terra'",
      scripted_preferred_time: undefined,
      scripted_objection_after_turns: undefined,
      scripted_objection_spacing: undefined,
    });
    expect(sql(model).ok).toBe(true);
    expectRejected(model.replace("'call_model1'", "'call_model2'").replace("'00000000-0000-4000-8000-0000000000a4'", "'00000000-0000-4000-8000-0000000000a5'").replace("'gpt-5.6-terra'", "'gpt terra'").replace(", 3,", ", 4,"), /sim_run_simulator_shape/);
  });

  it("keeps the unique key (batch, lead facts, repeat index, attempt): repeat 0 and 1 coexist, a duplicate is rejected", () => {
    const repeat = (id: string, record: string, repeatIndex: number, attempt = 1) =>
      runAs(id, record, { repeat_index: String(repeatIndex), attempt: String(attempt) });
    expect(sql(repeat("00000000-0000-4000-8000-0000000000e1", "call_rep1", 1)).ok).toBe(true);
    expect(sql(repeat("00000000-0000-4000-8000-0000000000e2", "call_rep2", 2)).ok).toBe(true);
    expectRejected(repeat("00000000-0000-4000-8000-0000000000e3", "call_rep3", 1), /sim_run_one_per_attempt/);
    expect(sql(repeat("00000000-0000-4000-8000-0000000000e4", "call_rep4", 1, 2)).ok).toBe(true);
    expect(sql(`select count(*) from voice_harness.sim_run where batch_id = '${BATCH}' and lead_facts_id = '${LEAD_FACTS}' and attempt = 1;`).out.trim()).toBe("3");
    expect(sql(`delete from voice_harness.sim_run where record_id in ('call_rep1', 'call_rep2', 'call_rep4', 'call_model1');`).ok).toBe(true);
  });

  it("ties persona_origin to the content and source columns", () => {
    const persona = (n: number, over: Record<string, string | undefined> = {}) =>
      factsInsert({
        id: `'00000000-0000-4000-8000-00000000${(0xd000 + n).toString(16)}'`,
        source_call_key: "'fixture:persona-roofer-one'",
        persona_origin: "'synthetic_persona'",
        persona_id: "'roofer-one'",
        ...over,
      });
    // A persona, and the same persona with facts from a model extractor, are separate rows.
    expect(sql(persona(1)).ok).toBe(true);
    const byModel = persona(2, { extractor_id: "'model-one'", extractor_version: `'${HEX40}:some-model:low'`, extractor_model: "'some-model'", extractor_effort: "'low'" });
    const accepted = sql(byModel);
    expect(accepted.ok, accepted.err).toBe(true);
    expectRejected(persona(3), /sim_lead_facts_one_per_extraction/);
    // A plain fixture and the persona rules.
    expect(sql(factsInsert({ id: "'00000000-0000-4000-8000-0000000000d4'", source_call_key: "'fixture:persona'" })).ok).toBe(true);
    const ties = /sim_lead_facts_persona_ties/;
    const sha = (n: number) => `'${String(n).repeat(64).slice(0, 64)}'`;
    expectRejected(persona(5, { persona_id: undefined, facts_sha256: sha(5) }), ties);
    expectRejected(persona(6, { persona_id: "'roofer-two'", facts_sha256: sha(6) }), ties);
    expectRejected(persona(7, { source_call_key: "'fixture:roofer-one'", facts_sha256: sha(7) }), ties);
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000d8'", source_call_key: "'fixture:persona-x'", facts_sha256: sha(8) }), ties);
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000d9'", source_call_key: "'fixture:lead-two'", persona_id: "'lead-two'", facts_sha256: sha(9) }), ties);
    expectRejected(persona(10, { persona_origin: "'real_call'", facts_sha256: sha(1) }), ties);
    expectRejected(realFactsInsert({ persona_origin: "'fixture'" }), ties);
    expectRejected(realFactsInsert({ persona_origin: "'synthetic_persona'", persona_id: "'x'" }), ties);
    // persona_id must be lowercase letters, digits and hyphens, at most 72 characters; the origin is required and known.
    expectRejected(persona(11, { source_call_key: "'fixture:persona-Roofer'", persona_id: "'Roofer'", facts_sha256: sha(2) }), /persona_id/);
    expectRejected(persona(12, { source_call_key: `'fixture:persona-${"a".repeat(73)}'`, persona_id: `'${"a".repeat(73)}'`, facts_sha256: sha(3) }), /persona_id|source_call_shape/);
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000da'", persona_origin: "'invented'", facts_sha256: sha(4) }), /persona_origin/);
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000db'", persona_origin: undefined, facts_sha256: sha(4) }), /persona_origin/);
    expect(sql("delete from voice_harness.sim_lead_facts where persona_origin = 'synthetic_persona' or source_call_key in ('fixture:persona');").ok).toBe(true);
  });

  it("accepts the lead-record extractor only with a lead facts key, no model, and real-call content", () => {
    const record = (n: number, over: Record<string, string | undefined> = {}) =>
      realFactsInsert({
        id: `'00000000-0000-4000-8000-0000000000f${n}'`,
        source_call_key: `'${REAL_UUID.slice(0, -1)}${n}'`,
        facts_sha256: `'${String(n).repeat(64).slice(0, 64)}'`,
        extractor_id: "'lead-record'",
        extractor_version: `'${HEX40}-dirty:lead-loader.v1'`,
        extractor_model: undefined,
        extractor_effort: undefined,
        source_lead_facts_key: `'dialer:source_primary:${REAL_UUID}'`,
        trade_redacted: "'roofing'",
        redaction_method: "'not_redacted'",
        ...over,
      });
    const ok = sql(record(1));
    expect(ok.ok, ok.err).toBe(true);
    const shape = /sim_lead_facts_extractor_shape/;
    expectRejected(record(2, { extractor_model: "'some-model'" }), shape);
    expectRejected(record(3, { extractor_effort: "'low'" }), shape);
    expectRejected(record(4, { extractor_version: `'${HEX64}'` }), shape);
    expectRejected(record(5, { extractor_version: `'${HEX40}:has space'` }), shape);
    expectRejected(record(6, { source_lead_facts_key: undefined }), /sim_lead_facts_lead_record_key/);
    expectRejected(record(7, { source_lead_facts_key: "'not a key'" }), /source_lead_facts_key/);
    expectRejected(record(8, { source_lead_facts_key: "'dialer:somewhere:abc'" }), /source_lead_facts_key/);
    expectRejected(
      realFactsInsert({ id: "'00000000-0000-4000-8000-0000000000f9'", source_call_key: `'${REAL_UUID.slice(0, -1)}9'`, source_lead_facts_key: `'dialer:source_primary:${REAL_UUID}'`, facts_sha256: `'${"9".repeat(64)}'` }),
      /sim_lead_facts_lead_record_key/,
    );
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000fa'", source_lead_facts_key: `'dialer:source_primary:${REAL_UUID}'`, facts_sha256: `'${"8".repeat(64)}'` }), /sim_lead_facts_lead_record_key/);
    // A lead record is real-call content: a persona or a fixture never uses it.
    expectRejected(
      factsInsert({
        id: "'00000000-0000-4000-8000-0000000000fb'",
        source_call_key: "'fixture:from-record'",
        facts_sha256: `'${"7".repeat(64)}'`,
        extractor_id: "'lead-record'",
        extractor_version: `'${HEX40}:loader'`,
        source_lead_facts_key: `'dialer:source_primary:${REAL_UUID}'`,
      }),
      /sim_lead_facts_persona_ties/,
    );
    expect(sql("delete from voice_harness.sim_lead_facts where extractor_id = 'lead-record';").ok).toBe(true);
  });

  it("checks the value types and shapes inside the jsonb columns, not only the key names", () => {
    const update = (column: string, value: string) =>
      `update voice_harness.sim_run set ${column} = '${value}'::jsonb where id = '${RUN}';`;
    const batchUpdate = (value: string) => `update voice_harness.sim_batch set failures = '${value}'::jsonb where id = '${BATCH}';`;
    // Fixed codes and plain values are accepted.
    for (const ok of [
      update("enforcement", '[{"rule":"Never-01","passed":true,"note":"partial (0.5): a short note"}]'),
      update("judge_verdicts", '[{"action":"book_appointment","allowed":true,"reason":"A plain sentence.","recordSeq":4,"scores":[{"criterion":"rules","score":1,"note":"ok"}]}]'),
      update("judge_score", '{"judgedAt":"2026-10-20T10:00:00.000Z","score":80,"criteria":[{"criterion":"booked","score":1,"note":"ok"}]}'),
      batchUpdate('[{"source_call_origin":"synthetic_fixture","source_call_table":"fixture","source_call_key":"fixture:lead-one","turn_index":null,"code":"turn_judge_failed"}]'),
    ]) {
      const result = sql(ok);
      expect(result.ok, result.err).toBe(true);
    }
    expectRejected(update("enforcement", '[{"rule":"has spaces and a name, Jane Doe!","passed":true,"note":"x"}]'), /sim_run_enforcement_shape/);
    expectRejected(update("enforcement", '[{"rule":"r","passed":"yes","note":"x"}]'), /sim_run_enforcement_shape/);
    expectRejected(update("enforcement", `[{"rule":"r","passed":true,"note":"${"n".repeat(301)}"}]`), /sim_run_enforcement_shape/);
    expectRejected(update("judge_verdicts", '[{"action":"a","allowed":"yes","reason":"r","recordSeq":1}]'), /sim_run_judge_verdicts_shape/);
    expectRejected(update("judge_verdicts", '[{"action":"a","allowed":true,"reason":{"nested":"x"},"recordSeq":1}]'), /sim_run_judge_verdicts_shape/);
    expectRejected(update("judge_verdicts", '[{"action":"a","allowed":true,"reason":"r","recordSeq":1,"scores":[{"free":"Jane Doe said"}]}]'), /sim_run_judge_verdicts_shape/);
    expectRejected(update("judge_score", '{"criteria":[{"free":"Jane Doe said"}]}'), /sim_run_judge_score_shape/);
    expectRejected(update("judge_score", '{"score":"high"}'), /sim_run_judge_score_shape/);
    expectRejected(batchUpdate('[{"code":"c","source_call_key":"anything at all with spaces and call text"}]'), /sim_batch_failures_shape/);
    expectRejected(batchUpdate('[{"code":"c","turn_index":"text"}]'), /sim_batch_failures_shape/);
  });

  it("enforces the unique keys", () => {
    expectRejected(factsInsert({ id: "'00000000-0000-4000-8000-0000000000b1'" }), /sim_lead_facts_one_per_extraction/);
    expectRejected(batchInsert("00000000-0000-4000-8000-0000000000b2", "whole-call-2026-10-20T10-00-00-000Z", "whole_call", "{}"), /sim_batch_key_unique/);
    expectRejected(runAs("00000000-0000-4000-8000-0000000000b3", "call_abc123", { attempt: "9" }), /sim_run_record_unique/);
    expectRejected(runAs("00000000-0000-4000-8000-0000000000b4", "call_other", { attempt: "1" }), /sim_run_one_per_attempt/);
    expectRejected(turnInsert(0), /sim_turn_order_unique/);
    expectRejected(turnEvalInsert(), /sim_turn_eval_one_per_turn/);
  });

  it("gives anon and authenticated no privilege, and service_role only the four", () => {
    for (const table of TABLES) {
      const name = `voice_harness.${table}`;
      for (const role of ["anon", "authenticated"]) {
        const held = sql(`select has_table_privilege('${role}', '${name}', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`);
        expect(held.out.trim(), `${role} on ${table}`).toBe("f");
      }
      const service = sql(`select
        has_table_privilege('service_role', '${name}', 'SELECT,INSERT,UPDATE,DELETE'),
        has_table_privilege('service_role', '${name}', 'TRUNCATE') or has_table_privilege('service_role', '${name}', 'REFERENCES') or has_table_privilege('service_role', '${name}', 'TRIGGER');`);
      expect(service.out.trim(), `service_role on ${table}`).toBe("t|f");
    }
    for (const role of ["anon", "authenticated"]) {
      expect(sql(`select has_schema_privilege('${role}', 'voice_harness', 'USAGE,CREATE');`).out.trim()).toBe("f");
      expectRejected(`set role ${role}; select count(*) from voice_harness.sim_run;`, /permission denied/);
    }
  });

  it("enables and forces row level security, with no policy", () => {
    for (const table of TABLES) {
      const state = sql(`select relrowsecurity::text || ',' || relforcerowsecurity::text || ',' ||
        (select count(*) from pg_policy where polrelid = c.oid)::text
        from pg_class c where c.oid = 'voice_harness.${table}'::regclass;`);
      expect(state.out.trim(), table).toBe("true,true,0");
    }
  });
});
