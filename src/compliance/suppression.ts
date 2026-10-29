import type { LeadRecord } from "../store/lead-store.js";

export function checkSuppression(lead: LeadRecord): string | null {
  if (lead.onStopList) return "stop_list";
  if (lead.onDncList || lead.dncStatus === "listed") return "dnc_list";
  if (lead.suppressed) return "suppression_list";
  // Anything but an explicit clear (unchecked, or no answer at all) is not clear.
  if (lead.dncStatus !== "clear") return "dnc_unchecked";
  return null;
}

/**
 * The part of the suppression check that stays on in test mode: the stop list
 * and the suppression list. The do-not-call parts (`dnc_list`, `dnc_unchecked`)
 * are the ones test mode skips, and the harness shows them as skipped.
 */
export function checkStopAndSuppressionLists(lead: LeadRecord): string | null {
  if (lead.onStopList) return "stop_list";
  if (lead.suppressed) return "suppression_list";
  return null;
}
