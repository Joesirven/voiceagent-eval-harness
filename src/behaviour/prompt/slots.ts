/**
 * Slot filling and prior-note redaction. Bracketed slots in the playbook text are
 * replaced when the value is known and left bracketed when it is not; the facts
 * section then lists what is missing, so the model never guesses.
 */

import type { LeadContextPacket } from "../../memory/context.js";
import { redactSensitiveSummaries } from "../guard/redaction.js";
import type { PromptContext } from "./types.js";

export type FactKey = "agencyName" | "businessName" | "contactName" | "xDate" | "carrier" | "publishedNumber" | "agreedCallTime" | "renewalSource" | "producerFirstName";

/** Plain-words names for the facts, in the order the facts section lists them. */
export const FACT_LABELS: Record<FactKey, string> = {
  agencyName: "agency name",
  businessName: "business name",
  contactName: "name of the person to speak with",
  xDate: "policy renewal date (the X-date)",
  carrier: "carrier on the public record",
  publishedNumber: "agency published phone number",
  agreedCallTime: "call time the lead agreed to by text",
  renewalSource: "source of the renewal date, as the lead record names it",
  producerFirstName: "first name of the licensed producer the call books",
};

const FACT_ORDER = Object.keys(FACT_LABELS) as FactKey[];

/** The facts a call of this direction needs. An inbound caller is often unknown, so fewer are expected. */
export function expectedFacts(direction: PromptContext["direction"]): FactKey[] {
  // The producer's name is welcome but never required: the booking line says "a licensed producer" without it.
  const required = FACT_ORDER.filter((key) => key !== "producerFirstName");
  return direction === "inbound" ? ["agencyName", "publishedNumber"] : required;
}

function valueOf(ctx: PromptContext, key: FactKey): string | undefined {
  const value = ctx[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function knownFacts(ctx: PromptContext): { key: FactKey; label: string; value: string }[] {
  return FACT_ORDER.flatMap((key) => {
    const value = valueOf(ctx, key);
    return value ? [{ key, label: FACT_LABELS[key], value }] : [];
  });
}

export function missingFactKeys(ctx: PromptContext): FactKey[] {
  return expectedFacts(ctx.direction).filter((key) => !valueOf(ctx, key));
}

function slotValues(ctx: PromptContext): Record<string, string | undefined> {
  const contact = valueOf(ctx, "contactName");
  return {
    "[agency name]": valueOf(ctx, "agencyName"),
    "[agencia]": valueOf(ctx, "agencyName"),
    "[business name]": valueOf(ctx, "businessName"),
    "[contact name on file]": contact,
    "[name on file]": contact,
    "[name]": contact,
    "[first name]": contact?.split(/\s+/)[0],
    "[X-date]": valueOf(ctx, "xDate"),
    "[carrier on public record]": valueOf(ctx, "carrier"),
    "[published number]": valueOf(ctx, "publishedNumber"),
    "[source of the renewal date, as the lead record names it]": valueOf(ctx, "renewalSource"),
    "[agreed call time]": valueOf(ctx, "agreedCallTime"),
    "[producer first name]": valueOf(ctx, "producerFirstName"),
  };
}

/**
 * Replaces the known slots. The booking slots [day] and [time] are left alone on
 * purpose: they name the producer appointment being agreed on this call, which is
 * not the call time the lead agreed to by text.
 */
export function fillSlots(text: string, ctx: PromptContext): string {
  let out = text;
  for (const [slot, value] of Object.entries(slotValues(ctx))) {
    if (value !== undefined) out = out.split(slot).join(value);
  }
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A record date ("2026-12-04") as words a voice reads well ("December 4, 2026"); any other text is returned as it is. */
export function spokenDate(value: string | undefined): string | undefined {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim()) : null;
  if (!match) return value?.trim() || undefined;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}

function quoteField(packet: LeadContextPacket, key: string): string | undefined {
  const value = packet.quoteFields[key]?.value?.trim();
  return value || undefined;
}

export function promptContextFromPacket(
  packet: LeadContextPacket,
  extras: Omit<PromptContext, "priorNotes" | "contactName">,
): PromptContext {
  // The lead's record (the briefing a setup or a demo lead carries) fills what the caller has not said yet.
  const b = packet.briefing;
  return {
    ...extras,
    contactName: packet.name,
    priorNotes: [...packet.priorCallSummaries],
    agencyName: extras.agencyName ?? b?.agencyName,
    businessName:
      quoteField(packet, "business_name") ?? quoteField(packet, "businessName") ?? extras.businessName ?? b?.business,
    xDate: spokenDate(quoteField(packet, "x_date") ?? quoteField(packet, "xDate") ?? extras.xDate ?? b?.xDate?.date),
    carrier: quoteField(packet, "carrier") ?? extras.carrier ?? b?.xDate?.carrier ?? b?.carriersCurrent[0],
    renewalSource:
      quoteField(packet, "renewal_source") ?? quoteField(packet, "renewalSource") ?? extras.renewalSource,
    agreedCallTime:
      packet.scheduledOutboundAt ?? quoteField(packet, "agreed_call_time") ?? extras.agreedCallTime,
    producerFirstName: b?.producerName?.trim().split(/\s+/)[0] ?? extras.producerFirstName,
  };
}

/** Earlier call summaries with the sensitive sentences removed (Never-18). */
export function redactPriorNotes(notes: string[] | undefined): string[] {
  if (!notes || notes.length === 0) return [];
  return redactSensitiveSummaries(notes).kept;
}
