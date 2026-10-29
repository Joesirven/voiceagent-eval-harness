/**
 * What the agent is told about one lead before the call: the lead's real
 * record, supplied through the LeadStore interface. Pure types, so the
 * context packet and the lead record can both carry it without importing the
 * database code.
 *
 * Unknown means unknown: a field the database does not hold is absent or
 * empty here, never filled in. The prompt tells the agent to collect it.
 */

export interface BriefingContact {
  /** ISO time of the call, text or voicemail. */
  at: string;
  direction: "inbound" | "outbound";
  /** The channel as CRM records it. */
  channel: "call" | "sms" | "email" | "whatsapp" | "voicemail" | "form";
  /** Title and snippet from the timeline row, trimmed. */
  summary: string;
}

export interface BriefingMissedCall {
  /** ISO time the system rang and nobody answered. */
  at: string;
  /** True when no such dial is on file and the harness stands in for the outbound pattern. */
  simulated: boolean;
}

export interface LeadBriefing {
  /** The agency the lead belongs to, as the record names it. Absent when the record carries only an identifier. */
  agencyName?: string;
  business: string;
  ownerName?: string;
  /** Display name of the producer who holds this lead (live holding, then the seat's name). Absent when no producer holds it. */
  producerName?: string;
  trade?: string;
  city?: string;
  state?: string;
  /** The renewal date ("X-date") and where it comes from, if on file. */
  xDate?: { date: string; line?: string; carrier?: string };
  /** Carriers CRM believes the business holds today. */
  carriersCurrent: string[];
  employees?: { count: number; basis?: string; modeled?: boolean };
  /** Annual payroll in whole dollars, with how it was estimated. Absent when unknown. */
  payroll?: { annualEstimate: number; basis?: string };
  priorCalls: BriefingContact[];
  priorTexts: BriefingContact[];
  /** The two unanswered outbound calls of the outbound pattern. */
  missedOutboundCalls: BriefingMissedCall[];
  /** The producer's sticky note on the lead, if any. */
  producerNote?: string;
}
