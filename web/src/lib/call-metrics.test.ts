import { describe, expect, it } from "vitest";
import type { SortedEvent } from "../../../src/server/live-view-core.js";
import { callStage, interimResponses, objectiveState, replyTimings, stats, toolTimings } from "./call-metrics";

let seq = 0;
const ev = (type: string, ms: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SortedEvent =>
  ({ seq: ++seq, recordSeq: seq, recordId: "r", leadId: "lead-1", channel: "call", callId: "c", at: new Date(1_700_000_000_000 + ms).toISOString(), atMs: ms, ms, type, data, ...extra }) as unknown as SortedEvent;
const tool = (ms: number, name: string, inputs: Record<string, unknown>, durationMs: number, success = true) =>
  ev("tool_call", ms, { tool: name, inputs, result: null, success, durationMs });

describe("reply timings", () => {
  it("reads the direct path's reply_timing and the Voice Live row alike, newest last", () => {
    const sorted = [
      tool(1500, "reply_timing", { source: "azure_gpt_live", decisionMs: 400, callerFinalToCreateMs: 500, createToFirstAudioMs: 1000, callerFinalToFirstAudioMs: 1500 }, 1500),
      tool(9000, "voice_live_reply_timing", { source: "azure_voice_live", decisionMs: 300, createToFirstAudioMs: 700, callerFinalToFirstAudioMs: 1100 }, 700),
      tool(9500, "reply_timing", {}, 0, false),
    ];
    const rows = replyTimings(sorted);
    expect(rows.map((r) => [r.source, r.latencyMs, r.modelMs, r.decisionMs, r.estimated])).toEqual([
      ["azure_gpt_live", 1500, 1000, 400, false],
      ["azure_voice_live", 1100, 700, 300, false],
    ]);
  });

  it("sums the Deepgram sidecar's stage times per turn and marks them estimated", () => {
    const sorted = [
      tool(1000, "voice_metrics", { turn: 0, stage: "speech_to_text", kind: "time_to_first_byte", milliseconds: 200 }, 0),
      tool(1200, "voice_metrics", { turn: 0, stage: "reply", kind: "time_to_first_byte", milliseconds: 600 }, 0),
      tool(1300, "voice_metrics", { turn: 0, stage: "reply", kind: "processing", milliseconds: 900 }, 0),
      tool(1500, "voice_metrics", { turn: 0, stage: "text_to_speech", kind: "time_to_first_byte", milliseconds: 150 }, 0),
      tool(4000, "voice_metrics", { turn: 1, stage: "speech_to_text", kind: "time_to_first_byte", milliseconds: 100 }, 0),
    ];
    const rows = replyTimings(sorted);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "deepgram", latencyMs: 950, modelMs: 600, decisionMs: null, estimated: true });
  });
});

describe("tool timings and interim responses", () => {
  it("keeps only the flow tools the agent waited on, and finds short agent lines said while one ran", () => {
    const sorted = [
      ev("transcript_final", 0, { role: "caller", text: "Can you book me for Tuesday?", turnIndex: 0 }),
      tool(100, "steer_voice_model", { instruction: "x" }, 0),
      tool(2100, "thinker_tool_call", { name: "book_producer", callId: "k1" }, 1800),
      ev("transcript_final", 2600, { role: "agent", text: "Sure, one moment while I check.", turnIndex: 1 }),
      ev("transcript_final", 6000, { role: "agent", text: "You are booked for Tuesday at ten; I will text the details, and the producer will call you then.", turnIndex: 2 }),
      tool(9000, "voice_live_tool_call", { name: "send_text" }, 400, false),
    ];
    expect(toolTimings(sorted).map((t) => [t.name, t.durationMs, t.ok])).toEqual([["book_producer", 1800, true], ["send_text", 400, false]]);
    const interim = interimResponses(sorted);
    expect(interim.map((r) => [r.text, r.tool, r.explicit])).toEqual([["Sure, one moment while I check.", "book_producer", false]]);
  });

  it("reads an explicit interim_response row once, without counting its line twice", () => {
    const sorted = [
      tool(2000, "thinker_tool_call", { name: "save_message" }, 1000),
      tool(1500, "interim_response", { text: "Got it, one second.", tool: "save_message" }, 0),
      ev("transcript_final", 1500, { role: "agent", text: "Got it, one second.", turnIndex: 1 }),
    ];
    const interim = interimResponses(sorted);
    expect(interim).toHaveLength(1);
    expect(interim[0].explicit).toBe(true);
  });
});

describe("stats", () => {
  it("gives latest, median and max, ignoring missing values", () => {
    expect(stats([300, null, 100, 200])).toEqual({ latest: 200, median: 200, max: 300, count: 3 });
    expect(stats([4, 1])).toEqual({ latest: 1, median: 2.5, max: 4, count: 2 });
    expect(stats([null])).toEqual({ latest: null, median: null, max: null, count: 0 });
  });
});

describe("call stage and objectives", () => {
  it("takes the flow step from the node, or infers it from the node id, and notices the end", () => {
    const sorted = [
      ev("node_enter", 0, { nodeId: "open.greeting", label: "Greeting" }),
      ev("node_enter", 500, { nodeId: "x", label: "Confirm" }, { flowStep: "recognize_lead" }),
      ev("node_enter", 900, { nodeId: "discovery.confirm_xdate", label: "Confirm xdate" }),
    ];
    expect(callStage(sorted)).toEqual({ step: "discovery", nodeLabel: "Confirm xdate", ended: false, disposition: null, fromObjectives: false });
    expect(callStage([...sorted, ev("disposition", 1000, { value: "booked" }), ev("call_outcome", 1100, { status: "ai_handled" })])).toMatchObject({ step: "discovery", ended: true, disposition: "booked" });
    expect(callStage([])).toEqual({ step: null, nodeLabel: null, ended: false, disposition: null, fromObjectives: false });
  });

  it("with the tree off (no node after the voice session opened) the stage is the first objective not yet done", () => {
    const objectives = [
      { id: "disclosure", label: "AI disclosure given", step: "disclosure", status: "done", confidence: 0.9 },
      { id: "purpose", label: "Reason for the call stated", step: "recognize_lead", status: "done", confidence: 0.9 },
      { id: "coverage", label: "Current coverage learned", step: "discovery", status: "open", confidence: null },
      { id: "next_step", label: "Next step agreed", step: "booking", status: "open", confidence: null },
    ];
    const treeOff = [
      ev("node_enter", 72, { nodeId: "open.confirm_known_lead", label: "Confirm the known lead" }, { flowStep: "recognize_lead" }),
      tool(3448, "voice_session_open", { provider: "azure_voice_live", model: "gpt-5.1" }, 3000),
      tool(87318, "objective_check", { stage: "recognize_lead", trigger: "line", asked: 5, modelId: "azure-decision", modelKind: "real", objectives }, 900),
    ];
    expect(callStage(treeOff)).toEqual({ step: "discovery", nodeLabel: null, ended: false, disposition: null, fromObjectives: true });
    // Every objective done: the last one's step.
    const allDone = [...treeOff, tool(100_000, "objective_check", { stage: "discovery", trigger: "call_end", asked: 2, modelId: "azure-decision", modelKind: "real", objectives: objectives.map((o) => ({ ...o, status: "done", confidence: 0.9 })) }, 900)];
    expect(callStage(allDone).step).toBe("booking");
    // A node after the open: the tree is running, so it wins.
    expect(callStage([...treeOff, ev("node_enter", 90_000, { nodeId: "quote.payroll", label: "Payroll" })])).toMatchObject({ step: "quote_fields", nodeLabel: "Payroll", fromObjectives: false });
    // Before the first objective check the tree's first node stands.
    expect(callStage(treeOff.slice(0, 2))).toMatchObject({ step: "recognize_lead", fromObjectives: false });
  });

  it("reads the newest objective check and tolerates a malformed one", () => {
    const sorted = [
      tool(1000, "objective_check", { stage: "discovery", trigger: "line", asked: 7, modelId: "azure-decision", modelKind: "real", objectives: [{ id: "disclosure", label: "AI disclosure given", step: "disclosure", status: "done", confidence: 0.9 }] }, 1200),
      tool(3000, "objective_check", { stage: "discovery", trigger: "line", asked: 6, modelId: "azure-decision", modelKind: "real", objectives: [{ id: "disclosure", label: "AI disclosure given", step: "disclosure", status: "done", confidence: 0.9 }, { id: "identity", label: "Right person confirmed", step: "recognize_lead", status: "weird", confidence: "x" }, { nope: true }] }, 900),
    ];
    const state = objectiveState(sorted)!;
    expect(state.ms).toBe(3000);
    expect(state.asked).toBe(6);
    expect(state.objectives).toEqual([
      { id: "disclosure", label: "AI disclosure given", step: "disclosure", status: "done", confidence: 0.9 },
      { id: "identity", label: "Right person confirmed", step: "recognize_lead", status: "open", confidence: null },
    ]);
    expect(objectiveState([])).toBeNull();
  });
});
