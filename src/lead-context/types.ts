/**
 * Shapes for the lead context block: what the agent is told about who is
 * calling, where the call stands, what a quote still needs, and how long until
 * the current policy renews. Pure types; no database, no clock.
 */

import type { FlowStep, QuoteField } from "../decision-tree/types.js";
import type { LeadContextPacket } from "../memory/context.js";

/** Where a fact came from. Free text so a later second source (the stored lead facts table) fits. */
export type FactSource = string;

export const SOURCE_RECORD = "lead record";
export const SOURCE_PRODUCER_NOTE = "producer note";
// The lead packet cannot tell this call from an earlier one, so the label must not claim "on this call".
export const SOURCE_CALLER = "said by the caller";
export const SOURCE_NOT_ON_FILE = "not on file";

export interface LeadFact {
  key: string;
  label: string;
  /** "unknown" when absent. Never invented. */
  value: string;
  source: FactSource;
  /** True when this fact is withheld from the agent text until the named person is confirmed. */
  held: boolean;
  /** Room for a second source that disagrees (a later change prefers the newer). */
  alternates?: Array<{ value: string; source: FactSource }>;
}

export interface StageInfo {
  flowStep: FlowStep | "unknown";
  meaning: string;
  held: false;
}

export interface ChecklistRow {
  field: QuoteField;
  label: string;
  status: "known" | "still_needed";
  /** For a known row: who gave it. Record values still need confirming with the caller. */
  basis?: "caller" | "record";
  value?: string;
  source?: FactSource;
  /** The caller's own words, when basis is "caller". */
  evidenceSpan?: string;
  held: boolean;
}

export interface RenewalInfo {
  /** Whole calendar days to the renewal date; negative once passed. Absent when unknown. */
  days?: number;
  /** The renewal date used for the count (a calendar date). */
  date?: string;
  /** The date on the lead record when the caller gave a different one. */
  recordDate?: string;
  /** The date the caller said, when it differs from the record. */
  callerDate?: string;
  timeZone?: string;
  /** True when the count used the UTC date because no usable time zone is on file. */
  approximate: boolean;
  /** One plain sentence of information for the agent. */
  sentence: string;
  held: boolean;
}

/** A name the agent says when opening the call. Never held by the confirmation gate. */
export interface OpeningName {
  /** Exactly "unknown" when the name is not on file. Never invented. */
  value: string;
  source: FactSource;
  held: false;
}

export const SOURCE_PRODUCER_HOLDING = "lead record: assigned producer";
export const SOURCE_NO_PRODUCER = "no producer is assigned on the record";
export const SOURCE_AGENCY_CALL_SETUP = "call setup (agency name)";
export const SOURCE_NO_AGENCY = "no agency name in the call setup, and the lead record carries only an agency identifier";

export interface LeadContextInput {
  packet: LeadContextPacket;
  /** "unknown" when the direction of the call is not known. */
  direction: "inbound" | "outbound" | "unknown";
  flowStep?: FlowStep;
  /** Whether the named person is confirmed on this call. Default false. */
  confirmed?: boolean;
  /** The agency name from the call setup. The call setup wins: the lead record holds only an agency identifier. */
  agencyName?: string;
  /** Today's instant. */
  now: Date;
}

export interface LeadContextJson {
  leadId: string;
  direction: "inbound" | "outbound" | "unknown";
  confirmed: boolean;
  producerName: OpeningName;
  agencyName: OpeningName;
  facts: LeadFact[];
  stage: StageInfo;
  checklist: ChecklistRow[];
  renewal: RenewalInfo;
}

export interface LeadContextOutput {
  text: string;
  json: LeadContextJson;
}
