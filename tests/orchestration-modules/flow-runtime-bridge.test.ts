import { beforeEach, describe, expect, it, vi } from "vitest";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { resetHarnessConfig } from "../../src/config.js";
import { createFlowDispatcher } from "../../src/flow-tools/dispatch.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { Judge, JudgeVerdict } from "../../src/judge/types.js";
import { describeRow, eventsFor, summarize } from "../../src/server/live-view-core.js";
import { createFlowRuntimeBridge, type FlowReply } from "../../src/server/voice/flow-runtime-bridge.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { newCallContext, runWithTrace, traceBus, type TraceEvent } from "../../src/trace/events.js";
import { AGENCY_ID } from "../helpers/fake-db.js";
import { baseLead } from "../helpers/fixtures.js";

const NOW = "2026-10-15T14:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const LEAD = "lead-1";
const CALL = "call_flow_bridge_1";

class RefusingJudge implements Judge {
  readonly id = "refusing-stub";
  async judge(): Promise<JudgeVerdict> {
    return { allowed: false, reason: "the stub judge refuses everything", scores: [{ criterion: "stub", score: 0, note: "refused" }] };
  }
}

function make(judge: Judge = new RuleBasedJudge()) {
  const onStop = vi.fn(async (_text: string) => undefined);
  const gate = { judge, leadId: LEAD, callId: CALL };
  const dispatcher = createFlowDispatcher({ leadId: LEAD, callId: CALL, agencyId: AGENCY_ID, direction: "inbound", clock, gate, store: mockLeadStore, onStop });
  const sent: FlowReply[] = [];
  const bridge = createFlowRuntimeBridge({ dispatcher, gate, direction: "inbound", clock, send: (m) => sent.push(m) });
  return { bridge, dispatcher, onStop, sent };
}

async function traced(fn: () => Promise<void>): Promise<TraceEvent[]> {
  const ctx = newCallContext(LEAD, "inbound");
  await runWithTrace(ctx, fn);
  return traceBus.history().filter((e) => e.recordId === ctx.recordId);
}

const HANG_UP_GATE = {
  type: "judge_request",
  function: "decide_open_silence_or_noise",
  answer: "line_drops_or_caller_hangs_up",
  node: "open.silence_or_noise",
  treeNode: "open.silence_or_noise",
  judge: { codeRules: ["the caller's own words back it"], question: "Is this true?", minConfidence: 0.7 },
  action: null,
  disposition: "hung_up",
};

beforeEach(() => {
  resetHarnessConfig();
  resetLeadStore();
  clearCallLogs();
  traceBus.reset();
  seedLead(baseLead({ id: LEAD }));
});

describe("flow runtime bridge", () => {
  it("turns node_enter and decision into the trace events the tree panel reads", async () => {
    const { bridge, dispatcher } = make();
    const events = await traced(async () => {
      expect(await bridge.handle({ type: "node_enter", node: "open.greeting", treeNode: "open.greeting", label: "Greeting", flowStep: "recognize_lead" })).toBe(true);
      await bridge.handle({ type: "decision", node: "open.greeting", treeNode: "open.greeting", function: "decide_open_greeting", answer: "wants_a_quote", router: "pipecat_flows" });
      await bridge.handle({ type: "decision", node: "open.greeting", treeNode: "open.greeting", function: "interrupt", answer: "upset", router: "pipecat_flows" });
      await bridge.handle({ type: "node_enter", node: "compliance.upset_deescalate.via.upset", treeNode: "compliance.upset_deescalate", label: "Upset" });
    });
    const enters = events.filter((e) => e.type === "node_enter");
    expect(enters[0]).toMatchObject({ flowStep: "recognize_lead", data: { nodeId: "open.greeting", label: "Greeting" } });
    expect(enters[1]!.data).toMatchObject({ nodeId: "compliance.upset_deescalate", label: "Upset", flowNode: "compliance.upset_deescalate.via.upset" });
    const decisions = events.filter((e) => e.type === "decision");
    expect(decisions[0]).toMatchObject({
      flowStep: "recognize_lead",
      data: { nodeId: "open.greeting", answer: "wants_a_quote", module: "pipecat_flows", router: "pipecat_flows", routed: "proceed" },
    });
    expect(decisions[1]!.data).toMatchObject({ nodeId: "interrupts", answer: "upset" });
    expect(dispatcher.state.nodeId).toBe("compliance.upset_deescalate");
    // The live view's summary reads the latest node and decision from these events.
    const summary = summarize(eventsFor(events));
    expect(describeRow(decisions[0]!)).toMatchObject({ kind: "decision", bad: false });
    expect(summary.nodeId).toBe("compliance.upset_deescalate");
    expect(summary.decision).toMatchObject({ nodeId: "interrupts", answer: "upset" });
  });

  it("answers a judge request with allow when the harness judge allows it, and with a refusal otherwise", async () => {
    const allowing = make();
    const events = await traced(async () => {
      await allowing.bridge.handle({ type: "agent_turn", text: inboundOpeningScript() });
      await allowing.bridge.handle({ type: "caller_turn", text: "Sorry, I have to go now." });
      await allowing.bridge.handle({ ...HANG_UP_GATE, requestId: "flow-1" });
    });
    expect(allowing.sent).toEqual([{ type: "flow_reply", requestId: "flow-1", result: { allow: true, reason: expect.any(String) } }]);
    expect(events.filter((e) => e.type === "judge_verdict").map((e) => e.data.allowed)).toEqual([true]);

    // No disclosure and no caller words: the code rules refuse.
    const bare = make();
    await traced(async () => {
      await bare.bridge.handle({ ...HANG_UP_GATE, requestId: "flow-2" });
    });
    expect(bare.sent[0]).toMatchObject({ requestId: "flow-2", result: { allow: false } });

    // An injected judge that refuses wins over the code rules.
    const refusing = make(new RefusingJudge());
    await traced(async () => {
      await refusing.bridge.handle({ type: "agent_turn", text: inboundOpeningScript() });
      await refusing.bridge.handle({ type: "caller_turn", text: "Sorry, I have to go now." });
      await refusing.bridge.handle({ ...HANG_UP_GATE, requestId: "flow-3" });
    });
    expect(refusing.sent[0]).toEqual({ type: "flow_reply", requestId: "flow-3", result: { allow: false, reason: "the stub judge refuses everything" } });

    // An action the judge does not know is refused without asking.
    const unknown = make();
    await unknown.bridge.handle({ ...HANG_UP_GATE, requestId: "flow-4", action: { type: "launch" }, disposition: null });
    expect(unknown.sent[0]).toMatchObject({ result: { allow: false } });
  });

  it("judges an ending after its action with the action counted, and counts it only once the runtime took the answer", async () => {
    const { bridge, sent } = make();
    const transferGate = { ...HANG_UP_GATE, function: "decide_close_offer", answer: "yes_transfer", action: { type: "transfer", reason: "caller_requested" }, disposition: "handed_off" };
    const events = await traced(async () => {
      await bridge.handle({ type: "agent_turn", text: inboundOpeningScript() });
      await bridge.handle({ type: "caller_turn", text: "Can I talk to a real person?" });
      await bridge.handle({ ...transferGate, requestId: "flow-1" });
      // The runtime stopped waiting: the transfer was not taken, so a later handed_off ending is refused.
      await bridge.handle({ type: "judge_verdict", function: transferGate.function, answer: transferGate.answer, allowed: false, timedOut: true, latencyMs: 2000 });
      await bridge.handle({ ...HANG_UP_GATE, requestId: "flow-2", disposition: "handed_off" });
    });
    expect(sent[0]).toMatchObject({ requestId: "flow-1", result: { allow: true } });
    expect(events.filter((e) => e.type === "judge_verdict").map((e) => [e.data.action, e.data.allowed])).toEqual([
      ["transfer", true],
      ["end_with_disposition", true],
      ["end_with_disposition", false],
    ]);
    expect(sent[1]).toMatchObject({ requestId: "flow-2", result: { allow: false } });
    expect(events.some((e) => e.type === "judge_error" && e.data.code === "judge_timed_out")).toBe(true);

    // Taken this time: the transfer counts, so the handed_off ending alone is allowed.
    await traced(async () => {
      await bridge.handle({ ...transferGate, requestId: "flow-3" });
      await bridge.handle({ type: "judge_verdict", function: transferGate.function, answer: transferGate.answer, allowed: true, timedOut: false, latencyMs: 5 });
      await bridge.handle({ ...HANG_UP_GATE, requestId: "flow-4", disposition: "handed_off" });
    });
    expect(sent[3]).toMatchObject({ requestId: "flow-4", result: { allow: true } });
  });

  it("passes a tool call to the flow dispatcher and replies with its result", async () => {
    const { bridge, sent, dispatcher } = make();
    await traced(async () => {
      await bridge.handle({ type: "tool_call", requestId: "flow-7", name: "start_quote", arguments: { line: "workers_compensation", evidence_quote: "I would like a quote" } });
      await bridge.handle({ type: "tool_call", requestId: "flow-8", name: "record_stop", arguments: {} });
    });
    expect(sent[0]).toEqual({
      type: "flow_reply",
      requestId: "flow-7",
      result: { ok: false, speakable: "A licensed producer will follow up with you about that.", refused: { code: "needs_credential", reason: expect.any(String) } },
    });
    expect(sent[1]).toMatchObject({ requestId: "flow-8", result: { ok: false, refused: { code: "unknown_tool" } } });
    expect(dispatcher.state.followUps).toHaveLength(1);
  });

  it("sends every caller turn to the stop rule, which calls onStop on a stop phrase", async () => {
    const { bridge, onStop, dispatcher } = make();
    await traced(async () => {
      await bridge.handle({ type: "caller_turn", text: "Hi, who is this?" });
      expect(onStop).not.toHaveBeenCalled();
      await bridge.handle({ type: "caller_turn", text: "Stop calling me." });
    });
    expect(onStop).toHaveBeenCalledWith("Stop calling me.");
    expect(dispatcher.state.stopped).toBe(true);
    expect(dispatcher.state.transcript.map((t) => t.text)).toEqual(["Hi, who is this?", "Stop calling me."]);
  });

  it("ignores messages it does not know", async () => {
    const { bridge, sent } = make();
    expect(await bridge.handle({ type: "something_else" })).toBe(false);
    expect(await bridge.handle(null)).toBe(false);
    expect(sent).toEqual([]);
  });
});
