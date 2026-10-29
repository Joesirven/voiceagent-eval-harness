import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled, setLegalBlocks, setTestSessionId } from "../../src/config.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { CallHarness, type ScenarioRunOptions } from "../../src/harness/call-harness.js";
import { getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { loadTree, TreeValidationError, type DecisionTree } from "../../src/decision/tree.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { placeOutboundAttempts } from "../../src/decision/outbound-attempts.js";
import { resetJudges } from "../../src/judge/index.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const REASON = "text_agreed_callback";
const IN_WINDOW = "2026-10-15T14:00:00.000Z";

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "tree-interrupts-test-")));
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

const AGENT: ScenarioRunOptions["agent"] = "decision_tree";
let keySeq = 0;

const harnessWith = (tree: DecisionTree) =>
  new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { tree });

const inbound = (h: CallHarness, callerUtterances: string[]) =>
  h.runInbound("lead-1", "+15550143", { idempotencyKey: `in-${++keySeq}`, agent: AGENT, callerUtterances });

const eventsOf = (recordId: string | undefined): TraceEvent[] => recordStore.read(recordId!)!.events;
const ofType = (events: TraceEvent[], type: TraceEvent["type"]) => events.filter((e) => e.type === type);
const tools = (events: TraceEvent[]) => ofType(events, "tool_call").map((e) => e.data.tool);
const agentLines = (events: TraceEvent[]) =>
  ofType(events, "transcript_final").filter((e) => e.data.role === "agent").map((e) => String(e.data.text));
const decisionsAt = (events: TraceEvent[], nodeId: string) => ofType(events, "decision").filter((d) => d.data.nodeId === nodeId);
const enteredNodes = (events: TraceEvent[]) => ofType(events, "node_enter").map((e) => e.data.nodeId);

const ENTRY_LINE = "How can I help you today?";
const OUTBOUND_LINE = "I am calling about the quote you asked for.";
const AI_SAY = "Yes, I am an AI assistant, and a person from the agency reviews every request.";
const HANDOFF_LINE = "Of course, I am bringing in a person from the agency now.";
const UPSET_SAY = "I am sorry about that, and I will ask the agency to follow up with you.";
const REPEAT_SAY = "I hear you, so I will pass this to the agency and let them follow up.";

/** The answers every question node shares, so any of them can be spoken at any of those nodes. */
const topicAnswers = () => [
  { answer: "quote", minConfidence: 0.6, next: "quote_node" },
  { answer: "returning_missed_calls", minConfidence: 0.9, next: "callback_node" },
  { answer: "price_objection", cues: ["too expensive"], minConfidence: 0.6, next: "objection_price" },
  { answer: "busy_objection", cues: ["busy"], minConfidence: 0.6, next: "objection_busy" },
  { answer: "unclear", minConfidence: 0.5 },
];

const questionNode = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  clarify: "Sorry, could you say that another way?",
  decision: { question: `What does the caller want at ${label}?`, answers: topicAnswers() },
  ...extra,
});

/** A small tree with an interrupt check, a repeat rule and separate entries. Plain data, so a test can break it. */
const rawTree = (overrides: Record<string, unknown> = {}) => ({
  id: "interrupt-test-tree",
  version: "1",
  start: "inbound_entry",
  maxClarifications: 3,
  starts: { inbound: "inbound_entry", outbound: "outbound_entry" },
  escalation: { say: "Let me bring in a person.", disposition: "escalated" },
  repeatRule: { say: REPEAT_SAY, disposition: "repeat_objection" },
  dispositions: [
    { name: "escalated", durable: false },
    { name: "upset_followup", durable: false },
    { name: "repeat_objection", durable: false },
    { name: "do_not_contact", durable: true },
  ],
  interrupts: {
    question: "Is the caller interrupting with something other than the answer to the question?",
    clarify: "Sorry, could you say that again?",
    answers: [
      { answer: "none", minConfidence: 0.5 },
      { answer: "unclear", minConfidence: 0.5 },
      { answer: "asks_if_ai", resume: true, say: AI_SAY, minConfidence: 0.6 },
      {
        answer: "asks_for_person",
        next: "handoff_node",
        action: { type: "transfer", reason: "caller_requested" },
        minConfidence: 0.6,
        onBlocked: { say: "I cannot connect you right now, so let me take down what you need." },
      },
      {
        answer: "upset",
        disposition: "upset_followup",
        say: UPSET_SAY,
        minConfidence: 0.6,
        onBlocked: { say: "I am sorry, let me see what I can do." },
      },
    ],
  },
  nodes: [
    questionNode("inbound_entry", "Inbound entry", { agentLines: [{ line: ENTRY_LINE, direction: "inbound" }] }),
    questionNode("outbound_entry", "Outbound entry", { agentLines: [{ line: OUTBOUND_LINE, direction: "outbound" }] }),
    { id: "quote_node", label: "Quote", agentLines: [{ line: "Great, tell me about the vehicle." }] },
    { id: "callback_node", label: "Callback", agentLines: [{ line: "Thanks for calling back." }] },
    { id: "handoff_node", label: "Handoff", flowStep: "handoff", agentLines: [{ line: HANDOFF_LINE }] },
    questionNode("objection_price", "Price objection", {
      repeatKey: "price",
      agentLines: [{ line: "Prices vary, and I can have the agency look for savings." }],
    }),
    questionNode("objection_busy", "Busy objection", {
      repeatKey: "busy",
      agentLines: [{ line: "No problem, I can keep this short." }],
    }),
  ],
  ...overrides,
});

const interruptsWith = (patch: (answers: Array<Record<string, any>>) => Array<Record<string, any>>) => {
  const base = rawTree();
  return { interrupts: { ...base.interrupts, answers: patch(base.interrupts.answers) } };
};

describe("the interrupt check", () => {
  it("carries on with the node when the answer is none or unclear, and records no interrupt decision", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["I need a quote"]);
    const events = eventsOf(r.recordId);
    expect(decisionsAt(events, "interrupts")).toHaveLength(0);
    // The node's own question ran and a quote was recognized.
    const entry = decisionsAt(events, "inbound_entry");
    expect(entry[0]!.data).toMatchObject({ answer: "quote", routed: "proceed" });
    expect(enteredNodes(events)).toContain("quote_node");
    expect(agentLines(events)).toContain("Great, tell me about the vehicle.");
  });

  it("an unclear line is passed to the node's own clarifying line", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["zzz qqq"]);
    const events = eventsOf(r.recordId);
    expect(decisionsAt(events, "interrupts")).toHaveLength(0);
    expect(decisionsAt(events, "inbound_entry")[0]!.data).toMatchObject({ answer: "unclear", routed: "clarify" });
    expect(agentLines(events)).toContain("Sorry, could you say that another way?");
  });

  it("a resuming answer says its line, asks the node's question again, and stays on the node", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["are you a robot", "I need a quote"]);
    const events = eventsOf(r.recordId);

    const interrupts = decisionsAt(events, "interrupts");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.data).toMatchObject({ answer: "asks_if_ai", routed: "proceed" });

    const lines = agentLines(events);
    expect(lines[0]).toBe(inboundOpeningScript());
    expect(lines[1]).toBe(`${AI_SAY} ${ENTRY_LINE}`);

    // No node was left. The node's own question also ran on the interrupting line, so an answer given
    // alongside would be kept; it found none there, and the second caller line answered it.
    expect(enteredNodes(events)).toEqual(["inbound_entry", "quote_node"]);
    const own = decisionsAt(events, "inbound_entry");
    expect(own).toHaveLength(2);
    expect(own[0]!.data).toMatchObject({ routed: "clarify" });
    expect(own[1]!.data).toMatchObject({ answer: "quote", routed: "proceed" });
    expect(ofType(events, "disposition")).toHaveLength(0);
  });

  it("a routing answer goes to its node, and the transfer passes through the judge", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["I want to speak to a real person"]);
    const events = eventsOf(r.recordId);

    expect(decisionsAt(events, "interrupts")[0]!.data).toMatchObject({ answer: "asks_for_person", routed: "proceed" });
    expect(decisionsAt(events, "inbound_entry")).toHaveLength(0);
    expect(enteredNodes(events)).toEqual(["inbound_entry", "handoff_node"]);

    const verdict = ofType(events, "judge_verdict").find((v) => v.data.action === "transfer")!;
    expect(verdict.data.allowed).toBe(true);
    expect(tools(events)).toContain("transfer_to_human");
    expect(agentLines(events)).toContain(HANDOFF_LINE);
  });

  it("a routing answer is stopped by a judge that refuses, and the caller hears the blocked line", async () => {
    const tree = loadTree(rawTree());
    const refusing = {
      id: "refuse-transfer",
      judge: async () => ({ allowed: false, reason: "refused for the test", scores: [{ criterion: "test", score: 0, note: "refused" }] }),
    };
    const h = new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { tree, judge: refusing as never });
    const r = await inbound(h, ["I want to speak to a real person"]);
    const events = eventsOf(r.recordId);
    expect(ofType(events, "judge_verdict").find((v) => v.data.action === "transfer")!.data.allowed).toBe(false);
    expect(tools(events)).not.toContain("transfer_to_human");
    expect(enteredNodes(events)).not.toContain("handoff_node");
    expect(agentLines(events)).toContain("I cannot connect you right now, so let me take down what you need.");
  });

  it("an answer that carries a disposition ends the call with it, judge-gated", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["this is ridiculous"]);
    const events = eventsOf(r.recordId);
    expect(decisionsAt(events, "interrupts")[0]!.data).toMatchObject({ answer: "upset", routed: "proceed" });
    expect(ofType(events, "judge_verdict").find((v) => v.data.action === "end_with_disposition")!.data.allowed).toBe(true);
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["upset_followup"]);
    expect(agentLines(events).at(-1)).toBe(UPSET_SAY);
  });

  it("emits a decision with nodeId interrupts only for real interrupts", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["hello there", "I need a quote"]);
    const events = eventsOf(r.recordId);
    // "hello there" is unclear and "I need a quote" is not an interrupt.
    expect(decisionsAt(events, "interrupts")).toHaveLength(0);

    const r2 = await inbound(harnessWith(loadTree(rawTree())), ["are you a robot", "I need a quote"]);
    const real = decisionsAt(eventsOf(r2.recordId), "interrupts");
    expect(real).toHaveLength(1);
    expect(real[0]!.data.answer).toBe("asks_if_ai");
  });

  it("a spoken stop phrase is handled by the harness stop path and the interrupt check is not consulted", async () => {
    const ask = vi.spyOn(getDecisionRegistry(), "ask");
    const r = await inbound(harnessWith(loadTree(rawTree())), ["please stop calling me"]);
    const events = eventsOf(r.recordId);

    expect(ask).not.toHaveBeenCalled();
    expect(decisionsAt(events, "interrupts")).toHaveLength(0);
    expect(ofType(events, "decision")).toHaveLength(0);
    expect(ofType(events, "judge_verdict")).toHaveLength(0);
    expect(tools(events)).toContain("record_stop");
    expect(ofType(events, "disposition").map((d) => d.data.value)).toEqual(["do_not_contact"]);
    expect(getLead("lead-1")!.consentRevokedAt).toBeTruthy();
  });

  it("a low-confidence interrupt falls through to the node's own question", async () => {
    // "is this a robot" scores below this bar for either mock decision module.
    const strict = rawTree(interruptsWith((answers) => answers.map((a) => (a.answer === "asks_if_ai" ? { ...a, minConfidence: 0.99 } : a))));
    const r = await inbound(harnessWith(loadTree(strict)), ["is this a robot but I need a quote"]);
    const events = eventsOf(r.recordId);

    const interrupts = decisionsAt(events, "interrupts");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.data).toMatchObject({ answer: "asks_if_ai", routed: "clarify" });
    expect(agentLines(events)).not.toContain(`${AI_SAY} ${ENTRY_LINE}`);
    expect(agentLines(events).some((l) => l.includes(AI_SAY))).toBe(false);

    // The node's own question ran on the same line and took its own answer.
    const own = decisionsAt(events, "inbound_entry");
    expect(own).toHaveLength(1);
    expect(own[0]!.data.answer).toBe("quote");
    expect(enteredNodes(events)).toContain("quote_node");
  });

  it("rejects a bad interrupts block: no none answer, a dangling next", () => {
    const noNone = rawTree(interruptsWith((answers) => answers.filter((a) => a.answer !== "none")));
    expect(() => loadTree(noNone)).toThrow(TreeValidationError);
    expect(() => loadTree(noNone)).toThrow('interrupts needs a "none" answer');

    const dangling = rawTree(interruptsWith((answers) => answers.map((a) => (a.answer === "asks_for_person" ? { ...a, next: "nowhere" } : a))));
    expect(() => loadTree(dangling)).toThrow("interrupts.asks_for_person.next points at missing node nowhere");

    const noUnclear = rawTree(interruptsWith((answers) => answers.filter((a) => a.answer !== "unclear")));
    expect(() => loadTree(noUnclear)).toThrow('interrupts needs a "unclear" answer');

    const goesNowhere = rawTree(interruptsWith((answers) => [...answers, { answer: "asks_to_stop", minConfidence: 0.6 }]));
    expect(() => loadTree(goesNowhere)).toThrow("interrupts.asks_to_stop goes nowhere");
  });

  it("accepts the unmodified test tree", () => {
    expect(() => loadTree(rawTree())).not.toThrow();
  });
});

describe("the repeat rule", () => {
  it("ends the call the second time the same objection class is landed on, with the line, a disposition and a handoff note", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["that is too expensive", "still too expensive for me"]);
    const events = eventsOf(r.recordId);

    expect(enteredNodes(events).filter((n) => n === "objection_price")).toHaveLength(2);
    expect(ofType(events, "judge_verdict").find((v) => v.data.action === "end_with_disposition")!.data.allowed).toBe(true);
    expect(ofType(events, "disposition").map((d) => ({ value: d.data.value, nodeId: d.data.nodeId }))).toEqual([
      { value: "repeat_objection", nodeId: "objection_price" },
    ]);
    expect(agentLines(events).at(-1)).toBe(REPEAT_SAY);

    const handoffs = ofType(events, "handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.data.filed).toBe(true);
    expect(recordStore.read(r.recordId!)!.handoffNote).toBeTruthy();
    expect(getLead("lead-1")!.handoffNotes.length).toBeGreaterThan(0);
  });

  it("does not end the call the first time", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["that is too expensive"]);
    const events = eventsOf(r.recordId);
    expect(enteredNodes(events)).toContain("objection_price");
    expect(ofType(events, "disposition")).toHaveLength(0);
    expect(agentLines(events).at(-1)).toBe("Prices vary, and I can have the agency look for savings.");
    expect(agentLines(events)).not.toContain(REPEAT_SAY);
  });

  it("does not trigger for two different keys", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["that is too expensive", "also I am busy right now"]);
    const events = eventsOf(r.recordId);
    expect(enteredNodes(events)).toEqual(expect.arrayContaining(["objection_price", "objection_busy"]));
    expect(ofType(events, "disposition")).toHaveLength(0);
    expect(agentLines(events)).not.toContain(REPEAT_SAY);
    expect(ofType(events, "handoff").some((h) => h.data.note && JSON.stringify(h.data.note).includes(REPEAT_SAY))).toBe(false);
  });

  it("does not carry the count from one call into the next", async () => {
    const h = harnessWith(loadTree(rawTree()));
    const first = await inbound(h, ["that is too expensive"]);
    const second = await inbound(h, ["that is too expensive"]);
    expect(ofType(eventsOf(first.recordId), "disposition")).toHaveLength(0);
    expect(ofType(eventsOf(second.recordId), "disposition")).toHaveLength(0);
  });

  it("rejects a repeat rule that ends with a durable disposition, or an unknown one", () => {
    const durable = rawTree({ repeatRule: { say: REPEAT_SAY, disposition: "do_not_contact" } });
    expect(() => loadTree(durable)).toThrow("repeatRule must end with a non-durable disposition");
    const unknown = rawTree({ repeatRule: { say: REPEAT_SAY, disposition: "invented" } });
    expect(() => loadTree(unknown)).toThrow("repeatRule disposition is not in the disposition list");
  });
});

describe("separate inbound and outbound entries", () => {
  const outbound = (h: CallHarness, callerUtterances: string[]) =>
    placeOutboundAttempts(h, "lead-1", { idempotencyKey: `out-${++keySeq}`, scheduledReason: REASON, outcomes: ["answered"], agent: AGENT, callerUtterances });

  it("starts an inbound call at the inbound entry with the harness disclosure", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["I need a quote"]);
    const events = eventsOf(r.recordId);
    expect(ofType(events, "node_enter")[0]!.data.nodeId).toBe("inbound_entry");
    expect(agentLines(events)[0]).toBe(inboundOpeningScript());
    expect(enteredNodes(events)).not.toContain("outbound_entry");
  });

  it("starts an outbound call at the outbound entry and the engine prefixes the call's disclosure", async () => {
    const [result] = await outbound(harnessWith(loadTree(rawTree())), ["I need a quote"]);
    const events = eventsOf(result!.recordId);
    expect(ofType(events, "node_enter")[0]!.data.nodeId).toBe("outbound_entry");
    expect(enteredNodes(events)).not.toContain("inbound_entry");
    const opening = agentLines(events)[0]!;
    expect(opening.startsWith(`${inboundOpeningScript()} `)).toBe(true);
    expect(opening).toContain(OUTBOUND_LINE);
    expect(decisionsAt(events, "outbound_entry")[0]!.data.answer).toBe("quote");
  });

  it("does not repeat the disclosure when the outbound entry line already opens with it", async () => {
    const own = `${inboundOpeningScript()} Hi Jane, I'm calling from the agency about your quote.`;
    const raw = rawTree();
    raw.nodes = raw.nodes.map((n) => (n.id === "outbound_entry" ? { ...n, agentLines: [{ line: own, direction: "outbound" as const }] } : n));
    const [result] = await outbound(harnessWith(loadTree(raw)), ["I need a quote"]);
    expect(agentLines(eventsOf(result!.recordId))[0]).toBe(own);
  });

  it("rejects a starts block that names a missing node", () => {
    expect(() => loadTree(rawTree({ starts: { inbound: "inbound_entry", outbound: "nowhere" } }))).toThrow("outbound start nowhere does not exist");
  });
});

describe("recognizing a callback", () => {
  const WEAK = "yes I am calling back";

  const missedTwice = async (h: CallHarness) => {
    const results = await placeOutboundAttempts(h, "lead-1", { idempotencyKey: `miss-${++keySeq}`, scheduledReason: REASON, outcomes: ["no_answer", "no_answer"], agent: AGENT });
    expect(results.map((x) => x.status)).toEqual(["not_answered", "not_answered"]);
  };

  it("recognizes a line that plainly says the caller is returning missed calls", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), ["I am returning your missed calls"]);
    const events = eventsOf(r.recordId);
    expect(decisionsAt(events, "inbound_entry")[0]!.data).toMatchObject({ answer: "returning_missed_calls", routed: "proceed" });
    expect(enteredNodes(events)).toContain("callback_node");
    expect(agentLines(events)).toContain("Thanks for calling back.");
  });

  it("does not take the weak line as a callback when the lead had no missed calls", async () => {
    const r = await inbound(harnessWith(loadTree(rawTree())), [WEAK]);
    const events = eventsOf(r.recordId);
    const d = decisionsAt(events, "inbound_entry")[0]!.data;
    expect(d.answer).toBe("returning_missed_calls");
    expect(d.routed).toBe("clarify");
    expect(enteredNodes(events)).not.toContain("callback_node");
  });

  it("takes the same weak line as a callback after two unanswered outbound attempts", async () => {
    const h = harnessWith(loadTree(rawTree()));
    await missedTwice(h);
    const r = await inbound(h, [WEAK]);
    const events = eventsOf(r.recordId);
    expect(events[0]!.direction).toBe("inbound");
    const d = decisionsAt(events, "inbound_entry")[0]!.data;
    expect(d).toMatchObject({ answer: "returning_missed_calls", routed: "proceed" });
    expect(enteredNodes(events)).toContain("callback_node");
  });

  it("counts the missed calls of this test session in test mode too", async () => {
    setLegalBlocks("suspended");
    setTestSessionId("callback-session");
    const h = harnessWith(loadTree(rawTree()));
    await missedTwice(h);
    const r = await inbound(h, [WEAK]);
    const d = decisionsAt(eventsOf(r.recordId), "inbound_entry")[0]!.data;
    expect(d).toMatchObject({ answer: "returning_missed_calls", routed: "proceed" });
    expect(enteredNodes(eventsOf(r.recordId))).toContain("callback_node");
  });

  it("is more confident about the same line when calls were missed", async () => {
    const without = await inbound(harnessWith(loadTree(rawTree())), [WEAK]);
    const h = harnessWith(loadTree(rawTree()));
    await missedTwice(h);
    const withMissed = await inbound(h, [WEAK]);
    const before = decisionsAt(eventsOf(without.recordId), "inbound_entry")[0]!.data.confidence as number;
    const after = decisionsAt(eventsOf(withMissed.recordId), "inbound_entry")[0]!.data.confidence as number;
    expect(after).toBeGreaterThan(before);
  });
});
