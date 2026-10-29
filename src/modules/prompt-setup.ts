/**
 * Harness prompt-setup slot. Standing rules come from the behaviour prompt builder
 * (installed at server start). Agent session text is standing rules plus the lead
 * packet only. Simulated-caller personas use `buildSimulatedCallerPrompt` and
 * must never be merged into agent instructions.
 */

import { redactSensitiveSummaries } from "../behaviour/guard/redaction.js";
import type { CallOpening } from "../compliance/disclosures.js";
import { getHarnessConfig } from "../config.js";
import { CALL_OBJECTIVES } from "../judging/objective-definitions.js";
import { buildLeadContext, leadContextGateOn } from "../lead-context/build.js";
import { lastConversationExcerpt } from "../lead-context/last-conversation.js";
import type { LeadContextPacket } from "../memory/context.js";

export interface HarnessPromptCallContext {
  leadFirstName: string;
  direction: "inbound" | "outbound";
  /** Opening disclosure the agent must speak first on this call. */
  disclosure: string;
  agencyName?: string;
  publishedNumber?: string;
  /** The opening the harness fixed for this call, so the standing rules show the same words. */
  opening?: CallOpening;
}

/** Ground truth for a Pipecat simulated caller. Never pass this to the agent. */
export interface SimulatedCallerPersona {
  id: string;
  truth: Record<string, string>;
  revealMap: Record<string, string>;
}

export type SystemPromptBuilder = (
  setupId: string,
  call: HarnessPromptCallContext,
  packet: LeadContextPacket,
) => string;

export const stubSystemPrompt: SystemPromptBuilder = (_setupId, context) =>
  [
    "You are the artificial intelligence phone assistant for Northwind Insurance Agency.",
    `You are on a ${context.direction} call with ${context.leadFirstName}. Speak briefly and naturally, one or two sentences at a time.`,
    "Your first words are the disclosure given to you. Never claim to be a person. Never promise prices or coverage.",
    "If the caller asks to stop being contacted, agree at once and end the call politely.",
  ].join("\n");

let builder: SystemPromptBuilder = stubSystemPrompt;

export function setSystemPromptBuilder(fn: SystemPromptBuilder): void {
  builder = fn;
}

export function resetSystemPromptBuilder(): void {
  builder = stubSystemPrompt;
}

export interface StandingRulesOverride {
  text: string;
  setAt: string;
}

export const MAX_STANDING_RULES_CHARS = 60_000;

/**
 * The user's own standing rules, set from the call setup dialog's context editor
 * (src/setups/agent-context.ts). When set, every call gets this text in place of
 * the prompt setup's standing rules until it is cleared; the lead context block
 * is still built live for each lead and appended after it. In this process
 * only; nothing is written to disk.
 */
let standingRulesOverride: StandingRulesOverride | null = null;

export function getStandingRulesOverride(): StandingRulesOverride | null {
  return standingRulesOverride;
}

/** Sets the override (trimmed), or clears it with null. Throws agent_context_text_invalid for empty or oversized text. */
export function setStandingRulesOverride(text: string | null, now: () => Date = () => new Date()): StandingRulesOverride | null {
  if (text === null) {
    standingRulesOverride = null;
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_STANDING_RULES_CHARS) throw new Error("agent_context_text_invalid");
  standingRulesOverride = { text: trimmed, setAt: now().toISOString() };
  return standingRulesOverride;
}

/** Standing rules only (behaviour layers when installed), or the user's override when one is set. */
export function buildSystemPrompt(
  setupId: string,
  call: HarnessPromptCallContext,
  packet: LeadContextPacket,
  { ignoreOverride = false }: { ignoreOverride?: boolean } = {},
): string {
  if (!ignoreOverride && standingRulesOverride) return standingRulesOverride.text;
  return builder(setupId, call, packet);
}

/** The call's objectives as text for the agent: what to work toward, in order. Not lead data, so never gated. */
export function objectivesBlock(): string {
  return [
    "Objectives for this call, in order. Work toward the next one that is not yet done:",
    ...CALL_OBJECTIVES.map((o, i) => `${i + 1}. ${o.label}: done when ${o.criteria.done}.`),
  ].join("\n");
}

/**
 * Lead packet as plain text for the agent. Omits the phone number. Without options.confirmed it is gated. Does not
 * summarize or invent fields. Earlier contacts pass through the same sensitive-sentence redaction the standing
 * rules use (Never-18). The earlier call summaries are printed once, in the shared lead context block
 * (src/lead-context/build.ts), which redacts them the same way. When the harness's opening identity is set
 * (src/config.ts), that block names its producer and agency, as the opening line does.
 */
export function formatLeadContextBlock(
  packet: LeadContextPacket,
  options: { direction?: "inbound" | "outbound"; now?: Date; confirmed?: boolean; agencyName?: string; callId?: string } = {},
): string {
  const quoteLines = Object.entries(packet.quoteFields).map(([k, v]) => `${k}: ${v.value}`);
  const consent = packet.consentSnapshot;
  const consentLines: string[] = [];
  if (consent.smsConsentAt) consentLines.push(`text consent at ${consent.smsConsentAt}`);
  if (consent.voiceConsentAt) consentLines.push(`call consent at ${consent.voiceConsentAt}`);
  if (consent.consentRevokedAt) consentLines.push(`consent revoked at ${consent.consentRevokedAt}`);
  if (consent.artificialVoiceConsent) {
    consentLines.push(
      `artificial-voice consent at ${consent.artificialVoiceConsent.at} (${consent.artificialVoiceConsent.basis})`,
    );
  }
  const b = packet.briefing;
  const day = (iso: string) => iso.slice(0, 10);
  // The rest of the record, beyond what the shared block already lists: the policy line, dated earlier contacts and the missed dials.
  const contacts = b ? redactSensitiveSummaries(b.priorCalls.slice(0, 5).map((c) => `${day(c.at)} ${c.direction} ${c.channel}: ${c.summary}`)).kept : [];
  const missed = b?.missedOutboundCalls ?? [];
  const recordLines = [
    b?.xDate?.line ? `Policy line on file: ${b.xDate.line}${b.xDate.carrier ? ` with ${b.xDate.carrier}` : ""}, renewing ${b.xDate.date}` : undefined,
    contacts.length ? `Earlier contacts (dated): ${contacts.join(" | ")}` : undefined,
    missed.length ? `Missed outbound calls before this one: ${missed.length} (${missed.map((m) => day(m.at)).join(", ")}${missed.some((m) => m.simulated) ? "; some stand in for dials not on file" : ""})` : undefined,
  ].filter((line): line is string => line !== undefined);
  const suppression: string[] = [];
  if (packet.onStopList) suppression.push("stop list");
  if (packet.onDncList) suppression.push("do-not-call list flag");
  if (packet.suppressed) suppression.push("suppressed");
  if (packet.dncStatus) suppression.push(`do-not-call check: ${packet.dncStatus}`);

  // The shared lead context block (who, stage, quote checklist, days to renewal). At session start the
  // named person is not yet confirmed, so the block carries only the name on file and the stage.
  // Plainly: until a later change calls this with confirmed: true (the voice files that know when the
  // person is confirmed are outside this change), the live agent sees the name on file and the stage
  // only, and never the business, trade, headcount, quote checklist or days until renewal.
  // For the same reason the earlier call summaries and the quote details already collected are
  // withheld until confirmation: they can carry the business, the renewal date or account detail.
  // With VOICE_HARNESS_LEAD_CONTEXT_GATE=off the confirmed block renders from the start.
  const confirmed = (options.confirmed ?? false) || !leadContextGateOn();
  const openingIdentity = getHarnessConfig().openingIdentity;
  const shared = buildLeadContext({
    packet,
    direction: options.direction ?? "inbound",
    confirmed,
    agencyName: options.agencyName ?? packet.briefing?.agencyName,
    ...(openingIdentity ? { openingIdentity } : {}),
    now: options.now ?? new Date(),
  }).text;
  const last = confirmed ? lastConversationExcerpt(packet.leadId, { excludeCallId: options.callId }) : undefined;
  const lastLines = last
    ? [
        `Last conversation with them, on ${last.at.slice(0, 10)} (an excerpt for continuity: pick up where you left off, never read it back, never bring up anything sensitive):`,
        ...last.lines.map((l) => `- ${l}`),
      ]
    : [];

  return [
    "Lead context (read only):",
    `Lead id: ${packet.leadId}`,
    `Name on file: ${packet.name}`,
    packet.timezone ? `Timezone: ${packet.timezone}` : undefined,
    suppression.length ? `Suppression: ${suppression.join(", ")}` : undefined,
    consentLines.length ? `Consent: ${consentLines.join("; ")}` : undefined,
    packet.textAgreementAt ? `Text agreement at: ${packet.textAgreementAt}` : undefined,
    packet.scheduledOutboundAt ? `Scheduled outbound at: ${packet.scheduledOutboundAt}` : undefined,
    ...(confirmed
      ? [
          // The earlier call summaries are not repeated here: the shared block below lists them once.
          ...lastLines,
          `Quote details already collected: ${quoteLines.length ? quoteLines.join("; ") : "none"}`,
          ...recordLines,
        ]
      : ["Earlier call summaries and quote details already collected: withheld until the named person is confirmed on this call."]),
    "",
    shared,
    "",
    objectivesBlock(),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Full agent session instructions: standing rules, then the lead packet. */
export function buildAgentSessionInstructions(
  setupId: string,
  call: HarnessPromptCallContext,
  packet: LeadContextPacket,
): string {
  return `${buildSystemPrompt(setupId, call, packet)}\n\n${formatLeadContextBlock(packet, { direction: call.direction, agencyName: call.agencyName })}`;
}

/** Prompt for the simulated caller role only (Pipecat sidecar). Not for the agent. */
export function buildSimulatedCallerPrompt(persona: SimulatedCallerPersona): string {
  const truth = Object.entries(persona.truth).map(([k, v]) => `${k}: ${v}`).join("\n");
  const reveal = Object.entries(persona.revealMap).map(([k, v]) => `${k}: ${v}`).join("\n");
  return [
    `Simulated caller persona ${persona.id}.`,
    "Ground truth (role-play only; do not break character):",
    truth,
    "Reveal map (what you may say when asked):",
    reveal,
  ].join("\n");
}
