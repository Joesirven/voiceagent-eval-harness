/** The quote checklist: one row per quote field, still-needed rows first. */

import { QUOTE_FIELDS, type QuoteField } from "../decision-tree/types.js";
import type { LeadContextPacket } from "../memory/context.js";
import { SOURCE_CALLER, SOURCE_RECORD, type ChecklistRow } from "./types.js";

export const QUOTE_FIELD_LABELS: Record<QuoteField, string> = {
  x_date: "renewal date of the current policy",
  current_carrier: "current insurance carrier",
  payroll: "annual payroll",
  employee_count: "number of employees",
  owner_only: "whether the owner is the only worker",
  general_liability: "whether they also want general liability",
  business_class: "type of business",
  decision_maker_name: "name of the person who decides",
  decision_maker_phone: "phone number of the person who decides",
  contact_language: "preferred language",
};

function recordValue(field: QuoteField, packet: Pick<LeadContextPacket, "briefing">): string | undefined {
  const b = packet.briefing;
  if (!b) return undefined;
  switch (field) {
    case "x_date": return b.xDate?.date;
    case "current_carrier": return b.xDate?.carrier ?? b.carriersCurrent[0];
    case "payroll": return b.payroll ? `${b.payroll.annualEstimate} dollars (estimate)` : undefined;
    case "employee_count": return b.employees ? `${b.employees.count}${b.employees.modeled ? " (modelled estimate)" : ""}` : undefined;
    case "business_class": return b.trade;
    case "decision_maker_name": return b.ownerName;
    default: return undefined;
  }
}

export function buildChecklist(packet: Pick<LeadContextPacket, "briefing" | "quoteFields">, held: boolean): ChecklistRow[] {
  const rows = QUOTE_FIELDS.map((field): ChecklistRow => {
    const saved = packet.quoteFields[field];
    if (saved && saved.value.trim()) {
      return { field, label: QUOTE_FIELD_LABELS[field], status: "known", basis: "caller", value: saved.value, source: SOURCE_CALLER, evidenceSpan: saved.evidenceSpan, held };
    }
    const rec = recordValue(field, packet);
    if (rec) {
      return { field, label: QUOTE_FIELD_LABELS[field], status: "known", basis: "record", value: rec, source: SOURCE_RECORD, held };
    }
    return { field, label: QUOTE_FIELD_LABELS[field], status: "still_needed", held };
  });
  return [...rows.filter((r) => r.status === "still_needed"), ...rows.filter((r) => r.status === "known")];
}

export function checklistLine(row: ChecklistRow): string {
  if (row.status === "still_needed") return `- Still needed: ${row.label}.`;
  if (row.basis === "caller") return `- Known: ${row.label}: ${row.value} (${row.source}; their words: "${row.evidenceSpan ?? ""}").`;
  return `- On file, confirm with the caller: ${row.label}: ${row.value} (${row.source}).`;
}
