import type { Clock } from "../types/clock.js";
import type { LeadRecord } from "../store/lead-store.js";

const QUIET_START_HOUR = 8;
const QUIET_END_HOUR = 21;

/**
 * Returns null if allowed, or a reason string if blocked.
 * Lead without timezone is blocked (not guessed).
 */
export function checkQuietHours(lead: LeadRecord, clock: Clock): string | null {
  if (!lead.timezone) {
    return "unknown_time_zone";
  }
  const local = localParts(clock.now(), lead.timezone);
  if (!local) {
    return "unknown_time_zone";
  }
  const { hour } = local;
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
    return `outside_quiet_hours_local_${hour}`;
  }
  return null;
}

function localParts(date: Date, timeZone: string): { hour: number; minute: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}
