import { describe, expect, it } from "vitest";
import { redactSensitiveSummaries, SENSITIVE_PATTERNS } from "../../src/behaviour/guard/redaction.js";

describe("redactSensitiveSummaries", () => {
  it("Never-18: removes only the sensitive sentence", () => {
    const result = redactSensitiveSummaries([
      "Renewal is March 14. The owner is out for surgery next month. Payroll is about 250,000.",
    ]);
    expect(result.kept).toEqual(["Renewal is March 14. Payroll is about 250,000."]);
    expect(result.removedCount).toBe(1);
  });

  it("leaves a clean summary exactly alone", () => {
    const clean = "Wants a producer call Thursday morning.  Twelve employees; no general liability.";
    expect(redactSensitiveSummaries([clean])).toEqual({ kept: [clean], removedCount: 0 });
  });

  it("Never-18: drops a summary entirely when nothing is left", () => {
    const result = redactSensitiveSummaries(["His wife is in the hospital.", "Needs a certificate by Friday."]);
    expect(result.kept).toEqual(["Needs a certificate by Friday."]);
    expect(result.removedCount).toBe(1);
  });

  it("keeps the order of the summaries that remain", () => {
    const result = redactSensitiveSummaries([
      "First: call back Tuesday.",
      "Second: funeral this week.",
      "Third: payroll is 90,000. Her cancer diagnosis was in May.",
      "Fourth: has a bookkeeper.",
    ]);
    expect(result.kept).toEqual(["First: call back Tuesday.", "Third: payroll is 90,000.", "Fourth: has a bookkeeper."]);
    expect(result.removedCount).toBe(2);
  });

  it("splits sentences on line breaks as well as full stops", () => {
    const result = redactSensitiveSummaries(["Payroll 90,000\nGoing through a divorce\nCall Monday"]);
    expect(result.kept).toEqual(["Payroll 90,000 Call Monday"]);
  });

  it("returns nothing for no summaries", () => {
    expect(redactSensitiveSummaries([])).toEqual({ kept: [], removedCount: 0 });
  });

  it.each([
    "He had a health scare last year.",
    "She was in the hospital for a week.",
    "He is recovering from surgery.",
    "An illness in the family slowed the business.",
    "Cancer treatment is keeping him out.",
    "A new diagnosis changed the plan.",
    "They are arranging a funeral.",
    "Her father's death is recent.",
    "His mother passed away in June.",
    "Going through a divorce.",
    "Filed for bankruptcy two years ago.",
    "There is a lawsuit pending.",
    "He was arrested last spring.",
    "Family hardship this year.",
    "His wife keeps the books.",
    "Her husband owns the other half.",
    "The spouse signs checks.",
    "The kids work summers.",
    "His son runs the second crew.",
    "Her daughter handles payroll.",
  ])("Never-18: removes %s", (sentence) => {
    expect(redactSensitiveSummaries([sentence])).toEqual({ kept: [], removedCount: 1 });
  });

  it.each([
    "Renewal is March 14.",
    "Twelve employees, three in the field.",
    "Owner wants a Thursday call.",
    "Has general liability with Hartford.",
    "Sonoma County roofing contractor.",
  ])("keeps a sentence with nothing sensitive: %s", (sentence) => {
    expect(redactSensitiveSummaries([sentence])).toEqual({ kept: [sentence], removedCount: 0 });
  });

  it("exports the patterns for reuse", () => {
    expect(SENSITIVE_PATTERNS.length).toBeGreaterThan(0);
    expect(SENSITIVE_PATTERNS.some((p) => p.test("her cancer"))).toBe(true);
  });
});
