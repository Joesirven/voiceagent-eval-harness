import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import type {
  DecisionModel,
  DecisionModelCallOptions,
  DecisionModelOutcome,
  DecisionModelRequest,
} from "../../src/decision-models/types.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { guardedAction } from "../../src/judge/gate.js";
import { resetJudges } from "../../src/judge/index.js";
import type { Judge, JudgeRequest, JudgeVerdict } from "../../src/judge/types.js";
import { LiveJudge, DEFAULT_BLOCK_THRESHOLD, defaultBlockThreshold } from "../../src/judging/live-judge.js";
import { liveQuestionFor } from "../../src/judging/live-questions.js";
import type { TranscriptTurn } from "../../src/provider/interface.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { newCallContext, recordStore, runWithTrace, traceBus, type TraceEvent } from "../../src/trace/index.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const turn = (role: "agent" | "caller", text: string, turnIndex: number): TranscriptTurn => ({ role, text, turnIndex, spoken: true });

type Script = (request: DecisionModelRequest, options: DecisionModelCallOptions | undefined) => DecisionModelOutcome;

/** A small stand-in for a decision model: answers from a script and remembers what it was asked. */
function standIn(script: Script, kind: "mock" | "real" = "real") {
  const calls: Array<{ request: DecisionModelRequest; options: DecisionModelCallOptions | undefined }> = [];
  const model: DecisionModel = {
    id: "stand-in",
    label: "Stand-in",
    kind,
    async decide(request, options) {
      calls.push({ request, options });
      return script(request, options);
    },
  };
  return { model, calls };
}

const answer = (choice: string, confidence: number, latencyMs = 90): Script => () => ({
  ok: true,
  answer: choice,
  confidence,
  reason: "Jane Doe asked for it",
  latencyMs,
  modelId: "stand-in",
});
const failure = (reason: "timeout" | "error" | "off" | "invalid_answer"): Script => () => ({
  ok: false,
  reason,
  latencyMs: 300,
  modelId: "stand-in",
});

/** A clock that moves forward by `step` each time it is read, so one call measures `step`. */
const ticking = (step: number) => {
  let now = 1_000;
  return () => {
    const value = now;
    now += step;
    return value;
  };
};

const noWait = async () => {};
const NOW = new Date(IN_WINDOW);
const bookRequest = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({
  action: "book",
  nodeId: "booking",
  direction: "inbound",
  transcript: [
    turn("agent", inboundOpeningScript(), -1),
    turn("caller", "Hi, I would like to meet", 0),
    turn("caller", "tomorrow at 3 pm works, my word is zanzibar", 1),
    turn("agent", "Shall I book you for tomorrow at 3 PM?", 2),
    turn("caller", "yes", 3),
  ],
  completed: [],
  payload: { slotIso: "2026-10-16T19:00:00.000Z", slotWords: "tomorrow at 3 PM" },
  now: NOW,
  ...overrides,
});
const saveQuoteFieldRequest = (): JudgeRequest => ({
  action: "save_quote_field",
  nodeId: "quote_fields",
  direction: "inbound",
  transcript: [turn("agent", inboundOpeningScript(), -1), turn("caller", "Hi", 0), turn("caller", "it is a 2019 Honda", 1)],
  completed: [],
  payload: { field: "vehicle_year", value: "2019", evidenceSpan: "2019" },
  now: NOW,
});

/** Runs a judge inside a traced call and returns the verdict with every event the run emitted. */
async function traced(run: () => Promise<JudgeVerdict>) {
  const events: TraceEvent[] = [];
  const stop = traceBus.subscribe((e) => events.push(e));
  try {
    const verdict = await runWithTrace(newCallContext("lead-1", "inbound"), run);
    return { verdict, events };
  } finally {
    stop();
  }
}
const liveEvents = (events: TraceEvent[]) => events.filter((e) => e.type === "decision" && e.data.kind === "live_judge");

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "live-judge-test-")));
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

describe("the live judge: order and the block threshold", () => {
  it("never asks the model when the rules refuse, and says so in a decision_model line", async () => {
    const m = standIn(answer("allow", 0.99));
    const judge = new LiveJudge({ model: m.model });
    const request = bookRequest();
    request.transcript = request.transcript.slice(0, 2);
    const verdict = await judge.judge(request);
    expect(m.calls).toHaveLength(0);
    expect(verdict.allowed).toBe(false);
    const line = verdict.scores.find((s) => s.criterion === "decision_model")!;
    expect(line.score).toBe(0);
    expect(line.note).toContain("not asked");
    expect(verdict.scores.length).toBeGreaterThan(1);
  });

  it("a model that says block does not matter once the rules refused: still refused, no model asked", async () => {
    const m = standIn(answer("block", 0.99));
    const request = bookRequest();
    request.transcript = request.transcript.slice(0, 2);
    expect((await new LiveJudge({ model: m.model }).judge(request)).allowed).toBe(false);
    expect(m.calls).toHaveLength(0);
  });

  it("emits no trace event when the model was not asked", async () => {
    const judge = new LiveJudge({ model: standIn(answer("allow", 0.99)).model });
    const request = bookRequest();
    request.transcript = request.transcript.slice(0, 2);
    const { events } = await traced(() => judge.judge(request));
    expect(liveEvents(events)).toHaveLength(0);
  });

  it("proceeds when the model says allow, and asks exactly once with the budget as its timeout", async () => {
    const m = standIn(answer("allow", 0.95));
    const verdict = await new LiveJudge({ model: m.model, budgetMs: 250 }).judge(bookRequest());
    expect(verdict.allowed).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.options).toEqual({ timeoutMs: 250 });
    const line = verdict.scores.find((s) => s.criterion === "decision_model")!;
    expect(line.score).toBe(1);
    expect(line.note).toContain("stand-in");
    expect(line.note).toContain("allow");
    expect(line.note).toContain("0.70");
    expect(line.note).toContain("250 millisecond");
  });

  it("proceeds when the model says unclear, however sure it is", async () => {
    const verdict = await new LiveJudge({ model: standIn(answer("unclear", 0.99)).model }).judge(bookRequest());
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("the decision model did not ask to block the action, so it went ahead");
  });

  it("blocks when the model says block at the threshold, for a hard-to-undo and an easy action alike", async () => {
    const book = await new LiveJudge({ model: standIn(answer("block", 0.7)).model }).judge(bookRequest());
    expect(book.allowed).toBe(false);
    expect(book.reason).toBe("the decision model said to block the action with enough confidence");
    expect((await new LiveJudge({ model: standIn(answer("block", 0.95)).model }).judge(saveQuoteFieldRequest())).allowed).toBe(false);
  });

  it("does not block when the model says block below the threshold", async () => {
    const verdict = await new LiveJudge({ model: standIn(answer("block", 0.69)).model }).judge(bookRequest());
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("was not confident enough, so it went ahead");
  });

  it("takes a threshold override per action, leaving the others at the default", async () => {
    const judge = new LiveJudge({ model: standIn(answer("block", 0.6)).model, blockThresholds: { book: 0.5 } });
    expect((await judge.judge(bookRequest())).allowed).toBe(false);
    expect((await judge.judge(saveQuoteFieldRequest())).allowed).toBe(true);
    const strict = new LiveJudge({ model: standIn(answer("block", 0.9)).model, blockThresholds: { book: 0.95 } });
    expect((await strict.judge(bookRequest())).allowed).toBe(true);
  });

  it("treats an answer outside the closed list as a failure that proceeds, not a vote", async () => {
    const { verdict, events } = await traced(() => new LiveJudge({ model: standIn(answer("maybe", 0.99)).model }).judge(saveQuoteFieldRequest()));
    expect(verdict.allowed).toBe(true);
    expect(liveEvents(events)[0]!.data).toMatchObject({ ok: false, failureReason: "invalid_answer", policyApplied: "proceed", blocked: false, allowed: true });
  });
});

describe("the live judge: when the model cannot answer", () => {
  const cases: Array<[string, Script, string]> = [
    ["a timeout", failure("timeout"), "timeout"],
    ["an error", failure("error"), "error"],
    ["an off model", failure("off"), "off"],
    ["an invalid answer", failure("invalid_answer"), "invalid_answer"],
  ];
  for (const [name, script, code] of cases) {
    it(`${name} lets both a hard-to-undo and an easy action proceed, and records the failure`, async () => {
      const judge = new LiveJudge({ model: standIn(script).model, sleep: noWait });
      const book = await traced(() => judge.judge(bookRequest()));
      expect(book.verdict.allowed).toBe(true);
      expect(book.verdict.reason).toBe("the decision model could not answer, so the action went ahead");
      expect(liveEvents(book.events)[0]!.data).toMatchObject({ ok: false, failureReason: code, policyApplied: "proceed", blocked: false, allowed: true, blockThreshold: 0.7 });
      expect((await judge.judge(saveQuoteFieldRequest())).allowed).toBe(true);
    });
  }

  it("treats a late answer as a timeout and proceeds, even a block: the injected clock says it took longer than the budget", async () => {
    const m = standIn(answer("block", 0.99, 5));
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model, clock: ticking(400), attemptBudgetMs: 300, retries: 0 }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(liveEvents(events)[0]!.data).toMatchObject({ ok: false, overBudget: true, failureReason: "timeout", latencyMs: 400, attemptBudgetMs: 300 });
  });

  it("a model source that returns null counts as off and the action proceeds", async () => {
    const judge = new LiveJudge({ model: () => null });
    const { verdict, events } = await traced(() => judge.judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(verdict.scores.find((s) => s.criterion === "decision_model")!.note).toContain("no decision model");
    expect(liveEvents(events)[0]!.data).toMatchObject({ modelId: "none", ok: false, failureReason: "off", policyApplied: "proceed", allowed: true });
    expect((await judge.judge(saveQuoteFieldRequest())).allowed).toBe(true);
  });

  it("a model that throws is an error that proceeds, never a thrown error", async () => {
    const model: DecisionModel = {
      id: "broken", label: "Broken", kind: "real",
      decide: async () => { throw new Error("secret detail"); },
    };
    const { verdict, events } = await traced(() => new LiveJudge({ model, sleep: noWait }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(liveEvents(events)[0]!.data).toMatchObject({ failureReason: "error", policyApplied: "proceed" });
    expect(JSON.stringify([verdict, events])).not.toContain("secret detail");
  });

  it("looks the model up on every call when given a function", async () => {
    let configured: DecisionModel | null = null;
    const judge = new LiveJudge({ model: () => configured });
    expect((await judge.judge(saveQuoteFieldRequest())).scores.at(-1)!.note).toContain("no decision model");
    configured = standIn(answer("block", 0.95)).model;
    expect((await judge.judge(bookRequest())).allowed).toBe(false);
  });
});

describe("the live judge: trace and privacy", () => {
  it("emits exactly one decision event per model call with the agreed fields", async () => {
    const m = standIn(answer("allow", 0.91));
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model, clock: ticking(120) }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(events.filter((e) => e.type === "decision")).toHaveLength(1);
    expect(liveEvents(events)[0]!.data).toEqual({
      kind: "live_judge",
      action: "book",
      nodeId: "booking",
      modelId: "stand-in",
      modelKind: "real",
      ok: true,
      answer: "allow",
      confidence: 0.91,
      blockThreshold: 0.7,
      latencyMs: 120,
      attemptBudgetMs: 3000,
      deadlineMs: 6000,
      attemptCount: 1,
      attempts: [{ n: 1, outcome: "answered", latencyMs: 120 }],
      stoppedBy: "answered",
      totalMs: 120,
      overBudget: false,
      failureReason: null,
      policyApplied: "none",
      blocked: false,
      allowed: true,
    });
  });

  it("records the latency from the injected clock for a real model, and the model's own number for a mock", async () => {
    const real = await traced(() => new LiveJudge({ model: standIn(answer("allow", 0.95, 1)).model, clock: ticking(75) }).judge(bookRequest()));
    expect(liveEvents(real.events)[0]!.data.latencyMs).toBe(75);
    const mock = await traced(() => new LiveJudge({ model: standIn(answer("allow", 0.95, 110), "mock").model, clock: ticking(1) }).judge(bookRequest()));
    expect(liveEvents(mock.events)[0]!.data).toMatchObject({ modelKind: "mock", latencyMs: 110 });
  });

  it("puts no caller words, no model reason and no payload value in any event or in the verdict", async () => {
    const m = standIn(answer("allow", 0.95));
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model }).judge(saveQuoteFieldRequest()));
    const all = JSON.stringify([verdict, liveEvents(events)]);
    for (const word of ["Honda", "2019", "Jane Doe asked"]) expect(all).not.toContain(word);
    const withWord = await traced(() => new LiveJudge({ model: standIn(answer("block", 0.9)).model }).judge(bookRequest()));
    const text = JSON.stringify([withWord.verdict, withWord.events]);
    expect(text).not.toContain("zanzibar");
    expect(text).not.toContain("Jane Doe asked");
  });

  it("sends the model the conversation and the closed question, but only non-personal payload facts in the instructions", async () => {
    const m = standIn(answer("allow", 0.95));
    await new LiveJudge({ model: m.model }).judge(saveQuoteFieldRequest());
    const sent = m.calls[0]!.request;
    expect(sent.answers).toEqual(["allow", "block", "unclear"]);
    expect(sent.transcript.some((t) => t.text.includes("Honda"))).toBe(true);
    expect(sent.instructions).toContain("vehicle_year");
    expect(sent.instructions).not.toContain("2019");
    expect(Object.keys(sent.answerCriteria!)).toEqual(["allow", "block", "unclear"]);
  });
});

describe("the live questions", () => {
  it("covers all six actions with a closed list that always has a way out", () => {
    for (const action of ["transfer", "save_details", "save_quote_field", "book", "send_text", "end_with_disposition"] as const) {
      const q = liveQuestionFor(action, {});
      expect(q.answers).toEqual(["allow", "block", "unclear"]);
      expect(q.criteria.unclear.length).toBeGreaterThan(10);
      expect(q.instructions).toContain(action);
    }
  });

  it("states the enforcement idea of each action", () => {
    expect(liveQuestionFor("book", {}).instructions).toMatch(/named a time.*read the slot back.*plain yes/);
    expect(liveQuestionFor("transfer", {}).instructions).toMatch(/asked for a person/);
    expect(liveQuestionFor("end_with_disposition", { disposition: "not_interested", durable: true }).instructions).toMatch(
      /explicit words[\s\S]*not_interested[\s\S]*lasting|not_interested[\s\S]*lasting[\s\S]*explicit words/,
    );
  });

  it("drops a payload name that is not a short lowercase token, so free text cannot get in", () => {
    const q = liveQuestionFor("save_quote_field", { field: "Jane's phone 555-1234", value: "x" });
    expect(q.instructions).not.toContain("Jane");
    expect(q.instructions).not.toContain("555");
  });

  it("defaults: one block threshold of 0.7 for every action", () => {
    expect(DEFAULT_BLOCK_THRESHOLD).toBe(0.7);
    for (const action of ["transfer", "save_details", "save_quote_field", "book", "send_text", "end_with_disposition"] as const) {
      expect(defaultBlockThreshold(action)).toBe(0.7);
    }
  });
});

describe("the live judge through the gate", () => {
  it("guardedAction runs the action unless the model blocks it with enough confidence", async () => {
    let ran = 0;
    const run = async () => ++ran;
    const gate = (choice: string): { judge: Judge; leadId: string; callId: string } => ({
      judge: new LiveJudge({ model: standIn(answer(choice, 0.95)).model }),
      leadId: "lead-1",
      callId: "call-1",
    });
    const ok = await runWithTrace(newCallContext("lead-1", "inbound"), () => guardedAction(gate("allow"), bookRequest(), run));
    expect(ok.allowed).toBe(true);
    const refused = await runWithTrace(newCallContext("lead-1", "inbound"), () => guardedAction(gate("block"), bookRequest(), run));
    expect(refused.allowed).toBe(false);
    expect(ran).toBe(1);
    expect(getCallLogs().some((l) => l.outcome === "blocked" && l.reason === "judge_refused:book")).toBe(true);
  });
});

describe("the live judge in a whole call", () => {
  const bookingLines = ["Hi", "I want to book an appointment", "tomorrow at 3 pm", "yes"];
  const run = (choice: string) => {
    const m = standIn(answer(choice, 0.95));
    const harness = new CallHarness(clockAt(IN_WINDOW), undefined, getModuleRegistry(), { judge: new LiveJudge({ model: m.model }) });
    return harness
      .runInbound("lead-1", "+15550143", { idempotencyKey: `live-${choice}`, agent: "decision_tree", callerUtterances: bookingLines })
      .then((r) => ({ events: recordStore.read(r.recordId!)!.events, calls: m.calls }));
  };

  it("books when the model allows", async () => {
    const { events, calls } = await run("allow");
    expect(getLead("lead-1")!.bookings.length).toBe(1);
    const verdict = events.find((e) => e.type === "judge_verdict" && e.data.action === "book")!;
    expect(verdict.data.allowed).toBe(true);
    const scores = verdict.data.scores as Array<{ criterion: string }>;
    expect(scores.some((s) => s.criterion === "decision_model")).toBe(true);
    expect(liveEvents(events).some((e) => e.data.action === "book" && e.data.allowed === true)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does not book when the model blocks", async () => {
    const { events } = await run("block");
    expect(getLead("lead-1")!.bookings).toHaveLength(0);
    const verdict = events.find((e) => e.type === "judge_verdict" && e.data.action === "book")!;
    expect(verdict.data.allowed).toBe(false);
    expect(getCallLogs().some((l) => l.outcome === "blocked" && l.reason === "judge_refused:book")).toBe(true);
  });
});

describe("the live judge: retries on a timeout or an error", () => {
  /** A model that plays one scripted outcome per call, in order. */
  const sequence = (...steps: Script[]) => {
    let i = 0;
    return standIn((request, options) => steps[Math.min(i++, steps.length - 1)]!(request, options));
  };
  const sleeps = () => {
    const waited: number[] = [];
    return { waited, sleep: async (ms: number) => { waited.push(ms); } };
  };

  it("a first timeout then an allow answers allow, with both attempts recorded and the injected sleep used", async () => {
    const m = sequence(failure("timeout"), answer("allow", 0.9, 50));
    const s = sleeps();
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model, clock: ticking(80), sleep: s.sleep }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(m.calls).toHaveLength(2);
    expect(s.waited).toEqual([150]);
    expect(liveEvents(events)[0]!.data).toMatchObject({
      ok: true, answer: "allow", attemptCount: 2, stoppedBy: "answered",
      attempts: [{ n: 1, outcome: "timeout", latencyMs: 80 }, { n: 2, outcome: "answered", latencyMs: 80 }],
    });
  });

  it("two errors then a block at the threshold blocks, waiting 150 then 300", async () => {
    const m = sequence(failure("error"), failure("timeout"), answer("block", 0.9));
    const s = sleeps();
    const verdict = await new LiveJudge({ model: m.model, sleep: s.sleep }).judge(bookRequest());
    expect(verdict.allowed).toBe(false);
    expect(m.calls).toHaveLength(3);
    expect(s.waited).toEqual([150, 300]);
  });

  it("a thrown model is an error and is retried", async () => {
    let calls = 0;
    const model: DecisionModel = { id: "flaky", label: "Flaky", kind: "real", decide: async () => { if (calls++ === 0) throw new Error("x"); return answer("allow", 0.9)({} as never, undefined); } };
    const { verdict, events } = await traced(() => new LiveJudge({ model, sleep: sleeps().sleep }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(liveEvents(events)[0]!.data.attemptCount).toBe(2);
  });

  it("three failures let the action proceed, with three attempts recorded and the event saying so", async () => {
    const m = sequence(failure("error"));
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model, sleep: sleeps().sleep }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(m.calls).toHaveLength(3);
    expect(liveEvents(events)[0]!.data).toMatchObject({
      ok: false, policyApplied: "proceed", allowed: true, failureReason: "error", attemptCount: 3, stoppedBy: "retries_exhausted",
    });
    expect((liveEvents(events)[0]!.data.attempts as unknown[]).length).toBe(3);
  });

  it("an invalid answer is not retried", async () => {
    const m = sequence(failure("invalid_answer"), answer("block", 0.99));
    const { verdict, events } = await traced(() => new LiveJudge({ model: m.model, sleep: sleeps().sleep }).judge(bookRequest()));
    expect(verdict.allowed).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(liveEvents(events)[0]!.data).toMatchObject({ attemptCount: 1, stoppedBy: "not_retryable" });
  });

  it("off is not retried", async () => {
    const m = sequence(failure("off"), answer("block", 0.99));
    const { events } = await traced(() => new LiveJudge({ model: m.model, sleep: sleeps().sleep }).judge(bookRequest()));
    expect(m.calls).toHaveLength(1);
    expect(liveEvents(events)[0]!.data).toMatchObject({ failureReason: "off", attemptCount: 1 });
  });

  it("an answer of any kind ends the retrying", async () => {
    const m = sequence(answer("unclear", 0.5), answer("block", 0.99));
    await new LiveJudge({ model: m.model, sleep: sleeps().sleep }).judge(bookRequest());
    expect(m.calls).toHaveLength(1);
  });

  it("stops retrying when the deadline would be exceeded", async () => {
    const m = sequence(failure("timeout"));
    const s = sleeps();
    const { events } = await traced(() =>
      new LiveJudge({ model: m.model, clock: ticking(100), sleep: s.sleep, attemptBudgetMs: 100, deadlineMs: 300 }).judge(bookRequest()));
    // 100 + 150 backoff + 100 = 350 > 300 on the second attempt's budget, so the second attempt is trimmed; the third cannot start.
    expect(m.calls.length).toBeLessThan(3);
    expect(liveEvents(events)[0]!.data).toMatchObject({ stoppedBy: "deadline", deadlineMs: 300 });
    const total = liveEvents(events)[0]!.data.totalMs as number;
    expect(total).toBeLessThanOrEqual(300);
  });

  it("gives each attempt the lesser of its budget and the time left", async () => {
    const m = sequence(failure("timeout"), failure("timeout"));
    await new LiveJudge({ model: m.model, clock: ticking(100), sleep: sleeps().sleep, attemptBudgetMs: 200, deadlineMs: 400 }).judge(bookRequest());
    expect(m.calls[0]!.options?.timeoutMs).toBe(200);
    expect(m.calls[1]!.options?.timeoutMs).toBeLessThanOrEqual(200);
  });

  it("does not hang past the deadline on a model that never answers", async () => {
    const model: DecisionModel = { id: "stuck", label: "Stuck", kind: "real", decide: () => new Promise(() => {}) };
    const started = Date.now();
    const verdict = await new LiveJudge({ model, attemptBudgetMs: 30, deadlineMs: 120, retries: 2, backoffMs: [5, 5] }).judge(bookRequest());
    expect(verdict.allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
