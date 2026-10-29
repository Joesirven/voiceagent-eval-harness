import { describe, expect, it } from "vitest";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../../src/decision-models/types.js";
import { CALL_OBJECTIVES, inferFlowStep, OBJECTIVE_ANSWERS } from "../../src/judging/objective-definitions.js";
import { callStage, callTranscript, ObjectivesJudge, OBJECTIVE_CHECK_TOOL, statusOf } from "../../src/judging/objectives.js";
import { TraceBus, type TraceEvent, type TraceEventInput } from "../../src/trace/events.js";

const base = { leadId: "lead-1", leadLabel: "Jane", recordId: "call_1", channel: "call" as const, direction: "inbound" as const, callId: "call_1" };
const line = (role: "caller" | "agent", text: string, turnIndex: number, spoken = true): TraceEventInput => ({ ...base, type: "transcript_final", data: { role, text, turnIndex, spoken } });

/** A stand-in model that answers from a script keyed by objective id and remembers every ask. */
function standIn(script: (id: string, request: DecisionModelRequest) => DecisionModelOutcome, kind: "mock" | "real" = "real") {
  const asks: DecisionModelRequest[] = [];
  const model: DecisionModel = {
    id: "stand-in",
    label: "Stand-in",
    kind,
    async decide(request) {
      asks.push(request);
      return script(request.nodeId.replace(/^objective\./, ""), request);
    },
  };
  return { model, asks };
}
const done = (confidence = 0.9): DecisionModelOutcome => ({ ok: true, answer: "done", confidence, reason: "said so", latencyMs: 50, modelId: "stand-in" });
const notYet = (): DecisionModelOutcome => ({ ok: true, answer: "not_yet", confidence: 0.8, reason: "not said", latencyMs: 50, modelId: "stand-in" });

/** A bus with manual timers: the test fires the settle timer itself. */
function harness(model: DecisionModel | null, settleMs = 1200) {
  const bus = new TraceBus();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const judge = new ObjectivesJudge({
    model,
    subscribe: (l) => bus.subscribe(l),
    history: () => bus.history(),
    emit: (input) => void bus.emit(input),
    settleMs,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
    },
  });
  judge.install();
  const fire = async () => { const t = timers.shift(); t?.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  const rows = () => bus.history().filter((e) => e.type === "tool_call" && e.data.tool === OBJECTIVE_CHECK_TOOL);
  return { bus, judge, timers, fire, rows };
}

describe("objective definitions", () => {
  it("answers are the closed list, every objective has a criterion per answer, and node ids map to steps", () => {
    expect(OBJECTIVE_ANSWERS).toEqual(["done", "not_yet", "unclear"]);
    for (const o of CALL_OBJECTIVES) for (const a of OBJECTIVE_ANSWERS) expect(o.criteria[a], `${o.id} ${a}`).toBeTruthy();
    expect(new Set(CALL_OBJECTIVES.map((o) => o.id)).size).toBe(CALL_OBJECTIVES.length);
    expect(inferFlowStep("open.greeting")).toBe("recognize_lead");
    expect(inferFlowStep("open.disclosure_objection")).toBe("disclosure");
    expect(inferFlowStep("discovery.confirm_xdate")).toBe("discovery");
    expect(inferFlowStep("service.book_time")).toBe("booking");
    expect(inferFlowStep("close.take_message")).toBe("message");
    expect(inferFlowStep("compliance.stop")).toBeNull();
    expect(inferFlowStep(null)).toBeNull();
  });

  it("turns a model outcome into a status: done needs confidence, not_yet is open, failures are unclear", () => {
    expect(statusOf(done(0.9))).toEqual({ status: "done", confidence: 0.9 });
    expect(statusOf(done(0.3))).toEqual({ status: "unclear", confidence: 0.3 });
    expect(statusOf(notYet())).toEqual({ status: "open", confidence: 0.8 });
    expect(statusOf({ ok: false, reason: "timeout", latencyMs: 10, modelId: "x" })).toEqual({ status: "unclear", confidence: null });
  });
});

describe("call transcript and stage from the trace", () => {
  it("keeps spoken caller and agent lines of the call only, and reads the stage from the newest node", () => {
    const bus = new TraceBus();
    bus.emit(line("agent", "Hi, this is an AI assistant.", 0));
    bus.emit({ ...base, type: "node_enter", data: { nodeId: "open.greeting", label: "Greeting" } });
    bus.emit(line("caller", "Yes this is Jane", 1));
    bus.emit(line("agent", "interrupted words", 2, false));
    bus.emit({ ...base, callId: "other", recordId: "other", type: "transcript_final", data: { role: "caller", text: "someone else", turnIndex: 0 } });
    bus.emit({ ...base, type: "node_enter", data: { nodeId: "n2", label: "Discovery" }, flowStep: "discovery" });
    const history = bus.history();
    expect(callTranscript(history, "call_1")).toEqual([
      { role: "agent", text: "Hi, this is an AI assistant.", turnIndex: 0, spoken: true },
      { role: "caller", text: "Yes this is Jane", turnIndex: 1, spoken: true },
    ]);
    expect(callStage(history, "call_1")).toBe("discovery");
  });
});

describe("objectives judge", () => {
  it("waits for a caller line, asks every objective once settled, writes one row, and does not ask done ones again", async () => {
    const { model, asks } = standIn((id) => (id === "disclosure" || id === "identity" ? done() : notYet()));
    const h = harness(model);
    h.bus.emit(line("agent", "Hi, this is Dana's AI assistant. Is this Jane?", 0));
    expect(h.timers).toHaveLength(1);
    await h.fire();
    expect(asks).toHaveLength(0);
    expect(h.rows()).toHaveLength(0);

    h.bus.emit(line("caller", "Yes, this is Jane.", 1));
    await h.fire();
    expect(asks).toHaveLength(CALL_OBJECTIVES.length);
    expect(asks[0].answers).toEqual(["done", "not_yet", "unclear"]);
    expect(asks[0].transcript.map((t) => t.role)).toEqual(["agent", "caller"]);
    expect(asks[0].answerCriteria).toBeTruthy();
    const rows = h.rows();
    expect(rows).toHaveLength(1);
    const inputs = rows[0].data.inputs as { asked: number; modelId: string; objectives: Array<{ id: string; status: string }> };
    expect(inputs.asked).toBe(CALL_OBJECTIVES.length);
    expect(inputs.modelId).toBe("stand-in");
    expect(inputs.objectives.find((o) => o.id === "disclosure")!.status).toBe("done");
    expect(inputs.objectives.find((o) => o.id === "coverage")!.status).toBe("open");
    // The model's reason never reaches the trace.
    expect(JSON.stringify(rows[0])).not.toContain("said so");

    h.bus.emit(line("agent", "Great. I am calling about your renewal.", 2));
    await h.fire();
    expect(asks).toHaveLength(CALL_OBJECTIVES.length * 2 - 2);
    expect(h.rows()).toHaveLength(2);
    expect(h.judge.resultsFor("call_1").filter((r) => r.status === "done").map((r) => r.id)).toEqual(["disclosure", "identity"]);
  });

  it("folds lines that arrive while a batch runs into one more batch", async () => {
    const pending: Array<() => void> = [];
    const { model, asks } = standIn(() => notYet());
    const slow: DecisionModel = { ...model, decide: (req, o) => new Promise((resolve) => { pending.push(() => resolve(model.decide(req, o))); }) };
    const h = harness(slow);
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
    const releaseAll = async () => { for (const release of pending.splice(0)) release(); await settle(); };
    h.bus.emit(line("caller", "hello", 0));
    await h.fire();
    expect(pending).toHaveLength(CALL_OBJECTIVES.length);
    // Two more lines while the batch is still waiting on the model: no new timer, the batch is marked pending.
    h.bus.emit(line("agent", "hi", 1));
    h.bus.emit(line("caller", "more", 2));
    expect(h.timers).toHaveLength(0);
    await releaseAll();
    expect(h.rows()).toHaveLength(1);
    // One follow-up batch for both lines, not two.
    expect(h.timers).toHaveLength(1);
    await h.fire();
    expect(pending).toHaveLength(CALL_OBJECTIVES.length);
    await releaseAll();
    expect(h.rows()).toHaveLength(2);
    expect(asks).toHaveLength(CALL_OBJECTIVES.length * 2);
    expect(h.timers).toHaveLength(0);
  });

  it("reports once per call that no decision model is configured, with every objective open", async () => {
    const h = harness(null);
    h.bus.emit(line("caller", "hello", 0));
    await h.fire();
    h.bus.emit(line("caller", "again", 1));
    await h.fire();
    const rows = h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].data.success).toBe(false);
    expect(rows[0].data.reason).toBe("no_decision_model");
    expect((rows[0].data.inputs as { objectives: unknown[] }).objectives).toHaveLength(CALL_OBJECTIVES.length);
  });

  it("treats a timeout or an answer outside the list as unclear, and judges once more at the call's end", async () => {
    const { model } = standIn((id) => (id === "closing" ? { ok: true, answer: "maybe", confidence: 1, reason: "", latencyMs: 1, modelId: "stand-in" } : id === "purpose" ? { ok: false, reason: "timeout", latencyMs: 10, modelId: "stand-in" } : notYet()));
    const h = harness(model);
    h.bus.emit(line("caller", "hello", 0));
    await h.fire();
    const first = h.rows()[0].data.inputs as { objectives: Array<{ id: string; status: string }>; trigger: string };
    expect(first.trigger).toBe("line");
    expect(first.objectives.find((o) => o.id === "closing")!.status).toBe("unclear");
    expect(first.objectives.find((o) => o.id === "purpose")!.status).toBe("unclear");
    h.bus.emit({ ...base, type: "call_outcome", data: { status: "ai_handled" } });
    expect(h.timers[0].ms).toBe(0);
    await h.fire();
    const rows = h.rows();
    expect(rows).toHaveLength(2);
    expect((rows[1].data.inputs as { trigger: string }).trigger).toBe("call_end");
    expect(h.judge.resultsFor("call_1")).toHaveLength(0);
  });

  it("never reacts to its own rows or to text channel events", async () => {
    const { model, asks } = standIn(() => notYet());
    const h = harness(model);
    h.bus.emit({ ...base, channel: "sms", callId: undefined, messageId: "m1", type: "text", data: { role: "caller", text: "hi" } } as TraceEventInput);
    h.bus.emit({ ...base, type: "tool_call", data: { tool: OBJECTIVE_CHECK_TOOL, inputs: {}, result: null, success: true, durationMs: 1 } });
    expect(h.timers).toHaveLength(0);
    expect(asks).toHaveLength(0);
  });
});

describe("judge stop", () => {
  it("stops listening and drops pending timers", async () => {
    const { model, asks } = standIn(() => notYet());
    const h = harness(model);
    h.bus.emit(line("caller", "hello", 0));
    expect(h.timers).toHaveLength(1);
    h.judge.stop();
    expect(h.timers).toHaveLength(0);
    h.bus.emit(line("caller", "again", 1));
    expect(h.timers).toHaveLength(0);
    await h.fire();
    expect(asks).toHaveLength(0);
    const unused: TraceEvent[] = h.rows();
    expect(unused).toHaveLength(0);
  });
});
