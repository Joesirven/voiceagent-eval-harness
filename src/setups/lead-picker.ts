/**
 * Lead picker: search or random, filtered by trade, by X-date window and by
 * whether the lead has call history. Reads the development database only.
 *
 * The lead table of one agency is small next to the warehouse of every
 * business, so the picker starts from the agency's own leads and looks each
 * batch up in the lead index with the filters applied there. At most
 * `scanLimit` leads are scanned; the answer says when that cut the search
 * short, so the page can say so instead of implying it saw everything.
 *
 * Phone numbers and emails are never returned.
 */

import type { DbClient, Row, SelectQuery } from "../store/database-client.js";
import { chunk, num, shuffled, text, UUID } from "./util.js";

/**
 * Used only when no agency with leads can be found.
 */
export const FALLBACK_PICKER_AGENCY_ID = "00000000-0000-4000-8000-000000000001";

const discovered = new WeakMap<DbClient, Promise<string>>();

/**
 * The agency to pick from when the caller names none: the first agency that is not dormant and has
 * at least one lead. Found once per database client, because the development database holds
 * different agencies from an external system.
 */
export function defaultAgencyId(db: DbClient): Promise<string> {
  let found = discovered.get(db);
  if (!found) {
    found = (async () => {
      const agencies = await db.select("crm_agency", { columns: "id,dormant_at", isNull: ["dormant_at"], limit: 50 });
      for (const a of agencies) {
        const lead = await db.select("crm_lead", { columns: "id", eq: { agency_id: String(a.id) }, limit: 1 });
        if (lead.length) return String(a.id);
      }
      return FALLBACK_PICKER_AGENCY_ID;
    })();
    // A failed lookup is not remembered.
    found.catch(() => discovered.delete(db));
    discovered.set(db, found);
  }
  return found;
}

export interface PickerFilters {
  agencyId?: string;
  /** Matches business or owner name, ignoring case. */
  search?: string;
  /** Matches the trade, ignoring case, as a substring. */
  trade?: string;
  /** X-date window, inclusive, as YYYY-MM-DD. */
  xDateFrom?: string;
  xDateTo?: string;
  /** true: only leads with a call on file. false: only leads without. Undefined: either. */
  hasCallHistory?: boolean;
  /** Shuffle the matches instead of sorting by X-date. */
  random?: boolean;
  limit?: number;
  /** How many of the agency's leads to look at. */
  scanLimit?: number;
}

export interface LeadCandidate {
  leadId: string;
  agencyId: string;
  businessName: string;
  ownerName?: string;
  trade?: string;
  city?: string;
  state?: string;
  xDate?: string;
  xDateCarrier?: string;
  employees?: number;
  stage?: string;
  /** Calls, voicemails and texts on file (at most the most recent rows the picker read). */
  callCount: number;
  hasCallHistory: boolean;
}

export interface PickerResult {
  candidates: LeadCandidate[];
  /** How many of the agency's leads were looked at. */
  scanned: number;
  /** True when the agency has more leads than `scanLimit`, so some were never looked at. */
  truncated: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INDEX_CHUNK = 80;
const HISTORY_CHUNK = 60;

export interface PickerDeps {
  random?: () => number;
}

export async function pickLeads(db: DbClient, filters: PickerFilters = {}, deps: PickerDeps = {}): Promise<PickerResult> {
  const agencyId = filters.agencyId ?? (await defaultAgencyId(db));
  if (!UUID.test(agencyId)) throw new Error("bad_agency_id");
  for (const d of [filters.xDateFrom, filters.xDateTo]) {
    if (d !== undefined && !ISO_DATE.test(d)) throw new Error("bad_x_date");
  }
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  const scanLimit = Math.min(Math.max(filters.scanLimit ?? 1000, 1), 5000);
  const random = deps.random ?? Math.random;

  // One more than the limit tells us whether the agency has leads we did not look at.
  const leadRows = await db.select("crm_lead", {
    columns: "id,agency_id,entity_id,owner_name,stage",
    eq: { agency_id: agencyId },
    order: { column: "created_at", ascending: false },
    limit: scanLimit + 1,
  });
  const truncated = leadRows.length > scanLimit;
  const leads = (filters.random ? shuffled(leadRows.slice(0, scanLimit), random) : leadRows.slice(0, scanLimit)).filter(
    (l) => typeof l.entity_id === "string",
  );

  const indexFilter: Pick<SelectQuery, "gte" | "lte"> = {};
  if (filters.xDateFrom) indexFilter.gte = { next_renewal_on: filters.xDateFrom };
  if (filters.xDateTo) indexFilter.lte = { next_renewal_on: filters.xDateTo };

  const trade = filters.trade?.trim().toLowerCase();
  const search = filters.search?.trim().toLowerCase();

  const matched: Array<{ lead: Row; index: Row }> = [];
  for (const batch of chunk(leads, INDEX_CHUNK)) {
    const rows = await db.select("crm_lead_index", {
      columns: "entity_id,business_name,owner_name,trade,city,state,employees,next_renewal_on,next_renewal_carrier",
      in: { entity_id: batch.map((l) => String(l.entity_id)) },
      ...indexFilter,
    });
    const byEntity = new Map(rows.map((r) => [String(r.entity_id), r]));
    for (const lead of batch) {
      const index = byEntity.get(String(lead.entity_id));
      if (!index) continue;
      if (trade && !String(index.trade ?? "").toLowerCase().includes(trade)) continue;
      if (search) {
        const haystack = [index.business_name, index.owner_name, lead.owner_name].map((v) => String(v ?? "").toLowerCase());
        if (!haystack.some((h) => h.includes(search))) continue;
      }
      matched.push({ lead, index });
    }
  }

  // Call history is a second query over the matches only, not over every lead scanned.
  const callCounts = new Map<string, number>();
  const toCount = matched.map((m) => String(m.lead.id));
  for (const batch of chunk(toCount, HISTORY_CHUNK)) {
    const rows = await db.select("crm_interaction_event", {
      columns: "contact_id,channel",
      in: { contact_id: batch, channel: ["call", "voicemail"] },
      limit: 1000,
    });
    for (const r of rows) {
      const id = String(r.contact_id);
      callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
    }
  }

  let candidates: LeadCandidate[] = matched.map(({ lead, index }) => {
    const callCount = callCounts.get(String(lead.id)) ?? 0;
    return {
      leadId: String(lead.id),
      agencyId: String(lead.agency_id),
      businessName: text(index.business_name) ?? text(lead.owner_name) ?? "Unknown business",
      ownerName: text(lead.owner_name) ?? text(index.owner_name),
      trade: text(index.trade),
      city: text(index.city),
      state: text(index.state),
      xDate: text(index.next_renewal_on),
      xDateCarrier: text(index.next_renewal_carrier),
      employees: num(index.employees),
      stage: text(lead.stage),
      callCount,
      hasCallHistory: callCount > 0,
    };
  });
  if (filters.hasCallHistory !== undefined) candidates = candidates.filter((c) => c.hasCallHistory === filters.hasCallHistory);
  if (!filters.random) {
    candidates = [...candidates].sort(
      (a, b) => (a.xDate ?? "9999").localeCompare(b.xDate ?? "9999") || a.businessName.localeCompare(b.businessName),
    );
  }
  return { candidates: candidates.slice(0, limit), scanned: leads.length, truncated };
}
