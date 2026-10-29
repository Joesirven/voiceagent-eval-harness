/**
 * Runtime settings for the lab voice agent engine, so a console can switch it on
 * for the next call instead of restarting the server with environment variables:
 * the prompt setup, the lead context gate, the thinker and Talk transcripts to the
 * local harness table. Served at GET and POST /api/setups/agent (src/setups/routes.ts).
 *
 * The gate and the thinker are read from the environment at call time
 * (leadContextGateOn, liveThinkerStatus), so this module sets those variables in
 * this process; nothing is written to disk. Every change applies to the next call.
 */

import { selectPromptSetup } from "../behaviour/install-prompt.js";
import { DEFAULT_SETUP_ID, getPromptSetupRegistry } from "../behaviour/prompt/setups.js";
import { leadContextGateOn } from "../lead-context/build.js";
import { LIVE_THINKER_ENV, liveThinkerStatus } from "../server/voice/live-thinker.js";
import { isRunWriteBackEnabled, isTalkWriteBackEnabled, setTalkWriteBack } from "./run-writer.js";

export const LEAD_CONTEXT_GATE_ENV = "VOICE_HARNESS_LEAD_CONTEXT_GATE";
export const LAB_PROMPT_SETUP_ID = "lab-natural";

export type AgentPreset = "lab" | "default";

export interface AgentSettings {
  promptSetups: { id: string; label: string }[];
  promptSetupId: string;
  /** "off" gives the agent the lead's facts, the last conversation and the days to renewal from the first word. */
  leadContextGate: "on" | "off";
  /** Experimental: in the live test gpt-live-1 never opened a delegation, so the thinker's tools did not run. */
  thinker: { enabled: boolean; deployment?: string; toolCount: number };
  /** Talk calls written to voice_harness.harness_run when they end; needs write-back itself on. */
  talkWriteBack: boolean;
  writeBack: boolean;
  /** Which preset every setting matches, or "custom". */
  preset: AgentPreset | "custom";
}

interface Choice {
  promptSetupId: string;
  leadContextGate: "on" | "off";
  thinker: boolean;
  talkWriteBack: boolean;
}

export const AGENT_PRESETS: Record<AgentPreset, Choice> = {
  lab: { promptSetupId: LAB_PROMPT_SETUP_ID, leadContextGate: "off", thinker: false, talkWriteBack: true },
  default: { promptSetupId: DEFAULT_SETUP_ID, leadContextGate: "on", thinker: false, talkWriteBack: false },
};

export function agentSettings(): AgentSettings {
  const registry = getPromptSetupRegistry();
  const thinker = liveThinkerStatus();
  const now: Choice = {
    promptSetupId: registry.selectedId(),
    leadContextGate: leadContextGateOn() ? "on" : "off",
    thinker: thinker.enabled,
    talkWriteBack: isTalkWriteBackEnabled(),
  };
  const preset = (Object.keys(AGENT_PRESETS) as AgentPreset[]).find((p) => JSON.stringify(AGENT_PRESETS[p]) === JSON.stringify(now)) ?? "custom";
  return {
    promptSetups: registry.list().map((s) => ({ id: s.id, label: s.label })),
    promptSetupId: now.promptSetupId,
    leadContextGate: now.leadContextGate,
    thinker: { enabled: thinker.enabled, ...(thinker.deployment ? { deployment: thinker.deployment } : {}), toolCount: thinker.tools.length },
    talkWriteBack: now.talkWriteBack,
    writeBack: isRunWriteBackEnabled(),
    preset,
  };
}

const KEYS = new Set(["preset", "promptSetupId", "leadContextGate", "thinker", "talkWriteBack"]);

/** Applies a preset first, then any single setting the body names. Refuses unknown keys and values before changing anything. */
export function applyAgentSettings(body: Record<string, unknown>): AgentSettings {
  for (const key of Object.keys(body)) if (!KEYS.has(key)) throw new Error(`agent_setting_unknown:${key}`);
  if (body.preset !== undefined && !(typeof body.preset === "string" && body.preset in AGENT_PRESETS)) throw new Error("agent_preset_unknown");
  if (body.promptSetupId !== undefined && !(typeof body.promptSetupId === "string" && getPromptSetupRegistry().get(body.promptSetupId))) throw new Error("agent_prompt_setup_unknown");
  if (body.leadContextGate !== undefined && body.leadContextGate !== "on" && body.leadContextGate !== "off") throw new Error("agent_lead_context_gate_invalid");
  if (body.thinker !== undefined && typeof body.thinker !== "boolean") throw new Error("agent_thinker_invalid");
  if (body.talkWriteBack !== undefined && typeof body.talkWriteBack !== "boolean") throw new Error("agent_talk_write_back_invalid");
  const choice: Partial<Choice> = { ...(body.preset ? AGENT_PRESETS[body.preset as AgentPreset] : {}) };
  if (typeof body.promptSetupId === "string") choice.promptSetupId = body.promptSetupId;
  if (body.leadContextGate === "on" || body.leadContextGate === "off") choice.leadContextGate = body.leadContextGate;
  if (typeof body.thinker === "boolean") choice.thinker = body.thinker;
  if (typeof body.talkWriteBack === "boolean") choice.talkWriteBack = body.talkWriteBack;
  if (choice.promptSetupId) selectPromptSetup(choice.promptSetupId);
  if (choice.leadContextGate) process.env[LEAD_CONTEXT_GATE_ENV] = choice.leadContextGate;
  if (choice.thinker !== undefined) process.env[LIVE_THINKER_ENV] = choice.thinker ? "on" : "off";
  if (choice.talkWriteBack !== undefined) setTalkWriteBack(choice.talkWriteBack);
  return agentSettings();
}
