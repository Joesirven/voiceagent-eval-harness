/**
 * A call on the local Pipecat engine, through the 4318 server's proxy
 * (/api/pipecat/, src/server/pipecat-proxy.ts): Pipecat's JavaScript client
 * with the SmallWebRTC transport. One call at a time; the state is a small
 * external store the call bar and the dialog read. Brief: an internal design brief,
 * pipecat-engine-for-4318.
 */

import { PipecatClient } from "@pipecat-ai/client-js";
import { useSyncExternalStore } from "react";
import { PipecatTraceFeed } from "@/lib/pipecat-trace";

export const PIPECAT_BASE = "/api/pipecat";

export interface PipecatPreset {
  id: string;
  name: string;
  config: Record<string, string | number>;
}

/**
 * Pipecat Flows (engine 9995b33, brief an internal design brief pipecat-flows-dialog): three choices, eight configurations.
 * Flow: the compiled full tree (inbound only for now) or the five-step quote flow. Steps moved by: the speaking
 * model itself, or the decision model (GPT-5.6 Luna) in the background, never holding the reply. Speaker: the
 * stepped stack (Nova-3, GPT-5.4 mini, Aura) or gpt-live-1.
 */
export const PIPECAT_FLOWS = [
  { id: "full_tree", name: "Full tree", note: "The compiled tree.flow.yaml. Inbound only for now; it can talk but cannot save, book, transfer or start a quote on this engine." },
  { id: "five_steps", name: "Five steps", note: "Saves the numbers, starts the quote, queues a text on fictional leads, and records a producer call time." },
] as const;
export const PIPECAT_MOVERS = [
  { id: "speaking_model", name: "Speaking model", note: "The model that talks also moves between steps." },
  { id: "decision_model", name: "Decision model in the background", note: "Decision model: GPT-5.6 Luna (the tree steering model), in the background; the reply is never held." },
] as const;
export const PIPECAT_SPEAKERS = [
  { id: "stepped", name: "Stepped: Nova-3, GPT-5.4 mini, Aura", note: "Deepgram Nova-3 listens, GPT-5.4 mini replies, Deepgram Aura speaks." },
  { id: "gpt_live", name: "gpt-live-1", note: "One Azure model listens and speaks." },
] as const;
export type PipecatFlowId = (typeof PIPECAT_FLOWS)[number]["id"];
export type PipecatMoverId = (typeof PIPECAT_MOVERS)[number]["id"];
export type PipecatSpeakerId = (typeof PIPECAT_SPEAKERS)[number]["id"];
export interface PipecatChoice { flow: PipecatFlowId; mover: PipecatMoverId; speaker: PipecatSpeakerId }

export const PIPECAT_DEFAULT_CHOICE: PipecatChoice = { flow: "full_tree", mover: "decision_model", speaker: "stepped" };

/** gpt-live-1 has no tools: with the speaking model moving the steps, GPT-5.6 Luna makes the moves behind it. */
export function pipecatSpeakerLabel(c: PipecatChoice): string {
  if (c.speaker === "gpt_live" && c.mover === "speaking_model") return "gpt-live-1, steps moved by GPT-5.6 Luna";
  return PIPECAT_SPEAKERS.find((s) => s.id === c.speaker)?.name ?? c.speaker;
}

export function pipecatPresetId(c: PipecatChoice): string {
  return `pipecat-flows-${c.flow.replace(/_/g, "-")}-${c.mover === "decision_model" ? "decision" : "speaking"}-${c.speaker === "gpt_live" ? "gpt-live-1" : "stepped"}`;
}

/** The engine's body.config keys for one combination, as the brief's table gives them. Full tree runs inbound only. */
export function pipecatPreset(c: PipecatChoice): PipecatPreset {
  const flow: Record<string, string> = c.flow === "full_tree"
    ? { orchestration: "pipecat_flows" }
    : { orchestration: "quote_prototype", flowName: c.mover === "speaking_model" ? "five_steps_speaking" : "five_steps" };
  const speaker: Record<string, string> = c.speaker === "stepped"
    ? { voicePath: "cascaded_deepgram", sttModel: "nova-3-general", replyDeployment: "gpt-5.4-mini", voice: "aura-2-thalia-en" }
    : { voicePath: "gpt_live", replyDeployment: c.mover === "speaking_model" ? "gpt-5.6-luna" : "none", voice: "azure-marin" };
  const flowName = PIPECAT_FLOWS.find((f) => f.id === c.flow)?.name ?? c.flow;
  const mover = c.mover === "decision_model" ? "decision model" : "speaking model";
  const speakerName = c.speaker === "stepped" ? "Nova-3 GPT-5.4 mini Aura" : "gpt-live-1";
  return {
    id: pipecatPresetId(c),
    name: `${flowName}, ${mover}, ${speakerName}`,
    config: { ...flow, stepsMovedBy: c.mover, ...speaker, ...(c.flow === "full_tree" ? { direction: "inbound" } : {}) },
  };
}

/** All eight combinations; the first is the default. */
export const PIPECAT_PRESETS: readonly PipecatPreset[] = [
  pipecatPreset(PIPECAT_DEFAULT_CHOICE),
  ...PIPECAT_FLOWS.flatMap((f) => PIPECAT_MOVERS.flatMap((m) => PIPECAT_SPEAKERS.map((s) => pipecatPreset({ flow: f.id, mover: m.id, speaker: s.id })))).filter((p) => p.id !== pipecatPresetId(PIPECAT_DEFAULT_CHOICE)),
];

export const PIPECAT_LEADS = [
  { id: "00000000-0000-4000-8000-0000000000b1", label: "Maria Lopez (Riverside Plumbing)" },
  { id: "00000000-0000-4000-8000-0000000000b2", label: "Tom Nguyen (Oak Street Electric)" },
] as const;

/** Every call sends all of these; a preset overrides some. */
const QUOTE_FLOW_BASE = {
  voicePath: "gpt_live",
  replyDeployment: "none",
  voice: "azure-marin",
  orchestration: "quote_prototype",
  promptSetup: "default",
  sttModel: "nova-3-general",
  endpointingMs: 300,
  vadStopSecs: 0.2,
};

export function pipecatConfig(preset: PipecatPreset, leadId: string, direction: "inbound" | "outbound"): Record<string, string | number> {
  // A preset that fixes the direction (the full tree, inbound only) keeps it.
  return { ...QUOTE_FLOW_BASE, lead: leadId, direction, ...preset.config };
}

export type PipecatStatus = "idle" | "starting" | "connected" | "ending" | "error";

export interface PipecatCallState {
  status: PipecatStatus;
  presetId: string;
  presetName: string;
  leadId: string;
  direction: "inbound" | "outbound";
  since: number | null;
  error: string | null;
  botSpeaking: boolean;
  lastAgentLine: string | null;
  lastCallerLine: string | null;
  /** The id the console's panels group this call by, and the engine's own id once known. */
  callId: string | null;
  engineCallId: string | null;
}

const IDLE: PipecatCallState = { status: "idle", presetId: PIPECAT_PRESETS[0].id, presetName: PIPECAT_PRESETS[0].name, leadId: PIPECAT_LEADS[0].id, direction: "inbound", since: null, error: null, botSpeaking: false, lastAgentLine: null, lastCallerLine: null, callId: null, engineCallId: null };

let state: PipecatCallState = IDLE;
let client: PipecatClient | null = null;
let feed: PipecatTraceFeed | null = null;
let audio: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<PipecatCallState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePipecatCall(): PipecatCallState {
  return useSyncExternalStore(subscribe, () => state);
}

export interface PipecatHealth { engine: string; commit: string | null }

/** GET /api/health through the proxy; throws when the engine is down. */
export async function pipecatHealth(): Promise<PipecatHealth> {
  const res = await fetch(`${PIPECAT_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json.engine !== "string") throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
  return { engine: json.engine, commit: typeof json.commit === "string" ? json.commit : null };
}

function playTrack(track: MediaStreamTrack): void {
  if (track.kind !== "audio") return;
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("data-slot", "pipecat-audio");
    document.body.appendChild(audio);
  }
  audio.srcObject = new MediaStream([track]);
  void audio.play().catch(() => undefined);
}

/** Starts a call with the preset, lead and direction. Resolves once the bot is ready; rejects with a short reason. */
export async function startPipecatCall(presetId: string, leadId: string, direction: "inbound" | "outbound", leadLabel = leadId): Promise<void> {
  if (client) throw new Error("pipecat_call_already_open");
  const preset = PIPECAT_PRESETS.find((p) => p.id === presetId) ?? PIPECAT_PRESETS[0];
  const config = pipecatConfig(preset, leadId, direction);
  const f = new PipecatTraceFeed({ leadId, leadLabel, direction, presetId: preset.id, presetName: preset.name, config });
  feed = f;
  set({ status: "starting", presetId: preset.id, presetName: preset.name, leadId, direction, since: Date.now(), error: null, botSpeaking: false, lastAgentLine: null, lastCallerLine: null, callId: f.callId, engineCallId: null });
  window.dispatchEvent(new CustomEvent("pipecat-call-started", { detail: { callId: f.callId } }));
  const errorText = (m: unknown): string => {
    const d = (m as { data?: unknown })?.data ?? m;
    if (typeof d === "string") return d;
    const o = d as { message?: unknown; error?: unknown } | undefined;
    return String(o?.message ?? o?.error ?? JSON.stringify(d ?? "engine_error")).slice(0, 400);
  };
  // Loaded on first use: the transport touches browser audio APIs at import time, which a page test environment lacks.
  const { SmallWebRTCTransport } = await import("@pipecat-ai/small-webrtc-transport");
  const transport = new SmallWebRTCTransport();
  const c = new PipecatClient({
    transport,
    enableMic: true,
    enableCam: false,
    callbacks: {
      onTrackStarted: (track) => playTrack(track),
      onBotStartedSpeaking: () => { set({ botSpeaking: true }); f.botStartedSpeaking(); },
      onBotStoppedSpeaking: () => { set({ botSpeaking: false }); f.botStoppedSpeaking(); },
      onBotTranscript: (data) => { const t = String((data as { text?: unknown }).text ?? ""); set({ lastAgentLine: t }); f.botTranscript(t); },
      onUserTranscript: (data) => { const d = data as { text?: unknown; final?: unknown }; const t = String(d.text ?? ""); if (d.final) { set({ lastCallerLine: t }); f.callerFinal(t); } else f.callerPartial(t); },
      onServerMessage: (data) => { f.serverMessage(data); const m = data as { type?: unknown; callId?: unknown }; if (m?.type === "call" && typeof m.callId === "string") set({ engineCallId: m.callId }); },
      onDisconnected: () => { if (state.status !== "idle") finish(null); },
      onError: (message) => { const text = errorText(message); set({ error: text }); f.error("Engine error", text); },
      onMessageError: (message) => { f.error("Engine message refused", errorText(message)); },
    },
  });
  client = c;
  try {
    const started = (await c.startBot({
      endpoint: `${PIPECAT_BASE}/start`,
      requestData: { transport: "webrtc", body: { config: pipecatConfig(preset, leadId, direction), setup: { id: preset.id, name: preset.name } } },
    })) as { sessionId?: unknown };
    if (typeof started?.sessionId !== "string") throw new Error("pipecat_start_without_session");
    await c.connect({ webrtcRequestParams: { endpoint: `${PIPECAT_BASE}/sessions/${started.sessionId}/api/offer` } });
    set({ status: "connected" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finish(reason);
    throw new Error(reason);
  }
}

async function finish(error: string | null): Promise<void> {
  const c = client;
  client = null;
  feed?.end(error ?? "ended");
  feed = null;
  if (audio) { audio.srcObject = null; audio.remove(); audio = null; }
  try { await c?.disconnect(); } catch { /* already gone */ }
  set({ status: error ? "error" : "idle", error, botSpeaking: false, since: error ? state.since : null });
}

export async function endPipecatCall(): Promise<void> {
  if (!client) { set({ status: "idle", error: null, since: null }); return; }
  set({ status: "ending" });
  await finish(null);
}
