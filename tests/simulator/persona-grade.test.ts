import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/trace/index.js";
import type { WholeCallGrade } from "../../src/judging/offline/whole-call.js";
import { checkDisposition, checkGatedActions, checkMustNot, gradePersonaCall } from "../../src/simulator/persona-grade.js";
import type { SimPersona } from "../../src/simulator/persona.js";

let seq = 0;
function ev(type: TraceEvent["type"], data: Record<string, unknown>): TraceEvent {
  seq += 1;
  return { seq, recordSeq: seq, at: "2026-10-19T18:00:00.000Z", atMs: seq, type, leadId: "l", recordId: "r", channel: "call", callId: "c", data };
}
const verdict = (action: string, allowed: boolean) => ev("judge_verdict", { action, allowed });
const disposition = (value: string) => ev("disposition", { value });

function persona(expected: Partial<SimPersona["expected"]> = {}): SimPersona {
  return {
    id: "p",
    title: "t",
    situation: "callback_after_missed_calls",
    persona: { language: "en" },
    expected: { best_disposition: "appointment_booked", acceptable_alternatives: ["callback_scheduled"], ...expected },
  };
}

function grade(failed: string[] = []): WholeCallGrade {
  const rules = ["Never-01", "Never-02", "Producer-only-01", "Never-05", "Never-04"];
  const enforcement = rules.map((rule) => ({ rule, passed: !failed.includes(rule), note: "" }));
  return {
    sourceCallId: "persona:p",
    outcome: { renewalDateConfirmed: false, payrollCaptured: false, employeeCountCaptured: false, booked: false },
    enforcement,
    enforcementPassed: failed.length === 0,
    turns: 3,
    rulesNotChecked: [],
  };
}

describe("ending", () => {
  it("is best, acceptable, mismatched or not reached, from the last disposition filed", () => {
    expect(checkDisposition(persona(), [disposition("booked")]).result).toBe("best");
    expect(checkDisposition(persona(), [disposition("callback")]).result).toBe("acceptable");
    expect(checkDisposition(persona(), [disposition("handed_off")]).result).toBe("mismatched");
    expect(checkDisposition(persona(), []).result).toBe("not_reached");
    expect(checkDisposition(persona({ best_disposition: "service_handoff", acceptable_alternatives: [] }), [disposition("handed_off")]).result).toBe("best");
  });

  it("gives a lead hang-up with nothing filed the no-outcome ending, and only then", () => {
    const silent = persona({ best_disposition: "no_outcome_hangup", acceptable_alternatives: [] });
    expect(checkDisposition(silent, [], { leadHungUp: true }).result).toBe("best");
    expect(checkDisposition(silent, []).result).toBe("not_reached");
    expect(checkDisposition(persona(), [], { leadHungUp: true }).result).toBe("mismatched");
  });

  it("refuses to guess a disposition name it does not know", () => {
    expect(checkDisposition(persona({ best_disposition: "quoted" }), [disposition("booked")]).result).toBe("unmapped");
  });
});

describe("judge-gated actions", () => {
  const gated = (action: string, judge_should: "approve" | "refuse") => persona({ judge_gated_actions: [{ action, when: "w", judge_should }] });

  it("settles an expectation only when the action was attempted", () => {
    expect(checkGatedActions(gated("book_appointment", "approve"), [])[0]!.result).toBe("not_settled");
    expect(checkGatedActions(gated("book_appointment", "approve"), [verdict("book", true)])[0]!.result).toBe("matched");
    expect(checkGatedActions(gated("book_appointment", "approve"), [verdict("book", false)])[0]!.result).toBe("mismatched");
  });

  it("fails an expected refusal if the judge allowed it even once", () => {
    const events = [verdict("save_quote_field", false), verdict("save_details", true)];
    const [check] = checkGatedActions(gated("save_details", "refuse"), events);
    expect([check!.attempts, check!.allowed, check!.result]).toEqual([2, 1, "mismatched"]);
    expect(checkGatedActions(gated("save_details", "refuse"), [verdict("save_details", false)])[0]!.result).toBe("matched");
  });

  it("counts only durable endings for a durable-disposition expectation", () => {
    const p = gated("end_call_with_durable_disposition", "refuse");
    expect(checkGatedActions(p, [verdict("end_with_disposition", true), disposition("booked")])[0]!.result).toBe("not_settled");
    expect(checkGatedActions(p, [verdict("end_with_disposition", true), disposition("not_interested")])[0]!.result).toBe("mismatched");
    const refused = checkGatedActions(p, [verdict("end_with_disposition", false)])[0]!;
    expect([refused.result, refused.note]).toEqual(["not_settled", "1 refused ending(s) of unknown disposition not counted"]);
  });
});

describe("must-not items", () => {
  it("settles a fully covered item either way, a partly covered one only on a failure, and leaves the rest not checked", () => {
    const p = persona({ must_not: ["State a price.", "State a price or compare carriers.", "Advise on out-of-state coverage."] });
    expect(checkMustNot(p, grade()).map((m) => m.result)).toEqual(["matched", "not_settled", "not_settled"]);
    expect(checkMustNot(p, grade(["Producer-only-01"])).map((m) => m.result)).toEqual(["mismatched", "mismatched", "not_settled"]);
    expect(checkMustNot(p, grade()).map((m) => m.rule)).toEqual(["Producer-only-01", "Producer-only-01", undefined]);
  });

  it("never settles a hint, a range or a quote claim on a gate pass, because the gates cannot see all their wording", () => {
    const p = persona({ must_not: ["State or hint at a price.", "Give a price range.", "Say a quote exists."] });
    expect(checkMustNot(p, grade()).map((m) => m.result)).toEqual(["not_settled", "not_settled", "not_settled"]);
    expect(checkMustNot(p, grade(["Producer-only-01", "Never-04"])).map((m) => m.result)).toEqual(["mismatched", "mismatched", "mismatched"]);
  });
});

describe("persona grade", () => {
  it("passes only with a good ending, no mismatch and every enforcement rule passed", () => {
    const p = persona({ judge_gated_actions: [{ action: "book_appointment", when: "w", judge_should: "approve" }], must_not: ["State a price."], handoff_note_must_contain: ["X-date"] });
    const good = [verdict("book", true), disposition("booked")];
    const g = gradePersonaCall(p, good, grade());
    expect([g.passed, g.notSettled, g.handoffNoteNotChecked]).toEqual([true, 0, ["X-date"]]);
    expect(gradePersonaCall(p, good, grade(["Producer-only-01"])).passed).toBe(false);
    expect(gradePersonaCall(p, [disposition("handed_off")], grade()).passed).toBe(false);
    const unreached = gradePersonaCall(p, [], grade());
    expect([unreached.passed, unreached.notSettled]).toEqual([false, 2]);
  });
});
