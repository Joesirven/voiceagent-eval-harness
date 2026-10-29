/**
 * Agent-bound instructions: standing rules from prompt setup plus the lead packet.
 * Simulator persona truth (reveal maps, expected dispositions, and similar) never
 * belongs here; callers use judge and simulator paths instead.
 */

import type { CallOpening } from "../compliance/disclosures.js";
import type { LeadContextPacket } from "../memory/context.js";
import type { CallDirection } from "../provider/interface.js";
import type { LeadRecord } from "../store/lead-store.js";
import {
  buildAgentSessionInstructions,
  formatLeadContextBlock,
  type HarnessPromptCallContext,
} from "./prompt-setup.js";

/** @deprecated Use `HarnessPromptCallContext` from prompt-setup. */
export type PromptContext = HarnessPromptCallContext;

/** Substrings that must not appear in text bound for the live agent or decision model. */
export const PERSONA_TRUTH_MARKERS = [
  "revealMap",
  "reveal_map",
  "expectedDisposition",
  "expected_disposition",
] as const;

const MAX_AGENT_INSTRUCTION_CHARS = 128_000;

/** Formats only fields on `LeadContextPacket`; phone stays out of the prompt. */
export function leadContextBlock(packet: LeadContextPacket): string {
  return formatLeadContextBlock(packet);
}

export function assertAgentInstructionExcludesPersonaTruth(text: string): void {
  for (const marker of PERSONA_TRUTH_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(`agent_instruction_contains_persona_truth:${marker}`);
    }
  }
}

export function validateAgentSystemInstruction(text: string): void {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_AGENT_INSTRUCTION_CHARS) {
    throw new Error("agent_instruction_invalid");
  }
  assertAgentInstructionExcludesPersonaTruth(text);
}

/** Shared string for Azure live sessions and orchestration DecisionContext. */
export function buildAgentSystemInstruction(
  setupId: string,
  promptContext: HarnessPromptCallContext,
  packet: LeadContextPacket,
): string {
  const instruction = buildAgentSessionInstructions(setupId, promptContext, packet);
  validateAgentSystemInstruction(instruction);
  return instruction;
}

/** Scripted harness and call-loop paths use the same builder as live voice. */
export function buildHarnessAgentSystemInstruction(
  setupId: string,
  direction: CallDirection,
  lead: Pick<LeadRecord, "name">,
  packet: LeadContextPacket,
  disclosure: string,
  opening?: CallOpening,
): string {
  const leadFirstName = lead.name.trim().split(/\s+/)[0] ?? lead.name;
  return buildAgentSystemInstruction(
    setupId,
    { leadFirstName, direction, disclosure, ...(opening ? { opening } : {}) },
    packet,
  );
}
