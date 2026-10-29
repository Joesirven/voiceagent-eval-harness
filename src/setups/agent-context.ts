/**
 * The context the agent is given, for the call setup dialog: the standing rules
 * the user may edit, and the lead context block the next call will append.
 * Served at GET, POST and DELETE /api/setups/agent-context (src/setups/routes.ts).
 *
 * The override replaces the standing rules only. The lead block is always built
 * live for the lead of the call, so an override never carries one lead's facts
 * into another lead's call, and the prompt setup's own rules return as soon as
 * the override is cleared. Read only otherwise: nothing here starts a call.
 */

import { getPromptSetupRegistry } from "../behaviour/prompt/setups.js";
import { callOpening, openingFactsFor, openingLine } from "../compliance/disclosures.js";
import { defaultAgencyName } from "../lead-context/route.js";
import { buildLeadContextPacket } from "../memory/context.js";
import { assertAgentInstructionExcludesPersonaTruth } from "../modules/agent-instructions.js";
import {
  buildSystemPrompt,
  formatLeadContextBlock,
  getStandingRulesOverride,
  MAX_STANDING_RULES_CHARS,
  setStandingRulesOverride,
  type HarnessPromptCallContext,
  type StandingRulesOverride,
} from "../modules/prompt-setup.js";
import { getActiveLeadStore } from "../store/active-store.js";
import type { LeadRecord } from "../store/lead-store.js";
import { getActiveSetup } from "./active-setup.js";
import { traceBus } from "../trace/events.js";

export interface AgentContextView {
  leadId: string | null;
  leadLabel: string | null;
  direction: "inbound" | "outbound";
  setupId: string;
  /** The prompt setup's standing rules for the next call, built now, ignoring any override. */
  standingRules: string;
  override: StandingRulesOverride | null;
  /** The lead block the next call appends, built now for the lead of the call. */
  leadBlock: string;
  /** What the next call sends: the override or the standing rules, then the lead block. */
  nextCallText: string;
  maxChars: number;
  note?: string;
}

export interface AgentContextDeps {
  getLead: (leadId: string) => Promise<LeadRecord | undefined>;
  /** The lead and direction the next call will use: the applied setup's lead, else the live or last call's. */
  target: () => { leadId: string; direction: "inbound" | "outbound" } | undefined;
  now: () => Date;
}

function lastCallTarget(): { leadId: string; direction: "inbound" | "outbound" } | undefined {
  const last = [...traceBus.history()].reverse().find((e) => e.channel === "call");
  return last ? { leadId: last.leadId, direction: last.direction ?? "inbound" } : undefined;
}

export const agentContextDeps: AgentContextDeps = {
  getLead: (id) => getActiveLeadStore().getLead(id),
  target: () => {
    const setup = getActiveSetup();
    if (setup) return { leadId: setup.profile.leadId, direction: lastCallTarget()?.direction ?? "inbound" };
    return lastCallTarget();
  },
  now: () => new Date(),
};

/** The lead the dialog asks about (the call bar's choice), when the query names one. */
export interface AgentContextQuery {
  leadId?: string;
  direction?: string;
}

/**
 * The view for the dialog. The query's lead wins (the call bar's choice), then the applied setup's lead, then the
 * live or last call's. Without a lead to build for, the standing rules still render (for a stand-in lead) and the note says so.
 */
export async function agentContextView(query: AgentContextQuery = {}, deps: AgentContextDeps = agentContextDeps): Promise<AgentContextView> {
  const setupId = getPromptSetupRegistry().selectedId();
  const override = getStandingRulesOverride();
  const asked = query.leadId?.trim();
  const askedDirection = query.direction === "outbound" ? "outbound" : query.direction === "inbound" ? "inbound" : undefined;
  const fallback = deps.target();
  const target: { leadId: string; direction: "inbound" | "outbound" } | undefined = asked
    ? { leadId: asked, direction: askedDirection ?? fallback?.direction ?? "inbound" }
    : fallback && askedDirection ? { ...fallback, direction: askedDirection } : fallback;
  const lead = target ? await deps.getLead(target.leadId) : undefined;
  const direction = target?.direction ?? "inbound";
  if (!lead) {
    const opening = callOpening();
    // The opening goes along too: without it the known-lead backstop renders "Is this the?" around the placeholder name.
    const call: HarnessPromptCallContext = { leadFirstName: "the caller", direction, disclosure: openingLine(opening), opening };
    const standingRules = buildSystemPrompt(setupId, call, emptyPacket(), { ignoreOverride: true });
    return {
      leadId: target?.leadId ?? null, leadLabel: null, direction, setupId, standingRules, override, leadBlock: "",
      nextCallText: override?.text ?? standingRules, maxChars: MAX_STANDING_RULES_CHARS,
      note: target ? "The lead of the next call was not found, so the lead block is not shown." : "No lead is chosen yet, so the lead block is not shown.",
    };
  }
  const packet = buildLeadContextPacket(lead);
  const agencyName = defaultAgencyName(lead.id) ?? packet.briefing?.agencyName;
  const facts = openingFactsFor({ name: lead.name, agencyName, briefing: packet.briefing }, direction, { knownLead: true });
  const opening = callOpening(facts);
  const leadFirstName = lead.name.trim().split(/\s+/)[0] ?? lead.name;
  const call: HarnessPromptCallContext = { leadFirstName, direction, disclosure: openingLine(opening), opening, ...(agencyName ? { agencyName } : {}) };
  const standingRules = buildSystemPrompt(setupId, call, packet, { ignoreOverride: true });
  const leadBlock = formatLeadContextBlock(packet, { direction, agencyName, now: deps.now() });
  return {
    leadId: lead.id, leadLabel: leadFirstName, direction, setupId, standingRules, override, leadBlock,
    nextCallText: `${override?.text ?? standingRules}\n\n${leadBlock}`, maxChars: MAX_STANDING_RULES_CHARS,
  };
}

function emptyPacket() {
  return { leadId: "none", name: "the caller", agencyId: "none", phone: "", priorCallSummaries: [], quoteFields: {}, consentSnapshot: {} };
}

/** Sets the override from the dialog. Refuses empty, oversized, or persona-truth text before changing anything. */
export function applyAgentContextOverride(body: Record<string, unknown>): void {
  if (typeof body.text !== "string") throw new Error("agent_context_text_invalid");
  assertAgentInstructionExcludesPersonaTruth(body.text);
  setStandingRulesOverride(body.text);
}

export function clearAgentContextOverride(): void {
  setStandingRulesOverride(null);
}
