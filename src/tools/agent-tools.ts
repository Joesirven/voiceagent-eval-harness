import { buildLeadContextPacket } from "../memory/context.js";
import type { LeadStore } from "../store/lead-store-seam.js";
import { traceTool } from "../trace/events.js";

export interface ToolResult {
  speakable: string;
}

export function toolReadLeadContext(store: LeadStore, leadId: string): Promise<ToolResult> {
  return traceTool("read_lead_context", { leadId }, () => readLeadContext(store, leadId));
}

async function readLeadContext(store: LeadStore, leadId: string): Promise<ToolResult> {
  const lead = await store.getLead(leadId);
  if (!lead) {
    return { speakable: "I could not load your record." };
  }
  const packet = buildLeadContextPacket(lead);
  const summary =
    packet.priorCallSummaries[0] ??
    `Lead ${packet.name}, agency ${packet.agencyId}.`;
  return { speakable: summary.slice(0, 120) };
}

export function toolSaveMessage(
  store: LeadStore,
  leadId: string,
  callId: string,
  body: string,
  kind?: string,
): Promise<ToolResult> {
  return traceTool("save_message", { leadId, callId, body, kind }, async () => {
    await store.saveMessageIdempotent(leadId, callId, body, kind);
    return { speakable: "Your message is saved." };
  });
}

export const ALREADY_BOOKED =
  "This call already has a producer time booked at a different time, so I have not changed it. A licensed producer will confirm the time with you.";

export interface BookingResult extends ToolResult {
  /** False when this call already holds a booking at a different time, which the store keeps. */
  booked: boolean;
}

export function toolBookProducer(
  store: LeadStore,
  leadId: string,
  callId: string,
  slotIso: string,
): Promise<BookingResult> {
  return traceTool("book_producer", { leadId, callId, slotIso }, async () => {
    const booking = await store.bookProducerIdempotent(leadId, callId, slotIso);
    // The store keeps the first booking of a call; a retry of the same time is still that booking.
    if (Date.parse(booking.slotIso) === Date.parse(slotIso)) return { speakable: "Your producer time is booked.", booked: true };
    return { speakable: ALREADY_BOOKED, booked: false };
  });
}
