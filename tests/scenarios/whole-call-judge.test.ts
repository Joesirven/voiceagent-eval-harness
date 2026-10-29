import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled, setRecordingNoticeEnabled } from "../../src/config.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { loadTree } from "../../src/decision/tree.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { resetJudges } from "../../src/judge/index.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import { ClaudeFactExtractor, ClaudeSimulatedLead, SONNET_MODEL } from "../../src/judging/offline/claude-lead.js";
import type { ClaudeJsonAsk, ClaudeJsonClient } from "../../src/judging/offline/claude.js";
import { OPUS_MODEL } from "../../src/judging/offline/claude.js";
import { monthDayOf, ScriptedSimulatedLead, spokenDate } from "../../src/judging/offline/simulated-lead.js";
import { gradeOutcome, gradeWholeCall, RULES_NOT_CHECKED, runWholeCall, statedPrice, totalsOf, transcriptGates } from "../../src/judging/offline/whole-call.js";
import type { LeadFacts, PastCall } from "../../src/judging/offline/types.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const clockAt = (iso: string) => ({ now: () => new Date(iso) });

const FACTS: LeadFacts = {
  sourceCallId: "past-call-1",
  businessType: "roofing",
  renewalDate: "2026-12-14",
  annualPayroll: "280,000 dollars",
  employeeCount: 6,
  currentCarrier: "Redwood Mutual",
  objections: ["I'm busy right now."],
};

/**
 * A small tree that saves the renewal date, the employee count and the payroll,
 * then books a time. The stub tree saves only a vehicle year, so it cannot
 * show a payroll or an employee count being captured.
 */
function discoveryTree() {
  const fieldAnswer = (answer: string, field: string, as: string, next: string, say: string, cue: string) => ({
    answer,
    next,
    say,
    extract: { as, with: "caller_line" },
    action: { type: "save_quote_field", field, from: as },
    minConfidence: 0.5,
    cues: [cue],
    onBlocked: { say: "I could not save that. Could you say it again?" },
  });
  return loadTree({
    id: "whole-call-test-tree",
    version: "0.0.1",
    start: "disclosure",
    maxClarifications: 2,
    escalation: { say: "Let me bring in a person.", disposition: "handed_off" },
    dispositions: [
      { name: "booked", label: "Booked", durable: false },
      { name: "handed_off", label: "Handed to a person", durable: false },
      { name: "wrong_number", label: "Wrong number", durable: false },
    ],
    nodes: [
      { id: "disclosure", label: "Disclosure", flowStep: "disclosure", next: "recognize_lead" },
      {
        id: "recognize_lead",
        label: "Recognize the lead",
        flowStep: "recognize_lead",
        clarify: "Sorry, who am I speaking with?",
        decision: {
          question: "Is the person on the line the lead on file?",
          answers: [
            { answer: "yes", next: "renewal", say: "Thanks. When does your policy renew?", minConfidence: 0.5 },
            { answer: "no", disposition: "wrong_number", say: "Sorry for the trouble. Goodbye.", minConfidence: 0.5, onBlocked: { say: "Sorry, who am I speaking with?" } },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "renewal",
        label: "Renewal date",
        flowStep: "discovery",
        clarify: "Sorry, when does the policy renew?",
        decision: {
          question: "Did the caller give a renewal date?",
          answers: [
            fieldAnswer("date_given", "renewal_date", "renewal", "employees", "Got it. How many employees do you have?", "renews"),
            { answer: "objection", next: "objection", minConfidence: 0.5 },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "objection",
        label: "Objection",
        flowStep: "objection",
        agentLines: [{ line: "I understand. This will only take a minute. Would you like to continue?" }],
        clarify: "Sorry, would you like to continue?",
        decision: {
          question: "After raising a concern, does the caller still want to go on?",
          answers: [
            { answer: "yes", next: "renewal", say: "Thank you. When does your policy renew?", minConfidence: 0.5 },
            { answer: "no", disposition: "handed_off", say: "Understood. Goodbye.", minConfidence: 0.5, onBlocked: { say: "Would you like to continue?" } },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "employees",
        label: "Employees",
        flowStep: "discovery",
        clarify: "Sorry, how many employees do you have?",
        decision: {
          question: "Did the caller give a number of employees?",
          answers: [
            fieldAnswer("count_given", "employee_count", "headcount", "payroll", "Thank you. And what is your annual payroll?", "employees"),
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "payroll",
        label: "Payroll",
        flowStep: "discovery",
        clarify: "Sorry, what is your annual payroll?",
        decision: {
          question: "Did the caller give an annual payroll?",
          answers: [
            fieldAnswer("payroll_given", "annual_payroll", "payroll", "booking", "Thank you. What day and time works for a call with a producer?", "payroll"),
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "booking",
        label: "Booking",
        flowStep: "booking",
        clarify: "Sorry, what day and time works?",
        decision: {
          question: "Did the caller give a day or a time?",
          answers: [
            { answer: "time_given", next: "booking_confirm", extract: { as: "slot", with: "time" }, minConfidence: 0.5 },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "booking_confirm",
        label: "Confirm the time",
        flowStep: "booking",
        agentLines: [{ line: "Just to confirm: {slotWords}. Shall I book that?" }],
        clarify: "Sorry, should I book {slotWords}? Please say yes or no.",
        decision: {
          question: "Did the caller say yes to the time read back to them?",
          answers: [
            {
              answer: "yes",
              next: "booking_wrap",
              action: { type: "book", from: "slot" },
              minConfidence: 0.5,
              onBlocked: { say: "I could not book that." },
            },
            { answer: "no", next: "booking", say: "No problem. What day and time works instead?", minConfidence: 0.5 },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
      {
        id: "booking_wrap",
        label: "Booking wrap-up",
        flowStep: "booking",
        agentLines: [{ line: "Your producer call is booked for {slotWords}. Is there anything else I can help with?" }],
        clarify: "Sorry, is there anything else I can help with?",
        decision: {
          question: "Does the caller want anything else?",
          answers: [
            { answer: "no", disposition: "booked", say: "Wonderful, talk to you then. Goodbye.", minConfidence: 0.5, onBlocked: { say: "Is there anything else I can help with?" } },
            { answer: "yes", next: "renewal", say: "Of course.", minConfidence: 0.5 },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
    ],
  });
}

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "whole-call-test-")));
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

const harness = (tree = discoveryTree()) => new CallHarness(clockAt(IN_WINDOW), mockLeadStore, getModuleRegistry(), { tree });

/** A trace event with just enough fields for the grading, which reads type and data. */
function event(type: TraceEvent["type"], data: Record<string, unknown>, recordSeq = 1): TraceEvent {
  return { seq: recordSeq, recordSeq, at: IN_WINDOW, atMs: recordSeq, type, leadId: "lead-1", recordId: "call_x", channel: "call", callId: "call_x", data };
}
const verdict = (action: string, allowed: boolean) => event("judge_verdict", { action, allowed, reason: "", scores: [] });
const write = (field: string, value: string, result: boolean) =>
  event("tool_call", { tool: "write_quote_field", inputs: { field, value, evidenceSpan: value }, result, success: true, durationMs: 0 });

const OPENING = "This call is handled by an AI assistant. Calls with this assistant are recorded and may be reviewed to improve service.";

describe("the scripted simulated lead", () => {
  it("is deterministic: the same facts and agent lines give the same lead lines", async () => {
    const lines = [OPENING, "Thanks. When does your policy renew?", "How many employees do you have?", "And what is your annual payroll?", "What day and time works for a call with a producer?"];
    const run = async () => {
      const lead = new ScriptedSimulatedLead(FACTS, { objectionAfterTurns: 99 });
      const said: Array<string | null> = [];
      for (const line of lines) said.push(await lead.next(line));
      return said;
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first).toEqual([
      "Hi, yes, this is me. Go ahead.",
      "It renews on December 14th.",
      "We have 6 employees.",
      "Our annual payroll is 280,000 dollars.",
      "tomorrow at 3 pm",
    ]);
  });

  it("raises the objections in order, once each, spaced apart, and answers between them", async () => {
    const lead = new ScriptedSimulatedLead(
      { ...FACTS, objections: ["I'm busy right now.", "Can you just email me?"] },
      { objectionAfterTurns: 1, objectionSpacing: 2 },
    );
    const said: string[] = [];
    for (const line of [OPENING, "When does it renew?", "Would you like to continue?", "How many employees do you have?", "What is your annual payroll?", "Anything else?"]) {
      said.push((await lead.next(line))!);
    }
    expect(said[1]).toBe("I'm busy right now.");
    expect(said[2]).toBe("Yes, go ahead.");
    expect(said[3]).toBe("Can you just email me?");
    expect(said.filter((s) => s === "I'm busy right now.")).toHaveLength(1);
    expect(said[4]).toBe("Our annual payroll is 280,000 dollars.");
  });

  it("says yes to a read-back of a time it proposed, and not to one it did not", async () => {
    const proposed = new ScriptedSimulatedLead(FACTS, { preferredTime: "Thursday morning" });
    await proposed.next(OPENING);
    expect(await proposed.next("What day and time works for you?")).toBe("Thursday morning");
    expect(await proposed.next("Just to confirm: Thursday morning. Shall I book that?")).toBe("Yes, that works.");
    const unproposed = new ScriptedSimulatedLead(FACTS);
    await unproposed.next(OPENING);
    expect(await unproposed.next("Just to confirm: Friday at noon. Shall I book that?")).toMatch(/^No,/);
  });

  it("does not know a fact the call never held, asks for the number when the agent states a price, and notes it", async () => {
    const lead = new ScriptedSimulatedLead({ sourceCallId: "x", objections: [] });
    await lead.next(OPENING);
    expect(await lead.next("When does your policy renew?")).toMatch(/not sure/);
    expect(lead.priceStatedByAgent).toBe(false);
    expect(await lead.next("That would be about $1,200 a year.")).toBe("Great, what is the number?");
    expect(lead.priceStatedByAgent).toBe(true);
  });

  it("hangs up on goodbye and after the turn limit", async () => {
    const lead = new ScriptedSimulatedLead(FACTS, { maxLeadTurns: 2 });
    expect(await lead.next(OPENING)).not.toBeNull();
    expect(await lead.next("Anything else?")).not.toBeNull();
    expect(await lead.next("Anything else?")).toBeNull();
    const polite = new ScriptedSimulatedLead(FACTS);
    await polite.next(OPENING);
    expect(await polite.next("Talk to you then. Goodbye.")).toBeNull();
  });

  it("reads month and day from the ways a date is written", () => {
    for (const written of ["2026-12-14", "12/14", "12/14/2026", "December 14th", "dec 14", "14 December", "the 14th of December"]) {
      expect(monthDayOf(written)).toBe("12-14");
    }
    expect(monthDayOf("sometime next year")).toBeNull();
    expect(spokenDate("2026-12-01")).toBe("December 1st");
    expect(spokenDate("2026-03-12")).toBe("March 12th");
  });
});

describe("a whole call through the harness", () => {
  it("plays a full call with the scripted lead and grades it, with outcome flags taken from harness events", async () => {
    // The grader's recording gate (Never-02) wants the recording sentence, which is said only while the notice is on.
    setRecordingNoticeEnabled(true);
    const lead = new ScriptedSimulatedLead(FACTS, { objectionAfterTurns: 1 });
    const run = await runWholeCall({ lead, harness: harness(), leadId: "lead-1", direction: "inbound" });

    expect(run.status).toBe("completed");
    expect(run.endedBy).toBe("agent_ended");
    expect(run.record?.recordId).toBe(run.recordId);
    expect(run.transcript[0]).toMatchObject({ role: "agent", text: inboundOpeningScript() });
    expect(lead.said.filter((s) => s === "I'm busy right now.")).toHaveLength(1);

    // What the harness really did.
    const judged = new Set(["write_quote_field", "book_producer", "record_disposition"]);
    const tools = run.events.filter((e) => e.type === "tool_call" && e.data.success === true && judged.has(String(e.data.tool))).map((e) => e.data.tool);
    expect(tools).toEqual(["write_quote_field", "write_quote_field", "write_quote_field", "book_producer", "record_disposition"]);
    expect(getLead("lead-1")!.bookings).toHaveLength(1);
    expect(Object.keys(getLead("lead-1")!.quoteFields).sort()).toEqual(["annual_payroll", "employee_count", "renewal_date"]);

    const grade = await gradeWholeCall({ record: run.record, facts: FACTS });
    expect(grade.outcome).toEqual({ renewalDateConfirmed: true, payrollCaptured: true, employeeCountCaptured: true, booked: true });
    expect(grade.sourceCallId).toBe("past-call-1");
    expect(grade.turns).toBe(run.leadTurns);
    const byRule = Object.fromEntries(grade.enforcement.map((r) => [r.rule, r.passed]));
    expect(byRule).toMatchObject({
      disclosure_first: true,
      judge_gate_respected: true,
      stop_honored: true,
      ended_with_a_disposition: true,
      "Never-01": true,
      "Never-02": true,
      "Producer-only-01": true,
      "Never-05": true,
    });
    expect(grade.enforcementPassed).toBe(true);
    expect(grade.rulesNotChecked).toContain("Never-03");
    expect(grade.rulesNotChecked).not.toContain("Never-01");
    expect(totalsOf([grade])).toMatchObject({ calls: 1, booked: 1, payrollCaptured: 1, enforcementPassed: 1 });
  });

  it("grades the same call from its events and transcript when there is no stored record", async () => {
    const run = await runWholeCall({ lead: new ScriptedSimulatedLead(FACTS), harness: harness(), leadId: "lead-1", direction: "inbound" });
    const fromRecord = await gradeWholeCall({ record: run.record, facts: FACTS });
    const fromParts = await gradeWholeCall({ events: run.events, transcript: run.transcript, direction: "inbound", facts: FACTS });
    expect(fromParts.outcome).toEqual(fromRecord.outcome);
    expect(fromParts.enforcement.filter((r) => r.rule.includes("-"))).toEqual(fromRecord.enforcement.filter((r) => r.rule.includes("-")));
  });

  it("the lead's own words never set an outcome flag: the stub tree saves no payroll, so none is reported", async () => {
    const lead = new ScriptedSimulatedLead(FACTS);
    // The stub tree is the default; it saves only a vehicle year.
    const stubHarness = new CallHarness(clockAt(IN_WINDOW), mockLeadStore, getModuleRegistry());
    const run = await runWholeCall({ lead, harness: stubHarness, leadId: "lead-1", direction: "inbound", maxTurns: 6 });
    const grade = await gradeWholeCall({ record: run.record, facts: FACTS });
    expect(run.status).toBe("completed");
    expect(grade.outcome).toEqual({ renewalDateConfirmed: false, payrollCaptured: false, employeeCountCaptured: false, booked: false });
  });

  it("reports a blocked start without saying anything", async () => {
    setAiCallingEnabled("agency-demo", false);
    const run = await runWholeCall({ lead: new ScriptedSimulatedLead(FACTS), harness: harness(), leadId: "lead-1", direction: "inbound" });
    expect(run).toMatchObject({ status: "blocked", blockedReason: "ai_calling_disabled", leadTurns: 0, transcript: [] });
  });

  it("hangs up when the lead does, and records the call without a disposition", async () => {
    const lead = new ScriptedSimulatedLead(FACTS, { maxLeadTurns: 2 });
    const run = await runWholeCall({ lead, harness: harness(), leadId: "lead-1", direction: "inbound" });
    expect(run.endedBy).toBe("lead_hung_up");
    const grade = await gradeWholeCall({ record: run.record, facts: FACTS });
    const disposition = grade.enforcement.find((r) => r.rule === "ended_with_a_disposition")!;
    expect(disposition.passed).toBe(true);
    expect(disposition.note).toMatch(/partial/);
  });
});

describe("outcome flags", () => {
  it("count only a field the harness stored after an allowing verdict", () => {
    const stored = [verdict("save_quote_field", true), write("annual_payroll", "280,000 dollars", true)];
    expect(gradeOutcome(stored, FACTS).payrollCaptured).toBe(true);
    // The verdict was a refusal, or the write was rejected for lack of evidence, or there was no event at all.
    expect(gradeOutcome([verdict("save_quote_field", false), write("annual_payroll", "x", true)], FACTS).payrollCaptured).toBe(false);
    expect(gradeOutcome([verdict("save_quote_field", true), write("annual_payroll", "x", false)], FACTS).payrollCaptured).toBe(false);
    expect(gradeOutcome([], FACTS).payrollCaptured).toBe(false);
  });

  it("match the renewal date on month and day, and need a date in the facts", () => {
    const saved = (value: string) => [verdict("save_quote_field", true), write("renewal_date", value, true)];
    expect(gradeOutcome(saved("It renews December 14th"), FACTS).renewalDateConfirmed).toBe(true);
    expect(gradeOutcome(saved("12/14"), FACTS).renewalDateConfirmed).toBe(true);
    expect(gradeOutcome(saved("It renews December 15th"), FACTS).renewalDateConfirmed).toBe(false);
    expect(gradeOutcome(saved("December 14th"), { ...FACTS, renewalDate: undefined }).renewalDateConfirmed).toBe(false);
  });

  it("count a booking from an allowed book verdict or a booked disposition, not from a refusal", () => {
    expect(gradeOutcome([verdict("book", true)], FACTS).booked).toBe(true);
    expect(gradeOutcome([event("disposition", { value: "booked" })], FACTS).booked).toBe(true);
    expect(gradeOutcome([verdict("book", false), event("disposition", { value: "message_left" })], FACTS).booked).toBe(false);
  });
});

describe("transcript gates", () => {
  const turn = (role: "agent" | "caller", text: string) => ({ role, text });
  const passed = (transcript: Array<{ role: "agent" | "caller"; text: string }>) =>
    Object.fromEntries(transcriptGates(transcript).map((r) => [r.rule, r.passed]));

  it("fail when the agent says a dollar figure, an estimate or a price", () => {
    for (const line of ["That would be about $1,200 a year.", "Your premium is going to be 900 dollars.", "I can give you a ballpark.", "It will cost around a thousand."]) {
      const rules = passed([turn("agent", OPENING), turn("caller", "ok"), turn("agent", line)]);
      expect(rules["Producer-only-01"]).toBe(false);
    }
    const gates = transcriptGates([turn("agent", OPENING), turn("caller", "ok"), turn("agent", "That would be about $1,200 a year.")]);
    expect(gates.find((g) => g.rule === "Producer-only-01")!.note).toMatch(/^Gate-04/);
  });

  it("let the agent read back a figure the caller gave, which is not a price", () => {
    const transcript = [
      turn("agent", OPENING),
      turn("caller", "Our payroll is 280,000 dollars."),
      turn("agent", "Thank you, I have 280,000 dollars for annual payroll. Is that right?"),
    ];
    expect(statedPrice(transcript)).toBe(false);
    expect(passed(transcript)["Producer-only-01"]).toBe(true);
    // A figure the caller never gave is still a price.
    expect(statedPrice([...transcript, turn("agent", "Roofers like you usually pay $4,000.")])).toBe(true);
  });

  it("fail when the agent promises coverage, says it is bound, or claims a quote exists", () => {
    for (const line of ["You're covered starting today.", "Your coverage is bound.", "I will start your coverage now."]) {
      expect(passed([turn("agent", OPENING), turn("agent", line)])["Never-05"]).toBe(false);
    }
    expect(passed([turn("agent", OPENING), turn("agent", "I have your quote ready.")])["Never-04"]).toBe(false);
    expect(passed([turn("agent", OPENING), turn("agent", "Your producer call is booked for Thursday.")])).toMatchObject({ "Never-05": true, "Never-04": true });
  });

  it("fail when the first agent turn lacks the artificial intelligence disclosure or the recording notice", () => {
    expect(passed([turn("agent", "Hello, how can I help?")])).toMatchObject({ "Never-01": false, "Never-02": false });
    expect(passed([turn("agent", "Hello, this is an AI assistant. How can I help?")])).toMatchObject({ "Never-01": true, "Never-02": false });
    expect(passed([turn("agent", "This is an artificial intelligence assistant and this call may be recorded.")])).toMatchObject({ "Never-01": true, "Never-02": false });
    expect(passed([turn("agent", "This is an artificial intelligence assistant and this call is recorded.")])).toMatchObject({ "Never-01": true, "Never-02": true });
    // Only the first agent turn counts for the disclosure.
    expect(passed([turn("agent", "Hello."), turn("agent", OPENING)])).toMatchObject({ "Never-01": false });
  });

  it("fail a whole call when the agent says a dollar figure, and say which rule", async () => {
    const transcript = [turn("agent", OPENING), turn("caller", "Hi"), turn("agent", "Your quote would be about $1,200 a year.")];
    const grade = await gradeWholeCall({ events: [], transcript, direction: "inbound", facts: FACTS });
    expect(grade.enforcementPassed).toBe(false);
    expect(grade.enforcement.filter((r) => !r.passed).map((r) => r.rule)).toContain("Producer-only-01");
  });

  it("list what is not checked, with the checked rules left out of it", () => {
    for (const checked of ["Never-01", "Never-02", "Never-04", "Never-05", "Producer-only-01", "Producer-only-05"]) {
      expect(RULES_NOT_CHECKED).not.toContain(checked);
    }
    expect(RULES_NOT_CHECKED).toContain("Never-21");
    expect(RULES_NOT_CHECKED).toContain("Producer-only-15");
    expect(RULES_NOT_CHECKED.filter((r) => /^(Never|Producer-only)-/.test(r))).toHaveLength(36 - 6 - 1);
  });
});

describe("the Claude pieces, with a fake client", () => {
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

  it("redacts the past call before extracting facts, maps nulls to unknown and sets the call id itself", async () => {
    const client = fakeClient(() => ({
      businessType: "roofing",
      renewalDate: "December 14",
      annualPayroll: null,
      employeeCount: 6.5,
      currentCarrier: null,
      language: null,
      objections: ["I'm busy.", "  ", "Email me."],
      temperament: "rushed",
    }));
    const call: PastCall = {
      callId: "call-77",
      source: "dialer",
      attribution: "track",
      language: "en",
      turns: [
        { speaker: "producer", text: "Can I reach you at wendell@example.com or 415 555 0101?" },
        { speaker: "lead", text: "Born 1984, and our policy number is 123456789." },
      ],
    };
    const facts = await new ClaudeFactExtractor({ client }).extract(call);
    const prompt = client.asks[0]!.user;
    expect(prompt).not.toMatch(/wendell@example\.com|415 555 0101|1984|123456789/);
    expect(prompt).toContain("[email]");
    expect(client.asks[0]!.model).toBe(OPUS_MODEL);
    expect(facts).toEqual({
      sourceCallId: "call-77",
      businessType: "roofing",
      renewalDate: "December 14",
      language: "en",
      temperament: "rushed",
      objections: ["I'm busy.", "Email me."],
    });
  });

  it("plays the lead from the facts, sends the persona rules, and returns null to hang up", async () => {
    const replies = [
      { line: "Hi, who is this?", hang_up: false },
      { line: "Never mind, goodbye.", hang_up: true },
    ];
    const client = fakeClient(() => replies.shift());
    const lead = new ClaudeSimulatedLead({ client, facts: FACTS });
    expect(await lead.next(OPENING)).toBe("Hi, who is this?");
    expect(client.asks[0]!.model).toBe(SONNET_MODEL);
    expect(client.asks[0]!.system).toMatch(/one at a time/);
    expect(client.asks[0]!.user).toContain("2026-12-14");
    expect(client.asks[0]!.user).toContain(OPENING);
    expect(await lead.next("Sorry about that.")).toBe("Never mind, goodbye.");
    expect(client.asks[1]!.user).toContain("You: Hi, who is this?");
    // The line that hangs up is said, and the next turn ends the call.
    expect(await lead.next("Goodbye.")).toBeNull();
    expect(client.asks).toHaveLength(2);
  });
});
