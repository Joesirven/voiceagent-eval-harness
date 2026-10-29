import type { LeadRecord } from "../store/lead-store.js";
import type { LeadBriefing } from "./briefing.js";

/** Read-only packet injected at every call start. Mirrors fields on the lead store record. */
export interface LeadContextPacket {
  leadId: string;
  name: string;
  agencyId: string;
  phone: string;
  timezone?: string;
  priorCallSummaries: string[];
  quoteFields: Record<string, { value: string; evidenceSpan: string }>;
  consentSnapshot: {
    smsConsentAt?: string;
    voiceConsentAt?: string;
    consentRevokedAt?: string;
    artificialVoiceConsent?: { at: string; basis: "lead_written" | "agency_attestation" };
  };
  /** The lead's real record, when a lead setup supplies one. Absent otherwise. */
  briefing?: LeadBriefing;
  onStopList?: boolean;
  onDncList?: boolean;
  dncStatus?: LeadRecord["dncStatus"];
  suppressed?: boolean;
  textAgreementAt?: string;
  scheduledOutboundAt?: string;
}

export function buildLeadContextPacket(lead: LeadRecord): LeadContextPacket {
  const packet: LeadContextPacket = {
    leadId: lead.id,
    name: lead.name,
    agencyId: lead.agencyId,
    phone: lead.phone,
    timezone: lead.timezone,
    priorCallSummaries: [...lead.priorCallSummaries],
    quoteFields: { ...lead.quoteFields },
    consentSnapshot: {
      smsConsentAt: lead.smsConsentAt,
      voiceConsentAt: lead.voiceConsentAt,
      consentRevokedAt: lead.consentRevokedAt,
      artificialVoiceConsent: lead.artificialVoiceConsent
        ? { ...lead.artificialVoiceConsent }
        : undefined,
    },
    onStopList: lead.onStopList,
    onDncList: lead.onDncList,
    dncStatus: lead.dncStatus,
    suppressed: lead.suppressed,
    textAgreementAt: lead.textAgreementAt,
    scheduledOutboundAt: lead.scheduledOutboundAt,
  };
  if (lead.briefing) packet.briefing = structuredClone(lead.briefing);
  return packet;
}

/** Ephemeral in-call state (reset each call). */
export interface InCallState {
  intent: "unknown" | "quote" | "book" | "message";
  slotFills: Record<string, string>;
  pendingToolResults: string[];
  callerWanted: string;
  promised: string;
  openQuestions: string[];
  evidenceBackedFields: Record<string, { value: string; evidenceSpan: string }>;
}

export function createInCallState(): InCallState {
  return {
    intent: "unknown",
    slotFills: {},
    pendingToolResults: [],
    callerWanted: "",
    promised: "",
    openQuestions: [],
    evidenceBackedFields: {},
  };
}
