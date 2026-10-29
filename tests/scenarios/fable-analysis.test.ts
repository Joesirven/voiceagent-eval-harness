import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { startInteractiveCall } from "../../src/decision/interactive.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { createJevMock, createOpenAiDecisionsMock } from "../../src/decision-models/mocks.js";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../../src/decision-models/types.js";
import { resetJudges } from "../../src/judge/index.js";
import { LiveJudge } from "../../src/judging/live-judge.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import type { ClaudeJsonAsk, ClaudeJsonClient } from "../../src/judging/offline/claude.js";
import { FABLE_MODEL } from "../../src/judging/offline/claude.js";
import {
  analyze,
  buildWorksheet,
  casesFromRecords,
  ClaudeFableLabeler,
  FAILED_ROW,
  labelCases,
  MockFableLabeler,
  readHandVerdicts,
  renderReport,
  runModelsOnCases,
  writeWorksheet,
  type DecisionCase,
  type FableLabel,
  type ModelAnswer,
} from "../../src/judging/offline/fable-analysis.js";
import { baseLead } from "../helpers/fixtures.js";

/* ------------------------------------------------------------- test helpers */

const turn = (role: "agent" | "caller", text: string, turnIndex: number) => ({ role, text, turnIndex, spoken: true });
const SHORT_TRANSCRIPT = [turn("agent", "Hello.", 0), turn("caller", "I want to book an appointment.", 1)];

let counter = 0;
function liveCase(action: string, models: Record<string, ModelAnswer>, extra: Partial<DecisionCase> = {}): DecisionCase {
  counter += 1;
  return {
    caseId: `rec#${counter}`,
    origin: "live_judge",
    nodeId: "booking_confirm",
    action,
    question: `Should the agent carry out ${action} now?`,
    answers: ["allow", "block", "unclear"],
    transcript: SHORT_TRANSCRIPT,
    modelAnswers: models,
    ...extra,
  };
}

const says = (answer: string, confidence: number): ModelAnswer => ({ answer, confidence });
const labelsFor = (cases: DecisionCase[], answers: Record<string, string>): Record<string, FableLabel> =>
  Object.fromEntries(cases.map((c) => [c.caseId, { answer: answers[c.caseId] ?? "allow", why: "reason" }]));

/** Cases for one model on one action: `n` answers of "allow" at `confidence`; Fable says `fable` on all of them. */
function allowCases(n: number, confidence: number, fable: string, action = "book", model = "m1") {
  const cases = Array.from({ length: n }, () => liveCase(action, { [model]: says("allow", confidence) }));
  return { cases, fable: Object.fromEntries(cases.map((c) => [c.caseId, fable])) };
}

/* ------------------------------------------------------------------ analyze */

describe("the confusion table", () => {
  it("counts model answers by Fable answers, with failures as their own row", () => {
    const allowAllow = allowCases(3, 0.9, "allow");
    const allowBlock = allowCases(2, 0.9, "block");
    const blockAllow = [liveCase("book", { m1: says("block", 0.8) })];
    const failed = [liveCase("book", { m1: { failed: "timeout" } })];
    const cases = [...allowAllow.cases, ...allowBlock.cases, ...blockAllow, ...failed];
    const labels = labelsFor(cases, { ...allowAllow.fable, ...allowBlock.fable });
    const m = analyze(cases, labels).models[0]!;
    expect(m.confusion.rows).toEqual(["allow", "block", FAILED_ROW]);
    expect(m.confusion.columns).toEqual(["allow", "block"]);
    expect(m.confusion.counts).toEqual({
      allow: { allow: 3, block: 2 },
      block: { allow: 1, block: 0 },
      [FAILED_ROW]: { allow: 1, block: 0 },
    });
    expect(m).toMatchObject({ compared: 7, failures: 1, agreements: 3, waitingForHandVerdict: 3 });
    expect(m.disagreements.map((d) => [d.modelAnswer, d.fableAnswer])).toEqual([
      ["allow", "block"],
      ["allow", "block"],
      ["block", "allow"],
    ]);
  });

  it("reports how many disagreements still wait for a hand verdict, in the result and in the report", () => {
    const wrong = allowCases(2, 0.9, "block");
    const labels = labelsFor(wrong.cases, wrong.fable);
    const result = analyze(wrong.cases, labels, { [wrong.cases[0]!.caseId]: "block" });
    expect(result.waitingCases).toBe(1);
    expect(renderReport(result)).toContain("still waiting for a hand verdict: 1 cases");
    expect(result.models[0]!.disagreements.map((d) => d.handVerdict)).toEqual(["block", undefined]);
  });

  it("leaves out a case that has no Fable label and a model that has no entry", () => {
    const a = liveCase("book", { m1: says("allow", 0.9), m2: says("allow", 0.9) });
    const b = liveCase("book", { m1: says("allow", 0.9) });
    const result = analyze([a, b], { [a.caseId]: { answer: "allow", why: "" } });
    expect(result.casesLabelled).toBe(1);
    expect(result.models.map((m) => [m.modelId, m.compared])).toEqual([["m1", 1], ["m2", 1]]);
  });
});

describe("recommended bars", () => {
  it("find the lowest bar on the 0.01 grid where precision reaches the target, judged against the adjudicated truth", () => {
    const right = allowCases(5, 0.9, "allow");
    const wrong = allowCases(5, 0.6, "block");
    const cases = [...right.cases, ...wrong.cases];
    const labels = labelsFor(cases, { ...right.fable, ...wrong.fable });
    // The hand verdict agrees with Fable on the wrong ones: the model should have said block.
    const hand = Object.fromEntries(wrong.cases.map((c) => [c.caseId, "block"]));
    const bar = analyze(cases, labels, hand).models[0]!.bars.find((b) => b.group === "live_judge:book" && b.answer === "allow")!;
    expect(bar).toMatchObject({ target: 0.95, answered: 10, withTruth: 10, bar: 0.61, supportAtBar: 5, correctAtBar: 5 });
  });

  it("holds a durable answer to 0.95 and the rest to 0.9", () => {
    const nine = [...allowCases(9, 0.8, "allow").cases, ...allowCases(1, 0.8, "block").cases];
    const labels = (cases: DecisionCase[]) => labelsFor(cases, Object.fromEntries(cases.slice(9).map((c) => [c.caseId, "block"])));
    const asBook = nine.map((c) => ({ ...c, action: "book" }));
    const asDetails = nine.map((c) => ({ ...c, action: "save_details" }));
    const hand = (cases: DecisionCase[]) => ({ [cases[9]!.caseId]: "block" });
    const book = analyze(asBook, labels(asBook), hand(asBook)).models[0]!.bars[0]!;
    const details = analyze(asDetails, labels(asDetails), hand(asDetails)).models[0]!.bars[0]!;
    expect(book).toMatchObject({ target: 0.95, bar: null });
    expect(book.best).toMatchObject({ support: 10, correct: 9 });
    expect(book.note).toMatch(/no bar reaches the target 0\.95; best was 9 of 10/);
    expect(details).toMatchObject({ target: 0.9, bar: 0.5, supportAtBar: 10, correctAtBar: 9 });
  });

  it("let the targets and the durable test be set", () => {
    const nine = [...allowCases(9, 0.8, "allow").cases, ...allowCases(1, 0.8, "block").cases];
    const labels = labelsFor(nine, Object.fromEntries(nine.slice(9).map((c) => [c.caseId, "block"])));
    const hand = { [nine[9]!.caseId]: "block" };
    expect(analyze(nine, labels, hand, { durableTarget: 0.9 }).models[0]!.bars[0]!.bar).toBe(0.5);
    expect(analyze(nine, labels, hand, { isDurable: () => false }).models[0]!.bars[0]!.target).toBe(0.9);
  });

  it("need minSupport cases above a bar, and say so when there are fewer", () => {
    const four = allowCases(4, 0.9, "allow");
    const labels = labelsFor(four.cases, four.fable);
    expect(analyze(four.cases, labels).models[0]!.bars[0]).toMatchObject({ bar: null, best: null });
    expect(analyze(four.cases, labels).models[0]!.bars[0]!.note).toMatch(/fewer than 5 answers with a known truth/);
    expect(analyze(four.cases, labels, {}, { minSupport: 4 }).models[0]!.bars[0]).toMatchObject({ bar: 0.5, supportAtBar: 4 });
    // Five cases but only four above 0.8: the bar cannot sit at or below 0.8 with support from the low one.
    const mixed = [...allowCases(4, 0.9, "allow").cases, ...allowCases(1, 0.7, "allow").cases];
    const mixedLabels = labelsFor(mixed, {});
    expect(analyze(mixed, mixedLabels).models[0]!.bars[0]).toMatchObject({ bar: 0.5, supportAtBar: 5 });
    expect(analyze(mixed, mixedLabels, {}, { minSupport: 5 }).models[0]!.bars[0]!.supportAtBar).toBe(5);
  });

  it("are not changed by agreements when the hand verdict is blank, and ignore the disagreements until they are judged", () => {
    const right = allowCases(6, 0.9, "allow");
    const rightLabels = labelsFor(right.cases, right.fable);
    // "answered" counts every answer the model gave, judged or not; the bar and what it rests on are what must stay put.
    const core = (bars: Array<{ bar: number | null; supportAtBar: number | null; correctAtBar: number | null; withTruth: number; best: unknown }>) =>
      bars.map(({ bar, supportAtBar, correctAtBar, withTruth, best }) => ({ bar, supportAtBar, correctAtBar, withTruth, best }));
    const base = core(analyze(right.cases, rightLabels).models[0]!.bars);
    // Add a disagreement with no hand verdict: the bars do not move.
    const dispute = allowCases(3, 0.95, "block");
    const withDispute = analyze([...right.cases, ...dispute.cases], { ...rightLabels, ...labelsFor(dispute.cases, dispute.fable) });
    expect(core(withDispute.models[0]!.bars)).toEqual(base);
    expect(withDispute.models[0]!.waitingForHandVerdict).toBe(3);
    // A blank verdict, or one that is not an answer to the question, counts as not given.
    const blank = analyze([...right.cases, ...dispute.cases], { ...rightLabels, ...labelsFor(dispute.cases, dispute.fable) }, { [dispute.cases[0]!.caseId]: "  ", [dispute.cases[1]!.caseId]: "maybe" });
    expect(core(blank.models[0]!.bars)).toEqual(base);
    expect(blank.invalidHandVerdicts).toBe(1);
  });

  it("move the right way when a disagreement is judged: Fable right lowers precision, the model right keeps it", () => {
    const right = allowCases(10, 0.9, "allow");
    const dispute = allowCases(1, 0.9, "block");
    const cases = [...right.cases, ...dispute.cases];
    const labels = labelsFor(cases, { ...right.fable, ...dispute.fable });
    const id = dispute.cases[0]!.caseId;
    const barOf = (hand: Record<string, string>) => analyze(cases, labels, hand).models[0]!.bars[0]!;
    expect(barOf({})).toMatchObject({ bar: 0.5, supportAtBar: 10, correctAtBar: 10, withTruth: 10 });
    // Fable was right: the model's "allow" was wrong, so 10 of 11 at best, below 0.95.
    expect(barOf({ [id]: "block" })).toMatchObject({ bar: null, withTruth: 11 });
    expect(barOf({ [id]: "block" }).best).toMatchObject({ support: 11, correct: 10 });
    // The model was right and Fable wrong: 11 of 11.
    expect(barOf({ [id]: "allow" })).toMatchObject({ bar: 0.5, supportAtBar: 11, correctAtBar: 11 });
  });

  it("let a hand verdict outrank an agreement when another model's disagreement was judged", () => {
    const c = liveCase("book", { m1: says("allow", 0.9), m2: says("block", 0.9) });
    const labels = { [c.caseId]: { answer: "allow", why: "" } };
    const result = analyze([c], labels, { [c.caseId]: "unclear" }, { minSupport: 1 });
    const m1 = result.models.find((m) => m.modelId === "m1")!;
    expect(m1.bars[0]).toMatchObject({ withTruth: 1, bar: null });
  });

  it("keep failures out of the bars and key tree bars by node", () => {
    const tree = (node: string, answer: string, confidence: number): DecisionCase => ({
      caseId: `t#${node}-${confidence}-${counter++}`,
      origin: "tree_decision",
      nodeId: node,
      question: "What does the caller want?",
      answers: ["quote", "not_interested", "unclear"],
      transcript: SHORT_TRANSCRIPT,
      modelAnswers: { m1: says(answer, confidence) },
    });
    const cases = [...Array.from({ length: 5 }, () => tree("discovery", "not_interested", 0.9)), tree("objection", "not_interested", 0.9)];
    cases.push({ ...cases[0]!, caseId: "t#failed", modelAnswers: { m1: { failed: "rate_limit" } } });
    const labels = labelsFor(cases, Object.fromEntries(cases.map((c) => [c.caseId, "not_interested"])));
    const bars = analyze(cases, labels).models[0]!.bars;
    expect(bars.map((b) => [b.group, b.answer, b.answered])).toEqual([
      ["tree:discovery", "not_interested", 5],
      ["tree:objection", "not_interested", 1],
    ]);
    // "not_interested" is durable in the tree.
    expect(bars[0]).toMatchObject({ target: 0.95, bar: 0.5 });
  });
});

/* ---------------------------------------------------------------- worksheet */

describe("the worksheet", () => {
  const long = [
    turn("agent", "Hello, this is an assistant.", 0),
    turn("caller", "Hi, it is wendell@example.com.", 1),
    turn("agent", "Thanks. What is your number?", 2),
    turn("caller", "Call 415 555 0101.", 3),
    turn("agent", "Born in 1984, right?", 4),
    turn("caller", "No.", 5),
    turn("agent", "Shall I book tomorrow?", 6),
    turn("caller", "Maybe, I was born in 1990.", 7),
  ];

  it("round-trips: disagreements out as markdown and JSON, hand verdicts back in", () => {
    const disputed = liveCase("book", { m1: says("allow", 0.91) }, { transcript: long });
    const agreed = liveCase("book", { m1: says("allow", 0.9) });
    const cases = [disputed, agreed];
    const labels = { [disputed.caseId]: { answer: "block", why: "the caller only said maybe" }, [agreed.caseId]: { answer: "allow", why: "" } };
    const result = analyze(cases, labels);
    const entries = buildWorksheet(cases, labels, result);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      case_id: disputed.caseId,
      question: "Should the agent carry out book now?",
      models: [{ model_id: "m1", answer: "allow", confidence: 0.91 }],
      fable: { answer: "block", why: "the caller only said maybe" },
      hand_verdict: "",
    });
    expect(entries[0]!.transcript_excerpt).toHaveLength(6);
    expect(JSON.stringify(entries)).not.toMatch(/wendell@example\.com|415 555 0101|1984|1990/);

    const dir = mkdtempSync(join(tmpdir(), "worksheet-test-"));
    const paths = writeWorksheet(dir, entries);
    expect(readFileSync(paths.markdown, "utf8")).toContain(`## ${disputed.caseId}`);
    expect(readFileSync(paths.markdown, "utf8")).toContain("hand_verdict:");

    const blank = readFileSync(paths.json, "utf8");
    expect(readHandVerdicts(blank)).toEqual({});

    const filled = JSON.parse(blank) as { entries: Array<{ hand_verdict: string }> };
    filled.entries[0]!.hand_verdict = " block ";
    writeFileSync(paths.json, JSON.stringify(filled));
    const verdicts = readHandVerdicts(readFileSync(paths.json, "utf8"));
    expect(verdicts).toEqual({ [disputed.caseId]: "block" });
    expect(readHandVerdicts(filled)).toEqual(verdicts);

    // Recomputing with the verdict clears the waiting count.
    expect(analyze(cases, labels).waitingCases).toBe(1);
    expect(analyze(cases, labels, verdicts).waitingCases).toBe(0);
    // A regenerated worksheet carries the verdict forward.
    expect(buildWorksheet(cases, labels, analyze(cases, labels, verdicts), verdicts)[0]!.hand_verdict).toBe("block");
  });

  it("rejects a file that is not a worksheet", () => {
    expect(() => readHandVerdicts("not json")).toThrow("hand_verdicts_not_json");
    expect(() => readHandVerdicts({ nothing: true })).toThrow("hand_verdicts_not_a_worksheet");
  });
});

/* ------------------------------------------------------------ rebuild cases */

const IN_WINDOW = "2026-10-15T14:00:00.000Z";

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "fable-test-")));
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

const allowingModel: DecisionModel = {
  id: "allowing-mock",
  label: "always allows",
  kind: "mock",
  decide: async (): Promise<DecisionModelOutcome> => ({ ok: true, answer: "allow", confidence: 0.9, reason: "", latencyMs: 40, modelId: "allowing-mock" }),
};
const silentModel: DecisionModel = {
  id: "silent-mock",
  label: "never answers",
  kind: "mock",
  decide: async (): Promise<DecisionModelOutcome> => ({ ok: false, reason: "timeout", latencyMs: 400, modelId: "silent-mock", code: "timeout" }),
};

async function playBooking(judgeModel: DecisionModel) {
  const harness = new CallHarness(
    { now: () => new Date(IN_WINDOW) },
    mockLeadStore,
    getModuleRegistry(),
    { judge: new LiveJudge({ model: judgeModel, attemptBudgetMs: 300, sleep: async () => {} }) },
  );
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness });
  for (const line of ["Hi", "I want to book an appointment", "tomorrow at 3 pm", "yes"]) await call.say(line);
  await call.hangUp();
  return recordStore.read(call.callId)!;
}

describe("casesFromRecords", () => {
  it("rebuilds tree decisions and live judge decisions from a record produced by a real harness call", async () => {
    const record = await playBooking(allowingModel);
    const cases = casesFromRecords([record]);

    const tree = cases.filter((c) => c.origin === "tree_decision");
    const live = cases.filter((c) => c.origin === "live_judge");
    expect(tree.length).toBe(record.events.filter((e) => e.type === "decision" && e.data.kind === undefined).length);
    expect(live.map((c) => c.action)).toContain("book");
    expect(new Set(cases.map((c) => c.caseId)).size).toBe(cases.length);

    // A tree decision carries its own question and the mock module's answer.
    const confirm = tree.find((c) => c.nodeId === "booking_confirm")!;
    expect(confirm.question).toBe("Did the caller say yes to the time read back to them?");
    expect(confirm.answers).toEqual(["no", "yes", "unclear"]);
    expect(Object.keys(confirm.modelAnswers)).toEqual(["jev-mock"]);
    expect(confirm.modelAnswers["jev-mock"]).toMatchObject({ answer: "yes" });
    expect(confirm.transcript.at(-1)).toMatchObject({ role: "caller", text: "yes" });
    expect(confirm.transcript[0]).toMatchObject({ role: "agent" });

    // A live judge decision is rebuilt with the live judge's own question and criteria.
    const book = live.find((c) => c.action === "book")!;
    expect(book.question).toBe("Should the agent carry out book now?");
    expect(book.answers).toEqual(["allow", "block", "unclear"]);
    expect(book.answerCriteria?.allow).toMatch(/plainly agreed/);
    expect(book.modelAnswers["allowing-mock"]).toEqual({ answer: "allow", confidence: 0.9 });
    expect(book.transcript.at(-1)).toMatchObject({ role: "caller", text: "yes" });
  });

  it("records a live judge model that gave no answer as a failure with its code", async () => {
    const record = await playBooking(silentModel);
    const book = casesFromRecords([record]).find((c) => c.origin === "live_judge" && c.action === "book")!;
    expect(book.modelAnswers["silent-mock"]).toEqual({ failed: "timeout" });
  });

  it("ignores text records", () => {
    expect(casesFromRecords([{ recordId: "text_x", kind: "text", leadId: "l", openedAt: "", events: [], transcript: [], texts: [] }])).toEqual([]);
  });
});

/* -------------------------------------------------------------- run models */

describe("runModelsOnCases", () => {
  it("asks every model the same question for every case and keeps failures as failures", async () => {
    const asked: DecisionModelRequest[] = [];
    const recorder: DecisionModel = {
      ...createJevMock(),
      decide: async (request) => {
        asked.push(request);
        return createJevMock().decide(request);
      },
    };
    const cases = [
      liveCase("book", {}, { answerCriteria: { allow: "a", block: "b", unclear: "u" } }),
      liveCase("transfer", { "old-model": says("allow", 0.5) }),
    ];
    const out = await runModelsOnCases(cases, [recorder, silentModel, createOpenAiDecisionsMock()]);
    expect(out.map((c) => Object.keys(c.modelAnswers).sort())).toEqual([
      ["jev-mock", "openai-decisions-mock", "silent-mock"],
      ["jev-mock", "old-model", "openai-decisions-mock", "silent-mock"],
    ]);
    expect(out[0]!.modelAnswers["silent-mock"]).toEqual({ failed: "timeout" });
    expect(asked.map((r) => r.question)).toEqual(cases.map((c) => c.question));
    expect(asked[0]!.answerCriteria).toEqual({ allow: "a", block: "b", unclear: "u" });
    // The inputs are not changed.
    expect(Object.keys(cases[0]!.modelAnswers)).toEqual([]);
  });

  it("never has more than two requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const gated: DecisionModel = {
      id: "gated",
      label: "counts requests in flight",
      kind: "mock",
      decide: async (): Promise<DecisionModelOutcome> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield to the other workers without any waiting.
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        inFlight -= 1;
        return { ok: true, answer: "allow", confidence: 0.9, reason: "", latencyMs: 1, modelId: "gated" };
      },
    };
    const cases = Array.from({ length: 9 }, () => liveCase("book", {}));
    const out = await runModelsOnCases(cases, [gated]);
    expect(peak).toBe(2);
    expect(out.every((c) => "answer" in c.modelAnswers.gated!)).toBe(true);
  });

  it("records a model that throws as a failure and goes on", async () => {
    const throwing: DecisionModel = { id: "throws", label: "throws", kind: "mock", decide: async () => { throw new Error("boom with text"); } };
    const out = await runModelsOnCases([liveCase("book", {})], [throwing]);
    expect(out[0]!.modelAnswers.throws).toEqual({ failed: "error" });
  });
});

/* -------------------------------------------------------------------- Fable */

describe("the Fable labeler", () => {
  function fakeClient(reply: (ask: ClaudeJsonAsk) => unknown): ClaudeJsonClient & { asks: ClaudeJsonAsk[] } {
    const asks: ClaudeJsonAsk[] = [];
    return {
      asks,
      async askJson<T>(ask: ClaudeJsonAsk): Promise<T> {
        asks.push(ask);
        return reply(ask) as T;
      },
    };
  }

  const withPersonalDetails = liveCase(
    "book",
    { m1: says("allow", 0.99) },
    {
      answerCriteria: { allow: "the caller agreed", block: "the caller did not", unclear: "cannot tell" },
      transcript: [
        turn("agent", "Can I confirm your email?", 0),
        turn("caller", "It is wendell@example.com and my number is 415 555 0101.", 1),
        turn("agent", "And your date of birth?", 2),
        turn("caller", "March 3rd 1984, policy 123456789.", 3),
      ],
    },
  );

  it("sends a redacted conversation, high effort and a closed schema, and never shows the model's own answer", async () => {
    const client = fakeClient(() => ({ answer: "block", why: "no clear yes" }));
    const label = await new ClaudeFableLabeler({ client }).label(withPersonalDetails);
    expect(label).toEqual({ answer: "block", why: "no clear yes" });
    const ask = client.asks[0]!;
    expect(ask.model).toBe(FABLE_MODEL);
    expect(ask.effort).toBe("high");
    expect(ask.user).not.toMatch(/wendell@example\.com|415 555 0101|1984|123456789/);
    expect(ask.user).toContain("[email]");
    expect(ask.user).toContain("[phone]");
    expect(ask.user).toContain("Caller:");
    expect(ask.user).toContain("- allow: the caller agreed");
    expect(ask.user).not.toMatch(/0\.99|m1/);
    expect(ask.schema).toMatchObject({
      required: ["answer", "why"],
      additionalProperties: false,
      properties: { answer: { enum: ["allow", "block", "unclear"] } },
    });
  });

  it("treats an answer outside the list as a failure and labels the rest", async () => {
    const replies = [{ answer: "maybe", why: "x" }, { answer: "allow", why: "y" }];
    const client = fakeClient(() => replies.shift());
    const second = liveCase("book", {});
    const run = await labelCases([withPersonalDetails, second], new ClaudeFableLabeler({ client }), { concurrency: 1 });
    expect(run.failures).toEqual({ [withPersonalDetails.caseId]: "fable_invalid_answer" });
    expect(run.labels).toEqual({ [second.caseId]: { answer: "allow", why: "y" } });
  });

  it("labels with the mock, by case id or by a function, and records what it was asked", async () => {
    const a = liveCase("book", {});
    const b = liveCase("book", {});
    const mock = new MockFableLabeler({ [b.caseId]: "block" });
    const run = await labelCases([a, b], mock);
    expect(run.labels[a.caseId]!.answer).toBe("allow");
    expect(run.labels[b.caseId]!.answer).toBe("block");
    expect(mock.asked.sort()).toEqual([a.caseId, b.caseId].sort());
    expect((await labelCases([a], new MockFableLabeler(() => "unclear"))).labels[a.caseId]!.answer).toBe("unclear");
  });
});

describe("model ids and the Fable retention flag", () => {
  it("routes all three default model ids to the Gateway", async () => {
    const { isGatewayModel } = await import("../../src/connectors/json-client.js");
    const { OPUS_MODEL } = await import("../../src/judging/offline/claude.js");
    const { SONNET_MODEL } = await import("../../src/judging/offline/claude-lead.js");
    expect(isGatewayModel(FABLE_MODEL)).toBe(true);
    expect(isGatewayModel(OPUS_MODEL)).toBe(true);
    expect(isGatewayModel(SONNET_MODEL)).toBe(true);
  });

  it("turns zero data retention off only for the Fable model", async () => {
    const asks: ClaudeJsonAsk[] = [];
    const client: ClaudeJsonClient = {
      async askJson<T>(ask: ClaudeJsonAsk): Promise<T> {
        asks.push(ask);
        return { answer: "block", why: "x" } as T;
      },
    };
    const item = liveCase("book", { m1: says("allow", 0.99) }, { answerCriteria: { allow: "a", block: "b" }, transcript: [turn("caller", "hello", 0)] });
    await new ClaudeFableLabeler({ client }).label(item);
    await new ClaudeFableLabeler({ client, model: "anthropic/claude-opus-5-5" }).label(item);
    expect(asks[0]!.zeroDataRetention).toBe(false);
    expect(asks[1]!.zeroDataRetention).toBeUndefined();
  });
});
