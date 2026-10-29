import type { LeadBriefing } from "../memory/briefing.js";
import { evidenceSupportsValue } from "../memory/evidence.js";
import { getHarnessConfig } from "../config.js";

export interface LeadRecord {
  id: string;
  agencyId: string;
  name: string;
  phone: string;
  timezone?: string;
  smsConsentAt?: string;
  voiceConsentAt?: string;
  /**
   * Consent to calls in an artificial voice: the lead's own written grant, or
   * the agency's signed attestation. A text agreement or an ordinary call
   * consent is not this. Absent means the AI may not place the call.
   */
  artificialVoiceConsent?: { at: string; basis: "lead_written" | "agency_attestation" };
  consentRevokedAt?: string;
  onStopList?: boolean;
  onDncList?: boolean;
  /**
   * Do-not-call check result. Only an explicit "clear" allows contact:
   * "unchecked" and a missing value both block.
   */
  dncStatus?: "clear" | "listed" | "unchecked";
  suppressed?: boolean;
  /** Text agreement timestamp for scheduled outbound callbacks. */
  textAgreementAt?: string;
  /** Agreed outbound dial time (ISO); outbound only when clock is at or after this instant. */
  scheduledOutboundAt?: string;
  priorCallSummaries: string[];
  quoteFields: Record<string, { value: string; evidenceSpan: string }>;
  handoffNotes: HandoffNote[];
  messages: SavedMessage[];
  bookings: ProducerBooking[];
  /** Set only by a lead setup: the lead's real record, for the agent's context packet and prompt. */
  briefing?: LeadBriefing;
}

/** A request to stop being contacted, heard on a call or read in a text. */
export interface StopRecord {
  leadId: string;
  callId?: string;
  source: "voice_call" | "text";
  matched: string;
  /** Verbatim words of the person. */
  callerWords: string;
  occurredAt: string;
}

export type StopResult = {
  /** Where the STOP was recorded. `memory` means it was not persisted. */
  recorded: "mock" | "database" | "memory" | "local_test";
  /** Why a database write did not happen, when it did not. */
  note?: string;
};

export interface HandoffNote {
  callId: string;
  /** Which way the call went; set by the harness when it files the note. */
  direction?: "inbound" | "outbound";
  createdAt: string;
  callerWanted: string;
  promised: string;
  openQuestions: string[];
  evidenceBackedFields: Record<string, { value: string; evidenceSpan: string }>;
  narrative: string;
}

export interface SavedMessage {
  id: string;
  leadId: string;
  callId: string;
  body: string;
  /** What the message is, as the tool that saved it named it ("message", "service_request", "phone"). */
  kind?: string;
  createdAt: string;
}

export interface ProducerBooking {
  id: string;
  leadId: string;
  callId: string;
  slotIso: string;
  createdAt: string;
}

const leads = new Map<string, LeadRecord>();
const placedIdempotencyKeys = new Set<string>();
const stopLedger: StopRecord[] = [];

export function resetLeadStore(): void {
  leads.clear();
  placedIdempotencyKeys.clear();
  stopLedger.length = 0;
}

/** Mock store: suppress and revoke at once, and keep a ledger entry. */
export function recordStop(stop: StopRecord): StopResult {
  const lead = leads.get(stop.leadId);
  if (!lead) throw new Error("lead_not_found");
  lead.onStopList = true;
  lead.consentRevokedAt = stop.occurredAt;
  stopLedger.push({ ...stop });
  return { recorded: "mock" };
}

export function getStopLedger(): StopRecord[] {
  return [...stopLedger];
}

export function seedLead(lead: LeadRecord): void {
  leads.set(lead.id, { ...lead });
}

export function getLead(leadId: string): LeadRecord | undefined {
  return leads.get(leadId);
}

export function updateLead(leadId: string, patch: Partial<LeadRecord>): LeadRecord {
  const existing = leads.get(leadId);
  if (!existing) {
    throw new Error(`Lead not found: ${leadId}`);
  }
  const next = { ...existing, ...patch };
  leads.set(leadId, next);
  return next;
}

export function tryClaimIdempotency(key: string): boolean {
  if (placedIdempotencyKeys.has(key)) {
    return false;
  }
  placedIdempotencyKeys.add(key);
  return true;
}

export function releaseIdempotency(key: string): void {
  placedIdempotencyKeys.delete(key);
}

export function hasIdempotencyKey(key: string): boolean {
  return placedIdempotencyKeys.has(key);
}

export function writeQuoteField(
  leadId: string,
  field: string,
  value: string,
  evidenceSpan: string,
  callerTurns: string[],
): boolean {
  // With the action judge off, the evidence rule is not enforced; the span is still kept.
  if (!getHarnessConfig().actionJudgeOff && !evidenceSupportsValue(value, evidenceSpan, callerTurns, field)) {
    return false;
  }
  const lead = leads.get(leadId);
  if (!lead) return false;
  lead.quoteFields[field] = { value, evidenceSpan };
  return true;
}

export function appendHandoffNote(leadId: string, note: HandoffNote): void {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  lead.handoffNotes.push(note);
}

export function saveMessageIdempotent(
  leadId: string,
  callId: string,
  body: string,
  kind?: string,
): SavedMessage {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  // A retry of the same message stays one message; a different message on the same call is added.
  const sameCall = lead.messages.filter((m) => m.leadId === leadId && m.callId === callId);
  const existing = sameCall.find((m) => m.body === body);
  if (existing) return existing;
  const msg: SavedMessage = {
    id: sameCall.length === 0 ? `msg_${leadId}_${callId}` : `msg_${leadId}_${callId}_${sameCall.length + 1}`,
    leadId,
    callId,
    body,
    ...(kind ? { kind } : {}),
    createdAt: new Date().toISOString(),
  };
  lead.messages.push(msg);
  return msg;
}

export function bookProducerIdempotent(
  leadId: string,
  callId: string,
  slotIso: string,
): ProducerBooking {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  const existing = lead.bookings.find((b) => b.leadId === leadId && b.callId === callId);
  if (existing) return existing;
  const booking: ProducerBooking = {
    id: `book_${leadId}_${callId}`,
    leadId,
    callId,
    slotIso,
    createdAt: new Date().toISOString(),
  };
  lead.bookings.push(booking);
  return booking;
}
