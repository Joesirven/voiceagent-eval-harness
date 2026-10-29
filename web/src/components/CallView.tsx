import { ChevronDownIcon, ChevronUpIcon, HistoryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { Summary } from "../../../src/server/live-view-core.js";
import { CallOrb } from "@/components/CallOrb";
import { CallTimeline } from "@/components/CallTimeline";
import { LeadDetail, useChosenLead } from "@/components/LeadDetail";
import { LeadsPanel } from "@/components/LeadsPanel";
import { setLeadForCall, type LeadCandidate } from "@/lib/calls-history";
import { RateCallDialog, type RatingSetup, type RatingTarget } from "@/components/RateCallDialog";
import { ScoreCard } from "@/components/ScoreCard";
import { PIPECAT_PRESETS, usePipecatCall } from "@/lib/pipecat-call";
import { JudgeBody } from "@/components/JudgeDialog";
import { LiveVoiceCard } from "@/components/LiveVoiceCard";
import { Transcript } from "@/components/Transcript";
import { MetricsPane } from "@/components/console/MetricsPane";
import { ObjectivesPane } from "@/components/console/ObjectivesPane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WatchReplayControls } from "@/components/console/WatchReplayControls";
import { plainBySeq } from "@/lib/live";
import { useCallView } from "@/lib/use-call-view";
import { useLayout } from "@/lib/layout";
import type { AppState } from "@/lib/types";

function PanelTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-3">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h2>
      {actions}
    </div>
  );
}

export function CallView({ state, inCall, onInCall, settings, setup }: { state: AppState; inCall: boolean; onInCall: (v: boolean) => void; settings?: React.ReactNode; setup?: React.ReactNode }) {
  const model = useCallView();
  const { sorted, groups, sum, judged, pinned, setPinned, replay, callIds } = model;
  const outer = useLayout("call-outer");
  const top = useLayout("call-top");
  const right = useLayout("call-right");
  const centre = useLayout("call-centre");
  // The lead in view: the one picked on the left, else the call bar's.
  const [pickedLead, setPickedLead] = useState<LeadCandidate | null>(null);
  const chosenLead = useChosenLead();
  const leadInView = pickedLead ? { leadId: pickedLead.leadId, label: pickedLead.ownerName ?? pickedLead.businessName } : { leadId: chosenLead.leadId, label: chosenLead.label };
  const bottomRef = useRef<PanelImperativeHandle | null>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomTab, setBottomTab] = useState("timeline");
  // The rating pop-up: once when the live call ends (never in replay), once when a Pipecat call ends, and on request.
  const [rating, setRating] = useState<RatingTarget | null>(null);
  const ratedRef = useRef<string | null>(null);
  // Calls this page saw while still open: a page that loads on an already ended call does not ask for a rating.
  const seenOpenRef = useRef<Set<string>>(new Set());
  const liveCallId = replay.data ? null : (sorted[0]?.callId ?? null);
  /**
   * The setup a rating is saved with: what the call in view actually ran, read from its own rows (voice_session_open for the
   * provider, model and voice; voice_live_session_echo for the transcription; agent_context for the session mode), with the
   * page's settings only for what the rows do not carry. A Pipecat call carries its preset in the same open row.
   */
  const setupOfCall = (rows: typeof sorted): RatingSetup => {
    const inputsOf = (tool: string) => {
      const row = [...rows].reverse().find((e) => e.type === "tool_call" && e.data?.tool === tool);
      return (row?.data?.inputs ?? {}) as Record<string, unknown>;
    };
    const open = inputsOf("voice_session_open");
    const echo = inputsOf("voice_live_session_echo");
    const context = inputsOf("agent_context");
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const provider = str(open.provider);
    const voicePath = provider === "pipecat" ? str(open.voicePath) : provider ?? str(context.sessionMode) ?? (rows.length ? undefined : state.selectedVoicePathId);
    const routed = state.modules.find((m) => m.id === "azure-gpt-live") ?? state.modules[0];
    const treeSaid = str(open.decisionTree) ?? str(context.decisionTree);
    const treeOn = treeSaid === "on" ? true : treeSaid === "off" ? false : (state as { voiceLiveDecisionTree?: boolean }).voiceLiveDecisionTree === true;
    if (provider === "pipecat") {
      return { engine: "Pipecat (local)", preset: str(open.preset), voicePath, model: str(open.model), voice: str(open.voice), decisionTree: "engine flow" };
    }
    const engine = voicePath === "azure_voice_live" ? "Azure Voice Live" : voicePath === "deepgram" ? "Deepgram" : "Azure gpt-live";
    // Voice Live's flow: the open row says voice_live_flow when the five steps ran; the agent context row names the choice.
    const flow = voicePath === "azure_voice_live"
      ? (open.decisionRouter === "voice_live_flow" ? "step_by_step" : str(context.voiceLiveFlow) ?? (rows.length ? "one_prompt" : state.voiceLiveFlow ?? "step_by_step"))
      : undefined;
    return {
      engine, orchestrator: state.selectedOrchestratorId, voicePath, ...(flow ? { flow } : {}),
      model: str(open.model) ?? (rows.length ? undefined : routed?.config.model),
      voice: str(open.voice) ?? (rows.length ? undefined : routed?.config.voice),
      promptSetup: (state as { selectedPromptSetupId?: string }).selectedPromptSetupId,
      decisionTree: treeOn ? state.selectedDecisionTreeId : "off",
      decisionModule: state.decisionModules.find((d) => d.selected)?.id,
      extra: { voiceLiveDecisionTree: treeOn, ...(str(echo.transcription) ? { transcription: str(echo.transcription) } : {}), ...(str(context.sessionMode) ? { sessionMode: str(context.sessionMode) } : {}) },
    };
  };
  const harnessSetup = () => setupOfCall(sorted);
  const ended = sum.ended;
  useEffect(() => {
    if (liveCallId && !ended) seenOpenRef.current.add(liveCallId);
    // A Pipecat call is rated by the Pipecat effect below, with the engine's own setup.
    if (!ended || !liveCallId || liveCallId.startsWith("pipecat_") || !seenOpenRef.current.has(liveCallId) || ratedRef.current === liveCallId || !sorted.some((e) => e.type === "transcript_final" && e.data.role === "caller")) return;
    ratedRef.current = liveCallId;
    setRating({ callId: liveCallId, leadId: sorted[0]?.leadId, setup: harnessSetup() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, liveCallId]);
  const pipecat = usePipecatCall();
  // The panes follow the Pipecat call as soon as it starts (its rows come from the page, not the server stream).
  useEffect(() => {
    const onStart = (e: Event) => { const id = (e as CustomEvent<{ callId: string }>).detail?.callId; if (id) { replay.stop(); setPinned(id); } };
    window.addEventListener("pipecat-call-started", onStart);
    return () => window.removeEventListener("pipecat-call-started", onStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pipecatWas = useRef(pipecat.status);
  useEffect(() => {
    const was = pipecatWas.current;
    pipecatWas.current = pipecat.status;
    if (was === "connected" && pipecat.status === "idle" && pipecat.since) {
      const preset = PIPECAT_PRESETS.find((p) => p.id === pipecat.presetId);
      setRating({ callId: pipecat.engineCallId ?? pipecat.callId ?? `pipecat_${pipecat.since}`, leadId: pipecat.leadId, setup: { engine: "Pipecat (local)", preset: preset?.name ?? pipecat.presetId, voicePath: String(preset?.config.voicePath ?? ""), model: String(preset?.config.replyDeployment ?? ""), voice: String(preset?.config.voice ?? "") } });
    }
  }, [pipecat.status, pipecat.since, pipecat.presetId, pipecat.leadId]);
  // The score arrives once, after the call: the bottom panel turns to it.
  const scored = Boolean(sum.score && typeof (sum.score as { score?: unknown }).score === "number");
  useEffect(() => { if (scored) { setBottomTab("score"); if (bottomRef.current?.isCollapsed()) { bottomRef.current.expand(); setBottomCollapsed(false); } } }, [scored]);
  const toggleBottom = () => {
    const panel = bottomRef.current;
    if (!panel) return;
    if (bottomCollapsed) panel.expand(); else panel.collapse();
    setBottomCollapsed(!bottomCollapsed);
  };

  const azureDown = state.azureStatus && !state.azureStatus.ok;
  const moduleDown = state.decisionModuleStatus && !state.decisionModuleStatus.available;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LiveVoiceCard inCall={inCall} settings={settings} setup={setup} orb={<CallOrb sorted={sorted} inCall={inCall} />} onCall={(callId) => { onInCall(Boolean(callId)); if (callId) { replay.stop(); setPinned(callId); } }} />
      {(azureDown || moduleDown) && (
        <div className="grid gap-1 border-b p-2">
          {azureDown && (
            <Alert variant="destructive" role="alert" id="azureAlert" className="py-1.5">
              <AlertTitle className="text-xs">Azure is not working, so new calls are refused</AlertTitle>
              <AlertDescription className="text-xs">{state.azureStatus?.message ?? "Azure unavailable."}</AlertDescription>
            </Alert>
          )}
          {moduleDown && (
            <Alert variant="destructive" role="alert" id="stackModuleWarning" className="py-1.5">
              <AlertTitle className="text-xs">Decision model unavailable</AlertTitle>
              <AlertDescription className="text-xs">{state.decisionModuleStatus?.message || "Decision model unavailable."}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <ResizablePanelGroup orientation="vertical" id="call-outer" {...outer} className="min-h-0 flex-1">
        <ResizablePanel id="top" defaultSize={68} minSize={30}>
          <ResizablePanelGroup orientation="horizontal" id="call-top" {...top}>
            {/* Leads and call history: find a lead, see its calls, open one in the panes. */}
            <ResizablePanel id="context" defaultSize={24} minSize={16} className="flex min-w-0 flex-col p-1" aria-label="Leads and calls">
              <LeadsPanel model={model} inCall={inCall} lead={pickedLead} onLead={setPickedLead} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="transcript" defaultSize={42} minSize={25} className="flex min-w-0 flex-col">
              <ResizablePanelGroup orientation="vertical" id="call-centre" {...centre}>
              {/* The lead in view, over the transcript: the record, what the agent is told, and what a quote still needs. */}
              <ResizablePanel id="call-lead" defaultSize={38} minSize={8} collapsible collapsedSize={0} className="flex min-h-0 flex-col" aria-label="Lead">
                <PanelTitle>Lead{leadInView.label ? `: ${leadInView.label.split(" (")[0]}` : ""}</PanelTitle>
                <div className="min-h-0 flex-1 overflow-auto">
                  <LeadDetail lead={pickedLead} leadId={leadInView.leadId} label={leadInView.label} direction={chosenLead.direction} sorted={sorted} inCall={inCall} onUse={pickedLead ? () => setLeadForCall(pickedLead) : undefined} />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="call-transcript" defaultSize={62} minSize={20} className="flex min-h-0 flex-col">
              <PanelTitle actions={!inCall && (
                <Dialog>
                  <DialogTrigger asChild><Button variant="ghost" size="icon" className="size-6" id="watchToggle" aria-label="Watch and replay" title="Watch another call or replay a stored one"><HistoryIcon /></Button></DialogTrigger>
                  <DialogContent className="max-w-[92vw] sm:max-w-xl">
                    <DialogHeader><DialogTitle>Watch and replay</DialogTitle><DialogDescription>Follow the newest call, pick one, or step through a stored call.</DialogDescription></DialogHeader>
                    <WatchReplayControls model={{ pinned, setPinned, callIds, replay }} />
                  </DialogContent>
                </Dialog>
              )}>Transcript and reasoning{replay.data ? " (replay)" : ""}</PanelTitle>
              <div className="min-h-0 flex-1">
                <Transcript sorted={sorted} groups={groups} judge={judged} plain={(e) => plainBySeq.get(e.seq)} score={sum.score as { score: number } | null} />
              </div>
              </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
            <ResizableHandle withHandle />
            {/* The right column: running metrics on top, then where the call is and what the agent still has to do. */}
            <ResizablePanel id="tree" defaultSize={36} minSize={18} className="flex min-w-0 flex-col" aria-label="Metrics and objectives">
              <ResizablePanelGroup orientation="vertical" id="call-right" {...right}>
                <ResizablePanel id="call-metrics" defaultSize={50} minSize={20} className="flex min-h-0 flex-col p-1"><MetricsPane model={model} /></ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel id="call-objectives" defaultSize={50} minSize={20} className="flex min-h-0 flex-col p-1"><ObjectivesPane model={model} leadId={leadInView.leadId || undefined} /></ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="judges" defaultSize={32} minSize={10} collapsible collapsedSize={0} panelRef={bottomRef}
          onResize={() => setBottomCollapsed(bottomRef.current?.isCollapsed() ?? false)} className="flex min-w-0 flex-col">
          <Tabs value={bottomTab} onValueChange={setBottomTab} className="min-h-0 flex-1 gap-0">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-2">
              <TabsList className="h-6 bg-transparent p-0">
                <TabsTrigger value="score" className="h-6 px-2 text-xs" id="scoreTab">Score{scored ? ` ${Math.round((sum.score as { score: number }).score)}` : ""}</TabsTrigger>
                <TabsTrigger value="timeline" className="h-6 px-2 text-xs" id="timelineTab">Timeline</TabsTrigger>
                <TabsTrigger value="judges" className="h-6 px-2 text-xs" id="judgesTab">Judges</TabsTrigger>
                <TabsTrigger value="now" className="h-6 px-2 text-xs">Now</TabsTrigger>
              </TabsList>
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[11px]" id="toggleBottom" onClick={toggleBottom} aria-expanded={!bottomCollapsed}>
                {bottomCollapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}{bottomCollapsed ? "Show" : "Hide"}
              </Button>
            </div>
            <TabsContent value="score" className="min-h-0 overflow-auto" id="scoreLive">
              <ScoreCard sum={sum} canRate={Boolean(sorted[0]?.callId) && (sum.ended || replay.data !== null)} onRate={() => { const id = sorted[0]?.callId; if (id) setRating({ callId: id, leadId: sorted[0]?.leadId, setup: harnessSetup() }); }} />
            </TabsContent>
            <TabsContent value="timeline" className="min-h-0 overflow-auto" id="timelineLive"><CallTimeline sorted={sorted} judged={judged} sum={sum} /></TabsContent>
            <TabsContent value="judges" className="min-h-0 overflow-auto p-2" id="judgesLive"><JudgeBody rows={judged} sum={sum} /></TabsContent>
            <TabsContent value="now" className="min-h-0 overflow-auto p-2"><NowBoard sum={sum} /></TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
      <RateCallDialog target={rating} onClose={() => setRating(null)} />
    </div>
  );
}

function NowBoard({ sum }: { sum: Summary }) {
  const d = sum.decision;
  const pct = d ? Math.round(Number(d.confidence) * 100) : 0;
  const min = d ? Math.round(Number(d.minConfidence) * 100) : 0;
  return (
    <div className="space-y-1 text-xs">
      <div>Disposition: {sum.disposition ?? "none yet"}{sum.ended ? " (call ended)" : ""}</div>
      {d && (
        <>
          <div>Latest decision: {d.answer} (module {d.module}, {d.routed})</div>
          <div className="relative h-2 max-w-sm rounded bg-muted">
            <div className={`absolute inset-y-0 left-0 rounded ${pct < min ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
            <div className="absolute -inset-y-0.5 w-0.5 bg-foreground" style={{ left: `${min}%` }} />
          </div>
          <div className="text-muted-foreground">Confidence {pct}% against a minimum of {min}%. {d.reason ?? ""}</div>
        </>
      )}
      <div>Agent said next: {sum.agentSaid ? sum.agentSaid.text : "nothing yet"}</div>
      <div className="pt-1 font-semibold">Judge scoreboard</div>
      {sum.verdicts.map((v, i) => (
        <div key={i} className={v.allowed ? "" : "font-semibold text-destructive"}>{v.allowed ? "allowed" : "BLOCKED"} {v.action}: {v.reason}</div>
      ))}
      {!sum.verdicts.length && <div className="text-muted-foreground">No verdicts yet.</div>}
      {sum.score && (
        <>
          <div className="pt-1">Post-call score: {sum.score.score}</div>
          {(sum.score.criteria ?? []).map((c: any, i: number) => <div key={i} className="text-muted-foreground">{c.criterion}: {c.score} ({c.note})</div>)}
        </>
      )}
    </div>
  );
}
