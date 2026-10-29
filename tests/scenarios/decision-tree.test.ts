import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { CallHarness, deriveCallKey, type ScenarioRunOptions } from "../../src/harness/call-harness.js";
import { getDecisionRegistry, resetDecisionRegistry, sanitizeDecision } from "../../src/decision/registry.js";
import { loadTree, toTreeView, TreeValidationError } from "../../src/decision/tree.js";
import { loadActiveTree, resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { placeOutboundAttempts } from "../../src/decision/outbound-attempts.js";
import { ClearedInteractiveCall } from "../../src/decision/interactive-call.js";
import { startInteractiveCall } from "../../src/decision/interactive.js";
import { extractCallerDetails, extractTime } from "../../src/decision/extract.js";
import { TreeDialog, type TreeDialogDeps } from "../../src/decision/engine.js";
import { DecisionModuleRegistry } from "../../src/decision/registry.js";
import { FULL_TREE_FILE } from "../../src/decision/tree-source.js";
import type { DecisionModule, DecisionRequest, DecisionResult } from "../../src/decision/types.js";
import { buildState } from "../../src/decision-models/state.js";
import { newCallContext, runWithTrace } from "../../src/trace/events.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import { resetJudges } from "../../src/judge/index.js";
import type { Judge, JudgeAction, JudgeRequest } from "../../src/judge/types.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const REASON = "text_agreed_callback";
const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const OUTSIDE_WINDOW = "2026-10-15T02:00:00.000Z";

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "decision-test-")));
  traceBus.reset();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE; // these tests assume the stub tree
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

const harness = (iso = IN_WINDOW, deps: ConstructorParameters<typeof CallHarness>[3] = {}) =>
  new CallHarness(clockAt(iso), undefined, getModuleRegistry(), deps);

const tree: ScenarioRunOptions["agent"] = "decision_tree";
let keySeq = 0;
const inbound = (h: CallHarness, callerUtterances: string[]) =>
  h.runInbound("lead-1", "+15550143", { idempotencyKey: `in-${++keySeq}`, agent: tree, callerUtterances });

const eventsOf = (recordId: string | undefined): TraceEvent[] => recordStore.read(recordId!)!.events;
const ofType = (events: TraceEvent[], type: TraceEvent["type"]) => events.filter((e) => e.type === type);
const tools = (events: TraceEvent[]) => ofType(events, "tool_call").map((e) => e.data.tool);
const agentLines = (events: TraceEvent[]) =>
  ofType(events, "transcript_final").filter((e) => e.data.role === "agent").map((e) => String(e.data.text));

/** The rule judge, except that it refuses one named action. */
const refusing = (action: JudgeAction): Judge => {
  const rules = new RuleBasedJudge();
  return {
    id: `refuse-${action}`,
    judge: async (req: JudgeRequest) =>
      req.action === action
        ? { allowed: false, reason: "refused for the test", scores: [{ criterion: "test", score: 0, note: "refused for the test" }] }
        : rules.judge(req),
  };
};

/** The actions a tree answer can take; the flow tool catalog's own actions are only reached through its tools. */
type TreeAction = Exclude<JudgeAction, "send_email" | "start_quote" | "set_eligibility" | "cancel_booking">;
const FLOWS: Record<TreeAction, { lines: string[]; sideEffect: () => boolean; tool: string }> = {
  transfer: { lines: ["Hi", "I want to talk to a real person"], sideEffect: () => false, tool: "transfer_to_human" },
  save_quote_field: {
    lines: ["Hi", "I need a quote", "It is a 2019 Honda"],
    sideEffect: () => getLead("lead-1")!.quoteFields.vehicle_year !== undefined,
    tool: "write_quote_field",
  },
  save_details: {
    lines: ["Hi", "I want to leave a message", "Please tell Tom the roof claim photos are ready"],
    sideEffect: () => getLead("lead-1")!.messages.length > 0,
    tool: "save_message",
  },
  book: {
    lines: ["Hi", "I want to book an appointment", "tomorrow at 3 pm", "yes"],
    sideEffect: () => getLead("lead-1")!.bookings.length > 0,
    tool: "book_producer",
  },
  send_text: {
    lines: ["Hi", "I want to leave a message", "Please tell Tom the roof claim photos are ready", "yes please"],
    sideEffect: () => getCallLogs().some((l) => l.channel === "sms" && l.outcome === "message_sent"),
    tool: "",
  },
  end_with_disposition: { lines: ["Hi", "no thanks, I am not interested"], sideEffect: () => false, tool: "record_disposition" },
};

describe("the decision tree", () => {
  it("loads the stub tree, which covers every step and the dispositions", () => {
    const t = loadActiveTree();
    const steps = new Set(Object.values(t.nodes).map((n) => n.flowStep));
    for (const step of ["disclosure", "recognize_lead", "discovery", "quote_fields", "objection", "booking", "message"]) {
      expect(steps.has(step as never)).toBe(true);
    }
    expect(t.dispositions.find((d) => d.name === "not_interested")?.durable).toBe(true);
    expect(t.dispositions.find((d) => d.name === "do_not_contact")?.durable).toBe(true);
  });

  it("rejects a broken tree before any call, listing every problem", () => {
    const broken = {
      id: "x", start: "a", escalation: { say: "s", disposition: "d" }, dispositions: [{ name: "d", durable: false }],
      nodes: [{ id: "a", label: "A", decision: { question: "q", answers: [{ answer: "yes", next: "missing", minConfidence: 2 }] } }],
    };
    try {
      loadTree(broken);
      throw new Error("should not load");
    } catch (err) {
      expect(err).toBeInstanceOf(TreeValidationError);
      const text = (err as Error).message;
      expect(text).toContain("missing node missing");
      expect(text).toContain('no "unclear" answer');
      expect(text).toContain("minConfidence");
      expect(text).toContain("clarifying line");
    }
  });

  it("serves the shape the views read", () => {
    const view = toTreeView(loadActiveTree());
    expect(view.start).toBe("disclosure");
    const discovery = view.nodes.find((n) => n.id === "discovery")!;
    expect(discovery.question).toBeTruthy();
    expect(discovery.minConfidence).toBeGreaterThan(0);
    expect(discovery.edges).toContainEqual({ answer: "quote", to: "quote_fields" });
    expect(discovery.edges).toContainEqual({ answer: "not_interested", to: "end_not_interested" });
    expect(discovery.edges).toContainEqual({ answer: "unclear", to: null });
    expect(view.nodes.find((n) => n.id === "end_not_interested")).toMatchObject({ disposition: "not_interested", edges: [] });
    expect(view.dispositions).toContain("do_not_contact");
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const n of view.nodes) for (const e of n.edges) if (e.to) expect(ids.has(e.to)).toBe(true);
  });
});

describe("clarifying lines", () => {
  it("routes an unclear answer to the clarifying line and does nothing else", async () => {
    const r = await inbound(harness(), ["Hi", "hmm well"]);
    const events = eventsOf(r.recordId);
    const decisions = ofType(events, "decision");
    const unclear = decisions.filter((d) => d.data.nodeId === "discovery");
    expect(unclear[0]!.data).toMatchObject({ answer: "unclear", routed: "clarify" });
    expect(agentLines(events)).toContain(loadActiveTree().nodes.discovery!.clarify);
    expect(tools(events).filter((t) => ["write_quote_field", "book_producer", "save_message", "transfer_to_human"].includes(String(t)))).toEqual([]);
  });

  it("routes a low-confidence answer to the clarifying line, even though the answer is allowed", async () => {
    const jev = getDecisionRegistry().get("jev-mock");
    const real = jev.decide.bind(jev);
    vi.spyOn(jev, "decide").mockImplementation(async (req) =>
      req.nodeId === "discovery" ? { answer: "quote", confidence: 0.4, reason: "weak match" } : real(req),
    );
    const r = await inbound(harness(), ["Hi", "something about a quote maybe"]);
    const events = eventsOf(r.recordId);
    const low = ofType(events, "decision").find((d) => d.data.nodeId === "discovery" && d.data.confidence === 0.4)!;
    expect(low.data).toMatchObject({ answer: "quote", routed: "clarify", minConfidence: 0.65, module: "jev-mock" });
    expect(agentLines(events).at(-1)).toBe(loadActiveTree().nodes.discovery!.clarify);
    expect(ofType(events, "node_enter").some((n) => n.data.nodeId === "quote_fields")).toBe(false);
  });

  it("brings in a person after the clarifying line has been asked twice in a row", async () => {
    const r = await inbound(harness(), ["Hi", "hmm", "uh"]);
    const events = eventsOf(r.recordId);
    expect(tools(events)).toContain("transfer_to_human");
    expect(ofType(events, "disposition").map((d) => d.data.value)).toContain("handed_off");
  });

  it("with no decision module switched on, every question is a clarifying line", async () => {
    const reg = getDecisionRegistry();
    reg.setEnabled("jev-mock", false);
    const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { decisions: reg }).runInbound("lead-1", "+1", {
      idempotencyKey: "none", agent: tree, callerUtterances: ["Hi, I need a quote"],
    });
    const d = ofType(eventsOf(r.recordId), "decision")[0]!;
    expect(d.data).toMatchObject({ module: "none", routed: "clarify" });
  });
});

describe("the judge gate", () => {
  it("allows the actions the rules support", async () => {
    const r = await inbound(harness(), ["Hi, I am Jane", "I need an auto quote", "It is a 2019 Honda", "no that is all"]);
    expect(getLead("lead-1")!.quoteFields.vehicle_year?.value).toBe("2019");
    const verdicts = ofType(eventsOf(r.recordId), "judge_verdict");
    expect(verdicts.map((v) => [v.data.action, v.data.allowed])).toEqual([
      ["save_quote_field", true],
      ["end_with_disposition", true],
    ]);
  });

  for (const action of Object.keys(FLOWS) as TreeAction[]) {
    it(`a refusal blocks ${action}: it does not run, the verdict says no, and the block is logged`, async () => {
      const flow = FLOWS[action];
      const r = await inbound(harness(IN_WINDOW, { judge: refusing(action) }), flow.lines);
      const events = eventsOf(r.recordId);
      const verdict = ofType(events, "judge_verdict").find((v) => v.data.action === action)!;
      expect(verdict.data.allowed).toBe(false);
      expect(verdict.data.scores).toBeTruthy();
      expect(flow.sideEffect()).toBe(false);
      if (flow.tool) expect(tools(events)).not.toContain(flow.tool);
      expect(getCallLogs().some((l) => l.outcome === "blocked" && l.reason === `judge_refused:${action}`)).toBe(true);
    });

    it(`the same dialog does run ${action} when nothing refuses it`, async () => {
      const flow = FLOWS[action];
      const r = await inbound(harness(), flow.lines);
      const events = eventsOf(r.recordId);
      expect(ofType(events, "judge_verdict").some((v) => v.data.action === action && v.data.allowed === true)).toBe(true);
      if (flow.tool) expect(tools(events)).toContain(flow.tool);
    });
  }

  it("a judge that throws lets the action proceed, with an error code and no text in the trace", async () => {
    const broken: Judge = { id: "broken", judge: async () => { throw new Error("secret down detail"); } };
    const r = await inbound(harness(IN_WINDOW, { judge: broken }), FLOWS.save_quote_field.lines);
    expect(getLead("lead-1")!.quoteFields.vehicle_year).toMatchObject({ value: "2019" });
    const events = eventsOf(r.recordId);
    expect(ofType(events, "judge_verdict")[0]!.data.allowed).toBe(true);
    const errors = ofType(events, "judge_error");
    expect(errors[0]!.data).toEqual({ action: "save_quote_field", code: "judge_threw" });
    expect(JSON.stringify(events)).not.toContain("secret down detail");
  });

  it("a judge that returns an invalid verdict lets the action proceed with a code", async () => {
    const bad = { id: "bad", judge: async () => ({ nonsense: true }) } as unknown as Judge;
    const r = await inbound(harness(IN_WINDOW, { judge: bad }), FLOWS.save_quote_field.lines);
    expect(getLead("lead-1")!.quoteFields.vehicle_year).toMatchObject({ value: "2019" });
    expect(ofType(eventsOf(r.recordId), "judge_error")[0]!.data).toEqual({ action: "save_quote_field", code: "judge_invalid_verdict" });
  });

  describe("the local rules", () => {
    const now = new Date(IN_WINDOW);
    const turn = (role: "agent" | "caller", text: string, turnIndex: number) => ({ role, text, turnIndex, spoken: true });
    const base = [turn("agent", inboundOpeningScript(), -1), turn("caller", "Hi", 0)];
    const judge = new RuleBasedJudge();

    it("refuses a quote field that is not in the caller's words", async () => {
      const v = await judge.judge({
        action: "save_quote_field", nodeId: "n", direction: "inbound", transcript: [...base, turn("caller", "my car is old", 1)],
        completed: [], now, payload: { field: "vehicle_year", value: "2019", evidenceSpan: "2019" },
      });
      expect(v.allowed).toBe(false);
      expect(v.scores.find((s) => s.criterion === "value_from_callers_words")!.score).toBe(0);
    });

    it("refuses a booking with no yes or no time", async () => {
      const v = await judge.judge({
        action: "book", nodeId: "n", direction: "inbound", transcript: [...base, turn("agent", "Shall I book tomorrow at 3 PM?", 1), turn("caller", "maybe", 2)],
        completed: [], now, payload: { slotIso: "2026-10-16T19:00:00.000Z", slotWords: "tomorrow at 3 PM" },
      });
      expect(v.allowed).toBe(false);
      const failed = v.scores.filter((s) => s.score === 0).map((s) => s.criterion);
      expect(failed).toEqual(expect.arrayContaining(["time_named_by_caller", "explicit_yes"]));
    });

    it("refuses a durable ending without explicit caller words, and a hollow booked ending", async () => {
      const durable = await judge.judge({
        action: "end_with_disposition", nodeId: "n", direction: "inbound", transcript: [...base, turn("caller", "no", 1)],
        completed: [], now, payload: { disposition: "not_interested", durable: true },
      });
      expect(durable.allowed).toBe(false);
      const hollow = await judge.judge({
        action: "end_with_disposition", nodeId: "n", direction: "inbound", transcript: [...base, turn("caller", "all done", 1)],
        completed: [], now, payload: { disposition: "booked", durable: false },
      });
      expect(hollow.allowed).toBe(false);
    });

    it("refuses anything when the disclosure did not come first", async () => {
      const v = await judge.judge({
        action: "transfer", nodeId: "n", direction: "inbound", transcript: [turn("caller", "I want a real person", 0)],
        completed: [], now, payload: { reason: "caller_requested" },
      });
      expect(v.allowed).toBe(false);
    });
  });

  it("a durable ending needs the caller's words: a bare no after an objection does not take the lead off the list", async () => {
    const r = await inbound(harness(), ["Hi", "that is too expensive", "no"]);
    const events = eventsOf(r.recordId);
    expect(ofType(events, "judge_verdict").find((v) => v.data.action === "end_with_disposition")!.data.allowed).toBe(false);
    expect(ofType(events, "disposition")).toHaveLength(0);
  });

  it("a spoken stop is honored before the tree or the judge, and is recorded", async () => {
    const r = await inbound(harness(), ["Hi", "please stop calling me"]);
    const events = eventsOf(r.recordId);
    expect(tools(events)).toContain("record_stop");
    expect(ofType(events, "judge_verdict")).toHaveLength(0);
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["do_not_contact"]);
    expect(getLead("lead-1")!.consentRevokedAt).toBeTruthy();
  });
});

describe("outbound pattern", () => {
  const sequence = (h: CallHarness, outcomes: Array<"answered" | "voicemail" | "no_answer">, callerUtterances: string[] = []) =>
    placeOutboundAttempts(h, "lead-1", { idempotencyKey: "job-1", scheduledReason: "text_agreed_callback", outcomes, agent: tree, callerUtterances });

  it("places two unanswered attempts and never a third", async () => {
    const h = harness();
    const results = await sequence(h, ["no_answer", "voicemail"]);
    expect(results.map((r) => r.status)).toEqual(["not_answered", "not_answered"]);
    expect(results.map((r) => r.attempt)).toEqual([1, 2]);

    const third = await h.runOutbound("lead-1", "", { idempotencyKey: "job-1", scheduledReason: "text_agreed_callback", attempt: 3, agent: tree });
    expect(third).toMatchObject({ status: "blocked", reason: "unanswered_attempt_limit_reached" });
    // A repeat of attempt 1 or 2 after the limit is refused too.
    expect((await h.runOutbound("lead-1", "", { idempotencyKey: "job-1", scheduledReason: "text_agreed_callback", attempt: 1 })).status).toBe("blocked");
    expect(getCallLogs().filter((l) => l.direction === "outbound" && l.outcome === "placed")).toHaveLength(2);
  });

  it("leaves no message on voicemail or no answer: it hangs up, says nothing and logs it", async () => {
    const mod = getModuleRegistry().get("azure-gpt-live");
    const stream = vi.spyOn(mod, "streamTranscript");
    const results = await sequence(harness(), ["voicemail", "no_answer"]);
    expect(stream).not.toHaveBeenCalled();
    for (const r of results) {
      const events = eventsOf(r.recordId);
      expect(ofType(events, "transcript_final")).toHaveLength(0);
      expect(ofType(events, "transcript_partial")).toHaveLength(0);
      expect(ofType(events, "turn")).toHaveLength(0);
      expect(ofType(events, "text")).toHaveLength(0);
      expect(r.transcript).toBeUndefined();
      expect(tools(events)).toEqual(["bind_agent_system_instruction", "start_outbound_call", "end_call"]);
    }
    expect(ofType(eventsOf(results[0]!.recordId), "disposition")[0]!.data.value).toBe("voicemail_no_message");
    expect(ofType(eventsOf(results[1]!.recordId), "disposition")[0]!.data.value).toBe("no_answer");
    const logs = getCallLogs().filter((l) => l.reason.includes("hung_up_no_message"));
    expect(logs.map((l) => l.reason)).toEqual(["outbound_voicemail_hung_up_no_message", "outbound_no_answer_hung_up_no_message"]);
  });

  it("each attempt has its own idempotency key, and a repeated delivery of an attempt is skipped", async () => {
    const lead = baseLead();
    expect(deriveCallKey("outbound", lead, "k")).toBe(`outbound:lead-1:${lead.scheduledOutboundAt}`);
    expect(deriveCallKey("outbound", lead, "k", 2)).toBe(`outbound:lead-1:${lead.scheduledOutboundAt}:attempt-2`);
    const h = harness();
    await sequence(h, ["no_answer", "no_answer"]);
    // Attempt 1 delivered again after attempt 2 ran: over the limit, so blocked before it can dial.
    expect((await h.runOutbound("lead-1", "", { idempotencyKey: "k", scheduledReason: REASON, attempt: 1 })).status).toBe("blocked");
    // Attempt 2 requested before attempt 1 ever happened: out of order.
    resetLeadStore();
    seedLead(baseLead());
    traceBus.reset();
    recordStore.setDir(mkdtempSync(join(tmpdir(), "decision-test-")));
    expect((await h.runOutbound("lead-1", "", { idempotencyKey: "k", scheduledReason: REASON, attempt: 2 })).reason).toBe("attempt_out_of_order");
  });

  it("an answered first attempt does not open a second attempt", async () => {
    const h = harness();
    const first = await h.runOutbound("lead-1", "", { idempotencyKey: "a", scheduledReason: REASON, attempt: 1, callerUtterances: ["hi"] });
    expect(first.status).not.toBe("not_answered");
    const second = await h.runOutbound("lead-1", "", { idempotencyKey: "a", scheduledReason: REASON, attempt: 2, callerUtterances: ["hi"] });
    expect(second).toMatchObject({ status: "blocked", reason: "attempt_out_of_order" });
  });

  it("every existing gate applies to each attempt", async () => {
    const h = harness();
    const first = await h.runOutbound("lead-1", "", { idempotencyKey: "j", scheduledReason: REASON, attempt: 1, dialOutcome: "no_answer" });
    expect(first.status).toBe("not_answered");
    seedLead(baseLead({ artificialVoiceConsent: undefined, voiceConsentAt: undefined }));
    const second = await h.runOutbound("lead-1", "", { idempotencyKey: "j", scheduledReason: REASON, attempt: 2, dialOutcome: "no_answer" });
    expect(second.status).toBe("blocked");
    expect(ofType(eventsOf(second.recordId), "compliance_check").some((c) => c.data.check === "consent" && c.data.passed === false)).toBe(true);

    const late = await harness(OUTSIDE_WINDOW).runOutbound("lead-1", "", { idempotencyKey: "j2", scheduledReason: REASON, attempt: 1, dialOutcome: "no_answer" });
    expect(late.status).toBe("blocked");
  });

  it("when a person answers, the normal outbound flow runs with an AI opening, and the sequence stops", async () => {
    const results = await sequence(harness(), ["answered", "no_answer"], ["Yes this is Jane", "no thanks, I am not interested"]);
    expect(results).toHaveLength(1);
    const events = eventsOf(results[0]!.recordId);
    const lines = agentLines(events);
    expect(lines[0]).toMatch(/AI assistant/);
    expect(ofType(events, "compliance_check").some((c) => c.data.check === "disclosure_first" && c.data.passed === true)).toBe(true);
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["not_interested"]);
  });

  it("the lead calling back is an inbound call and the tree opens with the inbound disclosure", async () => {
    const h = harness();
    await sequence(h, ["no_answer", "no_answer"]);
    const back = await inbound(h, ["Hi, it is Jane", "I need a quote"]);
    expect(back.status).toBe("ai_handled");
    const events = eventsOf(back.recordId);
    expect(events[0]!.direction).toBe("inbound");
    expect(agentLines(events)[0]).toBe(inboundOpeningScript());
    const firstNode = ofType(events, "node_enter")[0]!;
    expect(firstNode.data.nodeId).toBe("disclosure");
    expect(ofType(events, "transcript_final")[0]!.recordSeq).toBeLessThan(ofType(events, "decision")[0]!.recordSeq);
  });
});

describe("play a lead", () => {
  it("emits the contract events in order, each with atMs, and ends with the score before the outcome", async () => {
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: harness() });
    expect(call.status).toBe("connected");
    await call.say("Hi, I need an auto quote");
    await call.say("It is a 2019 Honda");
    await call.hangUp();
    const events = traceBus.history().filter((e) => e.callId === call.callId);

    expect(events.every((e) => e.leadId === "lead-1" && typeof e.at === "string" && typeof e.atMs === "number")).toBe(true);
    const atMs = events.map((e) => e.atMs);
    expect(atMs).toEqual([...atMs].sort((a, b) => a - b));
    expect(events.map((e) => e.recordSeq)).toEqual(events.map((_, i) => i + 1));

    const kinds = events.map((e) => e.type);
    const firstOf = (t: string) => kinds.indexOf(t as never);
    expect(events.find((e) => e.type === "transcript_final")!.data).toMatchObject({ role: "agent", turnIndex: -1, text: inboundOpeningScript() });
    expect(firstOf("node_enter")).toBeLessThan(firstOf("decision"));
    expect(firstOf("decision")).toBeLessThan(firstOf("judge_verdict"));
    expect(firstOf("judge_verdict")).toBeLessThan(kinds.indexOf("judge_score"));
    expect(kinds.at(-1)).toBe("call_outcome");
    expect(kinds.at(-2)).toBe("judge_score");

    const decision = ofType(events, "decision")[0]!.data;
    expect(Object.keys(decision)).toEqual(expect.arrayContaining(["nodeId", "question", "answers", "answer", "confidence", "reason", "module", "minConfidence", "routed"]));
    expect(ofType(events, "transcript_final").map((e) => e.data.role)).toEqual(["agent", "caller", "agent", "caller", "agent"]);
    expect(ofType(events, "transcript_partial").length).toBeGreaterThan(0);
    const verdict = ofType(events, "judge_verdict")[0]!.data;
    expect(Object.keys(verdict)).toEqual(expect.arrayContaining(["action", "allowed", "reason", "scores"]));

    const record = recordStore.read(events[0]!.recordId)!;
    expect(record.transcript.map((t) => t.role)).toEqual(["agent", "caller", "agent", "caller", "agent"]);
    expect(record.judge?.criteria.length).toBeGreaterThan(0);
    expect(record.judge?.score).toBeGreaterThan(0);
  });

  it("outbound play opens with the AI line, and the caller can end it with a disposition", async () => {
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "outbound", harness: harness() });
    await call.say("Yes, this is Jane");
    await call.say("not interested, thanks");
    expect(call.status).toBe("ended");
    await expect(call.say("hello?")).rejects.toThrow("call_ended");
    const events = traceBus.history().filter((e) => e.callId === call.callId);
    expect(agentLines(events)[0]).toMatch(/AI assistant/);
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["not_interested"]);
  });

  it("a switched-off agency flag blocks the start, and the trace shows only the checks that ran", async () => {
    setAiCallingEnabled("agency-demo", false);
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: harness() });
    expect(call).toMatchObject({ status: "blocked", blockedReason: "ai_calling_disabled" });
    await expect(call.say("hello")).rejects.toThrow("call_not_started");
    const checks = traceBus.history().filter((e) => e.callId === call.callId && e.type === "compliance_check").map((e) => e.data.check);
    expect(checks).toEqual(["lead_found", "ai_calling_enabled"]);
    expect(traceBus.history().some((e) => e.callId === call.callId && e.type === "transcript_final")).toBe(false);
  });

  it("no artificial-voice consent blocks an outbound play", async () => {
    seedLead(baseLead({ artificialVoiceConsent: undefined, voiceConsentAt: undefined }));
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "outbound", harness: harness() });
    expect(call.status).toBe("blocked");
    expect(call.blockedReason).toMatch(/consent/);
    const checks = traceBus.history().filter((e) => e.callId === call.callId && e.type === "compliance_check");
    expect(checks.at(-1)!.data).toMatchObject({ check: "consent", passed: false });
    expect(checks.some((c) => c.data.check === "store_reach_rules")).toBe(false);
  });

  it("quiet hours block a play start", async () => {
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: harness(OUTSIDE_WINDOW) });
    expect(call.status).toBe("blocked");
    expect(call.blockedReason).toMatch(/quiet_hours/);
  });

  it("a spoken stop is recorded, the call ends, and a later start is refused", async () => {
    const h = harness();
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: h });
    await call.say("please do not call me again");
    expect(call.status).toBe("ended");
    expect(getLead("lead-1")!.consentRevokedAt).toBeTruthy();
    const events = traceBus.history().filter((e) => e.callId === call.callId);
    expect(tools(events)).toContain("record_stop");
    const again = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: h });
    expect(again.status).toBe("blocked");
  });

  it("a handle cannot be made without a genuine clearance", () => {
    const queue = { push() {}, next: async () => null, whenIdle: async () => {} };
    const params = { callId: "c", leadId: "lead-1", direction: "inbound" as const, idempotencyKey: "k", queue: queue as never, done: Promise.resolve() };
    expect(() => new ClearedInteractiveCall({ ...params, clearance: undefined as never })).toThrow("call_not_cleared");
    expect(() => new ClearedInteractiveCall({ ...params, clearance: { leadId: "lead-1", direction: "inbound", idempotencyKey: "k" } as never })).toThrow("call_not_cleared");
    // @ts-expect-error a clearance is required by type
    expect(() => new ClearedInteractiveCall(params)).toThrow("call_not_cleared");
  });
});

describe("swapping the decision module", () => {
  const dialog = ["Hi, I am Jane", "I need an auto quote", "It is a 2019 Honda", "no that is all"];

  async function run(moduleId: string) {
    resetLeadStore();
    seedLead(baseLead());
    clearCallLogs();
    getDecisionRegistry().select(moduleId);
    const r = await inbound(harness(), dialog);
    return eventsOf(r.recordId);
  }

  /** Everything the module is allowed to change is left out. */
  const shape = (events: TraceEvent[]) =>
    events
      .filter((e) => !["judge_score", "call_outcome"].includes(e.type))
      .map((e) => {
        const d = { ...e.data };
        for (const k of ["module", "latencyMs", "confidence", "reason", "durationMs", "providerCallId", "scores"]) delete d[k];
        // The voice module numbers its calls, and notes carry their filing time.
        const text = JSON.stringify(d).replace(/call_\d+/g, "call_N").replace(/"createdAt":"[^"]+"/g, '"createdAt":"T"');
        return [e.type, e.flowStep ?? null, text];
      });

  it("changes confidence, latency and the module name, and nothing else", async () => {
    const jev = await run("jev-mock");
    const openai = await run("openai-mock");
    expect(shape(openai)).toEqual(shape(jev));
    const pick = (events: TraceEvent[]) => ofType(events, "decision").find((d) => d.data.answer === "year_given")!.data;
    const a = pick(jev);
    const b = pick(openai);
    expect([a.module, b.module]).toEqual(["jev-mock", "openai-mock"]);
    expect([a.latencyMs, b.latencyMs]).toEqual([100, 450]);
    expect(a.confidence).not.toBe(b.confidence);
    expect(ofType(openai, "judge_verdict").map((v) => v.data.allowed)).toEqual(ofType(jev, "judge_verdict").map((v) => v.data.allowed));
  });

  it("validates a latency patch and keeps the old config when it is rejected", () => {
    const reg = getDecisionRegistry();
    expect(() => reg.update("jev-mock", { latencyMs: -1 })).toThrow("latency_out_of_range");
    expect(reg.get("jev-mock").getConfig().latencyMs).toBe(100);
    expect(reg.update("openai-mock", { latencyMs: 300 }).config.latencyMs).toBe(300);
    expect(() => reg.select("nope")).toThrow("unknown_decision_module");
  });
});

describe("registering any decision module", () => {
  const plain = (id: string) => ({
    id,
    label: id,
    getConfig: () => ({ enabled: true, latencyMs: 5 }),
    decide: async () => ({ answer: "unclear", confidence: 0.1, reason: "stub" }),
  });

  it("accepts a module with no settings, and refuses a duplicate name", () => {
    const reg = getDecisionRegistry();
    reg.register(plain("kev-stub"));
    expect(reg.list().map((m) => m.id)).toContain("kev-stub");
    expect(() => reg.register(plain("kev-stub"))).toThrow("duplicate_decision_module:kev-stub");
    expect(() => reg.register(plain("jev-mock"))).toThrow("duplicate_decision_module");
  });

  it("skips settings changes for a module that has none, but still selects it", async () => {
    const reg = getDecisionRegistry();
    reg.register(plain("kev-stub"));
    expect(reg.update("kev-stub", { latencyMs: 900 }).config.latencyMs).toBe(5);
    expect(() => reg.setEnabled("kev-stub", false)).not.toThrow();
    reg.select("kev-stub");
    expect(reg.activeModule()?.id).toBe("kev-stub");
    const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { decisions: reg }).runInbound("lead-1", "+1", {
      idempotencyKey: "kev", agent: tree, callerUtterances: ["Hi, I need a quote"],
    });
    expect(ofType(eventsOf(r.recordId), "decision")[0]!.data).toMatchObject({ module: "kev-stub", latencyMs: 5 });
  });
});

describe("critic fixes", () => {
  it("never hands a usable clearance to a caller: a module cannot be started directly", async () => {
    let captured: Record<string, unknown> | undefined;
    const r = await harness().runOutbound("lead-1", "", {
      idempotencyKey: "c", scheduledReason: REASON, agent: tree, callerUtterances: [], onConnected: (c) => (captured = { ...c }),
    });
    expect(r.status).toBe("placed");
    expect(captured).toBeTruthy();
    expect(Object.keys(captured!)).not.toContain("clearance");
    const mod = getModuleRegistry().get("azure-gpt-live");
    const base = { leadId: "lead-1", toNumber: "+15550167", contextPacket: {} as never, idempotencyKey: "outbound:lead-1:x" };
    await expect(mod.startOutboundCall({ ...base, clearance: undefined as never })).rejects.toThrow("call_not_cleared");
    await expect(mod.startOutboundCall({ ...base, clearance: { leadId: "lead-1", direction: "outbound", idempotencyKey: base.idempotencyKey } as never })).rejects.toThrow("call_not_cleared");
    await expect(mod.startOutboundCall({ ...base, clearance: captured as never })).rejects.toThrow("call_not_cleared");
  });

  for (const bad of [Number.NaN, undefined, 2, -0.5, Infinity, "0.9"]) {
    it(`a confidence of ${String(bad)} routes to the clarifying line`, async () => {
      const reg = getDecisionRegistry();
      const jev = reg.get("jev-mock");
      vi.spyOn(jev, "decide").mockImplementation(async () => ({ answer: "quote", confidence: bad as never, reason: "bad" }));
      const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { decisions: reg }).runInbound("lead-1", "+1", {
        idempotencyKey: `bad-${String(bad)}`, agent: tree, callerUtterances: ["Hi", "I need a quote"],
      });
      const events = eventsOf(r.recordId);
      expect(ofType(events, "decision").every((d) => d.data.routed === "clarify")).toBe(true);
      expect(ofType(events, "node_enter").some((n) => n.data.nodeId === "quote_fields")).toBe(false);
    });
  }

  it("the registry makes module output safe, and a module that throws is an unclear answer", async () => {
    const reg = getDecisionRegistry();
    reg.register({ id: "throws", label: "t", getConfig: () => ({ enabled: true, latencyMs: 0 }), decide: async () => { throw new Error("boom"); } });
    reg.select("throws");
    const out = await reg.ask({ nodeId: "n", question: "q", answers: ["yes", "unclear"], transcript: [] });
    expect(out.result).toMatchObject({ answer: "unclear", confidence: 0 });
    expect(sanitizeDecision({ answer: "maybe", confidence: 0.9, reason: "x" }, ["yes", "unclear"]).answer).toBe("unclear");
    // An invalid confidence is no answer at all, so even a zero threshold cannot let it through.
    expect(sanitizeDecision({ answer: "yes", confidence: Number.NaN, reason: "x" }, ["yes"])).toMatchObject({ answer: "unclear", confidence: 0 });
  });

  for (const bad of [Number.NaN, undefined, 2, -0.5, Infinity, "0.9"]) {
    it(`a confidence of ${String(bad)} cannot pass an answer whose threshold is zero`, async () => {
      const t = loadTree({
        id: "zero", start: "a", escalation: { say: "Let me bring in a person.", disposition: "handed_off" },
        dispositions: [{ name: "handed_off", label: "Handed off", durable: false }],
        nodes: [
          { id: "a", label: "A", agentLines: [{ line: "Hello." }], decision: { question: "q", answers: [{ answer: "yes", next: "end", minConfidence: 0, carry: false }, { answer: "unclear", minConfidence: 0 }] }, clarify: "Again?" },
          { id: "end", label: "End", agentLines: [{ line: "Thanks." }] },
        ],
      });
      const reg = getDecisionRegistry();
      vi.spyOn(reg.get("jev-mock"), "decide").mockImplementation(async () => ({ answer: "yes", confidence: bad as never, reason: "bad" }));
      const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { tree: t, decisions: reg }).runInbound("lead-1", "+1", {
        idempotencyKey: `zero-${String(bad)}`, agent: tree, callerUtterances: ["yes"],
      });
      const events = eventsOf(r.recordId);
      expect(ofType(events, "decision").every((d) => d.data.routed === "clarify")).toBe(true);
      expect(ofType(events, "node_enter").some((n) => n.data.nodeId === "end")).toBe(false);
    });
  }

  it("the scripted agent books and saves messages only through the judge", async () => {
    const scripted = (lines: string[], deps = {}) =>
      new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), deps).runInbound("lead-1", "+1", { idempotencyKey: `s-${++keySeq}`, callerUtterances: lines });
    // The scripted booking has no time named and no yes, so the rules refuse it.
    await scripted(["I want to book an appointment", "ok"]);
    expect(getLead("lead-1")!.bookings).toHaveLength(0);
    expect(getCallLogs().some((l) => l.reason === "judge_refused:book")).toBe(true);
    // A saved message is the caller's own words, so the rules allow it, and a refusing judge stops it.
    await scripted(["I want to leave a message", "tell Tom the photos are ready"], { judge: refusing("save_details") });
    expect(getLead("lead-1")!.messages).toHaveLength(0);
    resetLeadStore();
    seedLead(baseLead());
    await scripted(["I want to leave a message", "tell Tom the photos are ready"]);
    expect(getLead("lead-1")!.messages).toHaveLength(1);
  });

  it("the scripted agent writes no quote field without the judge", async () => {
    const asked: JudgeRequest[] = [];
    const denyAll: Judge = {
      id: "deny-all",
      judge: async (req) => {
        asked.push(req);
        return { allowed: false, reason: "deny all", scores: [{ criterion: "deny_all", score: 0, note: "refused" }] };
      },
    };
    const lines = ["Hi, I am Jane Doe, I need an auto quote.", "I drive a 2019 Honda Civic."];
    await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { judge: denyAll }).runInbound("lead-1", "+1", { idempotencyKey: `q-${++keySeq}`, callerUtterances: lines });
    expect(getLead("lead-1")!.quoteFields.vehicle_year).toBeUndefined();
    const quoteAsks = asked.filter((r) => r.action === "save_quote_field");
    expect(quoteAsks).toHaveLength(1);
    expect(quoteAsks[0]!.payload).toMatchObject({ field: "vehicle_year", value: "2019" });
    // The judge sees the same transcript shape as the scripted agent's other actions: the disclosure first.
    expect(quoteAsks[0]!.transcript[0]).toMatchObject({ role: "agent", text: inboundOpeningScript() });
    expect(getCallLogs().some((l) => l.reason === "judge_refused:save_quote_field")).toBe(true);
    // The rule judge allows it, because the value is in the caller's own words.
    await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry()).runInbound("lead-1", "+1", { idempotencyKey: `q-${++keySeq}`, callerUtterances: lines });
    expect(getLead("lead-1")!.quoteFields.vehicle_year?.value).toBe("2019");
  });

  it("purging the record files cannot reset the two-attempt limit", async () => {
    const h = harness();
    await placeOutboundAttempts(h, "lead-1", { idempotencyKey: "j", scheduledReason: REASON, outcomes: ["no_answer", "no_answer"], agent: tree });
    recordStore.purge();
    const third = await h.runOutbound("lead-1", "", { idempotencyKey: "j", scheduledReason: REASON, attempt: 3 });
    expect(third).toMatchObject({ status: "blocked", reason: "unanswered_attempt_limit_reached" });
    const repeat = await h.runOutbound("lead-1", "", { idempotencyKey: "j", scheduledReason: REASON, attempt: 1 });
    expect(repeat).toMatchObject({ status: "blocked", reason: "unanswered_attempt_limit_reached" });
  });
});

describe("a node with no question", () => {
  it("brings in a person instead of failing when a caller line reaches it", async () => {
    const t = loadTree({
      id: "dead", start: "a", escalation: { say: "Let me bring in a person.", disposition: "handed_off" },
      dispositions: [{ name: "handed_off", label: "Handed off", durable: false }],
      nodes: [
        { id: "a", label: "A", agentLines: [{ line: "Hello." }], decision: { question: "q", answers: [{ answer: "yes", next: "end", minConfidence: 0.5, carry: false }, { answer: "unclear", minConfidence: 0 }] }, clarify: "Again?" },
        { id: "end", label: "End", agentLines: [{ line: "Thanks." }] },
      ],
    });
    const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { tree: t }).runInbound("lead-1", "+1", {
      idempotencyKey: "dead", agent: tree, callerUtterances: ["yes", "hello?"],
    });
    const events = eventsOf(r.recordId);
    expect(tools(events)).toContain("transfer_to_human");
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["handed_off"]);
  });
});

describe("registry edge cases", () => {
  it("treats a module that reports itself off as off, and still rejects unknown names and empty ids", async () => {
    const reg = getDecisionRegistry();
    reg.register({ id: "off-stub", label: "off", getConfig: () => ({ enabled: false, latencyMs: 1 }), decide: async () => ({ answer: "unclear", confidence: 0, reason: "x" }) });
    reg.select("off-stub");
    expect(reg.activeModule()).toBeNull();
    const r = await new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { decisions: reg }).runInbound("lead-1", "+1", {
      idempotencyKey: "off", agent: tree, callerUtterances: ["Hi, I need a quote"],
    });
    expect(ofType(eventsOf(r.recordId), "decision")[0]!.data).toMatchObject({ module: "none", latencyMs: 0 });
    expect(() => reg.update("nope", { latencyMs: 1 })).toThrow("unknown_decision_module");
    expect(() => reg.setEnabled("nope", true)).toThrow("unknown_decision_module");
    expect(() => reg.register({ id: " ", label: "", getConfig: () => ({ enabled: true, latencyMs: 0 }), decide: async () => ({ answer: "unclear", confidence: 0, reason: "" }) })).toThrow("decision_module_id_required");
  });
});

describe("time extraction", () => {
  it("reads a day and a clock time in the lead's own time zone", () => {
    const t = extractTime("Tomorrow at 3 pm works", new Date(IN_WINDOW), "America/New_York")!;
    expect(t.iso).toBe("2026-10-16T19:00:00.000Z"); // 3 PM Eastern daylight time
    expect(t.words).toBe("tomorrow at 3 PM");
    expect(extractTime("sometime in the morning", new Date(IN_WINDOW), "America/New_York")).toBeNull();
  });
});

describe("caller name and business extraction", () => {
  const none = { awaiting: [], known: {} };
  it("reads the call's own lines", () => {
    expect(extractCallerDetails("Sure. My name is Pat. Lee.", none)).toEqual({ callerName: "Pat Lee" });
    expect(extractCallerDetails("Pat Lee.", { awaiting: ["callerName"], known: {} })).toEqual({ callerName: "Pat Lee" });
    expect(extractCallerDetails("Al's Pizza.", { awaiting: ["businessName"], known: { callerName: "Pat Lee" } })).toEqual({ businessName: "Al's Pizza" });
    expect(extractCallerDetails("Yeah. It's Pat and the business is Al's Pizza. You just asked me that.", none)).toEqual({ callerName: "Pat", businessName: "Al's Pizza" });
  });

  it("takes nothing from filler, questions or a name said again when the business was asked for", () => {
    const both = { awaiting: ["callerName", "businessName"] as const, known: {} };
    expect(extractCallerDetails("Sure.", { ...both, awaiting: [...both.awaiting] })).toEqual({});
    expect(extractCallerDetails("Hello?", { ...both, awaiting: [...both.awaiting] })).toEqual({});
    expect(extractCallerDetails("You called me. I'm trying to figure out who you are.", { ...both, awaiting: [...both.awaiting] })).toEqual({});
    expect(extractCallerDetails("Pat Lee.", { awaiting: ["businessName"], known: { callerName: "Pat Lee" } })).toEqual({});
    expect(extractCallerDetails("Pat Lee.", none)).toEqual({});
    expect(extractCallerDetails("My name is Pat. Can you call back?", none)).toEqual({ callerName: "Pat" });
  });

  it("reads a business after a cue, and tells a bare business from a bare name when both were asked for", () => {
    expect(extractCallerDetails("This is Pat from Al's Pizza", none)).toEqual({ callerName: "Pat", businessName: "Al's Pizza" });
    expect(extractCallerDetails("I'm the owner of Smith and Sons Roofing", none)).toEqual({ businessName: "Smith and Sons Roofing" });
    expect(extractCallerDetails("Al's Pizza", { awaiting: ["callerName", "businessName"], known: {} })).toEqual({ businessName: "Al's Pizza" });
    expect(extractCallerDetails("Pat.", { awaiting: ["callerName", "businessName"], known: {} })).toEqual({ callerName: "Pat" });
  });

  it("takes no common word or question back for a name or a business", () => {
    const both = (): { awaiting: Array<"callerName" | "businessName">; known: Record<string, string> } => ({ awaiting: ["callerName", "businessName"], known: {} });
    for (const line of ["Pardon?", "Seriously?", "Huh?", "Nobody.", "I'm Busy.", "Pat?", "Sure, Pat?"]) {
      expect(extractCallerDetails(line, both())).toEqual({});
    }
    expect(extractCallerDetails("We're Closed.", none)).toEqual({});
    expect(extractCallerDetails("We're Closed.", both())).toEqual({});
    // Real names and businesses still come through.
    expect(extractCallerDetails("Mark.", both())).toEqual({ callerName: "Mark" });
    expect(extractCallerDetails("I'm Pat.", none)).toEqual({ callerName: "Pat" });
    expect(extractCallerDetails("We're Al's Pizza.", none)).toEqual({ businessName: "Al's Pizza" });
  });
});

/**
 * A stand-in decision model that decides from what each request carries, not
 * from a script. The interrupt check reads every line it is sent, agent lines
 * included, and makes the real model's mistake from record event 82: a bare
 * "Sure." after an agent line that names artificial intelligence is taken as
 * a question about artificial intelligence. A node question takes the first
 * answer, in the request's order, whose rule fits the caller's latest line.
 */
class ReadingModel implements DecisionModule {
  readonly id = "reading-stub";
  readonly label = "Reads the request (test)";
  readonly seen: DecisionRequest[] = [];
  /** When set, every decision waits for this before answering. */
  hold?: Promise<void>;
  getConfig() {
    return { enabled: true, latencyMs: 0 };
  }
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    this.seen.push(req);
    if (this.hold) await this.hold;
    const callerLines = req.transcript.filter((t) => t.role === "caller").map((t) => t.text);
    const said = callerLines.at(-1) ?? "";
    const pick = (answer: string, confidence = 0.9): DecisionResult => ({ answer, confidence, reason: "read from the request" });
    if (req.nodeId === "interrupts") {
      const mentionsAi = (l: string) => /\b(robot|machine|artificial intelligence)\b/i.test(l);
      if (callerLines.some(mentionsAi)) return pick("asks_if_ai");
      const bareYes = /^(sure|okay|ok|yes|yeah|fine|alright)[.!]?$/i.test(said.trim());
      const agentNamedAi = req.transcript.some((t) => t.role === "agent" && mentionsAi(t.text));
      if (bareYes && agentNamedAi) return pick("asks_if_ai", 0.99);
      if (/you just asked me that/i.test(said)) return pick("upset", 0.85);
      return pick("none", 0.95);
    }
    const proper = said.replace(/^(sure|yeah|yes|okay|ok|hello|hi)\b[.,!?]?\s*/i, "");
    const otherBusiness = req.context?.lead?.business;
    const rules: Record<string, () => boolean> = {
      asks_why_we_called_or_who_this_is: () => /who (you are|is this|this is)|why did you call/i.test(said),
      returning_missed_calls: () => /you called|missed call|calling back/i.test(said),
      // A bare name in reply to "Who am I speaking with?" accepts the explanation too.
      accepts_and_will_continue: () => /^(sure|okay|ok|yes|yeah|go ahead)\b/i.test(said) || /^[A-Z][a-z']+( [A-Z][a-z']+)?\.?$/.test(said.trim()),
      annoyed_but_willing_to_talk: () => /^(sure|okay|ok|yes|yeah|fine)\b/i.test(said),
      continues_with_the_assistant: () => /^(sure|okay|ok|yes|yeah|fine)\b/i.test(said),
      names_a_different_business_than_the_record: () => Boolean(otherBusiness) && /'s\b/.test(said) && !said.includes(otherBusiness!),
      gave_name_or_business: () => /\b[A-Z][a-z']+/.test(proper),
      owner_or_decision_maker: () => /\b(i own|owner|my company|i run)\b/i.test(said),
    };
    const fits = req.answers.find((a) => rules[a]?.());
    return fits ? pick(fits) : pick("unclear");
  }
}

const allowAll: Judge = { id: "allow-all", judge: async () => ({ allowed: true, reason: "allowed for the test", scores: [] }) };

function fullTreeDialog(model: ReadingModel, extra: Partial<TreeDialogDeps> = {}): TreeDialog {
  // Loaded explicitly: beforeEach points the active tree at the stub.
  process.env.VOICE_HARNESS_DECISION_TREE = FULL_TREE_FILE;
  resetActiveTree();
  const tree = loadActiveTree();
  const decisions = new DecisionModuleRegistry();
  decisions.register(model);
  decisions.select(model.id);
  const yes = async () => true;
  return new TreeDialog({
    tree,
    decisions,
    gate: { judge: allowAll, leadId: "lead-1", callId: "call-test" },
    actions: { transfer: yes, saveQuoteField: yes, saveDetails: yes, book: yes, sendText: yes, endWithDisposition: yes },
    recorder: { record: () => {} },
    direction: "inbound",
    firstName: "Pat",
    timeZone: "America/Los_Angeles",
    clock: clockAt(IN_WINDOW),
    ...extra,
  });
}

/** Runs the dialog inside a call trace and keeps every event it emits. */
async function traced<T>(run: () => Promise<T>): Promise<{ value: T; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  const off = traceBus.subscribe((e) => events.push(e));
  try {
    const value = await runWithTrace(newCallContext("lead-1", "inbound"), run);
    return { value, events };
  } finally {
    off();
  }
}

/** Synthetic caller lines that cover the full discovery sequence. */
const RECORDED_CALLER_LINES = [
  "Hello?",
  "You called me. I'm trying to figure out who you are.",
  "Sure. My name is Pat. Lee.",
  "Pat Lee.",
  "Al's Pizza.",
  "Yeah. It's Pat and the business is Al's Pizza. You just asked me that.",
  "Sure.",
  "Sure.",
];

// Removed old company-tree identity collection cases. The Northwind renewal tree starts with consent and a renewal-role check.

describe("the dialog's methods for the voice session", () => {
  it("marks a line not said, so the decision models leave it out, and traces it", async () => {
    const model = new ReadingModel();
    const dialog = fullTreeDialog(model);
    const { events } = await traced(async () => {
      await dialog.open();
      await dialog.step("Hi, I have a missed call from this number.");
      expect(dialog.markLineNotSaid()).toBe(true);
      expect(dialog.markLineNotSaid(-1)).toBe(true);
      expect(dialog.markLineNotSaid(99)).toBe(false);
      await dialog.step("Hello?");
    });
    const cut = dialog.transcript.filter((t) => t.role === "agent" && t.spoken === false).map((t) => t.turnIndex);
    expect(cut).toEqual([-1, 1]);
    expect(events.filter((e) => e.type === "tool_call" && e.data.tool === "agent_line_not_said").map((e) => (e.data.inputs as { turnIndex: number }).turnIndex)).toEqual([1, -1]);
    // The interrupt check falls back past the unsaid line, and buildState drops it from a node question.
    const interrupt = model.seen.filter((r) => r.nodeId === "interrupts").at(-1)!;
    expect(interrupt.transcript.map((t) => t.role)).toEqual(["caller"]);
    const node = model.seen.filter((r) => r.nodeId !== "interrupts").at(-1)!;
    const state = buildState(node);
    expect(state).not.toContain("may I have your name");
    expect(state).not.toContain("This call is handled by an AI assistant");
    expect(state).toContain("Caller: Hello?");
  });

  it("stops while a step waits on the decision model: nothing is said, entered, decided or done, and nothing throws", async () => {
    const model = new ReadingModel();
    const dialog = fullTreeDialog(model);
    const { events } = await traced(async () => {
      await dialog.open();
      let release!: () => void;
      model.hold = new Promise<void>((r) => (release = r));
      const inFlight = dialog.step("Hi, I have a missed call from this number.");
      await Promise.resolve();
      const agentLinesBefore = dialog.transcript.filter((t) => t.role === "agent").length;
      dialog.stop("caller_hung_up");
      dialog.stop("caller_hung_up");
      release();
      expect(await inFlight).toEqual({ reply: "", ended: true });
      expect(dialog.transcript.filter((t) => t.role === "agent").length).toBe(agentLinesBefore);
      expect(dialog.isEnded).toBe(true);
      expect(await dialog.step("Hello?")).toEqual({ reply: "", ended: true });
    });
    const stopAt = events.findIndex((e) => e.type === "tool_call" && e.data.tool === "dialog_stopped");
    expect(stopAt).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "tool_call" && e.data.tool === "dialog_stopped")).toHaveLength(1);
    expect(events.slice(stopAt + 1).filter((e) => ["node_enter", "decision", "transcript_final", "judge_verdict"].includes(e.type))).toEqual([]);
  });

  it("stops while a step waits on the judge: the action does not run", async () => {
    const model = new ReadingModel();
    let release!: () => void;
    const judgeWaits = new Promise<void>((r) => (release = r));
    let judged = 0;
    const slowJudge: Judge = { id: "slow", judge: async () => { judged += 1; await judgeWaits; return { allowed: true, reason: "allowed", scores: [] }; } };
    const ran: string[] = [];
    const dialog = fullTreeDialog(model, {
      gate: { judge: slowJudge, leadId: "lead-1", callId: "call-test" },
      actions: {
        transfer: async () => (ran.push("transfer"), true),
        saveQuoteField: async () => true,
        saveDetails: async () => true,
        book: async () => true,
        sendText: async () => true,
        endWithDisposition: async () => (ran.push("end"), true),
      },
    });
    await traced(async () => {
      await dialog.open();
      // Two unclear lines at the greeting bring in a person through the judge.
      await dialog.step("Hmm.");
      const inFlight = dialog.step("Hmm.");
      for (let i = 0; i < 20 && judged === 0; i++) await new Promise((r) => setTimeout(r, 1));
      expect(judged).toBe(1);
      dialog.stop();
      release();
      expect(await inFlight).toEqual({ reply: "", ended: true });
    });
    expect(ran).toEqual([]);
  });
});
