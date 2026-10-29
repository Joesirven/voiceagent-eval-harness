import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setRecordingNoticeEnabled } from "../../src/config.js";
import { INBOUND_AI_DISCLOSURE, INBOUND_RECORDING_DISCLOSURE, callOpening, inboundOpeningScript } from "../../src/compliance/disclosures.js";
import {
  buildSystemPrompt,
  compareSetups,
  getPromptSetupRegistry,
  promptContextFromPacket,
  resetPromptSetupRegistry,
  type PromptContext,
  type PromptSetup,
} from "../../src/behaviour/prompt/index.js";
import { ENFORCEMENT_RULES, RULE_ENFORCEMENT } from "../../src/behaviour/rules.js";
import { resetLegalBlocks, setLegalBlocks } from "../../src/behaviour/switches.js";
import type { LegalBlocksMode } from "../../src/behaviour/types.js";
import type { LeadContextPacket } from "../../src/memory/context.js";

const FULL: Omit<PromptContext, "direction"> = {
  agencyName: "Hartwell Insurance",
  businessName: "Ortega Landscaping",
  contactName: "Maria Ortega",
  xDate: "March 14",
  carrier: "State Compensation Fund",
  publishedNumber: "555-0142",
  agreedCallTime: "Tuesday at 3:30 pm",
  renewalSource: "the state licence board record",
};
const inboundCtx: PromptContext = { direction: "inbound", ...FULL };
const outboundCtx: PromptContext = { direction: "outbound", ...FULL };
const MODES: LegalBlocksMode[] = ["enforced", "suspended"];

const ZERO_LAYERS: PromptSetup = { id: "nothing", label: "Nothing", description: "No layers", layers: [], personalityId: "none" };

function section(built: ReturnType<typeof buildSystemPrompt>, id: string): string {
  const at = built.sections.findIndex((s) => s.id === id);
  if (at < 0) return "";
  const start = built.text.indexOf(`## ${built.sections[at].title}`);
  const next = built.sections[at + 1];
  const end = next ? built.text.indexOf(`## ${next.title}`) : built.text.length;
  return built.text.slice(start, end);
}

afterEach(() => {
  resetLegalBlocks();
  resetPromptSetupRegistry();
  resetHarnessConfig();
});

describe("every shipped setup builds", () => {
  const ids = getPromptSetupRegistry()
    .list()
    .map((s) => s.id);
  it("ships the required setups", () => {
    for (const id of ["playbook-full", "playbook-warm", "playbook-brisk", "rules-and-personality", "rules-only", "floor-only"]) {
      expect(ids).toContain(id);
    }
  });
  for (const id of ids) {
    for (const mode of MODES) {
      for (const direction of ["inbound", "outbound"] as const) {
        it(`${id} builds for ${direction} calls with legal blocks ${mode}`, () => {
          const built = buildSystemPrompt(id, { direction, ...FULL }, { legalBlocks: mode });
          expect(built.setupId).toBe(id);
          expect(built.legalBlocks).toBe(mode);
          expect(built.text.length).toBeGreaterThan(500);
          expect(built.approxTokens).toBe(Math.ceil(built.text.length / 4));
          expect(built.sections.every((s) => built.text.includes(`## ${s.title}`))).toBe(true);
        });
      }
    }
  }
});

describe("safety floor", () => {
  it("is the first section, even for a setup with zero layers", () => {
    const built = buildSystemPrompt(ZERO_LAYERS, inboundCtx);
    expect(built.sections.map((s) => s.id)).toEqual(["floor"]);
    const floor = built.text.toLowerCase();
    expect(floor).toContain("artificial intelligence assistant");
    expect(floor).toContain("not a licensed producer");
    expect(floor).toContain("never state or estimate a price");
    expect(floor).toContain("stop at once");
    expect(floor).toContain("never guess a fact");
  });

  it("comes first and before every layer in every shipped setup", () => {
    for (const entry of getPromptSetupRegistry().list()) {
      const built = buildSystemPrompt(entry.id, outboundCtx);
      expect(built.sections[0].id).toBe("floor");
      expect(built.text.startsWith("## Safety floor")).toBe(true);
    }
  });

  it("holds in suspended mode too, and carries no legal wording", () => {
    const built = buildSystemPrompt(ZERO_LAYERS, outboundCtx, { legalBlocks: "suspended" });
    expect(built.sections[0].layer).toBe("behaviour");
    expect(built.text).toContain("Never state or estimate a price");
  });

  it("keeps the layers in the fixed order", () => {
    const built = buildSystemPrompt("playbook-full", inboundCtx);
    expect(built.sections.map((s) => s.id)).toEqual([
      "floor", "identity", "rules", "disclosure", "flow", "openers", "gatekeepers", "discovery",
      "objections", "booking", "followup", "segment", "personality", "facts",
    ]);
  });
});

describe("legal blocks", () => {
  it("includes the recording notice, calling window, caller identification and opt-out footer when enforced", () => {
    // The recording sentence is in the opening only while the recording notice is on.
    setRecordingNoticeEnabled(true);
    for (const ctx of [inboundCtx, outboundCtx]) {
      const built = buildSystemPrompt("playbook-full", ctx, { legalBlocks: "enforced" });
      const opening = section(built, "disclosure");
      expect(opening).toMatch(/recorded/);
      expect(opening).toContain(INBOUND_RECORDING_DISCLOSURE);
      expect(section(built, "rules")).toMatch(/recorded/);
      expect(built.text).toContain("Reply STOP to opt out.");
      expect(built.text).toMatch(/opt-out instruction/);
      expect(built.text).toMatch(/Never call outside 08:00 to 21:00/);
      expect(built.text).toMatch(/Never spoof or rotate caller identification/);
    }
  });

  it("omits every legal block when suspended", () => {
    for (const ctx of [inboundCtx, outboundCtx]) {
      const built = buildSystemPrompt("playbook-full", ctx, { legalBlocks: "suspended" });
      expect(section(built, "disclosure")).not.toMatch(/recorded|graba/);
      expect(section(built, "rules")).not.toMatch(/recorded/);
      expect(built.text).not.toContain(INBOUND_RECORDING_DISCLOSURE);
      expect(built.text).not.toMatch(/this call is recorded|esta llamada se graba/i);
      expect(built.text).not.toMatch(/Reply STOP/);
      expect(built.text).not.toMatch(/opt-out instruction/);
      expect(built.text).not.toMatch(/Never call outside 08:00/);
      expect(built.text).not.toMatch(/two attempts at most/i);
      expect(built.text).not.toMatch(/legal calling window|legal window/);
      expect(built.text).not.toMatch(/Never spoof or rotate caller identification/);
      for (const id of ["Never-02", "Never-10", "Never-11", "Never-19"]) expect(built.text).not.toContain(`${id}:`);
    }
  });

  it("never omits a behaviour rule, in either mode", () => {
    for (const mode of MODES) {
      const built = buildSystemPrompt("rules-only", outboundCtx, { legalBlocks: mode });
      const rules = section(built, "rules");
      for (const rule of ENFORCEMENT_RULES) {
        const layer = RULE_ENFORCEMENT[rule.id].layer;
        if (layer === "behaviour") expect(rules).toContain(`${rule.id}:`);
        else expect(rules.includes(`${rule.id}:`)).toBe(mode === "enforced");
      }
    }
    expect(ENFORCEMENT_RULES).toHaveLength(36);
  });

  it("says not to leave voicemail messages in both modes", () => {
    for (const mode of MODES) {
      const built = buildSystemPrompt("playbook-full", outboundCtx, { legalBlocks: mode });
      expect(built.text).toContain("Do not leave voicemail messages.");
      expect(built.text).not.toMatch(/Please call \[number\]/);
    }
  });

  it("tags sections: no legal wording left in suspended sections, a mixed section when enforced", () => {
    const suspended = buildSystemPrompt("playbook-full", outboundCtx, { legalBlocks: "suspended" });
    expect(suspended.sections.every((s) => s.layer === "behaviour")).toBe(true);
    const enforced = buildSystemPrompt("playbook-full", outboundCtx, { legalBlocks: "enforced" });
    const byId = Object.fromEntries(enforced.sections.map((s) => [s.id, s.layer]));
    expect(byId.floor).toBe("behaviour");
    expect(byId.rules).toBe("mixed");
    expect(byId.disclosure).toBe("mixed");
    expect(byId.discovery).toBe("behaviour");
  });

  it("follows the process-wide switch when no option is given", () => {
    setLegalBlocks("suspended");
    expect(buildSystemPrompt("playbook-full", inboundCtx).legalBlocks).toBe("suspended");
    resetLegalBlocks();
    expect(buildSystemPrompt("playbook-full", inboundCtx).legalBlocks).toBe("enforced");
    setLegalBlocks("suspended");
    expect(buildSystemPrompt("playbook-full", inboundCtx, { legalBlocks: "enforced" }).legalBlocks).toBe("enforced");
  });
});

describe("opening lines", () => {
  const firstTurn = (text: string) => /First turn[^"\n]*"([^"\n]+)"/.exec(text)?.[1];
  const secondTurn = (text: string) => /Second turn[^"\n]*"([^"\n]+)"/.exec(text)?.[1];

  /** The disclosure for the test agency, with no producer name and no known caller. */
  const HARTWELL = "Hi, this is the AI assistant with Hartwell Insurance.";

  it("inbound: the first instructed turn is exactly the filled disclosure, the second is the usual greeting, left to the guidance", () => {
    const built = buildSystemPrompt("playbook-full", inboundCtx, { legalBlocks: "enforced" });
    expect(firstTurn(built.text)).toBe(HARTWELL);
    expect(firstTurn(built.text)).toBe(inboundOpeningScript(callOpening({ agencyName: "Hartwell Insurance" })));
    expect(secondTurn(built.text)).toBe("Thanks for calling Hartwell Insurance. How can I help you today?");
    // Only the first turn is fixed: the second is an example of what usually follows, and the guidance decides it.
    expect(built.text).toMatch(/Second turn[^"\n]*the guidance decides it[^"\n]*usually sounds like this: "/);
    expect(built.text).not.toMatch(/Open it in two separate turns/);
    expect(built.text).not.toMatch(/Second turn, spoken after the first has finished: "/);
    expect(built.text).not.toContain(`Thanks for calling Hartwell Insurance. ${HARTWELL}`);
  });

  it("inbound with the recording notice on: the recording sentence follows the artificial intelligence sentence in the first turn", () => {
    setRecordingNoticeEnabled(true);
    const built = buildSystemPrompt("playbook-full", inboundCtx, { legalBlocks: "enforced" });
    expect(firstTurn(built.text)).toBe(`${HARTWELL} ${INBOUND_RECORDING_DISCLOSURE}`);
  });

  it("inbound with the recording notice off: the first turn is the artificial intelligence sentence alone, and the recording sentence appears nowhere", () => {
    const built = buildSystemPrompt("playbook-full", inboundCtx, { legalBlocks: "enforced" });
    expect(firstTurn(built.text)).toBe(HARTWELL);
    expect(built.text).not.toContain(INBOUND_RECORDING_DISCLOSURE);
  });

  it("inbound, suspended: the first turn is the artificial intelligence statement alone, even with the recording notice on", () => {
    setRecordingNoticeEnabled(true);
    const built = buildSystemPrompt("playbook-full", inboundCtx, { legalBlocks: "suspended" });
    expect(firstTurn(built.text)).toBe(HARTWELL);
  });

  it("inbound with no agency name: the plain disclosure", () => {
    const built = buildSystemPrompt("playbook-full", { ...inboundCtx, agencyName: undefined }, { legalBlocks: "enforced" });
    expect(firstTurn(built.text)).toBe(INBOUND_AI_DISCLOSURE);
  });

  it("inbound opening is present in setups that list only the disclosure layer", () => {
    const built = buildSystemPrompt("floor-only", inboundCtx, { legalBlocks: "enforced" });
    expect(firstTurn(built.text)).toBe(HARTWELL);
  });

  it("inbound from a known lead: the filled disclosure with the producer, then the confirmation question, and never an identity question", () => {
    const opening = callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" });
    const built = buildSystemPrompt("playbook-full", { ...inboundCtx, opening }, { legalBlocks: "enforced" });
    const disclosure = section(built, "disclosure");
    expect(firstTurn(built.text)).toBe("Hi, this is Pat's AI assistant with Example Mutual.");
    expect(disclosure).toContain('"Is this Maria?"');
    expect(disclosure).toContain("Say nothing about the account or the renewal date to anyone until the named person is confirmed.");
    expect(disclosure).toContain("Never ask a known lead who they are");
    expect(disclosure).not.toMatch(/may I have your name|name of the business you're with|Who am I speaking with/i);
    expect(disclosure).not.toContain("How can I help you today?");
    expect(disclosure).not.toContain(INBOUND_RECORDING_DISCLOSURE);
  });

  it("outbound: the filled disclosure and the contact confirmation question, with nothing about the account before it", () => {
    for (const mode of MODES) {
      const built = buildSystemPrompt("playbook-full", outboundCtx, { legalBlocks: mode });
      const opening = section(built, "disclosure");
      expect(firstTurn(opening)).toBe(HARTWELL);
      expect(opening).toContain('"Is this Maria?"');
      expect(opening).toContain("Say nothing about the account or the renewal date to anyone until the named person is confirmed.");
      expect(opening).not.toContain("workers' compensation renewal for Ortega Landscaping");
      expect(opening).not.toContain(INBOUND_RECORDING_DISCLOSURE);
    }
  });

  it("outbound in Spanish: the disclosure sentence and the confirmation question, never the renewal before the lead is confirmed", () => {
    for (const mode of MODES) {
      const opening = section(buildSystemPrompt("playbook-full", { ...outboundCtx, language: "es" }, { legalBlocks: mode }), "disclosure");
      expect(opening).toContain("le llama un asistente de inteligencia artificial");
      expect(opening).toContain("¿Hablo con Maria?");
      expect(opening).not.toMatch(/renovación|compensación/);
      expect(opening).not.toContain("esta llamada se graba");
    }
  });

  it("outbound with the recording notice on: the recording sentence follows the disclosure only while legal blocks are enforced", () => {
    setRecordingNoticeEnabled(true);
    for (const mode of MODES) {
      const opening = section(buildSystemPrompt("playbook-full", outboundCtx, { legalBlocks: mode }), "disclosure");
      expect(opening.includes(`${HARTWELL} ${INBOUND_RECORDING_DISCLOSURE}`)).toBe(mode === "enforced");
    }
  });
});

describe("prompt text hygiene", () => {
  const BANNED = [/thr_/, /pending legal research/i, /\bc\d\d /, /context 0\d/i, /\bSDR\b/, /\barchive/i, /\bharness\b/i, /`/, /\brewritten\b/i, /\bextract\b/i, /—/, /Northwind/];
  const ALLOWED_CAPITALS = new Set(["AI", "STOP", "YES"]);

  for (const entry of getPromptSetupRegistry().list()) {
    for (const mode of MODES) {
      for (const direction of ["inbound", "outbound"] as const) {
        it(`${entry.id} (${direction}, ${mode}) carries no thread identifiers, citations, review notes or stray acronyms`, () => {
          const built = buildSystemPrompt(entry.id, { direction, ...FULL }, { legalBlocks: mode });
          for (const pattern of BANNED) expect(built.text).not.toMatch(pattern);
          const capitals = (built.text.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !ALLOWED_CAPITALS.has(w));
          expect(capitals).toEqual([]);
          for (const paragraph of built.text.split("\n")) expect((paragraph.match(/—/g) ?? []).length).toBeLessThanOrEqual(1);
        });
      }
    }
  }

  it("explains the X-date as the policy renewal date", () => {
    const built = buildSystemPrompt("playbook-full", outboundCtx);
    expect(built.text).toContain("X-date (the workers' compensation policy expiration date)");
  });
});

describe("slot filling", () => {
  it("fills known values and nothing else", () => {
    const built = buildSystemPrompt("playbook-full", outboundCtx);
    expect(built.text).toContain("Ortega Landscaping");
    expect(built.text).toContain("renews on March 14");
    expect(built.text).toContain("State Compensation Fund");
    expect(built.text).toContain("555-0142");
    expect(built.text).toContain("Thanks, Maria.");
    expect(built.text).not.toContain("[agency name]");
    expect(built.text).not.toContain("[X-date]");
    expect(built.text).not.toContain("[contact name on file]");
    expect(built.text).not.toContain("[published number]");
    expect(built.missingFacts).toEqual([]);
  });

  it("leaves the booking appointment slots alone, because they are agreed during the call", () => {
    const built = buildSystemPrompt("playbook-full", outboundCtx);
    expect(built.text).toContain("on [day] at [time], [time zone]");
    expect(built.text).not.toContain("Tuesday at 3:30 pm, [time zone]");
  });

  it("leaves a missing value bracketed, lists it under facts on file and in missingFacts", () => {
    const { xDate: _xDate, carrier: _carrier, ...rest } = outboundCtx;
    const built = buildSystemPrompt("playbook-full", rest);
    expect(built.text).toContain("[X-date]");
    expect(built.text).toContain("[carrier on public record]");
    expect(built.text).not.toContain("March 14");
    expect(built.missingFacts).toEqual(["xDate", "carrier"]);
    const facts = section(built, "facts");
    expect(facts).toContain("Not on file: policy renewal date (the X-date); carrier on the public record.");
    expect(facts).toMatch(/Never guess a missing fact/);
  });

  it("expects fewer facts on an inbound call and still lists a missing agency name", () => {
    const built = buildSystemPrompt("playbook-full", { direction: "inbound" });
    expect(built.missingFacts).toEqual(["agencyName", "publishedNumber"]);
    expect(built.text).toContain("Thanks for calling [agency name].");
  });

  it("treats blank values as missing", () => {
    const built = buildSystemPrompt("floor-only", { ...outboundCtx, businessName: "  " });
    expect(built.missingFacts).toEqual(["businessName"]);
  });

  it("includes only redacted prior notes", () => {
    const built = buildSystemPrompt("playbook-full", {
      ...outboundCtx,
      priorNotes: ["Owner prefers afternoons.", "His wife is in the hospital after surgery.", "Two trucks added last spring."],
    });
    const facts = section(built, "facts");
    expect(facts).toContain("Owner prefers afternoons.");
    expect(facts).toContain("Two trucks added last spring.");
    expect(facts).not.toMatch(/wife|hospital|surgery/);
  });

  it("builds the context from a lead packet", () => {
    const packet: LeadContextPacket = {
      leadId: "lead-1",
      name: "Maria Ortega",
      agencyId: "agency-1",
      phone: "+15550100",
      priorCallSummaries: ["Asked for a Thursday call."],
      quoteFields: {},
      consentSnapshot: {},
    };
    const ctx = promptContextFromPacket(packet, { direction: "outbound", agencyName: "Hartwell Insurance", xDate: "March 14" });
    expect(ctx.contactName).toBe("Maria Ortega");
    expect(ctx.priorNotes).toEqual(["Asked for a Thursday call."]);
    expect(ctx.xDate).toBe("March 14");
    const built = buildSystemPrompt("floor-only", ctx);
    expect(built.missingFacts).toContain("businessName");
    expect(built.missingFacts).not.toContain("contactName");
  });
});

describe("changing the setup changes the prompt", () => {
  it("warm and brisk differ in the personality section and nowhere important else", () => {
    const warm = buildSystemPrompt("playbook-warm", outboundCtx);
    const brisk = buildSystemPrompt("playbook-brisk", outboundCtx);
    expect(warm.personalityId).toBe("warm-conversational");
    expect(brisk.personalityId).toBe("brisk-direct");
    expect(section(warm, "personality")).not.toBe(section(brisk, "personality"));
    expect(section(warm, "rules")).toBe(section(brisk, "rules"));
    expect(section(warm, "personality")).toContain("At most 3 sentences per turn");
    expect(section(brisk, "personality")).toContain("At most 1 sentence per turn");
  });

  it("rules-only is shorter than playbook-full, and floor-only is shorter still", () => {
    const full = buildSystemPrompt("playbook-full", outboundCtx);
    const rulesOnly = buildSystemPrompt("rules-only", outboundCtx);
    const floorOnly = buildSystemPrompt("floor-only", outboundCtx);
    expect(rulesOnly.approxTokens).toBeLessThan(full.approxTokens);
    expect(floorOnly.approxTokens).toBeLessThan(rulesOnly.approxTokens);
    expect(rulesOnly.personalityId).toBe("none");
    expect(rulesOnly.text).not.toContain("How you sound");
  });

  it("renders the personality only when the setup lists the layer", () => {
    const noLayer: PromptSetup = { ...ZERO_LAYERS, id: "voice-without-layer", personalityId: "brisk-direct" };
    expect(buildSystemPrompt(noLayer, outboundCtx).personalityId).toBe("none");
    const withLayer: PromptSetup = { ...noLayer, id: "voice-with-layer", layers: ["personality"] };
    expect(buildSystemPrompt(withLayer, outboundCtx).personalityId).toBe("brisk-direct");
  });

  it("lets a personality override replace the setup's own, and rejects an unknown one", () => {
    const built = buildSystemPrompt("playbook-full", outboundCtx, { personalityOverride: "brisk-direct" });
    expect(built.personalityId).toBe("brisk-direct");
    expect(built.text).toContain("How you sound: Brisk and direct");
    expect(buildSystemPrompt("playbook-full", outboundCtx, { personalityOverride: "none" }).personalityId).toBe("none");
    expect(() => buildSystemPrompt("playbook-full", outboundCtx, { personalityOverride: "pirate" })).toThrow(/personality_unknown/);
  });

  it("rejects an unknown setup id and an invalid setup object", () => {
    expect(() => buildSystemPrompt("no-such-setup", outboundCtx)).toThrow(/setup_unknown/);
    expect(() => buildSystemPrompt({ ...ZERO_LAYERS, layers: ["rules", "bogus" as never] }, outboundCtx)).toThrow(/setup_layer_unknown/);
  });

  it("builds a setup object that is not registered", () => {
    const custom: PromptSetup = { id: "my-test", label: "My test", description: "x", layers: ["rules", "facts"], personalityId: "none" };
    const built = buildSystemPrompt(custom, outboundCtx);
    expect(built.setupId).toBe("my-test");
    expect(built.sections.map((s) => s.id)).toEqual(["floor", "rules", "facts"]);
  });

  it("compares setups by size", () => {
    const rows = compareSetups(["playbook-full", "rules-only"], outboundCtx);
    expect(rows.map((r) => r.setupId)).toEqual(["playbook-full", "rules-only"]);
    expect(rows[0].approxTokens).toBeGreaterThan(rows[1].approxTokens);
    expect(rows[0].sectionChars.rules).toBe(rows[1].sectionChars.rules);
  });
});

describe("determinism", () => {
  it("gives the same output for the same input", () => {
    for (const entry of getPromptSetupRegistry().list()) {
      const a = buildSystemPrompt(entry.id, outboundCtx);
      const b = buildSystemPrompt(entry.id, structuredClone(outboundCtx));
      expect(b).toEqual(a);
    }
  });
});
