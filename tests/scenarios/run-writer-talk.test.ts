import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig } from "../../src/config.js";
import { getPromptSetupRegistry } from "../../src/behaviour/prompt/setups.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { clearActiveSetup, type SetupSnapshot } from "../../src/setups/active-setup.js";
import type { Row } from "../../src/store/database-client.js";
import type { RunSink } from "../../src/setups/run-sink.js";
import {
  RUN_WRITEBACK_TALK_ENV,
  RunWriter,
  describeRunStore,
  isTalkWriteBackEnabled,
  resetRunWriter,
  runStoreLogLine,
  setRunWriteBack,
  setTalkWriteBack,
  talkSnapshotFor,
} from "../../src/setups/run-writer.js";
import { seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type HarnessRecord } from "../../src/trace/index.js";

const LEAD = "talk-lead-1";
const PROMPT_TEXT = "You are the agency's assistant. Rules follow. TALK-PROMPT-TEXT";

/** A sink in memory: inserts once per record id, then updates. */
function memorySink() {
  const rows = new Map<string, Row>();
  const inserts: Row[] = [];
  const updates: Array<{ recordId: string; patch: Row }> = [];
  const sink: RunSink = {
    insertIgnore: async (row) => {
      if (rows.has(row.record_id as string)) return false;
      rows.set(row.record_id as string, row);
      inserts.push(row);
      return true;
    },
    update: async (recordId, patch) => {
      rows.set(recordId, { ...rows.get(recordId), ...patch });
      updates.push({ recordId, patch });
    },
  };
  return { sink, rows, inserts, updates };
}

const emit = (recordId: string, type: string, data: Record<string, unknown> = {}) =>
  traceBus.emit({ type, leadId: LEAD, recordId, channel: "call", direction: "inbound", callId: recordId.replace("call_", "c_"), data } as never);

/** A Talk call as the voice manager records it: the agent context first, then turns, then the outcome. */
function talkCall(recordId: string, setupId = "default"): void {
  emit(recordId, "tool_call", { tool: "agent_context", inputs: { setupId }, result: { text: PROMPT_TEXT }, success: true, durationMs: 0 });
  emit(recordId, "turn", { role: "caller", text: "Hi, I need a quote.", turnIndex: 0, spoken: true });
  emit(recordId, "turn", { role: "agent", text: "Happy to help with that.", turnIndex: 1, spoken: true });
  emit(recordId, "call_outcome", { status: "completed", reason: "ended" });
}

beforeEach(() => {
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  clearActiveSetup();
  seedLead({ id: LEAD, agencyId: "agency-talk", name: "Talk Test Plumbing", phone: "+15550199", priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [] });
});
afterEach(() => {
  resetRunWriter();
  clearActiveSetup();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
});

describe("the Talk write-back switch", () => {
  it("is off unless the variable holds an on word, and the process override wins", () => {
    expect(isTalkWriteBackEnabled({})).toBe(false);
    for (const on of ["1", "true", "ON", " yes "]) expect(isTalkWriteBackEnabled({ [RUN_WRITEBACK_TALK_ENV]: on }), on).toBe(true);
    for (const off of ["0", "false", "off", "no", "", "2"]) expect(isTalkWriteBackEnabled({ [RUN_WRITEBACK_TALK_ENV]: off }), off).toBe(false);
    setTalkWriteBack(true);
    expect(isTalkWriteBackEnabled({})).toBe(true);
    setTalkWriteBack(false);
    expect(isTalkWriteBackEnabled({ [RUN_WRITEBACK_TALK_ENV]: "1" })).toBe(false);
  });

  it("shows in the run store description and the log line", () => {
    setRunWriteBack(undefined);
    setTalkWriteBack(undefined);
    expect(describeRunStore({})).toMatchObject({ writeBack: false, talkWriteBack: false });
    expect(runStoreLogLine(describeRunStore({}))).toBe("Run records: database on this machine, voice_harness.harness_run, write-back off, Talk calls off");
    expect(runStoreLogLine(describeRunStore({ [RUN_WRITEBACK_TALK_ENV]: "1" }))).toMatch(/Talk calls on$/);
    expect(describeRunStore({ [RUN_WRITEBACK_TALK_ENV]: "yes" }).talkWriteBack).toBe(true);
  });
});

describe("writing Talk calls without an applied setup", () => {
  it("writes nothing while the Talk switch is off", async () => {
    setRunWriteBack(true);
    setTalkWriteBack(false);
    const { sink, inserts } = memorySink();
    const writer = new RunWriter({ sink: () => sink });
    const detach = writer.attach();
    talkCall("call_talk_off");
    await writer.idle();
    detach();
    expect(inserts).toHaveLength(0);
    expect(writer.statuses()).toEqual([]);
  });

  it("needs write-back itself to be on", async () => {
    setRunWriteBack(false);
    setTalkWriteBack(true);
    const { sink, inserts } = memorySink();
    const writer = new RunWriter({ sink: () => sink });
    const detach = writer.attach();
    talkCall("call_talk_nowb");
    await writer.idle();
    detach();
    expect(inserts).toHaveLength(0);
    expect(writer.statuses()).toEqual([]);
  });

  it("with the switch on, the call outcome queues one insert with setup name talk, the resolved prompt setup, the transcript and the prompt", async () => {
    setRunWriteBack(true);
    setTalkWriteBack(true);
    const { sink, inserts, updates } = memorySink();
    const writer = new RunWriter({ sink: () => sink, now: () => new Date("2026-10-20T10:00:00.000Z") });
    const detach = writer.attach();
    talkCall("call_talk_on");
    await writer.idle();
    detach();

    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
    const row = inserts[0]!;
    const selected = getPromptSetupRegistry().selectedId();
    expect(selected).not.toBe("default");
    expect(row).toMatchObject({
      record_id: "call_talk_on",
      lead_id: LEAD,
      agency_id: "agency-talk",
      direction: "inbound",
      is_test_run: true,
      setup_name: "talk",
      voice_module_id: "azure-gpt-live",
      decision_module_id: "jev-mock",
      prompt_setup_id: selected,
      persona_id: null,
      outcome_status: "completed",
    });
    expect((row.transcript as Array<{ text: string }>).map((t) => t.text)).toEqual(["Hi, I need a quote.", "Happy to help with that."]);
    const snapshot = row.setup_snapshot as SetupSnapshot;
    expect(snapshot.renderedPrompt).toBe(PROMPT_TEXT);
    expect(snapshot.promptSetup).toMatchObject({ id: selected, label: selected, includesBriefing: false, instructions: PROMPT_TEXT });
    expect(snapshot.renderedPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.lead).toEqual({ leadId: LEAD, agencyId: "agency-talk", businessName: "Talk Test Plumbing", callCount: 0 });
    expect(snapshot.briefingGiven).toBeNull();
    expect(snapshot.persona).toBeUndefined();
    expect(writer.statuses()[0]).toMatchObject({ recordId: "call_talk_on", status: "written" });
  });

  it("a prompt setup named on the control page is kept as it is", async () => {
    setRunWriteBack(true);
    setTalkWriteBack(true);
    const { sink, inserts } = memorySink();
    const writer = new RunWriter({ sink: () => sink });
    const detach = writer.attach();
    talkCall("call_talk_named", "rules-only");
    await writer.idle();
    detach();
    expect(inserts[0]).toMatchObject({ prompt_setup_id: "rules-only" });
  });

  it("a later judge score refines the same row with an update", async () => {
    setRunWriteBack(true);
    setTalkWriteBack(true);
    const { sink, inserts, updates, rows } = memorySink();
    const writer = new RunWriter({ sink: () => sink });
    const detach = writer.attach();
    talkCall("call_talk_judge");
    await writer.idle();
    emit("call_talk_judge", "judge_verdict", { action: "start_quote", verdict: "approve" });
    emit("call_talk_judge", "judge_score", { score: 0.9, criteria: [] });
    await writer.idle();
    detach();
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.recordId === "call_talk_judge")).toBe(true);
    const row = rows.get("call_talk_judge")!;
    expect(row.judge_score).toMatchObject({ score: 0.9 });
    expect(row.judge_verdicts).toEqual([{ action: "start_quote", verdict: "approve" }]);
    expect(row.setup_name).toBe("talk");
  });

  it("the live parts can be replaced, and an unknown lead is written as unknown", async () => {
    setRunWriteBack(true);
    setTalkWriteBack(true);
    const { sink, inserts } = memorySink();
    const writer = new RunWriter({
      sink: () => sink,
      talkParts: async () => ({
        voiceModule: { id: "vapi", label: "Vapi" } as never,
        decisionModuleId: "openai-mock",
        decisionModuleLabel: "OpenAI decision model, mock",
        lead: undefined,
      }),
    });
    const detach = writer.attach();
    talkCall("call_talk_parts");
    await writer.idle();
    detach();
    expect(inserts[0]).toMatchObject({ voice_module_id: "vapi", decision_module_id: "openai-mock", agency_id: "unknown" });
    expect((inserts[0]!.setup_snapshot as SetupSnapshot).lead.businessName).toBe(LEAD);
  });
});

describe("talkSnapshotFor", () => {
  const parts = {
    voiceModule: { id: "azure-gpt-live", label: "Azure" } as never,
    decisionModuleId: "jev-mock",
    decisionModuleLabel: "Jev, mock",
    lead: { agencyId: "agency-talk", name: "Talk Test Plumbing" },
  };

  it("is pure and builds the snapshot from the record's agent context event", () => {
    talkCall("call_talk_pure", "rules-only");
    const record = recordStore.read("call_talk_pure")!;
    const a = talkSnapshotFor(record, parts);
    const b = talkSnapshotFor(record, parts);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      name: "talk",
      appliedAt: record.openedAt,
      direction: "inbound",
      voiceModule: { id: "azure-gpt-live" },
      decisionModule: { id: "jev-mock", label: "Jev, mock" },
      promptSetup: { id: "rules-only", label: "rules-only", includesBriefing: false, instructions: PROMPT_TEXT },
      renderedPrompt: PROMPT_TEXT,
      lead: { leadId: LEAD, agencyId: "agency-talk", businessName: "Talk Test Plumbing", callCount: 0 },
      briefingGiven: null,
    });
    expect(a.renderedPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.persona).toBeUndefined();
  });

  it("handles a record without an agent context event: empty prompt, default setup id", () => {
    const record = {
      recordId: "call_talk_bare",
      kind: "call",
      leadId: LEAD,
      openedAt: "2026-10-20T09:00:00.000Z",
      events: [],
      transcript: [],
      texts: [],
    } as unknown as HarnessRecord;
    const snapshot = talkSnapshotFor(record, { ...parts, lead: undefined });
    expect(snapshot.renderedPrompt).toBe("");
    expect(snapshot.promptSetup).toMatchObject({ id: "default", instructions: "" });
    expect(snapshot.renderedPromptSha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(snapshot.lead).toEqual({ leadId: LEAD, agencyId: "unknown", businessName: LEAD, callCount: 0 });
  });
});
