import { describe, expect, it } from "vitest";
import { listPersonalities, getPersonality, lintStyle } from "../../src/behaviour/prompt/index.js";
import { playbookItemIds } from "../../src/behaviour/prompt/sections.js";

const steady = getPersonality("steady-professional");
const warm = getPersonality("warm-conversational");
const brisk = getPersonality("brisk-direct");
const rules = (text: string, profile = steady) => lintStyle(text, profile).map((f) => f.rule);

describe("personality profiles", () => {
  it("ships the three profiles", () => {
    expect(listPersonalities().map((p) => p.id)).toEqual(["steady-professional", "warm-conversational", "brisk-direct"]);
  });

  it("differ in tempo numbers, not only in names", () => {
    const tempos = [steady, warm, brisk].map((p) => p.tempo);
    for (const key of ["maxSentencesPerTurn", "targetWordsPerTurn", "maxWordsPerTurn"] as const) {
      expect(new Set(tempos.map((t) => t[key])).size).toBe(3);
    }
    expect(brisk.tempo.maxWordsPerTurn).toBeLessThan(steady.tempo.maxWordsPerTurn);
    expect(steady.tempo.maxWordsPerTurn).toBeLessThan(warm.tempo.maxWordsPerTurn);
    expect(new Set([steady, warm, brisk].map((p) => p.tempo.pauseAfterQuestion)).size).toBe(3);
    expect(new Set([steady, warm, brisk].map((p) => p.tempo.rushedCallerRule)).size).toBe(3);
  });

  it("differ in tone and rapport", () => {
    expect(new Set([steady, warm, brisk].map((p) => p.tone.join("|"))).size).toBe(3);
    expect(new Set([steady, warm, brisk].map((p) => p.rapport.join("|"))).size).toBe(3);
    expect(warm.rapport.join(" ")).toContain("warm question");
    expect(brisk.rapport.join(" ")).toContain("Skip the warm question");
  });

  it("every profile has consistent tempo numbers and the shared vocabulary rules", () => {
    for (const p of [steady, warm, brisk]) {
      expect(p.tempo.targetWordsPerTurn).toBeLessThan(p.tempo.maxWordsPerTurn);
      expect(p.tone.length).toBeGreaterThan(5);
      const avoided = p.vocabulary.avoid.map((a) => a.term);
      for (const term of ["cohort", "enrollment", "variant", "funnel", "pipeline", "touchpoint", "nurture", "drip", "cadence", "audience", "segment", "conversion"]) {
        expect(avoided).toContain(term);
      }
      const said = p.vocabulary.prefer.map((x) => x.say).join(" ");
      for (const word of ["X-date", "renewal date", "book", "producer", "carrier", "policy"]) expect(said).toContain(word);
      expect(p.tone.join(" ") + p.rapport.join(" ")).toMatch(/trade words/);
      expect(p.avoidFillers).toEqual(expect.arrayContaining(["trust me", "to be honest", "I'm not going to lie", "are you still there"]));
    }
  });

  it("are derived from playbook items that exist", () => {
    const ids = new Set(playbookItemIds());
    for (const p of listPersonalities()) {
      expect(p.derivedFrom?.length).toBeGreaterThan(5);
      for (const id of p.derivedFrom ?? []) expect(ids.has(id)).toBe(true);
    }
  });

  it("rejects an unknown profile id", () => {
    expect(() => getPersonality("pirate")).toThrow("personality_unknown:pirate");
  });
});

describe("lintStyle", () => {
  const clean = "Thanks, Maria. Who carries your workers' compensation today?";

  it("passes a clean line", () => {
    expect(lintStyle(clean, steady)).toEqual([]);
    expect(lintStyle("Who carries your workers' compensation today?", brisk)).toEqual([]);
  });

  it("catches credibility fillers", () => {
    for (const phrase of ["Trust me, it is easy.", "To be honest, most owners skip it.", "I'm not going to lie, it is busy."]) {
      const found = lintStyle(phrase, steady).filter((f) => f.rule === "credibility_filler");
      expect(found).toHaveLength(1);
      expect(phrase.toLowerCase()).toContain(found[0].excerpt.toLowerCase());
    }
  });

  it("catches 'are you still there'", () => {
    expect(rules("Hello? Are you still there?")).toContain("are_you_still_there");
  });

  it("catches sir and ma'am", () => {
    expect(rules("Yes sir, a producer can call.")).toContain("formal_address");
    expect(rules("Thank you, ma'am.")).toContain("formal_address");
    expect(rules("The assistant said sirens were loud.")).not.toContain("formal_address");
  });

  it("catches avoided vocabulary and names the word to say instead", () => {
    const found = lintStyle("We keep a drip cadence for your cohort.", steady).filter((f) => f.rule === "avoided_vocabulary");
    expect(found.map((f) => f.excerpt.toLowerCase()).sort()).toEqual(["cadence", "cohort", "drip"]);
    expect(found.find((f) => f.excerpt === "cohort")?.note).toContain('"list"');
    expect(rules("Your pipeline is full.")).toContain("avoided_vocabulary");
    expect(rules("The pipelines are busy and the segmentation is done.")).not.toContain("avoided_vocabulary");
  });

  it("catches more than one question in a turn", () => {
    const found = lintStyle("How many employees do you have? And what is the payroll?", steady);
    expect(found.map((f) => f.rule)).toContain("multiple_questions");
    expect(rules("How many employees do you have?")).not.toContain("multiple_questions");
  });

  it("catches turns above the profile's maximum, and the limits differ by profile", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ") + ".";
    expect(rules(words(41), steady)).toContain("turn_too_long");
    expect(rules(words(40), steady)).not.toContain("turn_too_long");
    expect(rules(words(41), warm)).not.toContain("turn_too_long");
    expect(rules(words(61), warm)).toContain("turn_too_long");
    expect(rules(words(27), brisk)).toContain("turn_too_long");
    expect(rules(words(26), brisk)).not.toContain("turn_too_long");
  });

  it("catches too many sentences for the profile", () => {
    const three = "Got it. Thanks for that. Who carries it today?";
    expect(rules(three, steady)).toContain("too_many_sentences");
    expect(rules(three, warm)).not.toContain("too_many_sentences");
    expect(rules("Got it. Who carries it today?", brisk)).toContain("too_many_sentences");
  });

  it("catches more than one apology", () => {
    expect(rules("Sorry about that. I apologize for the wait.")).toContain("multiple_apologies");
    expect(rules("Sorry about that.")).not.toContain("multiple_apologies");
  });

  it("never blocks: it only returns findings with a rule, an excerpt and a note", () => {
    const findings = lintStyle("Trust me sir, are you still there? Sorry. Sorry again?", steady);
    expect(findings.length).toBeGreaterThanOrEqual(4);
    for (const f of findings) {
      expect(f.rule).toMatch(/^[a-z_]+$/);
      expect(f.excerpt.length).toBeGreaterThan(0);
      expect(f.note.length).toBeGreaterThan(0);
    }
  });
});
