/** Lead search for the built-in mock store. */

import type { ServerResponse } from "node:http";
import { getHarnessConfig } from "../config.js";
import { getLead, type LeadRecord } from "../store/lead-store.js";
import { recordStore, type HarnessRecord } from "../trace/records.js";
import { ensurePlayLeads, playLeads } from "./play-wiring.js";

export interface LeadSearchQuery {
  query?: string;
  renewalWithinDays?: number;
  hasPhone: boolean;
  notCalledSinceDays?: number;
  excludeDnc: boolean;
  trade?: string;
  limit: number;
  offset: number;
}

export interface LeadSearchItem {
  id: string;
  name: string | null;
  business: string | null;
  trade: string | null;
  city: string | null;
  state: string | null;
  phoneLast4: string | null;
  stage: string | null;
  renewal: { date: string; daysAway: number; line: string | null; carrier: string | null } | null;
  flags: { dnc: "clear" | "listed" | "unchecked"; suppressed: boolean; noPhone: boolean };
  lastCall: { at: string; outcome: string | null; source: "harness" | "mock" } | null;
  callCount: number;
  callable: boolean;
}

export interface LeadSearchResponse {
  source: "mock";
  leads: LeadSearchItem[];
  nextCursor: string | null;
  stages: string[];
}

export const leadsSearchDeps = {
  records: (): HarnessRecord[] => recordStore.list(),
  now: (): Date => new Date(),
};

export function resetLeadsSearch(): void {}

class BadLeadsQuery extends Error {}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return undefined;
  if (!/^\d{1,6}$/.test(raw)) throw new BadLeadsQuery();
  return Number(raw);
}

const encodeCursor = (offset: number): string => Buffer.from(`o${offset}`).toString("base64url");

function decodeCursor(raw: string | null): number {
  if (!raw) return 0;
  const match = /^o(\d{1,7})$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!match) throw new BadLeadsQuery();
  return Number(match[1]);
}

export function parseLeadsQuery(url: URL): LeadSearchQuery {
  const limit = intParam(url, "limit") ?? 50;
  return {
    query: url.searchParams.get("query")?.trim().slice(0, 100) || undefined,
    renewalWithinDays: intParam(url, "renewalWithinDays"),
    hasPhone: url.searchParams.get("hasPhone") === "true",
    notCalledSinceDays: intParam(url, "notCalledSinceDays"),
    excludeDnc: url.searchParams.get("excludeDnc") === "true",
    trade: url.searchParams.get("trade")?.trim().slice(0, 100) || undefined,
    limit: Math.min(200, Math.max(1, limit)),
    offset: decodeCursor(url.searchParams.get("cursor")),
  };
}

function callRows(leadId: string): HarnessRecord[] {
  return leadsSearchDeps.records().filter((record) => record.kind === "call" && record.leadId === leadId);
}

function item(lead: LeadRecord, now: Date): LeadSearchItem {
  const briefing = lead.briefing;
  const records = callRows(lead.id);
  const last = records.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];
  const phone = lead.phone.replace(/\D/g, "");
  const dnc = lead.onDncList ? "listed" : (lead.dncStatus ?? "unchecked");
  const suppressed = lead.onStopList === true || lead.suppressed === true;
  const date = briefing?.xDate?.date;
  return {
    id: lead.id,
    name: briefing?.ownerName ?? lead.name ?? null,
    business: briefing?.business ?? null,
    trade: briefing?.trade ?? null,
    city: briefing?.city ?? null,
    state: briefing?.state ?? null,
    phoneLast4: phone.length >= 10 ? phone.slice(-4) : null,
    stage: null,
    renewal: date
      ? {
          date,
          daysAway: Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000),
          line: briefing?.xDate?.line ?? null,
          carrier: briefing?.xDate?.carrier ?? null,
        }
      : null,
    flags: { dnc, suppressed, noPhone: phone.length < 10 },
    lastCall: last ? { at: last.openedAt, outcome: typeof last.outcome?.status === "string" ? last.outcome.status : null, source: "harness" } : null,
    callCount: records.length + (briefing?.priorCalls.filter((call) => call.channel === "call").length ?? 0),
    callable: phone.length >= 10 && (getHarnessConfig().complianceChecksOff === true || (dnc !== "listed" && !suppressed)),
  };
}

function matches(lead: LeadSearchItem, query: LeadSearchQuery, now: Date): boolean {
  const needle = query.query?.toLowerCase();
  if (needle && ![lead.name, lead.business].some((value) => value?.toLowerCase().includes(needle))) return false;
  if (query.trade && !lead.trade?.toLowerCase().includes(query.trade.toLowerCase())) return false;
  if (query.hasPhone && lead.flags.noPhone) return false;
  if (query.excludeDnc && (lead.flags.dnc === "listed" || lead.flags.suppressed)) return false;
  if (query.renewalWithinDays !== undefined && (!lead.renewal || lead.renewal.daysAway < 0 || lead.renewal.daysAway > query.renewalWithinDays)) return false;
  if (query.notCalledSinceDays !== undefined && lead.lastCall && Date.parse(lead.lastCall.at) >= now.getTime() - query.notCalledSinceDays * 86_400_000) return false;
  return true;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function handleLeadsRoute(method: string, path: string, url: URL, res: ServerResponse): Promise<boolean> {
  if (method !== "GET" || path !== "/api/leads") return false;
  let query: LeadSearchQuery;
  try {
    query = parseLeadsQuery(url);
  } catch {
    send(res, 400, { error: "bad_leads_query" });
    return true;
  }
  ensurePlayLeads();
  const now = leadsSearchDeps.now();
  const all = playLeads.map((entry) => getLead(entry.id)).filter((lead): lead is LeadRecord => lead !== undefined).map((lead) => item(lead, now)).filter((lead) => matches(lead, query, now));
  const leads = all.slice(query.offset, query.offset + query.limit);
  send(res, 200, { source: "mock", leads, nextCursor: query.offset + leads.length < all.length ? encodeCursor(query.offset + leads.length) : null, stages: [] } satisfies LeadSearchResponse);
  return true;
}
