import { describe, expect, it } from "vitest";
import { PIPECAT_PRESETS, pipecatConfig, pipecatPreset, pipecatSpeakerLabel } from "./pipecat-call";

// The brief's table (an internal design brief, pipecat-flows-dialog): body.config per combination.
describe("Pipecat Flows configurations", () => {
  it("full tree sends pipecat_flows, forces inbound, and names the stepped or gpt-live-1 speaker", () => {
    const stepped = pipecatConfig(pipecatPreset({ flow: "full_tree", mover: "decision_model", speaker: "stepped" }), "lead-x", "outbound");
    expect(stepped).toMatchObject({ orchestration: "pipecat_flows", stepsMovedBy: "decision_model", voicePath: "cascaded_deepgram", sttModel: "nova-3-general", replyDeployment: "gpt-5.4-mini", voice: "aura-2-thalia-en", direction: "inbound", lead: "lead-x", promptSetup: "default", endpointingMs: 300, vadStopSecs: 0.2 });
    expect(stepped).not.toHaveProperty("flowName");
    expect(stepped).not.toHaveProperty("flowVersion");
    const live = pipecatConfig(pipecatPreset({ flow: "full_tree", mover: "decision_model", speaker: "gpt_live" }), "lead-x", "inbound");
    expect(live).toMatchObject({ orchestration: "pipecat_flows", stepsMovedBy: "decision_model", voicePath: "gpt_live", replyDeployment: "none", voice: "azure-marin", direction: "inbound" });
    const liveSpeaking = pipecatConfig(pipecatPreset({ flow: "full_tree", mover: "speaking_model", speaker: "gpt_live" }), "lead-x", "inbound");
    expect(liveSpeaking).toMatchObject({ stepsMovedBy: "speaking_model", replyDeployment: "gpt-5.6-luna" });
    expect(pipecatSpeakerLabel({ flow: "full_tree", mover: "speaking_model", speaker: "gpt_live" })).toBe("gpt-live-1, steps moved by GPT-5.6 Luna");
  });

  it("five steps keeps quote_prototype with the flow named by who moves the steps, and keeps the chosen direction", () => {
    const decision = pipecatConfig(pipecatPreset({ flow: "five_steps", mover: "decision_model", speaker: "stepped" }), "lead-x", "outbound");
    expect(decision).toMatchObject({ orchestration: "quote_prototype", flowName: "five_steps", stepsMovedBy: "decision_model", voicePath: "cascaded_deepgram", direction: "outbound" });
    const speaking = pipecatConfig(pipecatPreset({ flow: "five_steps", mover: "speaking_model", speaker: "gpt_live" }), "lead-x", "inbound");
    expect(speaking).toMatchObject({ orchestration: "quote_prototype", flowName: "five_steps_speaking", stepsMovedBy: "speaking_model", voicePath: "gpt_live", replyDeployment: "gpt-5.6-luna", voice: "azure-marin" });
    const liveDecision = pipecatConfig(pipecatPreset({ flow: "five_steps", mover: "decision_model", speaker: "gpt_live" }), "lead-x", "inbound");
    expect(liveDecision).toMatchObject({ flowName: "five_steps", replyDeployment: "none" });
  });

  it("has eight presets with distinct ids and names, the full tree with the decision model and the stepped speaker first", () => {
    expect(PIPECAT_PRESETS).toHaveLength(8);
    expect(new Set(PIPECAT_PRESETS.map((p) => p.id)).size).toBe(8);
    expect(new Set(PIPECAT_PRESETS.map((p) => p.name)).size).toBe(8);
    expect(PIPECAT_PRESETS[0]).toMatchObject({ id: "pipecat-flows-full-tree-decision-stepped", name: "Full tree, decision model, Nova-3 GPT-5.4 mini Aura" });
  });
});
