import { ChevronDownIcon, ChevronRightIcon, Loader2Icon, PhoneOffIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { startBoundCall } from "../../../src/server/voice/voice-client.js";
import { AgentContextEditor } from "@/components/AgentContextEditor";
import { AgentSettings } from "@/components/AgentSettings";
import { LeadSearch } from "@/components/LeadSearch";
import { Field, SETUP_SOURCE, VOICE_MODULE_ID, VoiceSteps, choices, useVoiceOptions, type Option } from "@/components/settings-controls";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { act, api } from "@/lib/api";
import { pickLeadInCallBar } from "@/lib/calls-history";
import { describe } from "@/lib/labels";
import { endPipecatCall, PIPECAT_DEFAULT_CHOICE, PIPECAT_FLOWS, PIPECAT_LEADS, PIPECAT_MOVERS, PIPECAT_PRESETS, PIPECAT_SPEAKERS, pipecatHealth, pipecatPreset, pipecatSpeakerLabel, startPipecatCall, usePipecatCall, type PipecatChoice, type PipecatHealth } from "@/lib/pipecat-call";
import { cn } from "@/lib/utils";
import type { AppState } from "@/lib/types";

/** POST /api/call/warmup: what was warmed before the call, step by step (src/server/call-warmup.ts). */
export interface WarmupStep { id: "voice_path" | "azure" | "lead" | "decision_model"; label: string; ok: boolean; skipped?: boolean; ms: number; code?: string; detail?: string }
export interface WarmupResult { ok: boolean; totalMs: number; steps: WarmupStep[] }

/** The local Pipecat engine: not one of the server's orchestrators, so it is a choice of this dialog alone. */
const PIPECAT_ID = "pipecat_local";

/** Azure Voice Live's flow: the five steps shared with the Pipecat engine (the speaking model moves them), or one prompt. */
const VOICE_LIVE_FLOWS: Option[] = [
  { value: "step_by_step", name: "Step by step", description: "The five-step quote flow, the same one the Pipecat engine runs; the speaking model moves between steps and the stage strip follows." },
  { value: "one_prompt", name: "One prompt", description: "One prompt for the whole call, no steps." },
];

function elapsed(since: number | null): string {
  if (!since) return "";
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The Pipecat call in the call bar: its preset and clock, and the button that ends it. */
function PipecatCallChip() {
  const call = usePipecatCall();
  const [, tick] = useState(0);
  useEffect(() => { if (call.status === "idle") return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call.status]);
  if (call.status === "idle") return null;
  return (
    <div id="pipecatCall" data-status={call.status} className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-[11px]">
      <span className={cn("size-2 rounded-full", call.status === "connected" ? (call.botSpeaking ? "bg-[#1f7c74] animate-pulse" : "bg-emerald-500") : call.status === "error" ? "bg-destructive" : "bg-amber-500 animate-pulse")} />
      <span className="font-medium">Pipecat</span>
      <span className="text-muted-foreground">{call.status === "starting" ? "connecting…" : call.status === "ending" ? "ending…" : call.status === "error" ? (call.error ?? "error") : `${call.presetName} · ${elapsed(call.since)}`}</span>
      <Button size="sm" variant={call.status === "error" ? "outline" : "destructive"} className="h-5 px-1.5 text-[11px]" id="pipecatEnd" onClick={() => void endPipecatCall()} aria-label="End the Pipecat call">
        <PhoneOffIcon className="size-3" />{call.status === "error" ? "Dismiss" : "End"}
      </Button>
    </div>
  );
}

/** The lead and direction chosen in the call bar (the microphone client reads them there). */
function callTarget(): { leadId?: string; leadLabel?: string; direction?: string } {
  const lead = document.getElementById("playLead") as HTMLSelectElement | null;
  const dir = document.getElementById("playDir") as HTMLInputElement | null;
  const option = lead?.selectedOptions?.[0];
  return { leadId: lead?.value || undefined, leadLabel: option?.textContent ?? undefined, direction: dir?.value || undefined };
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return <section aria-label={`${n}. ${title}`} data-step={n} className="grid min-w-0 grid-cols-1 gap-2">{children}</section>;
}

/** The three stages across the top: the number, the name, and what was chosen; a done stage is a button back to it. */
function Stepper({ step, done, summaries, onJump }: { step: number; done: boolean[]; summaries: Array<string | null>; onJump: (n: number) => void }) {
  const names = ["Engine", "Voice", "Agent"];
  return (
    <ol id="setupStepper" className="flex min-w-0 items-center gap-1 text-[11px]" aria-label="Stages">
      {names.map((name, i) => {
        const current = i === step;
        const reachable = i <= step || done[i - 1] === true;
        return (
          <li key={name} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />}
            <button type="button" disabled={!reachable} aria-current={current ? "step" : undefined} onClick={() => onJump(i)}
              className={cn("flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors", current ? "bg-primary/10 text-foreground" : reachable ? "text-muted-foreground hover:bg-accent" : "text-muted-foreground/50")}>
              <span className={cn("grid size-4 shrink-0 place-items-center rounded-full text-[10px]", current ? "bg-primary text-primary-foreground" : done[i] ? "bg-[#1f7c74] text-white" : "bg-muted")}>{done[i] && !current ? "✓" : i + 1}</span>
              <span className="grid min-w-0 leading-tight">
                <span className="font-semibold">{name}</span>
                <span className="min-h-[13px] truncate text-[10px] text-muted-foreground">{summaries[i] ?? "\u00a0"}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** One step as a word: a tick, a cross, or a dash for a skipped one. */
function stepMark(s: WarmupStep): string {
  return s.skipped ? "–" : s.ok ? "✓" : "✗";
}

/** The warm-up in one line, timings in the tooltip; failed steps are named in the line. */
function WarmupLine({ result }: { result: WarmupResult }) {
  const detail = result.steps.map((s) => `${s.label}: ${s.skipped ? "skipped" : `${s.ms} ms`}${!s.ok && !s.skipped ? ` (${s.detail || s.code || "failed"})` : ""}${s.skipped && s.detail ? ` (${s.detail})` : ""}`).join("\n");
  return (
    <p id="callWarmup" role="status" title={detail} className={cn("truncate text-[11px]", result.ok ? "text-muted-foreground" : "text-destructive")}>
      {result.ok ? `Warmed up in ${result.totalMs} ms: ` : "Not ready: "}
      {result.steps.map((s) => `${stepMark(s)} ${s.label}`).join(" · ")}
    </p>
  );
}

/** The failed steps, one line each, for the toast. */
function failedSteps(result: WarmupResult): string {
  return result.steps.filter((s) => !s.ok && !s.skipped).map((s) => `${s.label}: ${s.detail || s.code || "failed"}`).join("\n");
}

/**
 * The setup that opens from Play, right before each call: first the orchestrator, then (revealed underneath) the
 * voice path and models that orchestrator offers, then the agent (prompt and lead context), then advanced settings. Go warms up (the voice path, Azure, the
 * lead and the decision model) and then starts the call with a phone ring.
 */
export function CallSetupDialog({ state, refresh, disabled }: { state: AppState; refresh: (s?: AppState) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  /** The orchestrator chosen in this opening of the dialog; nothing below it shows until it is chosen. */
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [warm, setWarm] = useState<WarmupResult | null>(null);
  const [warmError, setWarmError] = useState<string | null>(null);
  const [target, setTarget] = useState<ReturnType<typeof callTarget>>({});
  /** Which stage is on screen: 0 engine, 1 voice, 2 agent. */
  const [step, setStep] = useState(0);
  const { options, loadError, reload } = useVoiceOptions();
  const pipecat = usePipecatCall();
  /** Pipecat Flows: the flow, who moves the steps, and who speaks; the eight combinations are the presets. */
  const [pipecatChoice, setPipecatChoice] = useState<PipecatChoice>(PIPECAT_DEFAULT_CHOICE);
  const pipecatPresetChosen = pipecatPreset(pipecatChoice);
  const pipecatPresetId = pipecatPresetChosen.id;
  /** The call bar's lead for Pipecat: any fictional example lead id (a UUID); a harness-only id such as lead-1 cannot be sent. */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pipecatLead = target.leadId && UUID.test(target.leadId) ? { id: target.leadId, label: target.leadLabel ?? target.leadId, writes: PIPECAT_LEADS.some((l) => l.id === target.leadId) } : undefined;
  // The full tree runs inbound only for now (its outbound start is silent).
  const pipecatDirection: "inbound" | "outbound" = pipecatChoice.flow === "full_tree" ? "inbound" : target.direction === "outbound" ? "outbound" : "inbound";
  const [engine, setEngine] = useState<PipecatHealth | { error: string } | null>(null);
  useEffect(() => {
    if (orchestratorId !== PIPECAT_ID) return;
    let cancelled = false;
    setEngine(null);
    pipecatHealth().then((h) => { if (!cancelled) setEngine(h); }, (e) => { if (!cancelled) setEngine({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [orchestratorId]);

  useEffect(() => {
    if (!open) return;
    setOrchestratorId(null);
    setStep(0);
    setWarm(null);
    setWarmError(null);
    setTarget(callTarget());
    void reload();
  }, [open, reload]);

  const post = (url: string, body: object) => act(async () => refresh(await api(url, { ...body, source: SETUP_SOURCE })));
  const routed = state.modules.find((m) => m.id === VOICE_MODULE_ID) ?? state.modules[0];
  const chosenModule = state.decisionModules.find((d) => d.selected);
  const moduleOptions: Option[] = state.decisionModules.map((d) => {
    const info = describe("decisionModule", d.id, d.label);
    return { value: d.id, name: info.name, description: info.description || (d.kind === "model" ? "Calls a model for each decision." : "No model call."), disabled: d.available === false && !d.selected };
  });

  const chooseOrchestrator = (id: string) => act(async () => {
    setOrchestratorId(id);
    setWarm(null);
    setStep(1);
    if (id === PIPECAT_ID) return;
    if (id === state.selectedOrchestratorId) return;
    try {
      await refresh(await api("/api/orchestration/select", { orchestratorId: id, source: SETUP_SOURCE }));
    } catch (err) {
      // A refused switch leaves the server's choice as it was: back to the engine stage, nothing chosen.
      setOrchestratorId(null);
      setStep(0);
      await refresh(await api("/api/state"));
      throw err;
    } finally {
      await reload();
    }
  });

  const orchestrator = orchestratorId ? options?.orchestrators.find((o) => o.id === orchestratorId) : undefined;
  const path = orchestrator?.voicePaths.find((p) => p.id === state.selectedVoicePathId);
  const pipecatChosen = orchestratorId === PIPECAT_ID;
  const engineUp = engine !== null && !("error" in engine);
  const ready = (pipecatChosen ? engineUp && pipecat.status === "idle" && Boolean(pipecatLead) : Boolean(orchestrator && path && state.selectedOrchestratorId === orchestratorId)) && !warming;
  const voiceDone = pipecatChosen ? engineUp && Boolean(pipecatLead) : Boolean(path);
  const engineName = pipecatChosen ? "Pipecat Flows" : orchestratorId ? describe("orchestrator", orchestratorId, orchestrator?.label ?? orchestratorId).name : null;
  const shownModel = (() => {
    const slot = path?.slots.find((s) => s.role === "speech_to_speech") ?? path?.slots.find((s) => s.role === "reply");
    if (!slot) return routed?.config.model ?? null;
    const stored = path?.id === "azure_gpt_live" ? routed?.config.model : slot.selectedId;
    return (stored && slot.models.some((m) => m.id === stored) ? stored : slot.selectedId ?? slot.defaultId ?? slot.models[0]?.id) ?? null;
  })();
  const voiceLiveFlow: "step_by_step" | "one_prompt" = state.voiceLiveFlow === "one_prompt" ? "one_prompt" : "step_by_step";
  const voiceName = pipecatChosen
    ? pipecatPresetChosen.name
    : path ? `${path.label}${shownModel ? ` · ${shownModel}` : ""}${path.id === "azure_voice_live" ? ` · ${voiceLiveFlow === "one_prompt" ? "one prompt" : "step by step"}` : ""}` : null;
  const summaries: Array<string | null> = [engineName, voiceName, step >= 2 ? (state as { selectedPromptSetupId?: string }).selectedPromptSetupId ?? null : null];
  const done = [Boolean(orchestratorId), voiceDone, false];

  const goPipecat = async () => {
    setWarming(true);
    try {
      if (!pipecatLead) throw new Error("Pick a fictional example lead in the call bar: the Pipecat engine takes any of them, but not the harness-only demo leads.");
      await startPipecatCall(pipecatPresetId, pipecatLead.id, pipecatDirection, pipecatLead.label);
      setOpen(false);
      toast.success(`Pipecat Flows call started: ${pipecatPresetChosen.name}.`);
    } catch (err) {
      toast.error("The Pipecat call could not start", { description: err instanceof Error ? err.message : String(err), duration: 8000 });
    } finally {
      setWarming(false);
    }
  };

  const go = async () => {
    setWarming(true);
    setWarm(null);
    setWarmError(null);
    try {
      const result = await api<WarmupResult>("/api/call/warmup", { leadId: target.leadId });
      setWarm(result);
      if (result.ok) {
        // A failed step that does not stop the call (the decision model warm-up) is still said once.
        for (const s of result.steps) if (!s.ok && !s.skipped) toast.warning(`${s.label} did not warm up: ${s.detail || s.code || "no reason given"}`);
        setOpen(false);
        startBoundCall({ ring: true });
      } else {
        toast.error("The call cannot start yet", { description: failedSteps(result) || "A warm-up step failed.", duration: 8000 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWarmError(message);
      toast.error("Warm-up failed", { description: message, duration: 8000 });
    } finally {
      setWarming(false);
    }
  };

  return (
    <>
    <PipecatCallChip />
    <Dialog open={open} onOpenChange={(next) => { if (!warming) setOpen(next); }}>
      <DialogTrigger asChild>
        <Button id="playSetup" size="icon" className="size-8" disabled={disabled} aria-label="Play: set up and start a live voice call"
          title="Choose the orchestrator, the voice and the decisions, then Go: a warm-up, a ring, and the call."><PlayIcon /></Button>
      </DialogTrigger>
      {/* One height for every stage, so the stepper and the buttons never move: the header and footer are pinned, only the body scrolls. */}
      <DialogContent id="callSetupDialog" aria-busy={warming} className="flex h-[min(600px,90vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 gap-2 border-b px-4 pt-4 pb-3 text-left">
          <DialogTitle className="flex items-baseline gap-2 pr-6 text-base">
            Start a call
            {target.leadLabel && <span className="truncate text-xs font-normal text-muted-foreground">{target.leadLabel.split(" (")[0]} · {target.direction === "outbound" ? "outbound" : "inbound"}</span>}
          </DialogTitle>
          <DialogDescription className="sr-only">Choose the engine, the voice and the agent, then Go.</DialogDescription>
          <Stepper step={step} done={done} summaries={summaries} onJump={setStep} />
        </DialogHeader>

        {/* Keyed by stage: nothing from an earlier stage (open collapsibles, drafts) carries into the next. */}
        <div key={step} id="setupBody" data-step={step} className="grid min-h-0 flex-1 content-start gap-3 overflow-x-hidden overflow-y-auto px-4 py-3">
        {step === 0 && (
          <Collapsible>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate"><span className="text-muted-foreground">Lead: </span>{target.leadLabel ? target.leadLabel.split(" (")[0] : "none"} · {target.direction === "outbound" ? "outbound" : "inbound"}</span>
              <CollapsibleTrigger asChild><Button variant="outline" size="sm" id="setupFindLead" className="h-6 px-2 text-[11px]">Find a lead</Button></CollapsibleTrigger>
            </div>
            <CollapsibleContent className="mt-1.5">
              <LeadSearch compact idPrefix="setupLead" selectedId={target.leadId ?? null} onPick={(l) => {
                if (!pickLeadInCallBar(l.leadId, `${l.ownerName ?? l.businessName} (${l.businessName})`)) { toast.error("No call bar on this page."); return; }
                setTarget(callTarget());
                if (l.callable) toast.success(`${l.ownerName ?? l.businessName} is set for this call.`);
                else toast.warning(`${l.ownerName ?? l.businessName} is set, but a real dial will be refused`, { description: l.flags.noPhone ? "No phone on file." : l.flags.suppressed ? "The lead is suppressed." : "On the do-not-call list. A browser or simulated line still works." });
              }} />
            </CollapsibleContent>
          </Collapsible>
        )}
        {step === 0 && <Step n={1} title="Engine">
          <div role="radiogroup" aria-label="Orchestrator" className="grid grid-cols-1 gap-1.5">
            {state.orchestrators.map((o) => {
              const d = describe("orchestrator", o.id, o.label);
              const down = o.available === false;
              const chosen = orchestratorId === o.id;
              return (
                <button key={o.id} type="button" role="radio" aria-checked={chosen} id={`setupOrchestrator-${o.id}`} disabled={down || warming}
                  onClick={() => void chooseOrchestrator(o.id)}
                  className={cn("grid min-w-0 grid-cols-1 rounded-md border px-2.5 py-1.5 text-left break-words transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                    chosen && "border-primary bg-primary/5 ring-1 ring-primary")}>
                  <span className="text-[13px] font-medium">{d.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground" title={d.description}>{down ? (o.unavailableReason ? `Unavailable: ${o.unavailableReason}` : "Unavailable right now.") : d.description}</span>
                </button>
              );
            })}
            <button type="button" role="radio" aria-checked={pipecatChosen} id={`setupOrchestrator-${PIPECAT_ID}`} disabled={warming}
              onClick={() => void chooseOrchestrator(PIPECAT_ID)}
              className={cn("grid min-w-0 grid-cols-1 rounded-md border px-2.5 py-1.5 text-left break-words transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                pipecatChosen && "border-primary bg-primary/5 ring-1 ring-primary")}>
              <span className="text-[13px] font-medium">Pipecat Flows</span>
              <span className="truncate text-[11px] text-muted-foreground">The full tree or the five-step flow on the local engine; steps moved by the speaking model or a decision model in the background.</span>
            </button>
          </div>
        </Step>}

        {step === 1 && pipecatChosen && (
          <Step n={2} title="Voice">
            <p id="pipecatEngine" role="status" className={cn("text-[11px]", engine && "error" in engine ? "text-destructive" : "text-muted-foreground")}>
              {engine === null ? "Checking the engine…" : "error" in engine ? `Engine down: ${engine.error}` : `Engine ${engine.engine}, commit ${engine.commit?.slice(0, 7) ?? "unknown"}`}
            </p>
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <Label htmlFor="pipecatFlow" className="text-xs font-normal">Flow</Label>
              <Select value={pipecatChoice.flow} onValueChange={(v) => setPipecatChoice((c) => ({ ...c, flow: v as PipecatChoice["flow"] }))}>
                <SelectTrigger id="pipecatFlow" className="h-8 w-full min-w-0"><SelectValue /></SelectTrigger>
                <SelectContent>{PIPECAT_FLOWS.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{PIPECAT_FLOWS.find((f) => f.id === pipecatChoice.flow)?.note}</p>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <Label htmlFor="pipecatMover" className="text-xs font-normal">Steps moved by</Label>
              <Select value={pipecatChoice.mover} onValueChange={(v) => setPipecatChoice((c) => ({ ...c, mover: v as PipecatChoice["mover"] }))}>
                <SelectTrigger id="pipecatMover" className="h-8 w-full min-w-0"><SelectValue /></SelectTrigger>
                <SelectContent>{PIPECAT_MOVERS.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{PIPECAT_MOVERS.find((m) => m.id === pipecatChoice.mover)?.note}</p>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <Label htmlFor="pipecatSpeaker" className="text-xs font-normal">Speaker</Label>
              <Select value={pipecatChoice.speaker} onValueChange={(v) => setPipecatChoice((c) => ({ ...c, speaker: v as PipecatChoice["speaker"] }))}>
                <SelectTrigger id="pipecatSpeaker" className="h-8 w-full min-w-0"><SelectValue>{pipecatSpeakerLabel(pipecatChoice)}</SelectValue></SelectTrigger>
                <SelectContent>{PIPECAT_SPEAKERS.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{pipecatChoice.speaker === "gpt_live" && pipecatChoice.mover === "speaking_model" ? "gpt-live-1 has no tools, so GPT-5.6 Luna makes the step moves behind it." : PIPECAT_SPEAKERS.find((s) => s.id === pipecatChoice.speaker)?.note}</p>
            </div>
            <p id="pipecatTarget" role="status" className={cn("text-[11px]", pipecatLead ? "text-muted-foreground" : "text-destructive")}>
              {pipecatLead
                ? `Lead ${pipecatLead.label.split(" (")[0]}, ${pipecatDirection}${pipecatChoice.flow === "full_tree" && target.direction === "outbound" ? " (the full tree runs inbound only for now)" : ""}: set in the call bar, as for every engine.${pipecatLead.writes ? "" : " Check-only on the engine: the call runs, nothing is written to this lead."}`
                : `${target.leadLabel ? `${target.leadLabel.split(" (")[0]} is a harness-only demo lead` : "No lead is set"}: pick a fictional example lead in the call bar's menu for the Pipecat engine.`}
            </p>
          </Step>
        )}

        {step === 1 && orchestratorId && !pipecatChosen && (
          <Step n={2} title="Voice">
            {orchestrator
              ? <VoiceSteps state={state} options={options} loadError={loadError} routedModel={routed?.config.model ?? ""} routedVoice={routed?.config.voice ?? ""}
                  modelWarning={routed?.modelAllowed === false ? (routed.modelNotAllowedReason || "The server does not allow this model for calls.") : undefined}
                  post={post} reload={reload} refresh={refresh} />
              : loadError
                ? <div className="grid gap-1 text-xs text-destructive" role="status">
                    <p>Voice options could not be loaded: {loadError}</p>
                    <Button variant="outline" size="sm" className="h-7 w-fit" onClick={() => void reload()}>Try again</Button>
                  </div>
                : <p className="text-xs text-muted-foreground">Loading what this orchestrator offers…</p>}
            {/* Azure Voice Live only: the five-step flow shared with the Pipecat engine, or one prompt (src/server/voice/manager.ts, POST /api/voice/voice-live-flow). */}
            {orchestrator && path?.id === "azure_voice_live" && (
              <Field id="setupVoiceLiveFlow" label="Flow" value={voiceLiveFlow}
                options={VOICE_LIVE_FLOWS}
                note={VOICE_LIVE_FLOWS.find((o) => o.value === voiceLiveFlow)?.description}
                onChange={(v) => post("/api/voice/voice-live-flow", { flow: v })} />
            )}
          </Step>
        )}

        {step === 2 && orchestratorId && (pipecatChosen || path) && (
          <Step n={3} title="Agent">
            {/* The prompt and the lead context (the lab voice agent from an internal design brief, src/setups/agent-settings.ts). */}
            <AgentSettings />
            {/* The standing rules the agent gets, editable, and the lead block the call appends (src/setups/agent-context.ts). */}
            <AgentContextEditor />
          </Step>
        )}

        {step === 1 && orchestratorId && !pipecatChosen && path && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" id="setupAdvanced" className="group h-6 w-fit gap-1 px-1 text-[11px] text-muted-foreground">
                <ChevronDownIcon className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />More
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 grid gap-2">
              <Field id="setupTransferRing" label="Transfer to a person rings" value={state.transferRing}
                options={[
                  { value: "both", name: "Pat Lee and Dana Reyes", description: "Both cells ring at once; the first to press 1 takes the call." },
                  { value: "pat", name: "Pat Lee", description: "Only Pat Lee's phone rings." },
                  { value: "dana", name: "Dana Reyes", description: "Only Dana Reyes's phone rings." },
                ]}
                onChange={(v) => post("/api/voice/transfer-ring", { ring: v })} />
              <Field id="stackStaleDrop" label="After a barge-in" value={state.selectedStaleOutputDropId}
                options={choices("staleDrop", state.staleOutputDrops, state.selectedStaleOutputDropId)}
                onChange={(v) => post("/api/voice/stale-output-drop", { staleOutputDropId: v })} />
              <Field id="stackDecisionModule" label="Decision module" value={chosenModule?.id} options={moduleOptions}
                note={moduleOptions.find((o) => o.value === chosenModule?.id)?.description}
                onChange={(v) => act(async () => {
                  try { await refresh(await api("/api/decision-module/select", { decisionModuleId: v, source: SETUP_SOURCE })); }
                  catch (err) { await refresh(await api("/api/state")); throw err; } // a refused choice leaves the old module selected
                })} />
            </CollapsibleContent>
          </Collapsible>
        )}

        </div>

        <DialogFooter className="shrink-0 items-center gap-2 border-t px-4 py-3 sm:justify-between">
          <div className="min-w-0 flex-1" aria-live="polite">
            {warming && (
              <p id="callWarming" role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2Icon className="size-3.5 shrink-0 animate-spin" />Warming up the voice path, Azure, the lead and the decision model…
              </p>
            )}
            {!warming && warm && <WarmupLine result={warm} />}
            {!warming && !warm && warmError && <p id="callWarmup" role="status" className="truncate text-[11px] text-destructive" title={warmError}>Warm-up failed: {warmError}</p>}
          </div>
          <div className="flex shrink-0 gap-1.5">
            {step > 0
              ? <Button variant="ghost" size="sm" id="setupBack" onClick={() => setStep(step - 1)} disabled={warming}>Back</Button>
              : <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={warming}>Cancel</Button>}
            {step < 2 && <Button variant="outline" size="sm" id="setupNext" onClick={() => setStep(step + 1)} disabled={warming || (step === 0 ? !orchestratorId : !voiceDone)}>Next</Button>}
            <Button id="callGo" size="sm" onClick={() => void (pipecatChosen ? goPipecat() : go())} disabled={!ready} aria-busy={warming}>
              {warming ? <><Loader2Icon className="animate-spin" />{pipecatChosen ? "Connecting…" : "Warming up…"}</> : "Go"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
