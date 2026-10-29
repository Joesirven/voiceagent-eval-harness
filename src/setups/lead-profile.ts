/**
 * Reads one lead from a caller-supplied database adapter and shapes what
 * the agent and the persona card need: the business, trade, carrier, X-date,
 * payroll if known, past calls and texts, and the two unanswered outbound
 * calls.
 *
 * Reads only through DbClient, so nothing here can send
 * anything. The lead's phone number and email are deliberately not carried:
 * a setup never needs them, and the harness only ever dials a browser, a
 * simulated line or an allowlisted test phone.
 *
 * Where CRM holds nothing, the field stays empty. The two unanswered
 * calls are the one exception, and only when fewer than two real ones are on
 * file: the harness stands in for the missing ones and marks them simulated,
 * in memory only. They are never written anywhere, because a timeline row
 * would count as a real touch.
 */

import type {
  BriefingContact,
  BriefingMissedCall,
  LeadBriefing,
} from "../memory/briefing.js";
import type { DbClient, Row } from "../store/database-client.js";
import { clip, newest, num, text, textList, UUID } from "./util.js";

export interface LeadProfile {
  leadId: string;
  agencyId: string;
  /** The agency's display name from its own row, when the row has one. Read only. */
  agencyName?: string;
  entityId: string;
  stage?: string;
  briefing: LeadBriefing;
  /** Real call rows on file for this lead, any direction. */
  callCount: number;
}

const HISTORY_ROWS = 40;
const SNIPPET = 240;

function contact(row: Row): BriefingContact {
  const title = text(row.title);
  const snippet = text(row.snippet);
  const summary = [title, snippet].filter(Boolean).join(": ");
  return {
    at: String(row.occurred_at ?? ""),
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    channel: String(row.channel) as BriefingContact["channel"],
    summary: clip(summary || "(no summary on file)", SNIPPET),
  };
}

/** Two unanswered calls: the real ones first, then simulated stand-ins on the two days before `now`. */
export function missedOutboundCalls(real: string[], now: Date): BriefingMissedCall[] {
  const calls: BriefingMissedCall[] = real
    .slice(0, 2)
    .sort()
    .map((at) => ({ at, simulated: false }));
  for (let back = 2; calls.length < 2 && back >= 1; back -= 1) {
    const day = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    day.setUTCHours(back === 2 ? 17 : 21, 15, 0, 0);
    calls.push({ at: day.toISOString(), simulated: true });
  }
  return calls.sort((a, b) => a.at.localeCompare(b.at));
}

async function payrollFor(db: DbClient, entityId: string): Promise<LeadBriefing["payroll"]> {
  const facts = await db.select("crm_entity_fact", {
    columns: "key,value_num,value_text,observed_at",
    eq: { entity_id: entityId },
    in: { key: ["payroll.annual_est", "payroll.basis"] },
    order: { column: "observed_at", ascending: false },
    limit: 12,
  });
  const estimate = newest(facts.filter((f) => f.key === "payroll.annual_est"), "observed_at")[0];
  const annualEstimate = num(estimate?.value_num);
  if (annualEstimate === undefined) return undefined;
  const basis = text(newest(facts.filter((f) => f.key === "payroll.basis"), "observed_at")[0]?.value_text);
  return { annualEstimate, ...(basis ? { basis } : {}) };
}

/** Real unanswered outbound dials, newest first. A database without the table or the rows gives none. */
async function realMissedCalls(db: DbClient, leadId: string): Promise<string[]> {
  try {
    const rows = await db.select("crm_dialer_call", {
      columns: "started_at,outcome",
      eq: { contact_id: leadId, outcome: "no_answer" },
      order: { column: "started_at", ascending: false },
      limit: 2,
    });
    return rows.map((r) => text(r.started_at)).filter((s): s is string => s !== undefined);
  } catch {
    return [];
  }
}

/**
 * The display name of the producer who holds the lead: the live holding row
 * (not released) names the seat, and the seat's row names the person. Two
 * read-only selects. A database without either table, or a lead nobody holds,
 * gives nothing, and the name stays unknown.
 */
async function producerNameFor(db: DbClient, leadId: string, agencyId: string): Promise<string | undefined> {
  try {
    const [holding] = await db.select("crm_lead_holding", {
      columns: "app_user_id",
      eq: { lead_id: leadId, agency_id: agencyId },
      isNull: ["released_at"],
      order: { column: "held_at", ascending: false },
      limit: 1,
    });
    const seatId = text(holding?.app_user_id);
    if (!seatId || !UUID.test(seatId)) return undefined;
    const [seat] = await db.select("crm_app_user", {
      columns: "name",
      eq: { id: seatId, agency_id: agencyId },
      limit: 1,
    });
    return text(seat?.name);
  } catch {
    return undefined;
  }
}

/** The agency's display name: one read-only select. A missing row, column or table gives nothing and the name stays unknown. */
async function agencyNameFor(db: DbClient, agencyId: string): Promise<string | undefined> {
  try {
    if (!UUID.test(agencyId)) return undefined;
    const [agency] = await db.select("crm_agency", { columns: "name", eq: { id: agencyId }, limit: 1 });
    return text(agency?.name);
  } catch {
    return undefined;
  }
}

export async function readLeadProfile(
  db: DbClient,
  leadId: string,
  now: () => Date = () => new Date(),
): Promise<LeadProfile | undefined> {
  if (!UUID.test(leadId)) return undefined;
  const [lead] = await db.select("crm_lead", {
    columns: "id,agency_id,entity_id,owner_name,stage,note",
    eq: { id: leadId },
    limit: 1,
  });
  if (!lead) return undefined;
  const entityId = String(lead.entity_id);
  const [index] = await db.select("crm_lead_index", {
    columns:
      "business_name,owner_name,trade,city,state,employees,employees_basis,employees_is_modeled,next_renewal_on,next_renewal_line,next_renewal_carrier,carriers_current",
    eq: { entity_id: entityId },
    limit: 1,
  });
  const [payroll, producerName, agencyName, events, missed] = await Promise.all([
    payrollFor(db, entityId),
    producerNameFor(db, leadId, String(lead.agency_id)),
    agencyNameFor(db, String(lead.agency_id)),
    db.select("crm_interaction_event", {
      columns: "occurred_at,channel,direction,title,snippet",
      eq: { contact_id: leadId },
      order: { column: "occurred_at", ascending: false },
      limit: HISTORY_ROWS,
    }),
    realMissedCalls(db, leadId),
  ]);

  const calls = events.filter((e) => e.channel === "call" || e.channel === "voicemail");
  const texts = events.filter((e) => e.channel === "sms" || e.channel === "whatsapp");
  const employeeCount = num(index?.employees);
  const xDate = text(index?.next_renewal_on);
  const briefing: LeadBriefing = {
    business: text(index?.business_name) ?? text(lead.owner_name) ?? "Unknown business",
    ownerName: text(lead.owner_name) ?? text(index?.owner_name),
    trade: text(index?.trade),
    city: text(index?.city),
    state: text(index?.state),
    carriersCurrent: textList(index?.carriers_current),
    priorCalls: calls.map(contact),
    priorTexts: texts.map(contact),
    missedOutboundCalls: missedOutboundCalls(missed, now()),
  };
  if (xDate) {
    briefing.xDate = {
      date: xDate,
      line: text(index?.next_renewal_line),
      carrier: text(index?.next_renewal_carrier),
    };
  }
  if (employeeCount !== undefined) {
    briefing.employees = {
      count: employeeCount,
      basis: text(index?.employees_basis),
      modeled: index?.employees_is_modeled === true ? true : undefined,
    };
  }
  if (payroll) briefing.payroll = payroll;
  if (producerName) briefing.producerName = producerName;
  const producerNote = text(lead.note);
  if (producerNote) briefing.producerNote = clip(producerNote, 400);
  // Drop undefined keys so a snapshot compares and stores cleanly.
  return {
    leadId,
    agencyId: String(lead.agency_id),
    ...(agencyName ? { agencyName } : {}),
    entityId,
    stage: text(lead.stage),
    briefing: JSON.parse(JSON.stringify(briefing)) as LeadBriefing,
    callCount: calls.filter((c) => c.channel === "call").length,
  };
}
