import { afterEach, describe, expect, it } from "vitest";
import { installBehaviourPromptBuilder, resetBehaviourPromptInstall } from "../../src/behaviour/install-prompt.js";
import { resetLegalBlocks } from "../../src/behaviour/switches.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import {
  buildAgentSessionInstructions,
  buildSimulatedCallerPrompt,
  buildSystemPrompt,
  formatLeadContextBlock,
  resetSystemPromptBuilder,
  type SimulatedCallerPersona,
} from "../../src/modules/prompt-setup.js";
import type { LeadRecord } from "../../src/store/lead-store.js";

const CALL = {
  leadFirstName: "Maria",
  direction: "outbound" as const,
  disclosure: "This call uses an artificial intelligence assistant and is recorded.",
  agencyName: "Hartwell Insurance",
  publishedNumber: "555-0142",
};

function fullLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: "lead-99",
    agencyId: "agency-1",
    name: "Maria Ortega",
    phone: "+15550199",
    timezone: "America/Los_Angeles",
    smsConsentAt: "2026-10-01T12:00:00.000Z",
    voiceConsentAt: "2026-10-01T12:00:00.000Z",
    artificialVoiceConsent: { at: "2026-10-01T12:00:00.000Z", basis: "lead_written" },
    textAgreementAt: "2026-10-10T12:00:00.000Z",
    scheduledOutboundAt: "2026-10-15T19:30:00.000Z",
    onStopList: false,
    onDncList: false,
    dncStatus: "clear",
    suppressed: false,
    priorCallSummaries: ["Asked for a Thursday callback."],
    quoteFields: {
      business_name: { value: "Ortega Landscaping", evidenceSpan: "public record" },
      carrier: { value: "State Compensation Fund", evidenceSpan: "public record" },
    },
    handoffNotes: [],
    messages: [],
    bookings: [],
    ...overrides,
  };
}

const SIM_PERSONA: SimulatedCallerPersona = {
  id: "sim-busy-owner-07",
  truth: {
    "persona-truth-marker": "SECRET_PAYROLL_884200",
    hidden_intent: "wants to finish the job site first",
  },
  revealMap: {
    "reveal-map-marker": "only after you name the agency",
    carrier: "may confirm State Fund if asked directly",
  },
};

afterEach(() => {
  resetSystemPromptBuilder();
  resetBehaviourPromptInstall();
  resetLegalBlocks();
});

describe("LeadContextPacket mirrors the lead store", () => {
  it("copies timezone, suppression, schedule and consent fields", () => {
    const packet = buildLeadContextPacket(
      fullLead({ onStopList: true, suppressed: true, dncStatus: "listed", timezone: "Pacific/Honolulu" }),
    );
    expect(packet.timezone).toBe("Pacific/Honolulu");
    expect(packet.onStopList).toBe(true);
    expect(packet.suppressed).toBe(true);
    expect(packet.dncStatus).toBe("listed");
    expect(packet.textAgreementAt).toBe("2026-10-10T12:00:00.000Z");
    expect(packet.scheduledOutboundAt).toBe("2026-10-15T19:30:00.000Z");
    expect(packet.consentSnapshot.artificialVoiceConsent).toEqual({
      at: "2026-10-01T12:00:00.000Z",
      basis: "lead_written",
    });
  });

  it("lists store-backed values in the lead context block and omits the phone number", () => {
    const packet = buildLeadContextPacket(fullLead());
    const block = formatLeadContextBlock(packet);
    expect(block).toContain("Timezone: America/Los_Angeles");
    expect(block).toContain("Text agreement at:");
    expect(block).not.toContain("Ortega Landscaping");
    expect(formatLeadContextBlock(packet, { confirmed: true })).toContain("Ortega Landscaping");
    expect(block).not.toContain("+1555");
    expect(block).not.toMatch(/\bphone\b/i);
  });

  it("drops sensitive sentences from earlier call summaries in the lead context block", () => {
    const packet = buildLeadContextPacket(
      fullLead({ priorCallSummaries: ["Asked for a Thursday callback. His wife is in the hospital."] }),
    );
    const block = formatLeadContextBlock(packet, { confirmed: true });
    expect(block).toContain("Earlier call summaries: Asked for a Thursday callback.");
    expect(block).not.toMatch(/hospital|wife/i);
  });
});

describe("agent vs simulated caller context split", () => {
  it("keeps persona truth and reveal-map out of agent instructions when only the lead packet is supplied", () => {
    installBehaviourPromptBuilder();
    const packet = buildLeadContextPacket(fullLead());
    const instructions = buildAgentSessionInstructions("playbook-full", CALL, packet);
    expect(instructions).toContain("## Safety floor");
    expect(instructions).toContain("Never state or estimate a price");
    expect(instructions).not.toContain("persona-truth-marker");
    expect(instructions).not.toContain("SECRET_PAYROLL_884200");
    expect(instructions).not.toContain("reveal-map-marker");
    expect(instructions).not.toContain("hidden_intent");
    expect(instructions).not.toMatch(/carrier appetite/i);
    expect(instructions).not.toMatch(/preferred class/i);
  });

  it("puts persona truth and reveal-map only in the simulated caller prompt", () => {
    const caller = buildSimulatedCallerPrompt(SIM_PERSONA);
    expect(caller).toContain("persona-truth-marker");
    expect(caller).toContain("reveal-map-marker");
    expect(caller).toContain("SECRET_PAYROLL_884200");
  });

  it("places standing rules before the lead packet block", () => {
    installBehaviourPromptBuilder();
    const packet = buildLeadContextPacket(fullLead());
    const instructions = buildAgentSessionInstructions("floor-only", CALL, packet);
    const rulesAt = instructions.indexOf("## Safety floor");
    const leadAt = instructions.indexOf("Lead context (read only):");
    expect(rulesAt).toBeGreaterThanOrEqual(0);
    expect(leadAt).toBeGreaterThan(rulesAt);
  });
});

describe("behaviour prompt builder registration", () => {
  it("uses the stub until the behaviour builder is installed", () => {
    const packet = buildLeadContextPacket(fullLead());
    const stub = buildSystemPrompt("default", CALL, packet);
    expect(stub).toContain("artificial intelligence phone assistant for Northwind Insurance Agency");
    expect(stub).not.toContain("## Safety floor");
  });

  it("uses the behaviour layers prompt after install", () => {
    installBehaviourPromptBuilder();
    const packet = buildLeadContextPacket(fullLead());
    const text = buildSystemPrompt("playbook-full", CALL, packet);
    expect(text).toContain("## Safety floor");
    expect(text).toContain("artificial intelligence assistant");
  });
});
