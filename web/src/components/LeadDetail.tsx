import { BuildingIcon, CalendarClockIcon, HashIcon, MapPinIcon, PhoneIcon, PhoneIncomingIcon, PhoneOutgoingIcon, ShieldCheckIcon, UserIcon, UsersIcon, WalletIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LeadContextJson } from "../../../src/lead-context/types.js";
import { buildTranscript } from "../../../src/server/live-view-core.js";
import type { SortedEvent } from "../../../src/server/live-view-core.js";
import { renewalText } from "@/components/LeadSearch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { whenText, type LeadCandidate } from "@/lib/calls-history";
import { cn } from "@/lib/utils";

/** The lead and direction chosen in the call bar. */
function chosen(): { leadId: string; label: string; direction: string } {
  const lead = document.getElementById("playLead") as HTMLSelectElement | null;
  const dir = document.getElementById("playDir") as HTMLInputElement | null;
  return { leadId: lead?.value ?? "", label: lead?.selectedOptions?.[0]?.textContent ?? "", direction: dir?.value ?? "inbound" };
}

export function useChosenLead(): { leadId: string; label: string; direction: string } {
  const [value, setValue] = useState(chosen);
  useEffect(() => {
    const read = () => setValue((v) => { const n = chosen(); return n.leadId === v.leadId && n.label === v.label && n.direction === v.direction ? v : n; });
    const lead = document.getElementById("playLead");
    lead?.addEventListener("change", read);
    const t = setInterval(read, 1500);
    return () => { lead?.removeEventListener("change", read); clearInterval(t); };
  }, []);
  return value;
}

const WITHHELD = /^withheld/i;
type Icon = typeof BuildingIcon;

function Row({ label, value, Icon, title }: { label: string; value: string; Icon?: Icon; title?: string }) {
  const unknown = value === "unknown" || value === "";
  const withheld = WITHHELD.test(value);
  return (
    <div className="grid grid-cols-[72px_1fr] items-start gap-x-2 text-[11px]">
      <dt className="flex items-center gap-1 truncate text-muted-foreground">{Icon ? <Icon className="size-3 shrink-0" /> : null}{label}</dt>
      <dd className={cn("min-w-0 truncate", (unknown || withheld) && "text-muted-foreground")} title={title ?? value}>{unknown ? "—" : withheld ? "withheld until confirmed" : value}</dd>
    </div>
  );
}

/** Earlier call and text summaries come as one string with " | " between entries. */
function entries(value: string | undefined): string[] {
  if (!value || value === "unknown") return [];
  return value.split(" | ").map((s) => s.trim()).filter(Boolean);
}

/**
 * The open view of a selected lead: what the lead record says (business, owner,
 * trade, place, phone, stage, renewal, calls), then what the agent will be told
 * about them (the lead context: carriers, headcount, payroll, earlier calls and
 * texts, producer note) and what a quote still needs. The context is read live
 * and refreshed as the call goes, so quote fields fill in as the caller gives them.
 */
export function LeadDetail({ lead, leadId, label, direction, sorted, inCall, onUse }: { lead: LeadCandidate | null; leadId: string; label: string; direction: string; sorted: SortedEvent[]; inCall: boolean; onUse?: () => void }) {
  const lineCount = useMemo(() => buildTranscript(sorted).filter((l) => l.final).length, [sorted]);
  const [json, setJson] = useState<LeadContextJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!leadId) { setJson(null); setError(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/lead-context?leadId=${encodeURIComponent(leadId)}`, { signal: AbortSignal.timeout(15_000) });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || !body?.json) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        setJson(body.json);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [leadId, lineCount]);

  const facts = new Map((json?.facts ?? []).map((f) => [f.key, f]));
  const fact = (key: string) => facts.get(key)?.value ?? "unknown";
  const business = lead?.businessName ?? fact("business");
  const name = lead?.ownerName ?? facts.get("name_on_file")?.value ?? (label.split(" (")[0] || business || "Lead");
  const Dir = direction === "outbound" ? PhoneOutgoingIcon : PhoneIncomingIcon;
  if (!leadId) return <p className="p-2 text-[11px] text-muted-foreground" id="selectedLead">Pick a lead on the left or in the call bar.</p>;
  const needed = json?.checklist.filter((r) => r.status === "still_needed") ?? [];
  const known = json?.checklist.filter((r) => r.status === "known") ?? [];
  const calls = entries(fact("earlier_calls"));
  const texts = entries(fact("earlier_texts"));
  const renewalDays = json?.renewal && typeof json.renewal.days === "number" ? json.renewal.days : null;
  const renewal = lead?.xDate
    ? `${lead.xDate} (${renewalText(lead.xDate)})${lead.xDateCarrier ? `, ${lead.xDateCarrier}` : ""}${lead.xDateLine ? `, ${lead.xDateLine}` : ""}`
    : json?.renewal?.date ? `${json.renewal.date}${renewalDays !== null ? ` (${renewalDays} days)` : ""}` : json?.renewal?.held ? "withheld until confirmed" : "unknown";
  const dial = !lead ? null : lead.flags.noPhone ? "no phone on file" : lead.flags.suppressed ? "suppressed" : !lead.callable ? `do-not-call: ${lead.flags.dnc}` : null;

  return (
    <div className="grid gap-2 p-2" id="selectedLead" aria-label="Selected lead">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#1f7c74]/15 text-xs font-semibold text-[#1f7c74]">{name.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{[business !== name && business !== "unknown" ? business : null, lead?.stage, json ? (json.confirmed ? "named person confirmed" : "not yet confirmed on this call") : null].filter(Boolean).join(" · ")}</span>
        </span>
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal"><Dir className="size-3" />{direction}</Badge>
        {onUse && <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" id="callThisLead" onClick={onUse} disabled={inCall}><PhoneIcon className="size-3" />Use for the call</Button>}
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 lg:grid-cols-2">
        <Row label="Business" Icon={BuildingIcon} value={business} />
        <Row label="Trade" value={lead?.trade ?? fact("trade")} />
        <Row label="Where" Icon={MapPinIcon} value={[lead?.city, lead?.state].filter(Boolean).join(", ") || fact("location")} />
        <Row label="Phone" Icon={PhoneIcon} value={lead?.phoneLast4 ? `ends ${lead.phoneLast4}` : "unknown"} />
        <Row label="Renewal" Icon={CalendarClockIcon} value={renewal} />
        <Row label="Carriers" Icon={ShieldCheckIcon} value={fact("carriers_current")} />
        <Row label="Employees" Icon={UsersIcon} value={fact("employees")} />
        <Row label="Payroll" Icon={WalletIcon} value={fact("payroll")} />
        <Row label="Role" Icon={UserIcon} value={fact("role")} />
        <Row label="Producer" value={json?.producerName.value ?? "unknown"} title={json?.producerName.source} />
        <Row label="Agency" value={json?.agencyName.value ?? "unknown"} title={json?.agencyName.source} />
        <Row label="Calls" Icon={HashIcon} value={!lead ? "unknown" : lead.callCount === 0 ? "never called" : `${lead.callCount}${lead.lastCall ? `, last ${whenText(lead.lastCall.at)}${lead.lastCall.outcome ? ` (${lead.lastCall.outcome})` : ""}` : ""}`} />
        {dial && <div className="grid grid-cols-[72px_1fr] gap-x-2 text-[11px] lg:col-span-2"><dt className="text-muted-foreground">Dial</dt><dd className="text-amber-700">{dial}: a real dial is refused, a browser or simulated line still works</dd></div>}
        <Row label="Id" value={leadId} />
      </dl>

      {fact("producer_note") !== "unknown" && (
        <div className="grid gap-0.5 border-t pt-1.5">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Producer note</p>
          <p className="text-[11px]">{fact("producer_note")}</p>
        </div>
      )}

      <div className="grid gap-1 border-t pt-1.5">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">What a quote still needs</p>
        {error && <p className="text-[11px] text-destructive">Lead context unavailable: {error}</p>}
        {!json && !error && <p className="text-[11px] text-muted-foreground">Loading the lead context…</p>}
        {json && (needed.length === 0
          ? <p className="text-[11px] text-muted-foreground">Every quote field is on file.</p>
          : <div className="flex flex-wrap gap-1" id="leadStillNeeded">{needed.map((r) => <Badge key={r.field} variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{r.label}</Badge>)}</div>)}
        {known.length > 0 && <p className="text-[11px] text-muted-foreground">On file: {known.map((r) => `${r.label}${r.value && !WITHHELD.test(r.value) ? ` (${r.value})` : ""}`).join(", ")}</p>}
      </div>

      {(calls.length > 0 || texts.length > 0) && (
        <div className="grid gap-1 border-t pt-1.5">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Earlier contact the agent is told about</p>
          <ul className="grid gap-0.5" id="leadEarlierContact">
            {calls.map((c, i) => <li key={`c${i}`} className="text-[11px]"><span className="text-muted-foreground">Call · </span>{c}</li>)}
            {texts.map((t, i) => <li key={`t${i}`} className="text-[11px]"><span className="text-muted-foreground">Text · </span>{t}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
