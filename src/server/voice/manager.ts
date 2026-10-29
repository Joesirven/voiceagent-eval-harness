/**
 * The one place that starts live voice sessions. One session at a time, each
 * capped at five minutes (Azure bills CRM), duration logged on the way
 * out. A session needs a call the harness already cleared and connected.
 */

import { isClearedInteractiveCall } from "../../decision/interactive-call.js";
import { getHarnessConfig } from "../../config.js";
import { knownValue, type CallOpening } from "../../compliance/disclosures.js";
import { WebSocket } from "ws";
import { AzureStartError, type AzureLiveSession, type LiveSocket, type LiveSocketFactory, type StaleOutputCapGaps } from "../../modules/azure-live-session.js";
import { AzureGptLiveModule } from "../../modules/azure-gpt-live.js";
import type { HarnessLiveSession } from "../../modules/open-live-session.js";
import { getModuleRegistry } from "../../modules/registry.js";
import { buildAgentSystemInstruction } from "../../modules/agent-instructions.js";
import { formatLeadContextBlock } from "../../modules/prompt-setup.js";
import { buildVoiceLiveFlow, loadFiveStepsFlow } from "../../modules/voice-live-flow.js";
import type { LeadContextPacket } from "../../memory/context.js";
import { emitTrace, runWithTrace, traceBus, type TraceContext } from "../../trace/index.js";
import { createContextUpdater } from "../../lead-context/index.js";
import { getActiveLeadStore } from "../../store/active-store.js";
import { loadAzureLiveCredentials, type AzureLiveCredentials } from "./azure-credentials.js";
import { liveModelIds, loadAzureCatalog } from "../../modules/azure-catalog.js";
import { chosenPathModel, resetPathModelChoices } from "./path-model-choices.js";
import { PipecatOrchestratedLiveSession, type VoiceSessionMode } from "./pipecat-orchestrated-session.js";
import { PipecatVoiceRuntime } from "./pipecat-voice-runtime.js";
import { DEEPGRAM_MODE, DeepgramLiveSession } from "./deepgram-voice-session.js";
import { deepgramUnavailableReason, type DeepgramVoiceRuntime } from "./deepgram-voice-runtime.js";
import { reportVoiceError, type VoiceErrorPath, type VoiceErrorRecord } from "./voice-errors.js";
import { createLiveThinkerForCall, liveThinkerStatus, thinkerSpeakerNote, TOOLS_NOT_OFFERED, type LiveThinker } from "./live-thinker.js";
import {
  AzureVoiceLiveSession,
  BREVITY_NOTE,
  CALL_DONE_WHEN,
  SELF_RUN_NOTE,
  VOICE_LIVE_MODEL,
  VOICE_LIVE_BREVITY_NOTE,
  VOICE_LIVE_SELF_RUN_NOTE,
  VOICE_LIVE_TOOLS_NOTE,
  VOICE_LIVE_TOOLS_RULES,
  VOICE_LIVE_TRANSCRIPTION,
  VOICE_LIVE_TRANSCRIPTIONS,
  VOICE_LIVE_VOICE,
  VoiceLiveStartError,
  voiceLiveModelKind,
  type VoiceLiveFlowController,
  type VoiceLiveSessionMode,
} from "../../modules/azure-voice-live-session.js";
import { loadAzureVoiceLiveCredentials, voiceLiveSocketUrl, voiceLiveUnavailableReason, type AzureVoiceLiveCredentials } from "./azure-voice-live-credentials.js";
import { createFlowToolRunnerForCall, type FlowToolRunner } from "./flow-tool-runner.js";

export const SESSION_CAP_MS = 5 * 60 * 1000;

/** Who owns the live Talk transport. Affects future sessions only. */
export type TalkOrchestratorId = "direct" | "pipecat";

export interface TalkOrchestratorInfo {
  id: TalkOrchestratorId;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

/** Null means use the boot default on first read (direct Azure; Pipecat is opt-in). */
let talkOrchestrator: TalkOrchestratorId | null = null;

/** Pipecat is the boot default when its pinned interpreter is configured ; otherwise direct Azure. */
function defaultTalkOrchestrator(): TalkOrchestratorId {
  return PipecatVoiceRuntime.available() ? "pipecat" : "direct";
}

export function listTalkOrchestrators(): TalkOrchestratorInfo[] {
  const pipecatReady = PipecatVoiceRuntime.available();
  return [
    {
      id: "direct",
      label: "Direct Azure (own infrastructure)",
      available: true,
    },
    {
      id: "pipecat",
      label: "Pipecat → Azure gpt-live",
      available: pipecatReady,
      ...(pipecatReady ? {} : { unavailableReason: "pipecat_interpreter_not_configured" }),
    },
  ];
}

export function selectedTalkOrchestrator(): TalkOrchestratorId {
  if (talkOrchestrator === null) talkOrchestrator = defaultTalkOrchestrator();
  return talkOrchestrator;
}

/** Ends the open Talk websocket session and frees the single-session slot. */
export function closeActiveVoiceSession(reason = "session_replaced"): void {
  const slot = current;
  if (!slot) return;
  current = undefined;
  try {
    slot.session.stop(reason);
  } catch {
    /* stop is best-effort when replacing orchestration or hanging up play */
  }
}

/** Switching orchestrator ends any live Azure websocket before the next Talk start. */
export function selectTalkOrchestrator(id: TalkOrchestratorId): void {
  if (id !== "direct" && id !== "pipecat") {
    reportVoiceError("unknown_orchestrator");
    throw new Error("unknown_orchestrator");
  }
  closeActiveVoiceSession("orchestrator_switch");
  talkOrchestrator = id;
  // The Deepgram path runs through the Pipecat helper: Direct Azure goes back to the Azure gpt-live path.
  if (id === "direct" && voicePath === "deepgram") voicePath = DEFAULT_VOICE_PATH;
  // Azure Voice Live is reached directly: Pipecat goes back to the Azure gpt-live path too.
  if (id === "pipecat" && voicePath === "azure_voice_live") voicePath = DEFAULT_VOICE_PATH;
}

/** Which speech path a Talk session uses. Affects future sessions only. */
export type VoicePathId = "azure_gpt_live" | "azure_voice_live" | "deepgram";

const VOICE_PATH_IDS: readonly VoicePathId[] = ["azure_gpt_live", "azure_voice_live", "deepgram"];

export interface VoicePathInfo {
  id: VoicePathId;
  label: string;
  available: boolean;
  unavailableReason?: string;
}

/** Azure gpt-live is the default ; Deepgram is opt-in from the Call tab. */
const DEFAULT_VOICE_PATH: VoicePathId = "azure_gpt_live";
let voicePath: VoicePathId = DEFAULT_VOICE_PATH;

/** Why Azure Voice Live cannot run now (its settings), as a fixed code; tests that inject credentials make it available. */
function voiceLiveReason(): string | undefined {
  return deps.voiceLiveCredentials ? undefined : voiceLiveUnavailableReason();
}

export function listVoicePaths(): VoicePathInfo[] {
  const deepgramReason = deps.deepgramRuntime ? undefined : deepgramUnavailableReason();
  const voiceLiveUnavailable = voiceLiveReason();
  return [
    { id: "azure_gpt_live", label: "Azure gpt-live (default)", available: true },
    {
      id: "azure_voice_live",
      label: "Azure Voice Live (hosted speech agent: Azure turn detection and speech, tools on the speaking model)",
      available: !voiceLiveUnavailable,
      ...(voiceLiveUnavailable ? { unavailableReason: voiceLiveUnavailable } : {}),
    },
    {
      id: "deepgram",
      label: "Deepgram (nova-3 speech to text, Azure reply, Aura-2 speech)",
      available: !deepgramReason,
      ...(deepgramReason ? { unavailableReason: deepgramReason } : {}),
    },
  ];
}

export function selectedVoicePath(): VoicePathId {
  return voicePath;
}

/** Switching path ends any open Talk session before the next start. */
export function selectVoicePath(id: VoicePathId): void {
  if (typeof id !== "string" || !VOICE_PATH_IDS.includes(id)) {
    reportVoiceError("unknown_voice_path");
    throw new Error("unknown_voice_path");
  }
  if (id === "azure_voice_live") {
    // Missing or unreadable settings make the path unavailable; they never stop the server or block other calls.
    const reason = voiceLiveReason();
    if (reason) {
      reportVoiceError(reason, { path: "azure_voice_live" });
      throw new Error(reason);
    }
    if (selectedTalkOrchestrator() === "pipecat") {
      reportVoiceError("azure_voice_live_needs_direct", { path: "azure_voice_live" });
      throw new Error("azure_voice_live_needs_direct");
    }
  }
  if (id === "deepgram" && !deps.deepgramRuntime) {
    const reason = deepgramUnavailableReason();
    if (reason) {
      reportVoiceError(reason, { path: "deepgram" });
      throw new Error(reason);
    }
  }
  if (id === "deepgram" && selectedTalkOrchestrator() === "direct") {
    reportVoiceError("deepgram_needs_pipecat", { path: "deepgram" });
    throw new Error("deepgram_needs_pipecat");
  }
  if (id === voicePath) return;
  closeActiveVoiceSession("voice_path_switch");
  voicePath = id;
}

export function resetVoicePath(): void {
  voicePath = DEFAULT_VOICE_PATH;
}

/**
 * Whether the decision tree runs before each reply (one decision step and one steer per caller line) on the two Azure
 * paths, gpt-live-1 and Azure Voice Live. Off by default : each model answers every caller turn
 * itself from its prompt and the lead context; the call setup dialog's switch turns it back on for a comparison.
 * Applies to the next session. The Deepgram path always runs it.
 */
let azureDecisionTree = false;

export function decisionTreeOn(): boolean {
  return azureDecisionTree;
}

export function setDecisionTree(on: boolean): void {
  azureDecisionTree = on === true;
}

/** The earlier names, from when the switch was Voice Live's only (the rating board and POST /api/voice/voice-live-decision-tree). */
export const voiceLiveDecisionTreeOn = decisionTreeOn;
export const setVoiceLiveDecisionTree = setDecisionTree;

/** Whether a call on the selected voice path asks the decision model before each reply (the call warm-up reads it). */
export function decisionStepUsed(): boolean {
  return voicePath === "deepgram" || azureDecisionTree;
}

/**
 * How Azure Voice Live runs the conversation: step by step, from
 * the five-step flow shared with the Pipecat engine (src/modules/voice-live-flow.ts), the default; or one prompt for
 * the whole call. With the decision tree switched on, the tree wins and the call runs one prompt.
 */
export type VoiceLiveFlowId = "step_by_step" | "one_prompt";
let voiceLiveFlow: VoiceLiveFlowId = "step_by_step";

export function voiceLiveFlowChoice(): VoiceLiveFlowId {
  return voiceLiveFlow;
}

export function setVoiceLiveFlow(flow: VoiceLiveFlowId): void {
  voiceLiveFlow = flow;
}

/** How long model output is dropped after a barge-in (Call tab setting; applies to the next Talk session). */
export type StaleOutputDropId = "off" | "one_gap" | "two_gaps";
const STALE_OUTPUT_DROP_GAPS: Record<StaleOutputDropId, StaleOutputCapGaps> = { off: 0, one_gap: 1, two_gaps: 2 };
const DEFAULT_STALE_OUTPUT_DROP: StaleOutputDropId = "one_gap";
let staleOutputDrop: StaleOutputDropId = DEFAULT_STALE_OUTPUT_DROP;

export function listStaleOutputDrops(turnGapMs = deps.turnGapMs ?? 900): Array<{ id: StaleOutputDropId; label: string; gaps: number; maxMs: number }> {
  const seconds = (gaps: number) => ((turnGapMs * gaps) / 1000).toFixed(1);
  return [
    { id: "off", label: "Off: never drop output after a barge-in", gaps: 0, maxMs: 0 },
    { id: "one_gap", label: `One gap: up to ${seconds(1)} seconds`, gaps: 1, maxMs: turnGapMs },
    { id: "two_gaps", label: `Two gaps: up to ${seconds(2)} seconds`, gaps: 2, maxMs: turnGapMs * 2 },
  ];
}

export function selectedStaleOutputDrop(): StaleOutputDropId {
  return staleOutputDrop;
}

export function selectStaleOutputDrop(id: StaleOutputDropId): void {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(STALE_OUTPUT_DROP_GAPS, id)) {
    reportVoiceError("unknown_stale_output_drop");
    throw new Error("unknown_stale_output_drop");
  }
  staleOutputDrop = id;
}

export function resetStaleOutputDrop(): void {
  staleOutputDrop = DEFAULT_STALE_OUTPUT_DROP;
}

export function resetTalkOrchestrator(): void {
  talkOrchestrator = null;
}

/** A fixed code for the status Azure answered the websocket handshake with. */
export function azureHandshakeCode(status: number | undefined): string {
  if (status === 401 || status === 403) return "azure_auth_failed";
  if (status === 404) return "azure_deployment_not_found";
  if (status === 429) return "azure_rate_limited";
  return "azure_connect_failed";
}

/** A fixed code for the status Azure Voice Live answered the websocket handshake with. Never an Azure-block code. */
export function voiceLiveHandshakeCode(status: number | undefined): string {
  if (status === 401 || status === 403) return "azure_voice_live_auth_failed";
  if (status === 429) return "azure_voice_live_rate_limited";
  if (status === 400) return "azure_voice_live_session_rejected";
  return "azure_voice_live_connect_failed";
}

/** The real secure websocket to Azure. Failure surfaces as a fixed code, read from the handshake status when Azure answered. */
export const realSocketFactory: LiveSocketFactory = (url, apiKey) => openSecureSocket(url, apiKey, azureHandshakeCode, "azure_connect_failed");

/** The real secure websocket to Azure Voice Live, with its own fixed codes. */
export const realVoiceLiveSocketFactory: LiveSocketFactory = (url, apiKey) => openSecureSocket(url, apiKey, voiceLiveHandshakeCode, "azure_voice_live_connect_failed");

function openSecureSocket(url: string, apiKey: string, handshakeCode: (status: number | undefined) => string, connectFailed: string): Promise<LiveSocket> {
  return new Promise<LiveSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { "api-key": apiKey }, maxPayload: 16 * 1024 * 1024 });
    const messageCbs: Array<(raw: string) => void> = [];
    const closeCbs: Array<() => void> = [];
    ws.on("message", (data) => messageCbs.forEach((cb) => cb(data.toString())));
    ws.on("close", () => closeCbs.forEach((cb) => cb()));
    ws.once("open", () =>
      resolve({
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onMessage: (cb) => void messageCbs.push(cb),
        onClose: (cb) => void closeCbs.push(cb),
      }),
    );
    // Azure answered the handshake with an HTTP status instead of upgrading: keep only the code for it.
    ws.once("unexpected-response", (req, res) => {
      const code = handshakeCode(res.statusCode);
      res.resume();
      req.destroy();
      reject(new Error(code));
    });
    // The error object can echo the request; keep only a fixed code.
    ws.once("error", () => reject(new Error(connectFailed)));
  });
}

export interface VoiceDeps {
  socketFactory: LiveSocketFactory;
  credentials: () => AzureLiveCredentials;
  maxMs: number;
  turnGapMs?: number;
  log: (line: string) => void;
  /** Tests give the Deepgram session a runtime bound to a fake sidecar. */
  deepgramRuntime?: () => DeepgramVoiceRuntime;
  /** Tests give the Pipecat session a fake helper process. */
  pipecatRuntime?: () => PipecatVoiceRuntime;
  /** Quiet time before the one retry of a failed start; defaults to 400 milliseconds. */
  retryDelayMs?: number;
  /** The Azure Voice Live websocket; tests give a fake. */
  voiceLiveSocketFactory: LiveSocketFactory;
  /** Tests give fake Voice Live credentials (and so make the path available); absent means the settings file. */
  voiceLiveCredentials?: () => AzureVoiceLiveCredentials;
}

const defaults = (): VoiceDeps => ({
  socketFactory: realSocketFactory,
  voiceLiveSocketFactory: realVoiceLiveSocketFactory,
  credentials: () => loadAzureLiveCredentials(),
  maxMs: SESSION_CAP_MS,
  log: (line) => console.log(line),
});

let deps = defaults();
let current: { session: HarnessLiveSession; callId: string } | undefined;

/** Tests swap the socket, credentials, cap and log. */
export function setVoiceDeps(patch: Partial<VoiceDeps>): void {
  deps = { ...deps, ...patch };
}

export function resetVoiceDeps(): void {
  deps = defaults();
  azureDecisionTree = false;
  voiceLiveFlow = "step_by_step";
  resetVoicePath();
  resetPathModelChoices();
  current = undefined;
}

export function activeVoiceCallId(): string | undefined {
  return current?.callId;
}

export interface OpenVoiceParams {
  call: { callId: string; status?: string };
  /** Microphone audio through Pipecat when configured; typed lines are a text stand-in, not live audio. */
  input: "audio" | "text";
  trace: TraceContext;
  leadFirstName: string;
  direction: "inbound" | "outbound";
  disclosure: string;
  packet: LeadContextPacket;
  /** The opening the harness fixed for the call, so the agent's instructions show the same words (known-lead section included). */
  opening?: CallOpening;
  setupId?: string;
  /** Quiet time that ends a spoken line; defaults to 900 milliseconds. */
  turnGapMs?: number;
  /** Aborted when the browser leaves; stops the session even while it is still starting. */
  signal?: AbortSignal;
  guardAgentLine?: (line: string) => string | null | Promise<string | null>;
  dialogOwnsTranscript: boolean;
  onCallerFinal?: (text: string) => Promise<string | undefined>;
  /** Replaces the built-in stage and quote checklist updater (tests, or a caller with its own source). */
  contextUpdate?: () => Promise<string | undefined>;
  onAudio: (base64: string) => void;
  onClearPlayback: () => void;
  /** The code and the voice error record already emitted for it. */
  onProviderError?: (code: string, record: VoiceErrorRecord) => void;
  onEnd?: (summary: { durationMs: number; reason: string }) => void;
}

export { leadContextBlock } from "../../modules/agent-instructions.js";

export function resolveVoiceSessionMode(input: "audio" | "text"): VoiceSessionMode | typeof DEEPGRAM_MODE | VoiceLiveSessionMode {
  if (voicePath === "azure_voice_live") {
    const reason = voiceLiveReason();
    if (reason) throw new Error(reason);
    // GET /api/voice/options lists Azure Voice Live under Direct only; the server agrees.
    if (selectedTalkOrchestrator() !== "direct") throw new Error("azure_voice_live_needs_direct");
    return input === "text" ? "azure_voice_live_text" : "azure_voice_live_microphone";
  }
  if (voicePath === "deepgram") {
    const reason = deps.deepgramRuntime ? undefined : deepgramUnavailableReason();
    if (reason) throw new Error(reason);
    // GET /api/voice/options lists Deepgram under Pipecat only; the server agrees.
    if (selectedTalkOrchestrator() === "direct") throw new Error("deepgram_needs_pipecat");
    return DEEPGRAM_MODE;
  }
  if (selectedTalkOrchestrator() === "direct") {
    return input === "text" ? "direct_azure_text" : "direct_azure_microphone";
  }
  if (!PipecatVoiceRuntime.available()) throw new Error("pipecat_interpreter_not_configured");
  if (input === "text") return "pipecat_text_stand_in";
  return "pipecat_microphone";
}

/** The voice error record for a start that failed; its message is still the fixed code the session threw. */
export class VoiceStartError extends Error {
  constructor(message: string, readonly record: VoiceErrorRecord) {
    super(message);
    this.name = "VoiceStartError";
  }
}

const CODE_SHAPE = /^[a-z][a-z0-9_:]{0,60}$/;
const codeOf = (err: unknown): string => (err instanceof Error && CODE_SHAPE.test(err.message) ? err.message : "voice_start_failed");

/** Start failures that can be a passing moment: a fresh session is tried once. Never an Azure refusal or a settings problem. */
export const RETRYABLE_START_CODES: ReadonlySet<string> = new Set([
  "azure_connect_failed",
  "azure_start_timeout",
  "azure_closed_before_start",
  "pipecat_failed",
  "pipecat_closed",
  "deepgram_failed",
  "deepgram_start_timeout",
  "deepgram_closed",
  "protocol_error",
  "azure_voice_live_connect_failed",
  "azure_voice_live_start_timeout",
  "azure_voice_live_closed_before_start",
]);

/** Which path a start belongs to, for the error record. Never throws. */
export function voiceErrorPathFor(input: "audio" | "text"): VoiceErrorPath {
  if (voicePath === "deepgram") return "deepgram";
  if (voicePath === "azure_voice_live") return "azure_voice_live";
  return selectedTalkOrchestrator() === "pipecat" && input === "audio" ? "pipecat" : "azure_gpt_live";
}

/** The model a voice session on this path uses, for log lines and error records. */
function sessionModel(path: VoiceErrorPath): string {
  if (path === "deepgram") return "deepgram";
  if (path === "azure_voice_live") return voiceLiveChoice().model;
  try {
    return getModuleRegistry().get("azure-gpt-live").getConfig().model;
  } catch {
    return "unknown";
  }
}

/** One server log line per voice error: code, path, model and Azure's own type and code. Never a key or a host. */
function logVoiceError(record: VoiceErrorRecord, model: string, azure?: string, retrying = false): void {
  deps.log(`voice error call=${record.callId ?? "none"} code=${record.code} path=${record.path} model=${model} azure=${azure ?? "none"}${retrying ? " retrying=yes" : ""}`);
}

/** The extra a record needs for its code: the refused model and the allowed list for azure_model_not_deployed. */
function refusalFor(code: string, path: VoiceErrorPath): { refusedModel?: { model: string; allowed: string[] } } {
  return code === "azure_model_not_deployed" ? { refusedModel: { model: sessionModel(path), allowed: liveModelIds() } } : {};
}

const azureDetailOf = (err: unknown): string | undefined =>
  err instanceof AzureStartError ? err.azureDetail : err instanceof VoiceLiveStartError ? err.providerDetail : undefined;

/** The words the caller transcription should expect on these calls, plus the lead's business name and carriers. */
/** Tools Voice Live does not offer its model: the list gpt-live-1's thinker shares (TOOLS_NOT_OFFERED in live-thinker.ts). */
export const VOICE_LIVE_EXCLUDED_TOOLS: readonly string[] = TOOLS_NOT_OFFERED;

/** The call's vocabulary as a phrase list for azure-speech and mai-transcribe-2 (text models), plus the lead's names. */
export function voiceLiveTranscriptionPhrases(business?: string, carriers: string[] = [], firstName?: string): string[] {
  const fixed = [
    "workers' compensation", "general liability", "payroll", "full-time", "part-time", "in the field", "renewal", "premium",
    "carrier", "Hartford", "Travelers", "State Fund", "Example Mutual", "Liberty Mutual", "AmTrust", "Employers", "Next Insurance", "Dana",
  ];
  const names = [business, firstName, ...carriers].filter((n): n is string => typeof n === "string" && n.trim().length > 0 && n.length <= 80);
  return [...new Set([...fixed, ...names])];
}

/**
 * Follows the objectives judge's rows for one call (objective_check, src/judging/objectives.ts) and calls `note`
 * with one line whenever the set of done objectives changes: what is done and what is next. Returns the unsubscribe.
 */
export function followObjectives(
  callId: string,
  note: (text: string) => void,
  allDone = "say the one next step and a short goodbye, then call end_call.",
): () => void {
  let lastDone = "";
  return traceBus.subscribe((e) => {
    if (e.callId !== callId || e.type !== "tool_call" || e.data.tool !== "objective_check") return;
    const rows = (e.data.inputs as { objectives?: Array<{ label?: unknown; status?: unknown }> } | null | undefined)?.objectives;
    if (!Array.isArray(rows)) return;
    const done = rows.filter((r) => r.status === "done" && typeof r.label === "string").map((r) => r.label as string);
    const key = done.join("|");
    if (!done.length || key === lastDone) return;
    lastDone = key;
    const next = rows.find((r) => r.status !== "done" && typeof r.label === "string")?.label as string | undefined;
    note(`Call objectives update (information for you, not lines to say): done: ${done.join("; ")}.${next ? ` Next: ${next}.` : ` All done: ${allDone}`}`);
  });
}

export function voiceLiveTranscriptionPrompt(business?: string, carriers: string[] = []): string {
  const names = [business, ...carriers].filter((n): n is string => typeof n === "string" && n.trim().length > 0 && n.length <= 80);
  return [
    "A phone call about workers' compensation insurance: renewal, employees, full-time, part-time, payroll, in the field, general liability, premium, carrier.",
    "Carriers: Hartford, Travelers, State Fund, Example Mutual, Liberty Mutual, AmTrust, Employers, Next.",
    ...(names.length ? [`Names: ${names.join(", ")}.`] : []),
  ].join(" ");
}

/**
 * The model and, for a text model, the caller transcription the next Azure Voice Live session uses: the Settings
 * choice (POST /api/voice/path-models) when it is still on the list, else the defaults.
 */
export function voiceLiveChoice(): { model: string; kind: "speech_to_speech" | "text"; transcription?: string } {
  const chosen = chosenPathModel("azure_voice_live", "speech_to_speech")?.modelId;
  const model = chosen && voiceLiveModelKind(chosen) ? chosen : VOICE_LIVE_MODEL;
  const kind = voiceLiveModelKind(model)!;
  if (kind !== "text") return { model, kind };
  const stt = chosenPathModel("azure_voice_live", "speech_to_text")?.modelId;
  return { model, kind, transcription: stt && (VOICE_LIVE_TRANSCRIPTIONS as readonly string[]).includes(stt) ? stt : VOICE_LIVE_TRANSCRIPTION };
}


export async function openVoiceSession(p: OpenVoiceParams): Promise<HarnessLiveSession & { sessionMode?: VoiceSessionMode | typeof DEEPGRAM_MODE | VoiceLiveSessionMode }> {
  const trace = p.trace.callId === p.call.callId ? p.trace : undefined;
  const path = voiceErrorPathFor(p.input);
  // Refresh the deployment listing when it is old, without waiting: the slot is claimed before any
  // await, and the model check reads the last listing (the dev server lists once at startup).
  void loadAzureCatalog();
  try {
    return await openVoiceSessionOnce(p, trace, path);
  } catch (err) {
    if (err instanceof VoiceStartError) throw err;
    const code = codeOf(err);
    // The caller leaving while the call starts is not a failure.
    if (code === "voice_session_ended") throw err;
    const providerDetail = azureDetailOf(err);
    const record = reportVoiceError(code, { trace, callId: p.call.callId, path, providerDetail, ...refusalFor(code, path) });
    logVoiceError(record, sessionModel(path), providerDetail);
    throw new VoiceStartError(code, record);
  }
}

async function openVoiceSessionOnce(
  p: OpenVoiceParams,
  trace: TraceContext | undefined,
  path: VoiceErrorPath,
): Promise<HarnessLiveSession & { sessionMode?: VoiceSessionMode | typeof DEEPGRAM_MODE | VoiceLiveSessionMode }> {
  if (current) throw new Error("voice_session_already_open");
  // Only a call the harness cleared, and the trace of that same call, before anything else is built.
  if (!isClearedInteractiveCall(p.call) || p.call.status !== "connected" || p.trace.callId !== p.call.callId) throw new Error("call_not_cleared");
  const module = getModuleRegistry().get("azure-gpt-live");
  if (!(module instanceof AzureGptLiveModule)) throw new Error("voice_module_unavailable");
  // The call's own opening (and the harness's agency, when it names every call's agency), so the standing rules carry
  // the known-lead section and the same words the opening says. A test call got the generic inbound section.
  const openingAgency = getHarnessConfig().openingIdentity?.agencyName;
  let instructions = buildAgentSystemInstruction(p.setupId ?? "default", {
    leadFirstName: p.leadFirstName,
    direction: p.direction,
    disclosure: p.disclosure,
    ...(p.opening ? { opening: p.opening } : {}),
    ...(openingAgency ? { agencyName: openingAgency } : {}),
  }, p.packet);
  const sessionMode = resolveVoiceSessionMode(p.input);
  // The decision step before each reply runs on the Deepgram path always, on the Azure paths only with the switch on.
  const onCallerFinal = sessionMode === DEEPGRAM_MODE || azureDecisionTree ? p.onCallerFinal : undefined;
  // Azure Voice Live: the speaking model holds the dispatched flow tools itself. Its note goes into the
  // instructions before they are traced, so the Context panel shows what the model was told.
  const onVoiceLive = sessionMode === "azure_voice_live_text" || sessionMode === "azure_voice_live_microphone";
  // gpt-live-1, direct or inside the Pipecat orchestrator.
  const onGptLive = !onVoiceLive && sessionMode !== DEEPGRAM_MODE;
  // The thinker (VOICE_HARNESS_LIVE_THINKER) rides the direct Azure path only: Azure runs it through the live
  // protocol's delegation, and its tool calls run through the flow tool dispatcher.
  const thinkerStatus = liveThinkerStatus();
  const thinkerOn = Boolean(thinkerStatus.enabled && thinkerStatus.deployment && (sessionMode === "direct_azure_text" || sessionMode === "direct_azure_microphone"));
  // gpt-live-1 gets Voice Live's turn rules (compare the two fairly), and without the decision tree
  // the note that it runs the call itself, over what the prompt says about the decision module. Nothing gpt-live-1
  // calls ends the call: the goodbye does (the session hangs up after a goodbye heard in full), and the thinker, when
  // there is one, records the outcome with end_call.
  const gptLiveNotes = onGptLive
    ? [...(onCallerFinal ? [] : [SELF_RUN_NOTE]), `${BREVITY_NOTE} ${CALL_DONE_WHEN} say one short goodbye${thinkerOn ? " and delegate ending the call with its outcome" : ""}.`]
    : [];
  let thinker: LiveThinker | undefined;
  if (thinkerOn && thinkerStatus.deployment) {
    // The thinker reads the agent's instructions with the same notes, then the tool rules Voice Live's model follows,
    // with Voice Live's tools only and its neutral results. No await here, the slot is claimed below before the first one.
    thinker = createLiveThinkerForCall({
      callId: p.call.callId,
      leadId: p.packet.leadId,
      agencyId: p.packet.agencyId,
      direction: p.direction,
      agentInstructions: [instructions, ...gptLiveNotes].join("\n\n"),
      deployment: thinkerStatus.deployment,
      store: getActiveLeadStore(),
      trace: p.trace,
      // The goodbye has one owner, gpt-live-1: the thinker only records the outcome.
      toolRules: `Tools on this call. ${VOICE_LIVE_TOOLS_RULES} ${CALL_DONE_WHEN} the agent says the goodbye itself: call end_call with the outcome and write no line.`,
      exclude: TOOLS_NOT_OFFERED,
      neutralRefusals: true,
    });
    deps.log(`voice thinker call=${p.call.callId} deployment=${thinkerStatus.deployment} tools=${thinkerStatus.tools.length}`);
  }
  // The speaker's notes go into the instructions before they are traced, so the Context panel shows what it was told.
  if (onGptLive) instructions = [instructions, ...(thinker ? [thinkerSpeakerNote(Boolean(onCallerFinal))] : []), ...gptLiveNotes].join("\n\n");
  /** The direct gpt-live-1 session being started or running (a retry replaces it), for the objectives notes. */
  let gptLiveSession: AzureLiveSession | undefined;
  // Without the decision tree, nothing else tells gpt-live-1 how far the call has got: each time the objectives judge
  // marks another objective done, it gets one note, appended to its instructions and folded into the thinker's
  // delegation (information, not lines to say). Direct only: inside the Pipecat orchestrator the session is not reachable here.
  const gptLiveObjectives = onGptLive && !onCallerFinal && (sessionMode === "direct_azure_text" || sessionMode === "direct_azure_microphone");
  let toolRunner: FlowToolRunner | undefined;
  /** The Voice Live session being started or running (a retry replaces it), for the objectives notes. */
  let voiceLiveSession: AzureVoiceLiveSession | undefined;
  let stopObjectives: (() => void) | undefined;
  /** The step-by-step conversation on Voice Live, when it runs on this call. */
  let flow: VoiceLiveFlowController | undefined;
  if (onVoiceLive) {
    toolRunner = createFlowToolRunnerForCall({
      callId: p.call.callId,
      leadId: p.packet.leadId,
      agencyId: p.packet.agencyId,
      direction: p.direction,
      store: getActiveLeadStore(),
      trace: p.trace,
      stopTraceTool: "voice_live_stop_heard",
      // A refusal goes back as a short neutral result: judge reasons made the model re-disclose and talk about them.
      neutralRefusals: true,
      exclude: VOICE_LIVE_EXCLUDED_TOOLS,
    });
    // The shared five-step flow, read at each call so an edited file applies to the next one. Its start node's role
    // message is the core, so the lab prompt is not sent; the lead context goes with every node. A file that cannot be
    // read leaves the call on one prompt, and the record says so.
    let loaded: ReturnType<typeof loadFiveStepsFlow> | undefined;
    if (!azureDecisionTree && voiceLiveFlow === "step_by_step") {
      try {
        loaded = loadFiveStepsFlow();
      } catch (err) {
        const code = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "voice_live_flow_unreadable";
        deps.log(`voice live call=${p.call.callId} flow=unavailable code=${code}`);
        void runWithTrace(p.trace, async () => emitTrace("tool_call", { tool: "voice_live_flow_unavailable", inputs: {}, result: null, success: false, durationMs: 0, reason: code }));
      }
    }
    if (loaded) {
      const identity = getHarnessConfig().openingIdentity;
      flow = buildVoiceLiveFlow(loaded, {
        opening: p.disclosure,
        firstName: knownValue(p.leadFirstName) ?? "the person you are calling",
        producer: knownValue(identity?.producerFirstName) ?? knownValue(p.packet.briefing?.producerName)?.split(/\s+/)[0] ?? "the producer",
        agency: knownValue(identity?.agencyName) ?? knownValue(p.packet.briefing?.agencyName) ?? "the agency",
        business: knownValue(p.packet.briefing?.business) ?? "their business",
        leadBlock: formatLeadContextBlock(p.packet, { direction: p.direction, ...(openingAgency ? { agencyName: openingAgency } : {}) }),
      }, toolRunner.tools);
      // The Context panel shows what the model was told first; each node's update is traced as it goes out.
      instructions = flow.openingInstructions;
    } else {
      // With the decision tree the guidance decides what to say; without it the model runs the call itself, and the
      // note says so, over what the prompt says about the decision module. Every Voice Live call keeps turns short.
      instructions = `${instructions}\n\n${azureDecisionTree ? VOICE_LIVE_TOOLS_NOTE : VOICE_LIVE_SELF_RUN_NOTE}\n\n${VOICE_LIVE_BREVITY_NOTE}`;
      // With the decision tree off, nothing else tells the model how far the call has got: each time the objectives
      // judge marks another objective done, the model gets one note (information, not lines to say). The steps of the
      // step-by-step conversation do that job there.
      if (!azureDecisionTree) stopObjectives = followObjectives(p.call.callId, (text) => voiceLiveSession?.sendContextNote(text, "objectives"));
    }
    const choice = voiceLiveChoice();
    deps.log(`voice live call=${p.call.callId} model=${choice.model} kind=${choice.kind}${choice.transcription ? ` transcription=${choice.transcription}` : ""} voice=${VOICE_LIVE_VOICE} tools=${toolRunner.tools.length} decision_tree=${azureDecisionTree ? "on" : "off"} flow=${flow ? "step_by_step" : "one_prompt"}`);
  }
  if (gptLiveObjectives) {
    // The thinker, when there is one, ends the call with end_call; gpt-live-1 itself only says the goodbye.
    stopObjectives = followObjectives(
      p.call.callId,
      (text) => gptLiveSession?.sendContextNote(text, "objectives"),
      thinker ? "say the one next step and a short goodbye, and delegate ending the call with its outcome." : "say the one next step and a short goodbye.",
    );
  }
  // The context the agent is given, shown on the control page's Context panel (and stored with the call record).
  void runWithTrace(p.trace, async () => {
    // The session mode says which engine ran the call (the call history reads it): direct, relay, Deepgram or Voice Live.
    // decisionTree says whether the decision tree ran before each reply, on every engine.
    emitTrace("tool_call", {
      tool: "agent_context",
      inputs: { setupId: p.setupId ?? "default", sessionMode, decisionTree: onCallerFinal ? "on" : "off", ...(onVoiceLive ? { voiceLiveFlow: flow ? "step_by_step" : "one_prompt" } : {}) },
      result: { text: instructions },
      success: true,
      durationMs: 0,
    });
  });
  const cfg = module.getConfig();
  // Azure refuses a session start naming a model it has not deployed; say so before opening anything.
  if (sessionMode !== DEEPGRAM_MODE && !onVoiceLive && !liveModelIds().includes(cfg.model)) {
    thinker?.stop();
    stopObjectives?.();
    throw new Error("azure_model_not_deployed");
  }
  let started = false;
  /** An end during the start belongs to a failed attempt; it is passed on only if the start gives up. */
  let pendingEnd: { durationMs: number; reason: string } | undefined;
  // Keeps the agent's stage and quote checklist current for gpt-live-1 and the Deepgram path alike.
  const contextUpdater = createContextUpdater({
    callId: p.call.callId,
    leadId: p.packet.leadId,
    direction: p.direction,
    subscribe: (listener) => traceBus.subscribe(listener),
    getLead: (id) => getActiveLeadStore().getLead(id),
  });
  const contextUpdate = p.contextUpdate ?? (() => contextUpdater.next());

  const makeSession = (): HarnessLiveSession => {
    const onEnd = (summary: { durationMs: number; reason: string }) => {
      deps.log(`voice session ended call=${p.call.callId} mode=${sessionMode} seconds=${(summary.durationMs / 1000).toFixed(1)} reason=${summary.reason}`);
      if (!started) {
        pendingEnd = summary;
        return;
      }
      contextUpdater.stop();
      thinker?.stop();
      toolRunner?.stop();
      stopObjectives?.();
      if (current?.session === slot.session) current = undefined;
      // Azure dropped the connection in the middle of a call (a start that fails is reported by the start itself).
      if (summary.reason === "azure_closed") logVoiceError(reportVoiceError("azure_closed", { trace, callId: p.call.callId, path }), sessionModel(path));
      if (summary.reason === "voice_live_closed") logVoiceError(reportVoiceError("azure_voice_live_closed", { trace, callId: p.call.callId, path }), sessionModel(path));
      p.onEnd?.(summary);
    };
    const onProviderError = (code: string, azureDetail?: string) => {
      const record = reportVoiceError(code, { trace, callId: p.call.callId, path, providerDetail: azureDetail, ...refusalFor(code, path) });
      logVoiceError(record, sessionModel(path), azureDetail);
      p.onProviderError?.(record.code, record);
    };
    const liveOptions = {
      socketFactory: deps.socketFactory,
      credentials: deps.credentials,
      trace: p.trace,
      instructions,
      disclosure: p.disclosure,
      maxMs: deps.maxMs,
      turnGapMs: p.turnGapMs ?? deps.turnGapMs,
      staleOutputCapGaps: STALE_OUTPUT_DROP_GAPS[staleOutputDrop],
      signal: p.signal,
      dialogOwnsTranscript: p.dialogOwnsTranscript,
      guardAgentLine: p.guardAgentLine,
      onCallerFinal,
      orchestrator: sessionMode === "pipecat_microphone" || sessionMode === "pipecat_text_stand_in" ? "pipecat" as const : "direct" as const,
      contextUpdate,
      onAudio: p.onAudio,
      onClearPlayback: p.onClearPlayback,
      onProviderError,
      onEnd,
      thinker,
    };
    if (sessionMode === DEEPGRAM_MODE) {
      // The speech to text model and the Aura-2 voice chosen in Settings (POST /api/voice/path-models); sidecar defaults otherwise.
      const chosenVoice = chosenPathModel("deepgram", "text_to_speech")?.voice;
      const chosenSttModel = chosenPathModel("deepgram", "speech_to_text")?.modelId;
      return new DeepgramLiveSession({
        ...(chosenVoice ? { voice: chosenVoice } : {}),
        ...(chosenSttModel ? { sttModel: chosenSttModel } : {}),
        trace: p.trace,
        instructions,
        disclosure: p.disclosure,
        maxMs: deps.maxMs,
        turnGapMs: liveOptions.turnGapMs,
        staleOutputCapGaps: liveOptions.staleOutputCapGaps,
        signal: p.signal,
        dialogOwnsTranscript: p.dialogOwnsTranscript,
        guardAgentLine: p.guardAgentLine,
        onCallerFinal: p.onCallerFinal,
        contextUpdate,
        onAudio: p.onAudio,
        onClearPlayback: p.onClearPlayback,
        onProviderError,
        onEnd,
        runtime: deps.deepgramRuntime?.(),
      });
    }
    if (onVoiceLive) {
      const runner = toolRunner!;
      voiceLiveSession = new AzureVoiceLiveSession({
          socketFactory: deps.voiceLiveSocketFactory,
          // Read at each start (and the one retry), so a fixed settings file is picked up without a restart.
          credentials: (model) => {
            const creds = (deps.voiceLiveCredentials ?? (() => loadAzureVoiceLiveCredentials()))();
            return { socketUrl: voiceLiveSocketUrl(creds.resourceUrl, model), apiKey: creds.apiKey };
          },
          trace: p.trace,
          // The model chosen in Settings (the rest follows from its kind); one fixed voice.
          model: voiceLiveChoice().model,
          transcriptionModel: voiceLiveChoice().transcription,
          voice: VOICE_LIVE_VOICE,
          instructions,
          disclosure: p.disclosure,
          maxMs: deps.maxMs,
          turnGapMs: liveOptions.turnGapMs,
          staleOutputCapGaps: liveOptions.staleOutputCapGaps,
          signal: p.signal,
          dialogOwnsTranscript: p.dialogOwnsTranscript,
          guardAgentLine: p.guardAgentLine,
          // Without the decision tree, Voice Live answers each turn itself and the session records the caller's lines.
          onCallerFinal,
          autoReply: !azureDecisionTree,
          ...(flow ? { flow } : {}),
          transcriptionPrompt: voiceLiveTranscriptionPrompt(p.packet.briefing?.business, p.packet.briefing?.carriersCurrent),
          transcriptionPhrases: voiceLiveTranscriptionPhrases(p.packet.briefing?.business, p.packet.briefing?.carriersCurrent, p.leadFirstName),
          // The steps carry the call on the step-by-step conversation, as in the Pipecat flow: no stage notes per turn.
          ...(flow ? {} : { contextUpdate }),
          onAudio: p.onAudio,
          onClearPlayback: p.onClearPlayback,
          onProviderError,
          onEnd,
          tools: { definitions: runner.tools, call: (name, args) => runner.call(name, args) },
        });
      return Object.assign(voiceLiveSession, { sessionMode });
    }
    if (sessionMode === "pipecat_microphone") {
      return new PipecatOrchestratedLiveSession(
        sessionMode,
        { ...liveOptions, model: cfg.model, voice: cfg.voice },
        p.onAudio,
        p.onClearPlayback,
        p.call.callId,
        {
          runtimeFactory: deps.pipecatRuntime,
          onRestart: (code) => logVoiceError(reportVoiceError(code, { trace, callId: p.call.callId, path, retrying: true }), sessionModel(path), undefined, true),
        },
      );
    }
    gptLiveSession = module.openLiveSession(p.call, liveOptions);
    return Object.assign(gptLiveSession, { sessionMode });
  };

  // Claim the slot before the first await so two opens can never both pass.
  const slot = { session: makeSession(), callId: p.call.callId };
  current = slot;
  for (let attempt = 1; ; attempt++) {
    try {
      await slot.session.start();
      break;
    } catch (err) {
      const code = codeOf(err);
      if (attempt === 1 && RETRYABLE_START_CODES.has(code) && !p.signal?.aborted && current === slot) {
        // One more try with a fresh session; the person is told what went wrong and that it is retrying.
        logVoiceError(reportVoiceError(code, { trace, callId: p.call.callId, path, retrying: true }), sessionModel(path), azureDetailOf(err), true);
        pendingEnd = undefined;
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 400));
        if (current !== slot || p.signal?.aborted) {
          if (current === slot) current = undefined;
          contextUpdater.stop();
          thinker?.stop();
          toolRunner?.stop();
          stopObjectives?.();
          throw new Error("voice_session_ended");
        }
        slot.session = makeSession();
        continue;
      }
      if (current === slot) current = undefined;
      contextUpdater.stop();
      thinker?.stop();
      toolRunner?.stop();
      stopObjectives?.();
      if (pendingEnd) p.onEnd?.(pendingEnd);
      throw err;
    }
  }
  started = true;
  return slot.session;
}
