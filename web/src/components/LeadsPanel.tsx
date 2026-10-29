import { ArrowLeftIcon, PhoneIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { LeadSearch } from "@/components/LeadSearch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callDetail, callTranscript, durationText, listCalls, setLeadForCall, whenText, type CallSummary, type LeadCandidate } from "@/lib/calls-history";
import type { CallViewModel } from "@/lib/use-call-view";
import { cn } from "@/lib/utils";

function CallRow({ call, active, onOpen }: { call: CallSummary; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-pressed={active} data-call={call.id}
        className={cn("grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-x-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent", active && "bg-primary/10 ring-1 ring-primary")}>
        <span className="min-w-0 truncate"><span className="font-medium">{whenText(call.startedAt)}</span><span className="text-muted-foreground"> · {call.direction}{call.durationMs !== null ? ` · ${durationText(call.durationMs)}` : ""}{call.outcome ? ` · ${call.outcome}` : ""}</span></span>
        {call.score !== null && <Badge variant="outline" className={cn("h-4 px-1 text-[10px] tabular-nums", call.score >= 75 ? "border-emerald-500 text-emerald-700" : call.score >= 50 ? "border-amber-500 text-amber-700" : "border-red-500 text-red-700")}>{Math.round(call.score)}</Badge>}
        <span className="col-span-2 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">{call.engine}</Badge>
          {call.model && <span className="truncate">{call.model}</span>}
          {call.leadLabel && <span className="ml-auto truncate">{call.leadLabel}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * The left pane: find a lead among the fictional example leads, see its
 * calls, and open any call (its transcript, metrics and score show in the other
 * panes through replay; a Pipecat call shows its transcript here). With no
 * lead selected, the newest calls on every engine.
 */
export function LeadsPanel({ model, inCall, lead, onLead }: { model: CallViewModel; inCall: boolean; lead: LeadCandidate | null; onLead: (lead: LeadCandidate | null) => void }) {
  const setLead = onLead;
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<Array<{ role: string; text: string }> | null>(null);
  const leadId = lead?.leadId;
  const refresh = useCallback(() => listCalls(leadId ? { leadId } : {}).then((c) => { setCalls(c); setCallsError(null); }, (e) => setCallsError(e instanceof Error ? e.message : String(e))), [leadId]);
  useEffect(() => { void refresh(); }, [refresh]);
  // A call that just ended joins the list.
  const ended = model.sum.ended;
  useEffect(() => { if (ended) { const t = setTimeout(() => void refresh(), 3000); return () => clearTimeout(t); } }, [ended, refresh]);

  const forLead = useMemo(() => (lead ? (calls ?? []).filter((c) => c.leadId === lead.leadId) : calls ?? []), [calls, lead]);

  // A record on this machine replays as before; a call known only through the history endpoint replays from the trace rows in its detail, or shows its transcript when it has none.
  const open = async (call: CallSummary) => {
    setOpenId(call.id);
    setLines(null);
    try {
      if (call.recordId) {
        await model.replay.load(call.recordId, { all: true });
        return;
      }
      const d = await callDetail(call.id);
      if (Array.isArray(d.events) && d.events.length > 0) {
        model.replay.loadEvents(call.id, d.events, (d.score as Record<string, unknown> | null) ?? null, { all: true });
        return;
      }
      setLines((Array.isArray(d.transcript) ? d.transcript : []).map((l) => ({ role: String(l.role ?? "?"), text: String(l.text ?? "") })).filter((l) => l.text));
    } catch (e) {
      toast.error("The call could not be opened", { description: e instanceof Error ? e.message : String(e) });
      try { setLines(await callTranscript(call.id)); } catch { setLines([]); }
    }
  };
  const closeCall = () => { setOpenId(null); setLines(null); model.replay.stop(); };

  const callThis = () => { if (lead) setLeadForCall(lead); };

  return (
    <Card className="h-full min-h-0 gap-2 overflow-hidden py-2" id="leadsPanel" aria-label="Leads and calls">
      <CardHeader className="gap-1 px-3">
        <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {lead ? <Button variant="ghost" size="icon" className="size-5" onClick={() => { setLead(null); closeCall(); }} aria-label="Back to all leads"><ArrowLeftIcon /></Button> : null}
          <span className="min-w-0 flex-1 truncate">{lead ? (lead.ownerName ?? lead.businessName) : "Leads and calls"}</span>
          <Button variant="ghost" size="icon" className="size-5" onClick={() => void refresh()} aria-label="Refresh calls" title="Refresh calls"><RefreshCwIcon /></Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-auto px-3">
        {!lead && <LeadSearch onPick={(l) => { setLead(l); closeCall(); }} selectedId={null} compact />}
        {lead && (
          <div className="flex items-center gap-2 rounded-md border p-2 text-xs" id="selectedLeadRow">
            <span className="min-w-0 flex-1 truncate">{lead.businessName}<span className="text-muted-foreground"> · details above the transcript</span></span>
            <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" id="callThisLead" onClick={callThis} disabled={inCall}><PhoneIcon className="size-3" />Use for the call</Button>
          </div>
        )}
        <section className="grid gap-1" aria-label="Calls">
          <h3 className="flex items-center justify-between text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <span>{lead ? "Calls with this lead" : "Recent calls, every engine"}</span>
            {openId && <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] normal-case" onClick={closeCall}>Back to live</Button>}
          </h3>
          {callsError && <p className="text-[11px] text-destructive">Calls unavailable: {callsError}</p>}
          {calls && forLead.length === 0 && <p className="text-[11px] text-muted-foreground">{lead ? "No call with this lead yet." : "No calls yet."}</p>}
          {forLead.length > 0 && <ul id="callHistory" className="grid gap-0.5">{forLead.slice(0, 30).map((c) => <CallRow key={`${c.source}:${c.id}`} call={c} active={c.id === openId} onOpen={() => void open(c)} />)}</ul>}
          {openId && lines && (
            <div className="grid gap-0.5 rounded-md border p-2" id="callTranscript">
              {lines.length === 0
                ? <p className="text-[11px] text-muted-foreground">No transcript on file for this call.</p>
                : lines.map((l, i) => <p key={i} className="text-[11px]"><span className="font-medium text-muted-foreground">{l.role}: </span>{l.text}</p>)}
            </div>
          )}
          {openId && !lines && model.replay.data && <p className="text-[11px] text-muted-foreground">Showing this call in the panes: its transcript, metrics, objectives and score.</p>}
        </section>
      </CardContent>
    </Card>
  );
}
