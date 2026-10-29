import type { LeadRecord } from "../store/lead-store.js";

export function checkOutboundCallConsent(lead: LeadRecord): string | null {
  if (lead.consentRevokedAt) return "consent_revoked";
  // A text agreement schedules the time but does not clear an AI-voice call.
  if (!lead.artificialVoiceConsent?.at) return "no_artificial_voice_consent";
  return null;
}

export function checkSmsConsent(lead: LeadRecord): string | null {
  if (lead.consentRevokedAt) return "consent_revoked";
  if (!lead.smsConsentAt) return "sms_consent_missing";
  return null;
}
