import { describe, expect, it } from "vitest";
import { TRANSCRIPT_REDACTION_METHOD, nameCandidates, redactPatterns } from "../../src/transcripts/redact.js";

// Every name, number and address below is made up.
describe("transcript pattern redaction (harness_redact_text_v1, names not masked: prototype)", () => {
  it("names the method the simulator tables expect", () => {
    expect(TRANSCRIPT_REDACTION_METHOD).toBe("harness_redact_text_v1");
  });

  it("masks phones, emails, spoken emails, addresses, policy numbers and spelled-out numbers", () => {
    const all = [
      "Call me back at (555) 010-4477 or 555.010.9921.",
      "It's zed.quill@example.com, or zed quill at example dot com.",
      "We're at 4120 North Larkspur Avenue, suite 9.",
      "The policy number is WC-88A7731 and the old one was BOP 4471-22.",
      "My number is five five five, zero one zero, four four seven seven.",
      "Digits one by one: 5 5 5 0 1 0 4 4 7 7.",
    ].map(redactPatterns).join(" ");
    for (const leaked of ["555", "010", "4477", "9921", "example", "4120", "Larkspur", "88A7731", "4471", "five five", "four four"]) {
      expect(all.toLowerCase(), leaked).not.toContain(leaked.toLowerCase());
    }
    for (const token of ["[phone]", "[email]", "[address]", "[policy]", "[number]"]) expect(all).toContain(token);
  });

  it("keeps money amounts, small counts and ordinary words", () => {
    const out = redactPatterns("Payroll is about $250,000 a year with 12 employees, maybe fifteen in summer. We renew in March with Travelers.");
    for (const kept of ["$250,000", "12 employees", "fifteen", "March", "Travelers"]) expect(out).toContain(kept);
  });

  it("counts capitalized words after the first word of a sentence as name candidates", () => {
    expect(nameCandidates("Then Ostrander called Pembrook about it. Yes I did.")).toBe(2);
    expect(nameCandidates("[name] said so. I'm here.")).toBe(0);
  });
});
