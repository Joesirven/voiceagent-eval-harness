import type { LeadRecord } from "../../src/store/lead-store.js";
import { getHarnessConfig } from "../../src/config.js";

export function baseLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  const agencyId = getHarnessConfig().agencyId;
  return {
    id: "lead-1",
    agencyId,
    name: "Jane Doe",
    phone: "+15550167",
    timezone: "America/New_York",
    smsConsentAt: "2026-10-01T12:00:00.000Z",
    voiceConsentAt: "2026-10-01T12:00:00.000Z",
    artificialVoiceConsent: { at: "2026-10-01T12:00:00.000Z", basis: "lead_written" },
    textAgreementAt: "2026-10-01T12:00:00.000Z",
    scheduledOutboundAt: "2026-10-15T14:00:00.000Z",
    dncStatus: "clear",
    priorCallSummaries: ["Prior: asked about auto quote."],
    quoteFields: {},
    handoffNotes: [],
    messages: [],
    bookings: [],
    ...overrides,
  };
}
