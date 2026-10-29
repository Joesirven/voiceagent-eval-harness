import { afterEach, describe, expect, it } from "vitest";
import type { ExecFile, LocalPostgresTarget, SqlRunner } from "../../src/setups/local-postgres.js";
import { createPsqlRunner } from "../../src/setups/local-postgres.js";
import { defaultRunSink, type RunSink } from "../../src/setups/run-sink.js";
import { RunWriter, describeRunStore, isRunWriteBackEnabled, runStoreLogLine, resetRunWriter, setRunWriteBack } from "../../src/setups/run-writer.js";
import type { SetupSnapshot } from "../../src/setups/active-setup.js";
import type { HarnessRecord } from "../../src/trace/index.js";

// Content of a harness call: it goes to the configured local database in full.
const CONTENT = ["Hello, this is Dana", "PROMPT-TEXT-LEAD-RECORD", "Dana's Plumbing LLC", "Dana Owner", "payroll 480000", "prior call snippet", "persona situation text", "handoff words"];

const snapshot = {
  name: "s1",
  appliedAt: "2026-10-20T08:00:00.000Z",
  direction: "inbound",
  voiceModule: { id: "azure-gpt-live", label: "voice" },
  decisionModule: { id: "decision_tree", label: "tree" },
  promptSetup: { id: "with-briefing", label: "p", includesBriefing: true, instructions: "PROMPT-TEXT-LEAD-RECORD" },
  renderedPrompt: "PROMPT-TEXT-LEAD-RECORD Dana's Plumbing LLC",
  renderedPromptSha256: "abc123",
  lead: { leadId: "lead-1", agencyId: "agency-1", businessName: "Dana's Plumbing LLC", callCount: 2 },
  briefingGiven: { ownerName: "Dana Owner", payroll: "payroll 480000", priorCalls: [{ summary: "prior call snippet" }] },
  persona: { personaId: "persona-1", title: "t", situation: "persona situation text" },
} as unknown as SetupSnapshot;

const record = {
  recordId: "call_abc",
  kind: "call",
  leadId: "lead-1",
  openedAt: "2026-10-20T08:00:01.000Z",
  transcript: [{ role: "caller", text: "Hello, this is Dana" }],
  events: [{ type: "transcript_final", channel: "call", recordId: "call_abc", leadId: "lead-1", at: "2026-10-20T08:00:02.000Z", data: { text: "Hello, this is Dana", leadLabel: "Dana" } }],
  outcome: { status: "completed", summary: "Dana Owner wants a quote" },
  handoffNote: { text: "handoff words" },
} as unknown as HarnessRecord;

/** A runner that keeps every SQL text and answers like an insert that added one row. */
function recordingRunner(seen: string[]): SqlRunner {
  return { json: async (sql) => (seen.push(sql), [{ record_id: "call_abc" }]) };
}
const fakeTarget: LocalPostgresTarget = { libpqEnv: { PGHOST: "x" } };

function writer(sink: () => RunSink): RunWriter {
  return new RunWriter({ sink, now: () => new Date("2026-10-20T08:01:00.000Z"), read: () => record, snapshotFor: () => snapshot });
}

afterEach(() => resetRunWriter());

describe("harness run storage", () => {
  it("writes the whole run to voice_harness.harness_run", async () => {
    setRunWriteBack(true);
    const seen: string[] = [];
    const sink = defaultRunSink({ env: {}, load: () => fakeTarget, runner: () => recordingRunner(seen) });
    expect((await writer(() => sink).writeBack("call_abc")).status).toBe("written");
    const sql = seen.join("\n");
    for (const bit of CONTENT) expect(sql, bit).toContain(bit);
    expect(sql).toContain("insert into voice_harness.harness_run");
    expect(sql).not.toContain("public.harness_run");
  });

  it("write-back is off by default and the switch or variable turns it on", () => {
    setRunWriteBack(undefined);
    expect(isRunWriteBackEnabled({})).toBe(false);
    for (const off of ["false", "off", "no", "", "2"]) expect(isRunWriteBackEnabled({ VOICE_HARNESS_RUN_WRITEBACK: off }), off).toBe(false);
    for (const on of ["1", "true", "ON", " yes "]) expect(isRunWriteBackEnabled({ VOICE_HARNESS_RUN_WRITEBACK: on }), on).toBe(true);
    setRunWriteBack(false);
    expect(isRunWriteBackEnabled({})).toBe(false);
  });

  it("a missing password file or a psql failure marks the run failed and never throws into the call", async () => {
    setRunWriteBack(true);
    const missing = writer(() => defaultRunSink({ env: { VOICE_HARNESS_DATA_DIR: "/nonexistent-harness-dir" } }));
    expect(await missing.writeBack("call_abc")).toMatchObject({ status: "failed", error: "local_db_env_file_unreadable" });

    const failingExec: ExecFile = (_file, _args, _options, callback) => {
      setImmediate(() => callback(new Error("psql: could not connect; secret text"), "", "secret text"));
      return { stdin: { end: () => undefined } };
    };
    const broken = writer(() => defaultRunSink({ env: {}, load: () => fakeTarget, runner: (target) => createPsqlRunner(target, failingExec) }));
    expect(await broken.writeBack("call_abc")).toMatchObject({ status: "failed", error: "local_db_error" });
  });

  it("a write still queued when the switch is turned off does not run", async () => {
    setRunWriteBack(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserts = 0;
    const sink: RunSink = { insertIgnore: async () => (inserts++, await gate, true), update: async () => undefined };
    const w = writer(() => sink);
    const first = w.writeBack("call_abc");
    const second = w.writeBack("call_abc");
    await new Promise((r) => setImmediate(r));
    setRunWriteBack(false);
    release();
    await first;
    expect(await second).toMatchObject({ status: "refused", error: "run_writeback_off" });
    expect(inserts).toBe(1);
  });

  it("the run writer's own default sink is the harness database, and fails cleanly without its password file", async () => {
    setRunWriteBack(true);
    const own = new RunWriter({ now: () => new Date("2026-10-20T08:01:00.000Z"), read: () => record, snapshotFor: () => snapshot });
    // Test setup points the database file at a path that does not exist.
    expect(await own.writeBack("call_abc")).toMatchObject({ status: "failed", error: "local_db_env_file_unreadable" });
  });

  it("with write-back off, writing one call again is refused and the sink is never made", async () => {
    setRunWriteBack(false);
    let made = 0;
    const result = await writer(() => {
      made++;
      return { insertIgnore: async () => true, update: async () => undefined } satisfies RunSink;
    }).writeBack("call_abc");
    expect(result).toMatchObject({ status: "refused", error: "run_writeback_off" });
    expect(made).toBe(0);
  });


  it("name where run records go, by name only, for the log and /api/state", () => {
    setRunWriteBack(undefined);
    const harness = describeRunStore({});
    expect(harness).toEqual({ kind: "local", table: "voice_harness.harness_run", writeBack: false, talkWriteBack: false });
    expect(runStoreLogLine(harness)).toBe("Run records: database on this machine, voice_harness.harness_run, write-back off, Talk calls off");
    setRunWriteBack(false);
    expect(describeRunStore({}).writeBack).toBe(false);
  });
});
