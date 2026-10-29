/**
 * Days until the current policy renews, as whole calendar days from today in the
 * lead's time zone to the renewal calendar date.
 */

import type { LeadContextPacket } from "../memory/context.js";
import type { RenewalInfo } from "./types.js";

const DAY_MS = 86_400_000;

/** A calendar date as year, month, day; null when the text is not a real date. */
export function parseCalendarDate(text: string | undefined): { y: number; m: number; d: number } | null {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(text.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Today's calendar date in an IANA time zone; null when the zone is missing or not valid. */
export function localCalendarDate(now: Date, timeZone: string | undefined): { y: number; m: number; d: number } | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if ([y, m, d].some((n) => Number.isNaN(n))) return null;
    return { y, m, d };
  } catch {
    return null;
  }
}

function utcDate(now: Date): { y: number; m: number; d: number } {
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function dayNumber(date: { y: number; m: number; d: number }): number {
  return Math.round(Date.UTC(date.y, date.m - 1, date.d) / DAY_MS);
}

function plural(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function sentenceFor(days: number, date: string, approximate: boolean): string {
  const caveat = " (no time zone on file, may be off by one day)";
  if (approximate) {
    if (days === 0) return `The current policy renews about today${caveat} (renewal date ${date}).`;
    return days > 0
      ? `The current policy renews in about ${plural(days)}${caveat} (renewal date ${date}).`
      : `The current policy renewed about ${plural(-days)} ago${caveat} (renewal date ${date}).`;
  }
  if (days === 0) return `The current policy renews today (renewal date ${date}).`;
  return days > 0
    ? `The current policy renews in ${plural(days)} (renewal date ${date}).`
    : `The current policy renewed ${plural(-days)} ago (renewal date ${date}).`;
}

export function computeRenewal(packet: Pick<LeadContextPacket, "briefing" | "timezone" | "quoteFields">, now: Date, held: boolean): RenewalInfo {
  const recordRaw = packet.briefing?.xDate?.date;
  const recordDate = parseCalendarDate(recordRaw);
  const callerRaw = packet.quoteFields["x_date"]?.value;
  const callerDate = parseCalendarDate(callerRaw);
  const local = localCalendarDate(now, packet.timezone);
  const approximate = local === null;
  const timeZone = local ? packet.timezone : undefined;

  const useCaller = callerDate !== null;
  const chosen = useCaller ? callerDate : recordDate;
  const chosenText = useCaller ? callerRaw!.trim().slice(0, 10) : recordRaw?.trim().slice(0, 10);

  if (!chosen || !chosenText) {
    const why = recordRaw && !recordDate ? "unknown (the renewal date on file is not a valid date)" : "unknown (no renewal date on file)";
    return { approximate, timeZone, sentence: `Days until the current policy renews: ${why}.`, held };
  }
  const days = dayNumber(chosen) - dayNumber(local ?? utcDate(now));
  let sentence = sentenceFor(days, chosenText, approximate);
  const info: RenewalInfo = { days, date: chosenText, timeZone, approximate, sentence, held };
  if (useCaller && recordDate && callerRaw && recordRaw && callerRaw.trim().slice(0, 10) !== recordRaw.trim().slice(0, 10)) {
    info.recordDate = recordRaw.trim().slice(0, 10);
    info.callerDate = chosenText;
    sentence += ` The caller gave a different date than the record (record says ${info.recordDate}); the caller's date is the one used here.`;
    info.sentence = sentence;
  }
  if (!useCaller && callerRaw && callerRaw.trim() && recordDate) {
    info.sentence += ` The caller said "${callerRaw.trim()}" for the date, which is not a calendar date, so this count uses the record.`;
  }
  return info;
}
