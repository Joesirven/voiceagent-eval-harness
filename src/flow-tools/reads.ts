/**
 * The read-only flow tools. None of them calls the judge, and each answers in
 * one short sentence the agent can say: never raw rows, never a count or a
 * figure the caller could hear as a price or a promise. The one exception is
 * check_appointment_time: it gives the checked day and time in words, and the
 * next step, for the agent to read back before it books. The service role reads
 * go through a select-only database client; with no client they refuse.
 */

import type { LeadStore } from "../store/lead-store-seam.js";

export interface ReadDb {
  select(table: string, query: {
    columns: string;
    eq?: Record<string, string>;
    gte?: Record<string, string>;
    order?: { column: string; ascending: boolean };
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
}

export type ReadResult = { ok: true; speakable: string } | { ok: false; code: string; reason: string; speakable: string };

export const READ_UNAVAILABLE = "I cannot check that right now. A licensed producer can help with it.";

/** The booking bounds used by the generic CRM integration. */
export const BOOKING_SOONEST_MS = 5 * 60 * 1000;
export const BOOKING_LATEST_MS = 60 * 24 * 60 * 60 * 1000;
const TYPED_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TYPED_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Five minutes to sixty days ahead of now. */
export function slotInRange(at: number, now: Date): boolean {
  return Number.isFinite(at) && at >= now.getTime() + BOOKING_SOONEST_MS && at <= now.getTime() + BOOKING_LATEST_MS;
}

/** The offset of a time zone from universal time at an instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** A day and a clock time on the caller's clock as an instant, or null when either is malformed. */
export function instantOnCallerClock(day: string, time: string, timeZone: string): number | null {
  if (!TYPED_DAY.test(day) || !TYPED_TIME.test(time)) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  if (new Date(guess).getUTCDate() !== d) return null;
  try {
    const first = guess - offsetMs(new Date(guess), timeZone);
    return guess - offsetMs(new Date(first), timeZone);
  } catch {
    return null;
  }
}

/** A local copy of the dry run of bookTypedAppointment: the bounds only, never the producer's calendar. */
export async function checkAppointmentTime(store: LeadStore, leadId: string, day: string, time: string, now: Date): Promise<ReadResult> {
  const lead = await store.getLead(leadId);
  if (!lead?.timezone) {
    return { ok: false, code: "no_time_zone", reason: "the lead has no time zone to read the time on", speakable: READ_UNAVAILABLE };
  }
  const at = instantOnCallerClock(day, time, lead.timezone);
  if (at === null) return { ok: false, code: "invalid_arguments", reason: "the day or the time is not a real one", speakable: "I did not catch that time. Could you say it again?" };
  if (!slotInRange(at, now)) {
    return { ok: true, speakable: "That time cannot be booked. It needs to be at least five minutes and at most sixty days from now." };
  }
  const already = lead.bookings.length > 0 ? " There is already a producer time on the books for you." : "";
  return {
    ok: true,
    speakable: `That time can be booked: ${slotInWords(at, lead.timezone)}.${already} Read it back to the caller exactly and ask for a yes. Call book_producer only after that yes.`,
  };
}

/**
 * The checked time as the agent reads it back, for example "Thursday, October 22
 * at 5:00 PM PDT". The time zone is the lead record's (the CRM store sets it
 * from the lead's state, else the phone's area code). There is no default to the agency's
 * zone or to universal time: a lead with no time zone is refused before this, as
 * the day and time could not be read on the caller's clock either.
 */
function slotInWords(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short",
  }).format(new Date(at));
}

const BLOCK_BELIEVABLE_MS = 6 * 60 * 60 * 1000;
const VOICE_READY_WITHIN_MS = 90_000;

function stampFresh(stamp: unknown, now: number): boolean {
  const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(at) && Math.abs(now - at) <= VOICE_READY_WITHIN_MS;
}

/**
 * A producer is ready on a fresh stamp. A producer is busy on a fresh busy stamp
 * or an open calling block.
 */
export async function listAvailableProducers(db: ReadDb, agencyId: string, now: Date): Promise<ReadResult> {
  const t = now.getTime();
  const [presence, blocks] = await Promise.all([
    db.select("crm_producer_presence", { columns: "producer_id,voice_ready_at,voice_busy_at", eq: { agency_id: agencyId } }),
    db.select("crm_call_session", {
      columns: "producer_id,status",
      eq: { agency_id: agencyId },
      gte: { started_at: new Date(t - BLOCK_BELIEVABLE_MS).toISOString() },
      limit: 50,
    }),
  ]);
  const busy = new Set([
    ...blocks.filter((b) => b.status !== "ended" && b.status !== "planned").map((b) => String(b.producer_id ?? "")),
    ...presence.filter((p) => stampFresh(p.voice_busy_at, t)).map((p) => String(p.producer_id)),
  ]);
  const free = presence.some((p) => stampFresh(p.voice_ready_at, t) && !busy.has(String(p.producer_id)));
  return {
    ok: true,
    speakable: free
      ? "A licensed producer is free to take a transfer right now."
      : "No licensed producer is free to take a transfer right now. I can take a message or book a time instead.",
  };
}

const QUOTE_IN_PROGRESS = new Set(["queued", "claimed", "prewarming", "parked", "live", "rating"]);

/** Read the newest quote job for the lead, while leaving out deleted rows. */
export async function checkQuoteStatus(db: ReadDb, agencyId: string, leadId: string): Promise<ReadResult> {
  const [lead] = await db.select("crm_lead", { columns: "entity_id", eq: { id: leadId, agency_id: agencyId }, limit: 1 });
  const entityId = lead?.entity_id;
  const jobs = entityId
    ? await db.select("crm_quote_job", {
        columns: "status,mode,created_at",
        eq: { agency_id: agencyId, entity_id: String(entityId) },
        order: { column: "created_at", ascending: false },
        limit: 10,
      })
    : [];
  const newest = jobs.find((j) => j.mode !== "delete");
  if (!newest) return { ok: true, speakable: "I do not see a quote in progress. A licensed producer can help with that." };
  if (newest.status === "rated") return { ok: true, speakable: "Your quote is ready, and a licensed producer will go over it with you." };
  if (QUOTE_IN_PROGRESS.has(String(newest.status))) return { ok: true, speakable: "Your quote is still being worked on. A licensed producer will go over it with you when it is ready." };
  return { ok: true, speakable: "A licensed producer will follow up with you about your quote." };
}
