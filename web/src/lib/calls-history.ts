import { toast } from "sonner";

/**
 * Leads and call history for the console, on the server's normalized
 * endpoints: GET /api/leads searches the configured lead store, GET
 * /api/calls lists every engine's calls (records on this machine, the
 * harness_run table, the local Pipecat engine) in one shape, and GET
 * /api/calls/<id> opens one with its transcript and trace rows. Every call
 * becomes one CallSummary with its engine and model, whatever path it ran on.
 */

export interface LeadCandidate {
  leadId: string;
  businessName: string;
  ownerName?: string;
  trade?: string;
  city?: string;
  state?: string;
  phoneLast4?: string;
  xDate?: string;
  xDateCarrier?: string;
  xDateLine?: string;
  stage?: string;
  callCount: number;
  hasCallHistory: boolean;
  lastCall?: { at: string; outcome: string | null; source: string } | null;
  /** Whether a Talk call takes this lead now (a phone on file, not on do-not-call, not suppressed). */
  callable: boolean;
  flags: { dnc: string; suppressed: boolean; noPhone: boolean };
}

export interface LeadFilters {
  search?: string;
  trade?: string;
  /** "30" | "60" | "90": renewing within that many days; "past": already renewed; "" any. */
  renewal?: string;
  history?: "yes" | "no" | "";
  stage?: string;
  limit?: number;
}

interface LeadItem {
  id: string; name: string | null; business: string | null; trade: string | null; city: string | null; state: string | null; phoneLast4: string | null; stage: string | null;
  renewal: { date: string; daysAway: number; line: string | null; carrier: string | null } | null;
  flags: { dnc: string; suppressed: boolean; noPhone: boolean };
  lastCall: { at: string; outcome: string | null; source: string } | null;
  callCount: number; callable: boolean;
}

export interface LeadSearchResult { leads: LeadCandidate[]; stages: string[]; source: string }

function candidate(l: LeadItem): LeadCandidate {
  return {
    leadId: l.id,
    businessName: l.business ?? l.name ?? l.id,
    ownerName: l.name ?? undefined,
    trade: l.trade ?? undefined,
    city: l.city ?? undefined,
    state: l.state ?? undefined,
    phoneLast4: l.phoneLast4 ?? undefined,
    xDate: l.renewal?.date,
    xDateCarrier: l.renewal?.carrier ?? undefined,
    xDateLine: l.renewal?.line ?? undefined,
    stage: l.stage ?? undefined,
    callCount: l.callCount,
    hasCallHistory: l.callCount > 0,
    lastCall: l.lastCall,
    callable: l.callable,
    flags: l.flags,
  };
}

export function leadQuery(f: LeadFilters, cursor?: string | null): string {
  const q = new URLSearchParams();
  if (f.search?.trim()) q.set("query", f.search.trim());
  if (f.trade?.trim()) q.set("trade", f.trade.trim());
  if (f.stage?.trim()) q.set("stage", f.stage.trim());
  if (f.renewal && f.renewal !== "past") q.set("renewalWithinDays", f.renewal);
  q.set("limit", String(f.limit ?? 40));
  if (cursor) q.set("cursor", cursor);
  return `/api/leads?${q.toString()}`;
}

/** The filters the server does not take are applied here: "already renewed" and the call history. */
function keep(l: LeadItem, f: LeadFilters): boolean {
  if (f.renewal === "past" && !(l.renewal && l.renewal.daysAway < 0)) return false;
  if (f.history === "yes" && l.callCount === 0) return false;
  if (f.history === "no" && l.callCount > 0) return false;
  return true;
}

const MAX_PAGES = 6;

/**
 * Pages GET /api/leads until it has the asked number of matches or the server
 * has no more (a filtered page can be short or empty and still carry a cursor).
 */
export async function searchLeadsFull(f: LeadFilters): Promise<LeadSearchResult> {
  const want = f.limit ?? 40;
  const leads: LeadCandidate[] = [];
  let stages: string[] = [];
  let source = "";
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res: Response = await fetch(leadQuery(f, cursor), { signal: AbortSignal.timeout(15_000) });
    const json: { leads?: unknown; stages?: unknown; source?: unknown; nextCursor?: unknown; error?: unknown } | null = await res.json().catch(() => null);
    if (!res.ok || !json || !Array.isArray(json.leads)) throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
    stages = Array.isArray(json.stages) ? json.stages : stages;
    source = typeof json.source === "string" ? json.source : source;
    for (const l of json.leads as LeadItem[]) if (keep(l, f)) leads.push(candidate(l));
    cursor = typeof json.nextCursor === "string" ? json.nextCursor : null;
    if (!cursor || leads.length >= want) break;
  }
  return { leads: leads.slice(0, want), stages, source };
}

export async function searchLeads(f: LeadFilters): Promise<LeadCandidate[]> {
  return (await searchLeadsFull(f)).leads;
}

export interface CallSummary {
  id: string;
  source: "harness" | "pipecat";
  leadId: string;
  leadLabel: string | null;
  direction: string;
  startedAt: string;
  durationMs: number | null;
  engine: string;
  model: string | null;
  outcome: string | null;
  score: number | null;
  /** The record id when the console can replay the call from its record on this machine. */
  recordId: string | null;
  /** True when the console can show it in its own panes: a record here, or trace rows in the call detail. */
  replayable: boolean;
}

export interface CallItem {
  id: string; leadId: string | null; leadName: string | null; startedAt: string; endedAt: string | null; durationMs: number | null;
  direction: "inbound" | "outbound" | null; engine: string; sessionMode: string | null; model: string | null;
  outcome: { status: string | null; disposition: string | null }; score: unknown;
  turns: { caller: number | null; agent: number | null }; source: "memory" | "harness_run" | "pipecat_engine"; recordId: string | null;
}

export interface CallDetail {
  call: CallItem;
  transcript: Array<{ role: "agent" | "caller"; text: string; at: string | null; spoken: boolean }>;
  metrics: unknown;
  score: unknown;
  agentContext: string | null;
  settingsEcho: Record<string, unknown> | null;
  events: Array<Record<string, unknown>> | null;
  replayable: boolean;
}

const ENGINE_LABELS: Record<string, string> = {
  azure_gpt_live: "Azure gpt-live",
  azure_voice_live: "Azure Voice Live",
  deepgram: "Deepgram",
  pipecat_relay: "Pipecat relay",
  pipecat_engine: "Pipecat (local)",
  unknown: "Voice",
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

function scoreOf(score: unknown): number | null {
  if (typeof score === "number") return score;
  const s = (score as { score?: unknown } | null)?.score;
  return typeof s === "number" ? s : null;
}

export function summaryOf(c: CallItem): CallSummary {
  const outcome = [c.outcome?.status, c.outcome?.disposition].filter((v): v is string => typeof v === "string" && v.length > 0);
  return {
    id: c.id,
    source: c.source === "pipecat_engine" ? "pipecat" : "harness",
    leadId: c.leadId ?? "",
    leadLabel: c.leadName,
    direction: c.direction ?? "inbound",
    startedAt: c.startedAt,
    durationMs: c.durationMs,
    engine: engineLabel(c.engine),
    model: c.model ?? (c.source === "pipecat_engine" ? c.sessionMode : null),
    outcome: outcome.length ? [...new Set(outcome)].join(": ") : null,
    score: scoreOf(c.score),
    recordId: c.recordId,
    // harness_run rows come without a record here but with their trace rows in the detail; the engine's rows have a transcript only.
    replayable: c.recordId !== null || c.source === "harness_run",
  };
}

/** Engine and model from the session open row of a record's events, when the list does not say. */
export function engineOfEvents(events: Array<{ type: string; data: Record<string, unknown> }>): { engine: string; model: string | null } {
  const open = events.find((e) => e.type === "tool_call" && e.data.tool === "voice_session_open");
  const i = (open?.data.inputs ?? {}) as { provider?: unknown; model?: unknown };
  const model = typeof i.model === "string" ? i.model : null;
  if (i.provider === "azure_voice_live") return { engine: "Azure Voice Live", model };
  if (i.provider === "deepgram") return { engine: "Deepgram", model };
  if (i.provider === "pipecat" || String(i.provider ?? "").startsWith("pipecat")) return { engine: "Pipecat", model };
  if (model) return { engine: "Azure gpt-live", model };
  return { engine: open ? "Voice" : "Typed", model };
}

/** Every engine's calls, newest first, as the server orders them. */
export async function listCalls(opts: { leadId?: string; engine?: string; limit?: number } = {}): Promise<CallSummary[]> {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 50));
  if (opts.leadId) q.set("leadId", opts.leadId);
  if (opts.engine) q.set("engine", opts.engine);
  const res = await fetch(`/api/calls?${q.toString()}`, { signal: AbortSignal.timeout(10_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !Array.isArray(json.calls)) throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
  return (json.calls as CallItem[]).map(summaryOf);
}

/** One call with its transcript, metrics, score, agent context and trace rows (when known). */
export async function callDetail(id: string): Promise<CallDetail> {
  const res = await fetch(`/api/calls/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.call) throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
  return json as CallDetail;
}

/** A call's transcript lines from its detail; empty when none is on file. */
export async function callTranscript(id: string): Promise<Array<{ role: string; text: string }>> {
  const d = await callDetail(id);
  return (Array.isArray(d.transcript) ? d.transcript : []).map((l) => ({ role: String(l.role ?? "?"), text: String(l.text ?? "") })).filter((l) => l.text);
}

/**
 * Sets the call bar's lead. A development lead that is not in the menu yet is
 * added to it: Talk and the Pipecat engine take any development lead id.
 * Returns false only when the page has no call bar.
 */
export function pickLeadInCallBar(leadId: string, label?: string): boolean {
  const select = document.getElementById("playLead") as HTMLSelectElement | null;
  if (!select) return false;
  let option = [...select.options].find((o) => o.value === leadId);
  if (!option) {
    option = new Option(label ?? leadId, leadId);
    option.dataset.source = "leads";
    select.add(option);
  } else if (label && option.dataset.source === "leads") option.text = label;
  select.value = leadId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function whenText(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso || "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Sets the call bar's lead and says what that means for a dial; shared by the leads panel, the lead view and the dialog. */
export function setLeadForCall(lead: LeadCandidate): void {
  const who = lead.ownerName ?? lead.businessName;
  if (!pickLeadInCallBar(lead.leadId, `${who} (${lead.businessName})`)) { toast.error("No call bar on this page."); return; }
  if (lead.callable) toast.success(`${who} is set for the next call.`);
  else toast.warning(`${who} is set, but a real dial will be refused`, { description: lead.flags.noPhone ? "No phone on file." : lead.flags.suppressed ? "The lead is suppressed." : "The lead is on the do-not-call list. A browser or simulated line still works." });
}
