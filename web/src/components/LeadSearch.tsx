import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { searchLeadsFull, type LeadCandidate, type LeadFilters } from "@/lib/calls-history";
import { cn } from "@/lib/utils";

const INPUT = "h-7 w-full min-w-0 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

export function renewalText(xDate?: string): string {
  if (!xDate) return "no renewal date";
  const days = Math.round((Date.parse(xDate) - Date.now()) / 86_400_000);
  return days < 0 ? `renewed ${-days} d ago` : days === 0 ? "renews today" : `renews in ${days} d`;
}

/**
 * The lead search used by the left pane and by Start a call: a search box,
 * three filters (trade, renewal window, call history), and the matching
 * fictional example leads. The caller decides what picking one does.
 */
export function LeadSearch({ onPick, selectedId, compact = false, idPrefix = "leads" }: { onPick: (lead: LeadCandidate) => void; selectedId?: string | null; compact?: boolean; idPrefix?: string }) {
  const [filters, setFilters] = useState<LeadFilters>({ search: "", trade: "", renewal: "", history: "", stage: "" });
  const [leads, setLeads] = useState<LeadCandidate[] | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      searchLeadsFull(filters).then((r) => { if (!cancelled) { setLeads(r.leads); setStages(r.stages); setError(null); } }, (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filters]);
  const set = (patch: Partial<LeadFilters>) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1.5" data-slot="lead-search">
      <label className="relative block">
        <SearchIcon className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
        <input id={`${idPrefix}Search`} type="search" value={filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Business or owner" aria-label="Search leads" className={cn(INPUT, "pl-7")} />
      </label>
      <div className="grid grid-cols-2 gap-1">
        <input id={`${idPrefix}Trade`} value={filters.trade} onChange={(e) => set({ trade: e.target.value })} placeholder="Trade" aria-label="Trade" className={INPUT} />
        <Select value={filters.renewal || "any"} onValueChange={(v) => set({ renewal: v === "any" ? "" : v })}>
          <SelectTrigger id={`${idPrefix}Renewal`} aria-label="Renewal window" className="h-7 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any renewal</SelectItem>
            <SelectItem value="30">Renews in 30 d</SelectItem>
            <SelectItem value="60">Renews in 60 d</SelectItem>
            <SelectItem value="90">Renews in 90 d</SelectItem>
            <SelectItem value="past">Already renewed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.stage || "any"} onValueChange={(v) => set({ stage: v === "any" ? "" : v })}>
          <SelectTrigger id={`${idPrefix}Stage`} aria-label="Stage" className="h-7 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any stage</SelectItem>
            {stages.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filters.history || "any"} onValueChange={(v) => set({ history: v === "any" ? "" : (v as "yes" | "no") })}>
          <SelectTrigger id={`${idPrefix}History`} aria-label="Call history" className="h-7 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Called or not</SelectItem>
            <SelectItem value="yes">Called before</SelectItem>
            <SelectItem value="no">Never called</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-[11px] text-destructive">Leads unavailable: {error}</p>}
      {!leads && !error && <p className="text-[11px] text-muted-foreground">Loading leads…</p>}
      {leads && leads.length === 0 && <p className="text-[11px] text-muted-foreground">No lead matches.</p>}
      {leads && leads.length > 0 && (
        <ul id={`${idPrefix}List`} className={cn("grid gap-0.5 overflow-auto", compact ? "max-h-40" : "max-h-full")} aria-label="Leads">
          {leads.map((l) => {
            const chosen = l.leadId === selectedId;
            return (
              <li key={l.leadId}>
                <button type="button" onClick={() => onPick(l)} aria-pressed={chosen} data-lead={l.leadId}
                  className={cn("grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-x-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent", chosen && "bg-primary/10 ring-1 ring-primary")}>
                  <span className="min-w-0 truncate font-medium">{l.ownerName ?? l.businessName}<span className="font-normal text-muted-foreground"> · {l.businessName}</span></span>
                  <span className="flex items-center gap-1">
                    {!l.callable && <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal text-muted-foreground" title={l.flags.noPhone ? "No phone on file" : l.flags.suppressed ? "Suppressed" : "On the do-not-call list"}>{l.flags.noPhone ? "no phone" : l.flags.suppressed ? "suppressed" : "do not call"}</Badge>}
                    {l.callCount > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">{l.callCount} call{l.callCount === 1 ? "" : "s"}</Badge>}
                  </span>
                  <span className="col-span-2 min-w-0 truncate text-[11px] text-muted-foreground">{[l.stage, l.trade, [l.city, l.state].filter(Boolean).join(", "), renewalText(l.xDate)].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
