import { describe, expect, it } from "vitest";
import {
  assertAgentInstructionExcludesPersonaTruth,
  buildAgentSystemInstruction,
  leadContextBlock,
  PERSONA_TRUTH_MARKERS,
} from "../../src/modules/agent-instructions.js";
import { FLOW_IS_BACKGROUND } from "../../src/behaviour/prompt/sections.js";
import { installBehaviourPromptBuilder, resetBehaviourPromptInstall } from "../../src/behaviour/install-prompt.js";
import { formatLeadContextBlock, resetSystemPromptBuilder } from "../../src/modules/prompt-setup.js";

const packet = {
  leadId: "l1",
  name: "Ada Lovelace",
  agencyId: "agency-1",
  phone: "5550199",
  priorCallSummaries: ["asked about general liability"],
  quoteFields: { employees: { value: "12", evidenceSpan: "twelve employees" } },
  consentSnapshot: {},
};

describe("agent instructions", () => {
  it("builds standing rules plus lead packet without the phone number", () => {
    const text = buildAgentSystemInstruction("default", {
      leadFirstName: "Ada",
      direction: "inbound",
      disclosure: "This call may be recorded.",
    }, packet);
    expect(text).toContain("CRM");
    expect(text).toContain("Name on file: Ada Lovelace");
    // Quote details are held until the named person is confirmed.
    expect(text).not.toContain("employees: 12");
    expect(formatLeadContextBlock(packet, { direction: "inbound", confirmed: true })).toContain("employees: 12");
    expect(text).not.toContain("5550199");
    for (const marker of PERSONA_TRUTH_MARKERS) {
      expect(text).not.toContain(marker);
    }
  });

  it("says a decision module picks each next step and the call flow is background, not a script", () => {
    // The live builder, as the harness installs it; the other tests here use the stub.
    installBehaviourPromptBuilder();
    try {
      for (const direction of ["inbound", "outbound"] as const) {
        const text = buildAgentSystemInstruction("default", { leadFirstName: "Ada", direction, disclosure: "This call may be recorded." }, packet);
        expect(text).toContain("## Call flow");
        // The paragraph opens the call-flow section, before any step.
        const flow = text.slice(text.indexOf("## Call flow"));
        expect(flow.split("\n")[1]).toBe(FLOW_IS_BACKGROUND);
        expect(FLOW_IS_BACKGROUND).toMatch(/decision module picks each next step/);
        expect(FLOW_IS_BACKGROUND).toMatch(/not a script/);
        expect(FLOW_IS_BACKGROUND).toMatch(/Only the first opening turn, the disclosure, is fixed word for word/);
        expect(text).not.toMatch(/say the two opening turns exactly/);
        expect(text).not.toMatch(/Follow these steps in order/);
        // The disclosure section agrees: its second opening turn is left to the guidance, not scripted.
        expect(text).not.toMatch(/Open it in two separate turns/);
        if (direction === "inbound") expect(text).toMatch(/Second turn[^"\n]*the guidance decides it/);
      }
    } finally {
      resetSystemPromptBuilder();
      resetBehaviourPromptInstall();
    }
  });

  it("rejects persona truth embedded in a custom instruction string", () => {
    expect(() => assertAgentInstructionExcludesPersonaTruth("ok\nexpectedDisposition: booked")).toThrow(/persona_truth/);
  });

  it("formats lead context through the same helper voice and orchestration share", () => {
    const block = leadContextBlock(packet);
    // Earlier call summaries are held until the named person is confirmed.
    expect(block).not.toContain("asked about general liability");
    expect(formatLeadContextBlock(packet, { direction: "inbound", confirmed: true })).toContain("asked about general liability");
    expect(block).not.toContain("revealMap");
    expect(block).not.toContain("expectedDisposition");
  });
});
