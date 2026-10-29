import type { Clock } from "../types/clock.js";
import type { LeadRecord } from "../store/lead-store.js";

/**
 * Outbound dial is allowed only with a scheduled reason, text agreement on file,
 * and injected clock at or after the agreed time.
 */
export function checkOutboundSchedule(
  lead: LeadRecord,
  clock: Clock,
  scheduledReason?: string,
): string | null {
  if (!scheduledReason?.trim()) {
    return "scheduled_reason_missing";
  }
  if (!lead.textAgreementAt) {
    return "text_agreement_missing";
  }
  if (!lead.scheduledOutboundAt) {
    return "scheduled_time_missing";
  }
  const agreedMs = new Date(lead.scheduledOutboundAt).getTime();
  const nowMs = clock.now().getTime();
  if (Number.isNaN(agreedMs)) {
    return "invalid_scheduled_time";
  }
  if (nowMs < agreedMs) {
    return "before_scheduled_time";
  }
  return null;
}
