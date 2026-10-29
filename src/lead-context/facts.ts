/** Who is calling: the facts on file, each with its source. Absent means unknown. */

import { redactSensitiveSummaries } from "../behaviour/guard/redaction.js";
import type { LeadContextPacket } from "../memory/context.js";
import { SOURCE_NOT_ON_FILE, SOURCE_PRODUCER_NOTE, SOURCE_RECORD, type LeadFact } from "./types.js";

function fact(key: string, label: string, value: string | undefined, source: string, held: boolean): LeadFact {
  return value && value.trim()
    ? { key, label, value: value.trim(), source, held }
    : { key, label, value: "unknown", source: SOURCE_NOT_ON_FILE, held };
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

export function buildFacts(packet: LeadContextPacket, confirmed: boolean): LeadFact[] {
  const held = !confirmed;
  const b = packet.briefing;
  const facts: LeadFact[] = [
    // The name on file is the one account fact allowed before confirmation.
    fact("name_on_file", "Name on file", packet.name, SOURCE_RECORD, false),
    fact("business", "Business", b?.business, SOURCE_RECORD, held),
    fact("owner_name", "Owner name on file", b?.ownerName, SOURCE_RECORD, held),
    fact("trade", "Trade", b?.trade, SOURCE_RECORD, held),
    fact("location", "City and state", b ? [b.city, b.state].filter(Boolean).join(", ") : undefined, SOURCE_RECORD, held),
    fact("role", "Role of the person calling", "unknown", SOURCE_NOT_ON_FILE, held),
    fact("carriers_current", "Carriers believed current", b?.carriersCurrent.length ? b.carriersCurrent.join(", ") : undefined, SOURCE_RECORD, held),
    fact(
      "employees",
      "Headcount",
      b?.employees ? `${b.employees.count}${b.employees.modeled ? " (a modelled estimate, not the firm's own number)" : ""}${b.employees.basis ? `; basis: ${b.employees.basis}` : ""}` : undefined,
      SOURCE_RECORD,
      held,
    ),
    fact(
      "payroll",
      "Annual payroll",
      b?.payroll ? `${b.payroll.annualEstimate} dollars (an estimate, not the firm's figure)${b.payroll.basis ? `; basis: ${b.payroll.basis}` : ""}` : undefined,
      SOURCE_RECORD,
      held,
    ),
  ];
  const calls = redactSensitiveSummaries([...packet.priorCallSummaries]).kept;
  facts.push(fact("earlier_calls", "Earlier call summaries", calls.join(" | "), SOURCE_RECORD, held));
  const texts = b ? redactSensitiveSummaries(b.priorTexts.slice(0, 5).map((t) => `${day(t.at)} ${t.direction}: ${t.summary}`)).kept : [];
  facts.push(fact("earlier_texts", "Earlier text summaries", texts.join(" | "), SOURCE_RECORD, held));
  const note = b?.producerNote ? redactSensitiveSummaries([b.producerNote]).kept.join(" ") : undefined;
  facts.push(fact("producer_note", "Producer note", note, SOURCE_PRODUCER_NOTE, held));
  return facts;
}
