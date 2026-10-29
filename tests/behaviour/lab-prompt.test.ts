import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  collectSpokenLines,
  getPromptSetupRegistry,
  lintStyle,
  getPersonality,
  renderSetupSections,
  type PromptContext,
} from "../../src/behaviour/prompt/index.js";
import { parseOverridesMarkdown } from "../../src/behaviour/prompt/overrides-file.js";
import { guardAgentLine } from "../../src/behaviour/guard/speech-guard.js";

const FULL: PromptContext = {
  direction: "outbound",
  agencyName: "Hartwell Insurance",
  businessName: "Ortega Landscaping",
  contactName: "Maria Ortega",
  xDate: "March 14",
  carrier: "State Compensation Fund",
  publishedNumber: "555-0142",
  agreedCallTime: "Tuesday at 3:30 pm",
  renewalSource: "the state licence board record",
  producerFirstName: "Pat",
};

describe("the insurance sales lab prompt setup", () => {
  it("ships as lab-natural with its overrides read from the markdown file", () => {
    const setup = getPromptSetupRegistry().get("lab-natural");
    expect(setup?.overridesFile).toBe("lab-voice-agent.md");
    expect(Object.keys(setup?.overrides ?? {}).sort()).toEqual(["booking", "discovery", "flow", "gatekeepers", "identity", "objections", "openers", "personality", "segment"]);
    expect(setup?.overrides?.disclosure).toBeUndefined();
  });

  it("keeps the generated floor, rules, disclosure and facts, and replaces the other layers", () => {
    const sections = renderSetupSections("lab-natural", FULL);
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.overridden]));
    expect(byId.floor).toBe(false);
    expect(byId.rules).toBe(false);
    expect(byId.disclosure).toBe(false);
    expect(byId.facts).toBe(false);
    for (const id of ["identity", "flow", "openers", "gatekeepers", "discovery", "objections", "booking", "segment", "personality"]) expect(byId[id]).toBe(true);
    // Every section keeps its own heading, so the context pane reads the same way for every setup.
    const built = buildSystemPrompt("lab-natural", FULL);
    expect(built.sections.every((s) => built.text.includes(`## ${s.title}`))).toBe(true);
  });

  it("fills the variables from the call's facts, the producer's first name included", () => {
    const built = buildSystemPrompt("lab-natural", FULL, { legalBlocks: "suspended" });
    expect(built.text).toContain("You are the voice of Hartwell Insurance");
    expect(built.text).toContain("renews on March 14, and it's with State Compensation Fund");
    expect(built.text).toContain("the producer you book for is Pat");
    expect(built.text).toContain("Thanks, Maria.");
    expect(built.text).toContain("published number, 555-0142");
    for (const slot of ["[agency name]", "[X-date]", "[carrier on public record]", "[producer first name]", "[first name]", "[contact name on file]", "[published number]"]) {
      expect(built.text).not.toContain(slot);
    }
    // The appointment being agreed on the call stays bracketed on purpose.
    expect(built.text).toContain("on [day] at [time], [time zone]");
    expect(built.missingFacts).toEqual([]);
  });

  it("leaves an unknown producer bracketed and never lists it as a missing fact", () => {
    const { producerFirstName: _p, ...rest } = FULL;
    const built = buildSystemPrompt("lab-natural", rest);
    expect(built.text).toContain("[producer first name]");
    expect(built.missingFacts).toEqual([]);
    const facts = built.text.slice(built.text.indexOf("## Facts on file"));
    expect(facts).not.toContain("producer");
  });

  it("tells the voice model that the decision module's guidance and the call context updates drive the call", () => {
    const built = buildSystemPrompt("lab-natural", { direction: "inbound", agencyName: "Hartwell Insurance", publishedNumber: "555-0142" });
    expect(built.text).toContain("A decision module follows this call step by step");
    expect(built.text).toContain("Call context update");
    expect(built.text).toContain("never recite them in order");
  });

  it("speaks lines a warm conversational voice would: no fillers, no formal address, no sales words", () => {
    const profile = getPersonality("warm-conversational");
    const lines = collectSpokenLines("lab-natural", FULL);
    expect(lines.length).toBeGreaterThan(60);
    const findings = lines.flatMap((line) => lintStyle(line, profile).filter((f) => ["credibility_filler", "formal_address", "avoided_vocabulary", "are_you_still_there"].includes(f.rule)).map((f) => `${f.rule}: ${line}`));
    expect(findings).toEqual([]);
    for (const line of lines) expect(guardAgentLine(line, { direction: "outbound" }).allowed).toBe(true);
  });

  it("reads the markdown by layer heading and refuses a bad one", () => {
    expect(parseOverridesMarkdown("intro\n\n## identity\nWho.\n\n## flow\nHow.\n")).toEqual({ identity: "Who.", flow: "How." });
    expect(() => parseOverridesMarkdown("## disclosure\nNope.")).toThrow("disclosure_locked");
    expect(() => parseOverridesMarkdown("## voicemail\nNope.")).toThrow("overrides_layer_unknown:voicemail");
    expect(() => parseOverridesMarkdown("## flow\nA.\n## flow\nB.")).toThrow("overrides_layer_duplicate:flow");
    expect(() => parseOverridesMarkdown("## flow\n\n")).toThrow("overrides_section_empty:flow");
    expect(() => parseOverridesMarkdown("just text")).toThrow("overrides_file_has_no_sections");
  });

  it("refuses an overrides file on a custom setup and a disclosure override on any setup", () => {
    const registry = getPromptSetupRegistry();
    const base = { id: "mine", label: "Mine", description: "", layers: ["identity" as const], personalityId: "none" };
    expect(() => registry.register({ ...base, overridesFile: "lab-voice-agent.md" })).toThrow("setup_overrides_file_is_shipped_only");
    expect(registry.parseSetups(JSON.stringify({ ...base, overrides: { disclosure: "x" } })).errors).toEqual(["setup[0]: disclosure_locked"]);
    registry.register({ ...base, overrides: { identity: "You are [agency name]'s assistant." } });
    expect(buildSystemPrompt("mine", FULL).text).toContain("## Who you are\nYou are Hartwell Insurance's assistant.");
    registry.remove("mine");
  });
});
