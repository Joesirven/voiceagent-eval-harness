/**
 * One call on Azure Voice Live: Azure's hosted speech agent API at
 * /voice-live/realtime on the example-voice-live resource. Written for the
 * Voice Live protocol as observed on the wire on 2026-10-20 (api-version
 * 2026-04-10): `session.update`,
 * `input_audio_buffer.append`, `conversation.item.create`, `response.create`,
 * `response.cancel` and `conversation.item.truncate` go out; `session.created`,
 * `session.updated`, `input_audio_buffer.speech_started`,
 * `conversation.item.input_audio_transcription.completed`, the `response.*`
 * events and `error` come back. All audio is G.711 mu-law at 8 kilohertz in
 * both directions, as base64 text, so nothing is resampled.
 *
 * It carries every obligation of src/modules/azure-live-session.ts: the prompt
 * and lead context at session start, the opening disclosure word for word, one
 * decision step for each finished caller line and its steer, the context
 * updates, the traces (`turn` or `transcript_final` with source
 * `voice_module`, `voice_session_open`, `voice_session_close`, tool calls),
 * barge-in and the stale-output drop setting, the line guard, the five-minute
 * cap, the typed fallback and the reminder. Three choices differ, on purpose:
 *
 * - The harness triggers every reply. Turn detection runs with
 *   `create_response: false` (accepted on semantic_vad, observed), so Voice
 *   Live never answers on its own: the
 *   decision step's steer lands first, then the session sends
 *   `response.create`. Steers and context updates are system message items.
 * - The server owns barge-in. `input_audio_buffer.speech_started` (semantic
 *   turn detection, behind Azure noise suppression and server echo
 *   cancellation) while the agent is audible clears playback, cancels a
 *   response still being made, and truncates the agent's item at the
 *   milliseconds the caller heard, so the record and the model's own memory
 *   both match what was heard. The browser's loudness check is off on this
 *   path (the ready frame says `bargeInOwner: "server"`).
 * - The speaking model holds the flow tools itself (no thinker, no
 *   delegation). Each `function_call` runs through the flow tool dispatcher,
 *   goes back as a `function_call_output` item, then one `response.create`.
 *
 * Voice Live sends a reply's audio about five times faster than it plays, so
 * the session keeps its own playback clock (8 bytes a millisecond) to know
 * when the agent is audible, and records each agent line when its audio has
 * played out (or, after a barge-in, the words heard up to that point).
 */

import { traceBus, type TraceContext } from "../trace/index.js";
import { azureErrorDetail, DEFAULT_STALE_OUTPUT_CAP_GAPS, GOODBYE, GOODBYE_HANG_UP_MS, REMIND_AFTER_MS, SAVE_TOOLS, tracedArgs, type LiveSocket, type LiveSocketFactory, type StaleOutputCapGaps } from "./azure-live-session.js";
import type { HarnessLiveSession } from "./open-live-session.js";

/** Mu-law at 8 kilohertz: one byte per sample, so 8 bytes a millisecond. */
const AUDIO_BYTES_PER_MS = 8;
/** A truncate must stay inside the item's audio (Voice Live refuses one past the end: invalid_audio_end_time). */
const TRUNCATE_MARGIN_MS = 20;
/** Fixed provider codes: identifier tokens only. */
const CODE = /^[a-z][a-z0-9_]{0,60}$/;
/** A caller line waits at most this long for the agent lines heard before it to enter the record. */
const RECORD_WAIT_CAP_MS = 15_000;

/** The session modes of the Azure Voice Live path: microphone audio, or typed lines with no microphone. */
export type VoiceLiveSessionMode = "azure_voice_live_microphone" | "azure_voice_live_text";

/**
 * Appended to the agent's instructions on this path (visible on the Context
 * panel): the speaking model holds the flow tools itself. Nothing here asks it
 * to repeat lines word for word.
 */
/** How the speaking model uses the flow tools, whoever runs the conversation. */
export const VOICE_LIVE_TOOLS_RULES =
  "Call a tool only for a fact the caller has just said, or a step the caller has just agreed to. " +
  "evidence_quote is the caller's own words copied exactly from what they said: no 'Caller said', no quotation marks, nothing you said. " +
  // A test call showed that the head count and the no-other-workers answer were never saved.
  "Every quote answer is saved with write_quote_field, in the same turn as your next question, every time: " +
  "the renewal date is x_date; the current insurer is current_carrier; the yearly payroll is payroll; the head count is employee_count, " +
  "one value such as '2 full-time, 0 part-time, 2 in the field'; owner_only is 'no' as soon as they have any employees (never ask it then); " +
  "general liability coverage is general_liability; the kind of work is business_class; the person who decides is decision_maker_name and " +
  "decision_maker_phone; the language they prefer is contact_language; how the quote reaches them is quote_channel. " +
  "For any dollar amount, read it back first ('About $300,000 a year?') and save it only after the yes. " +
  "Save quote_channel as 'text' the moment the caller says yes to the quote by text; if the answer is not a clear yes or no, answer it in one sentence and ask once more. " +
  // send_text and request_quote can run on both Azure paths.
  "A text goes only through send_text, with one of its templates: offer it aloud first and call send_text only after the caller's spoken yes (quote_follow_up only once quote_channel is saved as 'text'). The quote itself, and any price, comes from the licensed producer after the call. " +
  "Start the quote with request_quote only after the caller asked for a quote or said yes to one, and after their employee count and payroll are saved. " +
  "A better phone number goes to add_callback_number only after you read it back digit by digit and heard yes; a correction to their name, the name they go by, their email or the best time to call goes to save_contact_detail, in their own words. " +
  "When you save a fact (write_quote_field, save_contact_detail, add_callback_number, record_decision_maker, save_message), acknowledge with two or three words ('Got it.') and ask your next question; " +
  "never say 'noted', 'I have noted that' or 'saved', and never mention a tool. " +
  "For a time: call check_appointment_time, read back the exact day, date, time and time zone it gives you, and ask for a yes; call book_producer only after that yes. " +
  "Never call the same tool twice for the same fact. Never say that something is booked or sent until a tool result says so. If a result says it was not done, do not mention it; ask your next question.";

export const VOICE_LIVE_TOOLS_NOTE =
  "Tools on this call. The decision module's guidance still decides what you say; you never take over the conversation. " +
  VOICE_LIVE_TOOLS_RULES;

/**
 * Appended when a call runs without the decision tree : no guidance ever comes, so this replaces
 * what the prompt says about the decision module. gpt-live-1 gets it alone; Voice Live gets it with its tool rules,
 * instead of VOICE_LIVE_TOOLS_NOTE.
 */
export const SELF_RUN_NOTE =
  "How this call runs. No decision module sends you guidance on this call, whatever the instructions above say about one: you run the conversation yourself, from the call's facts and what this call needs from the person.";

export const VOICE_LIVE_SELF_RUN_NOTE =
  `${SELF_RUN_NOTE} ` +
  "Tools on this call. " +
  VOICE_LIVE_TOOLS_RULES;

/**
 * How every turn sounds, on both Azure paths (the agent spoke too much, narrated its steps and
 * corrected the caller). Each path adds its own ending sentence.
 */
export const BREVITY_NOTE =
  "Keep every turn short: at most two short sentences, about 25 words. Ask one question per turn. Never recap everything the caller said. " +
  "Never repeat the AI disclosure after the opening, unless the caller asks whether they are talking to a person or a machine. " +
  // A test call showed that the agent narrated its own steps and never hung up.
  "Never narrate what you are doing or about to do (no \"I'll note that\", \"let me confirm\", \"then we'll\"), and never mention a tool or a save. " +
  "If the caller already answered something, or it follows from what they said, never ask it. " +
  // Same call: the agent corrected the caller ("Actually, my focus is on ...").
  "Never argue with or correct the caller: agree in a few words, add one short clarifying clause at most, and move on.";

/** When the call's goal is done; the end of both paths' brevity notes, apart from who ends the call. */
export const CALL_DONE_WHEN =
  "When the call's goal is done (a producer call is booked, or the quote by text is agreed and nothing else is needed), or the caller says goodbye or asks to stop,";

/** Appended on every Voice Live call (the agent spoke too much). */
export const VOICE_LIVE_BREVITY_NOTE =
  `${BREVITY_NOTE} ${CALL_DONE_WHEN} say one short goodbye and call end_call.`;

/**
 * The configuration of this path, in one place . One choice:
 * the model, from those that passed the whole flow on the example-voice-live
 * resource on 2026-10-20 (the disclosure, a transcribed caller line, no
 * automatic reply, a steer, a tool call and a reply after its result). The rest
 * follows from the model's kind; text models also choose their transcription.
 * `probeFirstAudioMs` is one probe sample from response.create to the first
 * audio of the opening line, for orientation only.
 */
export const VOICE_LIVE_MODELS = [
  { id: "gpt-realtime", kind: "speech_to_speech", probeFirstAudioMs: 675 },
  { id: "gpt-realtime-2.1", kind: "speech_to_speech", probeFirstAudioMs: 657 },
  { id: "gpt-6-luna", kind: "text", probeFirstAudioMs: 1036 },
  { id: "gpt-5.4", kind: "text", probeFirstAudioMs: 1184 },
  { id: "gpt-5.1", kind: "text", probeFirstAudioMs: 621 },
  { id: "gpt-4.1", kind: "text", probeFirstAudioMs: 626 },
] as const satisfies ReadonlyArray<{ id: string; kind: "speech_to_speech" | "text"; probeFirstAudioMs: number }>;
export type VoiceLiveModelKind = (typeof VOICE_LIVE_MODELS)[number]["kind"];
/** The default model, so nothing changes until a model is chosen. */
export const VOICE_LIVE_MODEL = "gpt-realtime";
export const VOICE_LIVE_VOICE = "en-US-Ava:DragonHDLatestNeural";
/** Caller transcription for text models (Azure speech on both ends); speech to speech models use gpt-4o-transcribe. */
export const VOICE_LIVE_TRANSCRIPTIONS = ["azure-speech", "mai-transcribe-2"] as const;
export const VOICE_LIVE_TRANSCRIPTION = "azure-speech";
/** The recognition languages for azure-speech, detected per turn; accepted by Voice Live on 2026-10-21 (mai-transcribe-2 takes one locale at most, so it gets none). */
export const VOICE_LIVE_TRANSCRIPTION_LANGUAGES = "en-US,es-US";
/**
 * Filler speech while a text model thinks or a tool runs (threshold 180 milliseconds; both
 * triggers). The wire names are the ones Microsoft's own kit sends (`@azure/ai-voicelive` 1.1.0,
 * llmInterimResponseConfigSerializer): `interim_response` with type `llm_interim_response`; Voice Live echoed it
 * back on 2026-10-21. After a 29-word generic answer played ahead of the real one, the filler
 * is one friendly line of about ten words on gpt-4.1-mini, Microsoft's documented default (the example: "Yeah,
 * let me check on that for you."), switched on only after the opening has been heard (a second session.update).
 * Realtime speech to speech models do not take it.
 */
export const VOICE_LIVE_INTERIM_RESPONSE = {
  type: "llm_interim_response",
  triggers: ["latency", "tool"],
  latency_threshold_ms: 180,
  model: "gpt-4.1-mini",
  max_completion_tokens: 25,
  instructions:
    "Say one short, friendly line, up to about ten words, that tells the caller you are checking or working on it, for example: 'Yeah, let me check on that for you.' or 'Sure, give me one second.' Never answer the caller's question, never ask anything, never greet, never say who you are or that you are an AI assistant.",
} as const;

/** The session.update that switches the interim response on, for a text model; undefined for a speech to speech model. */
export function voiceLiveInterimSettings(model: string): Record<string, unknown> | undefined {
  if (voiceLiveModelKind(model) !== "text") return undefined;
  return { interim_response: { ...VOICE_LIVE_INTERIM_RESPONSE, triggers: [...VOICE_LIVE_INTERIM_RESPONSE.triggers] } };
}

/** How long a node's first line waits for Voice Live to confirm the node's update (each took 90 to 130 milliseconds on 2026-10-21). */
const NODE_UPDATE_WAIT_MS = 1500;
/** Event and item keys of an assistant message as seen on the wire; anything else is traced once, as wire evidence. */
const KNOWN_ITEM_EVENT_KEYS = new Set(["type", "event_id", "response_id", "output_index", "item"]);
const KNOWN_ITEM_KEYS = new Set(["id", "object", "type", "status", "role", "content"]);

export function voiceLiveModelKind(model: string): VoiceLiveModelKind | undefined {
  return VOICE_LIVE_MODELS.find((m) => m.id === model)?.kind;
}

export type VoiceLiveEndReason =
  | "caller_hangup"
  | "session_cap"
  | "voice_live_closed"
  | "voice_live_error"
  | "start_failed"
  | "start_timeout"
  | "server_stop";

/** A function tool as session.update takes it. */
export interface VoiceLiveFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
}

/** The speaking model's tools and the runner that carries out its calls (the flow tool dispatcher in the harness). */
export interface VoiceLiveTools {
  definitions: VoiceLiveFunctionTool[];
  /** Never throws. */
  call(name: string, args: unknown): Promise<{ output: string; ok: boolean; refusedCode?: string; endCall?: boolean }>;
}

export interface VoiceLiveSessionOptions {
  socketFactory: LiveSocketFactory;
  /** The secure websocket address for the model and the key; throws a fixed code from the voice error catalog. */
  credentials: (model: string) => { socketUrl: string; apiKey: string };
  trace: TraceContext;
  /** A Voice Live model from VOICE_LIVE_MODELS. */
  model: string;
  /** For a text model: the caller transcription (VOICE_LIVE_TRANSCRIPTIONS). Ignored for speech to speech models. */
  transcriptionModel?: string;
  /** An Azure voice name (type azure-standard), for example en-US-Ava:DragonHDLatestNeural. */
  voice: string;
  /** Full system prompt, lead context included. */
  instructions: string;
  /** The agent's first turn, said word for word. */
  disclosure: string;
  maxMs: number;
  /** The Call tab's quiet time that ends a spoken line; here it only sets the stale-output window after a barge-in (turn detection is Voice Live's own). */
  turnGapMs?: number;
  staleOutputCapGaps?: StaleOutputCapGaps;
  /** One deadline for the whole start: the socket, session.created and session.updated together. */
  startTimeoutMs?: number;
  signal?: AbortSignal;
  dialogOwnsTranscript: boolean;
  guardAgentLine?: (line: string) => string | null | Promise<string | null>;
  onCallerFinal?: (text: string) => Promise<string | undefined>;
  contextUpdate?: () => Promise<string | undefined>;
  onAudio: (base64: string) => void;
  onClearPlayback: () => void;
  /** A provider error during the call: a fixed code, and Voice Live's own type and code (identifier tokens only). */
  onProviderError?: (code: string, providerDetail?: string) => void;
  onEnd: (summary: { durationMs: number; reason: string }) => void;
  tools?: VoiceLiveTools;
  /**
   * Voice Live answers each caller turn itself (turn detection with create_response true): no decision step and
   * no steer per caller line . False keeps the decision tree before each reply.
   */
  autoReply?: boolean;
  /** Words the caller transcription should expect (gpt-4o-transcribe's prompt): the call's vocabulary and the business name. */
  transcriptionPrompt?: string;
  /** The same vocabulary as a phrase list, for the transcription of text models (azure-speech and mai-transcribe-2 take one). */
  transcriptionPhrases?: string[];
  /**
   * The step-by-step conversation (src/modules/voice-live-flow.ts, from the five-step flow shared with the Pipecat
   * engine). Absent means one prompt for the whole call (`instructions` and `tools`).
   */
  flow?: VoiceLiveFlowController;
}

/** What the session needs of a step-by-step conversation; the speaking model moves the steps. */
export interface VoiceLiveFlowController {
  start: string;
  /** The flow file and its content hash, for the record. */
  source: { file: string; hash: string };
  /** Until the opening reply is done: the opening line to say (the start node's text says it was already said). */
  openingInstructions: string;
  node(id: string): { label: string; flowStep?: string; instructions: string; tools: VoiceLiveFunctionTool[]; endsCall: boolean; respondImmediately: boolean };
  /**
   * What a function of node `from` does: run a catalog tool (`runs`), move to a node (`to`, only after a tool that
   * worked when `onlyIfOk`; `failedTo` after one that did not), or both.
   */
  call(from: string, name: string): { runs?: string; to?: string; failedTo?: string; onlyIfOk: boolean; transitionOnly?: boolean } | undefined;
}

/** A start failure that carries Voice Live's own error type and code when it gave them. */
export class VoiceLiveStartError extends Error {
  constructor(message: string, readonly providerDetail?: string) {
    super(message);
    this.name = "VoiceLiveStartError";
  }
}

/** A fixed code for a Voice Live error event, read only from its code, type and status fields (never the message text). */
export function classifyVoiceLiveError(error: unknown): "azure_voice_live_auth_failed" | "azure_voice_live_rate_limited" | "azure_voice_live_error" {
  if (!error || typeof error !== "object") return "azure_voice_live_error";
  const e = error as Record<string, unknown>;
  const text = [e.code, e.type, e.status].filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v).toLowerCase()).join(" ");
  if (/\b(401|403)\b|invalid_api_key|authentication|unauthori[sz]ed|access_denied|permission/.test(text)) return "azure_voice_live_auth_failed";
  if (/\b429\b|rate_?limit|too_many_requests|quota/.test(text)) return "azure_voice_live_rate_limited";
  return "azure_voice_live_error";
}

/** A refused request (the call survives it), as opposed to an error that stops the call. */
function isRefusedRequest(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<string, unknown>).type === "invalid_request_error") && classifyVoiceLiveError(error) === "azure_voice_live_error";
}

/** The session.update settings: the configuration for the model's kind, the prompt and the tools. */
export function voiceLiveSessionSettings(o: Pick<VoiceLiveSessionOptions, "instructions" | "voice" | "tools" | "model" | "transcriptionModel" | "autoReply" | "transcriptionPrompt" | "transcriptionPhrases">): Record<string, unknown> {
  const text = voiceLiveModelKind(o.model) === "text";
  // With the decision tree, nobody but the harness starts a reply; without it, Voice Live answers each turn itself.
  // Either way the harness owns cancelling one (barge-in).
  const control = { create_response: o.autoReply === true, interrupt_response: false };
  return {
    instructions: o.instructions,
    modalities: ["text", "audio"],
    voice: { name: o.voice, type: "azure-standard" },
    // Mu-law at 8 kilohertz both ways, as the browser and a phone line carry it: nothing is resampled.
    input_audio_format: "g711_ulaw",
    output_audio_format: "g711_ulaw",
    // gpt-4o-transcribe gets no language (it detects it, a caller may switch to Spanish); Azure's recognizers get English and Spanish.
    input_audio_transcription: text
      ? {
          model: o.transcriptionModel ?? VOICE_LIVE_TRANSCRIPTION,
          // English and Spanish only, detected per turn . MAI Transcribe takes at most one locale
          // (Azure refused "en-US,es-US" on 2026-10-21), so it detects the language itself.
          ...((o.transcriptionModel ?? VOICE_LIVE_TRANSCRIPTION) === "azure-speech" ? { language: VOICE_LIVE_TRANSCRIPTION_LANGUAGES } : {}),
          ...(o.transcriptionPhrases?.length ? { phrase_list: o.transcriptionPhrases } : {}),
        }
      : { model: "gpt-4o-transcribe", ...(o.transcriptionPrompt ? { prompt: o.transcriptionPrompt } : {}) },
    input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
    input_audio_echo_cancellation: { type: "server_echo_cancellation" },
    // Text models refuse OpenAI's semantic_vad; the Azure multilingual type took ["en","es"] on the wire.
    turn_detection: text
      ? // Azure refuses auto_truncate unless it also owns barge-in (validate_auto_truncate_requires_interrupt_response, seen 2026-10-21).
        {
          type: "azure_semantic_vad_multilingual",
          remove_filler_words: true,
          languages: ["en", "es"],
          ...control,
          auto_truncate: true,
          interrupt_response: true,
          // A turn ends after 800 milliseconds of silence, or sooner when the end-of-utterance model is sure (Pat,
          // 2026-10-21: his answers were split in two; eagerness is a setting of the realtime models only).
          silence_duration_ms: 800,
          end_of_utterance_detection: { model: "semantic_detection_v1_multilingual", threshold_level: "low", timeout_ms: 2000 },
        }
      : // Medium, not high : high split one sentence into two or three caller lines.
        { type: "semantic_vad", eagerness: "medium", ...control },
    // The interim response is switched on later, once the opening has been heard (voiceLiveInterimSettings).
    output_audio_timestamp_types: ["word"],
    ...(o.tools?.definitions.length ? { tools: o.tools.definitions, tool_choice: "auto" } : {}),
  };
}

/** The echoed settings that must be what was asked: anything else would break playback, or who starts a reply. */
function echoProblem(session: Record<string, unknown>, autoReply: boolean): string | undefined {
  const td = (session.turn_detection ?? {}) as Record<string, unknown>;
  if (session.input_audio_format !== "g711_ulaw" || session.output_audio_format !== "g711_ulaw") return "echo_audio_format";
  if (td.create_response !== autoReply) return "echo_create_response";
  if (!session.input_audio_transcription) return "echo_no_transcription";
  return undefined;
}

/** What the session.updated echo says, for the trace: settings only, never the instructions text. */
function echoSummary(session: Record<string, unknown>): Record<string, unknown> {
  const td = (session.turn_detection ?? {}) as Record<string, unknown>;
  const voice = (session.voice ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>).type ?? (v as Record<string, unknown>).model ?? null : v ?? null);
  return {
    model: session.model ?? null,
    voice: voice.name ?? null,
    voiceType: voice.type ?? null,
    inputAudioFormat: session.input_audio_format ?? null,
    outputAudioFormat: session.output_audio_format ?? null,
    inputSampleRate: session.input_audio_sampling_rate ?? null,
    transcription: pick(session.input_audio_transcription),
    phraseList: Array.isArray((session.input_audio_transcription as Record<string, unknown> | undefined)?.phrase_list)
      ? ((session.input_audio_transcription as Record<string, unknown>).phrase_list as unknown[]).length
      : null,
    noiseReduction: pick(session.input_audio_noise_reduction),
    echoCancellation: pick(session.input_audio_echo_cancellation),
    turnDetection: td.type ?? null,
    eagerness: td.eagerness ?? null,
    createResponse: td.create_response ?? null,
    interruptResponse: td.interrupt_response ?? null,
    ...(td.languages !== undefined ? { languages: td.languages ?? null, removeFillerWords: td.remove_filler_words ?? null, autoTruncate: td.auto_truncate ?? null } : {}),
    ...(session.interim_response !== undefined ? { interimResponse: pick(session.interim_response), interimThresholdMs: (session.interim_response as Record<string, unknown> | null)?.latency_threshold_ms ?? null } : {}),
    timestamps: session.output_audio_timestamp_types ?? null,
    tools: Array.isArray(session.tools) ? session.tools.length : 0,
  };
}

/** One assistant message item: its words, its audio, and where that audio sits on the playback clock. */
interface AgentItem {
  id: string;
  responseId: string;
  /** The opening line (the disclosure): barge-in waits for its end. */
  opening: boolean;
  text: string;
  textDone: boolean;
  /** Word timestamps (milliseconds into the item's audio) for the words heard before a barge-in. */
  words: Array<{ atMs: number; text: string }>;
  /** Milliseconds of audio received for the item. */
  audioMs: number;
  /** Audio held for the line guard. */
  held: string[];
  /** Playback clock position of the item's first audio, once it was sent to the browser. */
  playStartAt?: number;
  /** Playback clock position of the end of the item's audio sent so far. */
  playEndAt?: number;
  /** The guard verdict is pending or the guard blocked the line. */
  guarding: boolean;
  blocked: boolean;
  /** Cut by a barge-in: its late audio is stale output. */
  interrupted: boolean;
  /** A tool call that was running when the item started (for an interim line). */
  toolRunning?: string;
  /** Recorded (as said, or as interrupted); nothing more happens to it. */
  settled: boolean;
  recordTimer?: NodeJS.Timeout;
  /** A record waits for this, so lines enter the record in the order they were heard. */
  done: Promise<void>;
  resolveDone: () => void;
  /** Set when the transcript is done and the audio may still be playing. */
  finalLine?: string;
}

/** Steps of one reply for the timing trace: what the harness waited on before Voice Live's first audio. */
interface ReplyTiming {
  callerFinalAt?: number;
  decisionDoneAt?: number;
  responseCreateAt?: number;
  source: string;
}

export class AzureVoiceLiveSession implements HarnessLiveSession {
  private socket: LiveSocket | undefined;
  private startedAt = 0;
  private ended = false;
  private capTimer: NodeJS.Timeout | undefined;
  private readonly eventCounts: Record<string, number> = {};
  private inputAudioAppends = 0;
  /** The response Voice Live is making now (between response.created and response.done). */
  private activeResponseId: string | undefined;
  /** response.create was sent and response.created has not arrived yet. */
  private responseRequested = false;
  /** A reply is owed once the active response is done. */
  private responseWanted = false;
  /** The timing of the response.create sent, until its response.created. */
  private pendingTiming: ReplyTiming | undefined;
  /** A reply asked for while another response was being made or asked for. */
  private waitingTiming: ReplyTiming | undefined;
  /** When Voice Live last committed a caller turn (input_audio_buffer.committed). */
  private lastCommitAt = 0;
  /** The options (response field) of the response.create in flight and of the waiting one, so a refusal can be retried plainly. */
  private pendingOptions: Record<string, unknown> | undefined;
  private waitingOptions: Record<string, unknown> | undefined;
  /** The event id of the last response.create sent, to match a refusal to it. */
  private lastCreateEventId: string | undefined;
  /** Tool outputs sent since the last reply was asked for, with how they went. */
  private toolOutputs: Array<{ name: string; ok: boolean; responseId?: string }> = [];
  private interimSent = false;
  /** The step-by-step conversation: the node the call is on, whether its first line is owed and by which response's call. */
  private flowNode: string | undefined;
  private flowOpened = false;
  private nodeEntered = false;
  private nodeEnteredBy: string | undefined;
  /** session.update messages sent and confirmed after the start, so a node's first line waits for its own update. */
  private updatesSent = 0;
  private updatesConfirmed = 0;
  private nodeUpdateWaiting: { seq: number; timer: NodeJS.Timeout } | undefined;
  /** On a node that ends the call: its own lines (responses created after the move) end it once heard, as a goodbye does. */
  private onEndStep = false;
  private readonly endStepResponses = new Set<string>();
  /** What the step-by-step call got done, for the disposition recorded at its end, and whether that was recorded. */
  private flowOutcome: "booked" | "callback" | "message_taken" | undefined;
  private flowDispositionSent = false;
  /** When each response was created, and when a typed caller line last came, so a stale question is not taken as open. */
  private readonly responseCreatedAt = new Map<string, number>();
  private lastTypedAt = 0;
  /** The step-by-step conversation runs the calls of one response in order (a save, then the text that needs it). */
  private readonly callChains = new Map<string, Promise<void>>();
  private itemShapeTraced = false;
  private goodbyeTimer: NodeJS.Timeout | undefined;
  /** The last response created, and when; a reply counts only while a barge-in has not cancelled it. */
  private lastResponseCreated: { id: string; at: number } | undefined;
  private replyCheckTimer: NodeJS.Timeout | undefined;
  /** When the server last heard the caller start speaking, so the reply fallback never answers half a turn. */
  private lastSpeechStartedAt: number | undefined;
  private activeTiming: (ReplyTiming & { responseId: string; firstAudioTraced: boolean }) | undefined;
  private readonly items = new Map<string, AgentItem>();
  /** Assistant items in the order they were created. */
  private itemOrder: AgentItem[] = [];
  /** Where the browser's playback of everything sent so far ends, at real time. */
  private playbackEndsAt = 0;
  /** Responses cancelled by a barge-in: their late output is stale. */
  private readonly staleResponses = new Set<string>();
  /** Stale output is dropped until then (the Call tab setting: off, one or two turn gaps after the barge-in), and played after. */
  private droppingStaleUntil = 0;
  private staleCapTimer: NodeJS.Timeout | undefined;
  private staleDropped = 0;
  private responseCreates = 0;
  /** What the decision module (or the opening) wants the next agent line to mean. */
  private intent: string | undefined;
  private owesLine = false;
  private reminded = false;
  private remindTimer: NodeJS.Timeout | undefined;
  /** Caller lines run one at a time, in arrival order. */
  private callerQueue: Promise<void> = Promise.resolve();
  /** Function calls of the current turn still waiting for their result, and outputs sent since the last response.create. */
  private readonly pendingToolCalls = new Set<string>();
  /** The name of each tool call running now, by call id. */
  private readonly runningTools = new Map<string, string>();
  private toolOutputsWaiting = false;
  private bargeInIgnoredTraced = new Set<string>();
  private disclosureChecked = false;
  private cancelPendingSocket: (() => void) | undefined;
  private onCreated: () => void = () => undefined;
  private onStarted: (session: Record<string, unknown>) => void = () => undefined;
  private onStartFailed: (err: Error) => void = () => undefined;
  private readonly onAbort = () => this.finish("caller_hangup");

  constructor(private readonly o: VoiceLiveSessionOptions) {}

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Counts of provider event kinds seen (kinds only, never content). */
  get eventKinds(): Record<string, number> {
    return { ...this.eventCounts };
  }

  get inputAudioAppendCount(): number {
    return this.inputAudioAppends;
  }

  /** A node of the step-by-step conversation entered: the row the console's stage strip and the objectives judge read. */
  private emitNodeEnter(nodeId: string, from: string | undefined, route: string | undefined): void {
    const node = this.o.flow!.node(nodeId);
    const c = this.o.trace;
    traceBus.emit({
      type: "node_enter", leadId: c.leadId, leadLabel: c.leadLabel, recordId: c.recordId, channel: c.channel,
      direction: c.direction, callId: c.callId,
      data: { nodeId, label: node.label, flowNode: nodeId, ...(from ? { from } : {}), ...(route ? { route } : {}) },
      ...(node.flowStep ? { flowStep: node.flowStep as never } : {}),
    });
  }

  /** A session.update after the start; counted, so a node's first line can wait until Voice Live confirms it. */
  private sendSessionUpdate(session: Record<string, unknown>, eventId?: string): number {
    this.updatesSent += 1;
    this.send({ type: "session.update", ...(eventId ? { event_id: eventId } : {}), session });
    return this.updatesSent;
  }

  /** One update with the node's whole instructions and tools (a later update replaces both, it does not merge). */
  private sendNodeUpdate(nodeId: string): void {
    const node = this.o.flow!.node(nodeId);
    clearTimeout(this.nodeUpdateWaiting?.timer);
    const seq = this.sendSessionUpdate({ instructions: node.instructions, tools: node.tools, tool_choice: "auto" }, `node_update_${this.updatesSent + 1}`);
    this.tool("voice_live_node_update", { node: nodeId, tools: node.tools.map((t) => t.name), instructionsChars: node.instructions.length }, true, 0);
    // Voice Live answers with session.updated in about a tenth of a second; a missing answer does not hold the call.
    const timer = setTimeout(() => this.nodeUpdateDone(seq, "voice_live_node_update_unconfirmed"), NODE_UPDATE_WAIT_MS);
    timer.unref();
    this.nodeUpdateWaiting = { seq, timer };
  }

  private nodeUpdateDone(seq: number, unconfirmed?: string): void {
    if (this.ended || !this.nodeUpdateWaiting || this.nodeUpdateWaiting.seq > seq) return;
    clearTimeout(this.nodeUpdateWaiting.timer);
    this.nodeUpdateWaiting = undefined;
    if (unconfirmed) this.tool(unconfirmed, { node: this.flowNode ?? null }, false, 0);
    this.afterTools();
  }

  /**
   * The opening reply is done: the call moves to the start node, whose text takes the opening as said. Not before
   * any agent audio was heard (a caller who spoke first cut the opening off unheard): then the next reply is the opening.
   */
  private openFlow(): void {
    if (!this.o.flow || this.flowOpened || this.ended) return;
    if (!this.itemOrder.some((i) => i.playStartAt !== undefined)) return;
    this.flowOpened = true;
    this.sendNodeUpdate(this.o.flow.start);
  }

  /**
   * The step-by-step call reached its end and its line was heard: the disposition goes on record through end_call, as
   * end_call does on the one-prompt path (booked, a callback, a message, else talked). The call then closes on the
   * socket route's closing wait or the goodbye hang-up, whichever comes first.
   */
  private sendFlowDisposition(): void {
    if (this.flowDispositionSent || !this.o.tools || this.ended) return;
    this.flowDispositionSent = true;
    const disposition = this.flowOutcome ?? "talked";
    this.tool("voice_live_flow_disposition", { disposition, node: this.flowNode ?? null }, true, 0);
    void this.o.tools.call("end_call", { disposition }).catch(() => undefined);
  }

  /** A transition function: no dispatcher. It is answered, and the call moves. */
  private enterNode(callId: string, name: string, to: string, responseId: string | undefined): void {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true, result: `now: ${to.replace(/_/g, " ")}` }) } });
    this.moveTo(to, name, responseId);
  }

  /** The call moves to `to`: one update, the node row, and the node's first line once the turn that moved is done. */
  private moveTo(to: string, name: string, responseId: string | undefined): void {
    const from = this.flowNode;
    const node = this.o.flow!.node(to);
    this.flowNode = to;
    this.flowOpened = true;
    this.sendNodeUpdate(to);
    this.tool("voice_live_node_transition", { name, from: from ?? null, to }, true, 0);
    this.emitNodeEnter(to, from, name);
    if (node.endsCall) this.onEndStep = true;
    // A step that waits (the start, or the transferred step once a person has the call): nothing more is said now,
    // not even a reply to the tool result that moved here.
    if (!node.respondImmediately) {
      this.toolOutputsWaiting = false;
      this.toolOutputs = [];
      return;
    }
    this.nodeEntered = true;
    this.nodeEnteredBy = responseId;
    this.toolOutputsWaiting = true;
    this.afterTools();
  }

  private emit(type: "tool_call" | "transcript_final" | "turn", data: Record<string, unknown>): void {
    const c = this.o.trace;
    traceBus.emit({
      type, leadId: c.leadId, leadLabel: c.leadLabel, recordId: c.recordId, channel: c.channel,
      direction: c.direction, callId: c.callId, data,
    });
  }

  private tool(tool: string, inputs: Record<string, unknown>, success: boolean, durationMs: number, reason?: string): void {
    this.emit("tool_call", { tool, inputs, result: null, success, durationMs, ...(reason ? { reason } : {}) });
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      /* the close handler ends the session */
    }
  }

  /** What a session open is traced with, the same on success and failure: never the instruction text, only its length. */
  private openInputs(): Record<string, unknown> {
    return {
      provider: "azure_voice_live",
      model: this.o.model,
      voice: this.o.voice,
      instructionsChars: this.o.instructions.length,
      tools: this.o.tools?.definitions.length ?? 0,
      // Whether the decision tree ran before each reply on this call (the rating board reads it, not today's toggle).
      decisionTree: this.o.autoReply ? "off" : "on",
      // The router this call runs (decision_model, the step-by-step flow, or none), and for the flow, which file and who moves the steps.
      decisionRouter: this.o.flow ? "voice_live_flow" : this.o.autoReply ? "none" : "decision_model",
      orchestrator: "direct",
      ...(this.o.flow ? { flow: { file: this.o.flow.source.file, hash: this.o.flow.source.hash, start: this.o.flow.start }, stepMover: "speaking_model" } : {}),
    };
  }

  async start(): Promise<void> {
    const began = Date.now();
    const deadline = began + (this.o.startTimeoutMs ?? 10_000);
    if (this.ended) throw new Error("voice_session_ended");
    if (this.o.signal?.aborted) {
      this.finish("caller_hangup");
      throw new Error("voice_session_ended");
    }
    this.o.signal?.addEventListener("abort", this.onAbort, { once: true });
    try {
      const creds = this.o.credentials(this.o.model);
      this.socket = await this.openSocket(creds, deadline);
    } catch (err) {
      const code = err instanceof Error && CODE.test(err.message) ? err.message : "azure_voice_live_connect_failed";
      this.tool("voice_session_open", this.openInputs(), false, Date.now() - began, code);
      this.finish(code === "azure_voice_live_start_timeout" ? "start_timeout" : "start_failed");
      throw new Error(code);
    }
    const created = new Promise<void>((resolve) => {
      this.onCreated = resolve;
    });
    const started = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.onStarted = resolve;
      this.onStartFailed = reject;
    });
    started.catch(() => undefined);
    this.socket.onMessage((raw) => this.handle(raw));
    this.socket.onClose(() => this.finish("voice_live_closed"));
    // The settings go once Voice Live has created the session; a refused model answers with an error before that.
    // With the step-by-step conversation the session starts on the opening and the start node's tools.
    const first = this.o.flow ? this.o.flow.node(this.o.flow.start) : undefined;
    const settings = this.o.flow && first && this.o.tools
      ? { ...this.o, instructions: this.o.flow.openingInstructions, tools: { definitions: first.tools, call: this.o.tools.call } }
      : this.o;
    void created.then(() => this.send({ type: "session.update", session: voiceLiveSessionSettings(settings) }));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("azure_voice_live_start_timeout")), Math.max(0, deadline - Date.now()));
      timer.unref();
    });
    let echo: Record<string, unknown>;
    try {
      echo = await Promise.race([started, timeout]);
    } catch (err) {
      const code = err instanceof Error && CODE.test(err.message) ? err.message : "azure_voice_live_session_rejected";
      this.tool("voice_session_open", this.openInputs(), false, Date.now() - began, code);
      this.finish(code === "azure_voice_live_start_timeout" ? "start_timeout" : "start_failed");
      throw new VoiceLiveStartError(code, err instanceof VoiceLiveStartError ? err.providerDetail : undefined);
    } finally {
      clearTimeout(timer);
    }
    this.startedAt = Date.now();
    this.tool(
      "voice_session_open",
      { ...this.openInputs(), staleOutputCapGaps: this.o.staleOutputCapGaps ?? DEFAULT_STALE_OUTPUT_CAP_GAPS, bargeInOwner: "server" },
      true,
      Date.now() - began,
    );
    // What Voice Live accepted, from its own echo (settings only).
    this.tool("voice_live_session_echo", echoSummary(echo), true, 0);
    if (this.o.flow) {
      this.flowNode = this.o.flow.start;
      this.emitNodeEnter(this.flowNode, undefined, undefined);
    }
    this.capTimer = setTimeout(() => this.finish("session_cap"), this.o.maxMs);
    this.capTimer.unref();
    this.intent = this.o.disclosure;
    // Spoken by the model, so it sounds natural and the caller can talk over it (not prerecorded).
    // The call's own opening is in the instructions too, so nothing there asks for another sentence first.
    this.systemItem(`The call just connected. Speak first: say exactly "${this.o.disclosure}" and then stop and listen.`);
    this.oweLine();
    this.requestResponse({ source: "opening" });
  }

  /** The socket, or a rejection at the deadline or on stop, whichever comes first. A socket that arrives after that is closed at once. */
  private openSocket(creds: { socketUrl: string; apiKey: string }, deadline: number): Promise<LiveSocket> {
    return new Promise<LiveSocket>((resolve, reject) => {
      let settled = false;
      const settle = (err: Error | undefined, socket?: LiveSocket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelPendingSocket = undefined;
        if (err) reject(err);
        else resolve(socket!);
      };
      const timer = setTimeout(() => settle(new Error("azure_voice_live_start_timeout")), Math.max(0, deadline - Date.now()));
      timer.unref();
      this.cancelPendingSocket = () => settle(new Error("voice_session_ended"));
      Promise.resolve()
        .then(() => this.o.socketFactory(creds.socketUrl, creds.apiKey))
        .then(
          (socket) => {
            if (settled) {
              try {
                socket.close();
              } catch {
                /* already closed */
              }
              return;
            }
            settle(undefined, socket);
          },
          (err: unknown) => settle(err instanceof Error ? err : new Error("azure_voice_live_connect_failed")),
        );
    });
  }

  /** Caller audio from the browser (or a phone line): mu-law at 8 kilohertz, base64. */
  sendAudio(base64: string): void {
    if (this.ended || !this.startedAt) return;
    this.inputAudioAppends += 1;
    this.send({ type: "input_audio_buffer.append", audio: base64 });
  }

  /** A typed caller line (no microphone): a user item the model reads, then the same path as a transcribed line. */
  async sendCallerText(text: string): Promise<void> {
    if (this.ended) throw new Error("voice_session_ended");
    // Typing over the agent is a barge-in, as speaking over it is.
    this.bargeInFrom("typed_text");
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.queueCallerLine(text, "typed");
  }

  /**
   * The browser's loudness check. The server owns barge-in on this path (its
   * turn detection hears the caller behind echo cancellation), and the ready
   * frame tells the browser so; a stray frame is ignored and traced once.
   */
  bargeIn(): void {
    if (this.ended) return;
    this.traceIgnoredBargeIn("server_owns_barge_in");
  }

  stop(reason: string = "caller_hangup"): void {
    this.finish(reason);
  }

  /** The caller is waiting and the model has not answered: ask it once more to say its line now. */
  remind(): void {
    if (this.ended || !this.startedAt || !this.owesLine || this.reminded) return;
    this.reminded = true;
    clearTimeout(this.remindTimer);
    const line = !this.intent
      ? " Reply to them now."
      : this.intent === this.o.disclosure
        ? ` Say exactly "${this.intent}" now.`
        : ` Say this in your own natural words, keeping its meaning: "${this.intent}"`;
    this.tool("remind_voice_model", {}, true, 0);
    this.systemItem(`The caller is waiting for your reply.${line}`);
    this.requestResponse({ source: "reminder" });
  }

  private oweLine(): void {
    this.owesLine = true;
    this.reminded = false;
    clearTimeout(this.remindTimer);
    this.remindTimer = setTimeout(() => {
      if (this.owesLine) this.remind();
    }, REMIND_AFTER_MS);
    this.remindTimer.unref();
  }

  private systemItem(text: string): void {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }

  /** One reply at a time: response.create now, or once the response being made (or asked for) is done. `options` is the response field. */
  private requestResponse(timing: ReplyTiming, options?: Record<string, unknown>): void {
    if (this.ended) return;
    if (this.activeResponseId || this.responseRequested) {
      this.responseWanted = true;
      this.waitingTiming = timing;
      this.waitingOptions = options;
      return;
    }
    this.responseWanted = false;
    this.waitingTiming = undefined;
    this.waitingOptions = undefined;
    this.responseRequested = true;
    this.toolOutputsWaiting = false;
    this.toolOutputs = [];
    timing.responseCreateAt = Date.now();
    this.pendingTiming = timing;
    this.pendingOptions = options;
    this.responseCreates += 1;
    this.lastCreateEventId = `response_create_${this.responseCreates}`;
    this.send({ type: "response.create", event_id: this.lastCreateEventId, ...(options ? { response: options } : {}) });
  }

  /**
   * Information for the model, not lines to say (for example which call objectives are done): one system item.
   * Traced as call_context_update with its length and where it came from.
   */
  sendContextNote(text: string, source: string): void {
    if (this.ended || !this.startedAt || !text.trim()) return;
    this.systemItem(text);
    this.tool("call_context_update", { chars: text.length, source }, true, 0);
  }

  private handle(raw: string): void {
    if (this.ended) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = typeof e.type === "string" ? e.type : "unknown";
    this.eventCounts[kind] = (this.eventCounts[kind] ?? 0) + 1;
    switch (kind) {
      case "session.created":
        this.onCreated();
        return;
      case "session.updated": {
        if (this.startedAt) {
          // A later update (the interim response after the opening): what Voice Live kept, settings only.
          const later = (e.session && typeof e.session === "object" ? e.session : {}) as Record<string, unknown>;
          this.tool("voice_live_session_echo_update", { ...echoSummary(later), ...(Array.isArray(later.tools) ? { tools: later.tools.length } : {}) }, true, 0);
          // Updates are confirmed in order: a node's first line may go once its own update is.
          this.updatesConfirmed += 1;
          this.nodeUpdateDone(this.updatesConfirmed);
          return;
        }
        const session = (e.session && typeof e.session === "object" ? e.session : {}) as Record<string, unknown>;
        const problem = echoProblem(session, this.o.autoReply === true);
        if (problem) this.onStartFailed(new VoiceLiveStartError("azure_voice_live_session_rejected", problem));
        else this.onStarted(session);
        return;
      }
      case "error":
        this.providerError(e.error);
        return;
      case "input_audio_buffer.speech_started":
        // Kinds, times and counts only, never words: when Voice Live heard the caller start, stop and finish a turn.
        this.tool("caller_speech_started", { audioStartMs: typeof e.audio_start_ms === "number" ? e.audio_start_ms : null }, true, 0);
        this.lastSpeechStartedAt = Date.now();
        clearTimeout(this.goodbyeTimer);
        this.bargeInFrom("caller_spoke_over");
        return;
      case "input_audio_buffer.speech_stopped":
        this.tool("caller_speech_stopped", { audioEndMs: typeof e.audio_end_ms === "number" ? e.audio_end_ms : null }, true, 0);
        return;
      case "input_audio_buffer.committed":
        this.tool("caller_turn_committed", { itemId: typeof e.item_id === "string" ? e.item_id : null }, true, 0);
        // When the caller's turn ended: with automatic replies, the reply's timing and the record's order start here.
        this.lastCommitAt = Date.now();
        // The caller answered before the opening reply was done: the call is on the start node now.
        this.openFlow();
        if (this.o.autoReply) this.checkReplyComes(this.lastCommitAt);
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof e.transcript === "string" ? e.transcript.trim() : "";
        // Every transcript, empty ones too, by word count only.
        this.tool("caller_transcription", { itemId: typeof e.item_id === "string" ? e.item_id : null, words: text ? text.split(/\s+/).length : 0 }, text.length > 0, 0, text ? undefined : "empty_transcript");
        if (text) this.queueCallerLine(text, "spoken");
        return;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.tool("caller_transcription_failed", {}, false, 0, "transcription_failed");
        this.systemItem("The caller's last words could not be heard clearly. Ask them briefly to say that again.");
        this.oweLine();
        this.requestResponse({ source: "transcription_failed" });
        return;
      case "response.created": {
        const r = (e.response ?? {}) as Record<string, unknown>;
        this.activeResponseId = typeof r.id === "string" ? r.id : "unknown";
        this.lastResponseCreated = { id: this.activeResponseId, at: Date.now() };
        if (this.o.flow) {
          this.responseCreatedAt.set(this.activeResponseId, Date.now());
          if (this.onEndStep) this.endStepResponses.add(this.activeResponseId);
        }
        this.responseRequested = false;
        // A response the harness did not ask for is Voice Live answering a caller turn by itself.
        const own: ReplyTiming = { source: "auto_reply", ...(this.lastCommitAt ? { callerFinalAt: this.lastCommitAt } : {}), responseCreateAt: Date.now() };
        this.activeTiming = { ...(this.pendingTiming ?? own), responseId: this.activeResponseId, firstAudioTraced: false };
        this.pendingTiming = undefined;
        return;
      }
      case "response.output_item.added":
        this.itemAdded(e);
        return;
      case "response.audio_transcript.delta":
        this.transcriptDelta(e);
        return;
      case "response.audio.delta":
        this.audioDelta(e);
        return;
      case "response.audio_timestamp.delta":
        this.timestampDelta(e);
        return;
      case "response.audio_transcript.done":
        void this.transcriptDone(e);
        return;
      case "response.output_item.done":
        this.outputItemDone(e);
        return;
      case "response.done":
        this.responseDone(e);
        return;
      default:
        return;
    }
  }

  /** Before the start, any error refuses the session; after it, a refused request is a warning and anything else ends the call. */
  private providerError(error: unknown): void {
    const detail = azureErrorDetail(error);
    if (!this.startedAt) {
      const code = classifyVoiceLiveError(error);
      this.onStartFailed(new VoiceLiveStartError(code === "azure_voice_live_error" ? "azure_voice_live_session_rejected" : code, detail));
      return;
    }
    if (isRefusedRequest(error)) {
      const e = error as Record<string, unknown>;
      this.tool("voice_provider_warning", {}, false, 0, typeof e.code === "string" && CODE.test(e.code) ? e.code : "invalid_request");
      // A node update Voice Live refused: the call stays up on the last settings it took, and the node's line is not held.
      if (typeof e.event_id === "string" && e.event_id.startsWith("node_update_")) {
        this.updatesConfirmed += 1;
        this.nodeUpdateDone(this.updatesConfirmed, "voice_live_node_update_refused");
        return;
      }
      // A refused response.create must not leave later replies waiting for a response that never starts.
      // It is asked for again when a response ends, or with the next reply; never at once, which could loop.
      if (this.responseRequested && typeof e.event_id === "string" && e.event_id.startsWith("response_create_")) {
        const timing = this.pendingTiming;
        const hadOptions = this.pendingOptions !== undefined && e.event_id === this.lastCreateEventId;
        this.responseRequested = false;
        this.pendingTiming = undefined;
        this.pendingOptions = undefined;
        if (hadOptions && timing) {
          // Options Voice Live did not take (tool_choice): ask once more without them.
          this.tool("voice_live_response_options_refused", { source: timing.source }, false, 0, typeof e.code === "string" && CODE.test(e.code) ? e.code : "invalid_request");
          this.requestResponse({ source: timing.source, ...(timing.callerFinalAt ? { callerFinalAt: timing.callerFinalAt } : {}) });
          return;
        }
        this.responseWanted = true;
        this.waitingTiming ??= timing;
      }
      return;
    }
    const code = classifyVoiceLiveError(error);
    this.tool("voice_provider_error", {}, false, 0, code);
    this.o.onProviderError?.(code, detail);
    this.finish("voice_live_error");
  }

  private itemAdded(e: Record<string, unknown>): void {
    const item = (e.item ?? {}) as Record<string, unknown>;
    if (item.type !== "message" || item.role !== "assistant" || typeof item.id !== "string") return;
    // An interim line may carry a marker; the harness has not seen one yet, so any unexpected key names are traced once.
    if (!this.itemShapeTraced) {
      const extra = [...Object.keys(e).filter((k) => !KNOWN_ITEM_EVENT_KEYS.has(k)), ...Object.keys(item).filter((k) => !KNOWN_ITEM_KEYS.has(k)).map((k) => `item.${k}`)];
      if (extra.length) {
        this.itemShapeTraced = true;
        this.tool("voice_live_item_shape", { extraKeys: extra.slice(0, 20) }, true, 0);
      }
    }
    const responseId = typeof e.response_id === "string" ? e.response_id : this.activeResponseId ?? "unknown";
    let resolveDone = () => undefined as void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const agent: AgentItem = {
      ...(this.runningTools.size ? { toolRunning: [...this.runningTools.values()][0] } : {}),
      id: item.id,
      responseId,
      opening: this.activeTiming?.source === "opening" && !this.itemOrder.some((i) => i.opening),
      text: "",
      textDone: false,
      words: [],
      audioMs: 0,
      held: [],
      guarding: false,
      blocked: false,
      interrupted: false,
      settled: false,
      done,
      resolveDone,
    };
    // A late item of a cancelled response was never heard.
    if (this.staleResponses.has(responseId)) {
      agent.interrupted = true;
      agent.settled = true;
      agent.resolveDone();
    }
    this.items.set(agent.id, agent);
    this.itemOrder.push(agent);
    if (this.itemOrder.length > 64) this.itemOrder = this.itemOrder.filter((i) => !i.settled).slice(-64);
  }

  private itemOf(e: Record<string, unknown>): AgentItem | undefined {
    return typeof e.item_id === "string" ? this.items.get(e.item_id) : undefined;
  }

  private transcriptDelta(e: Record<string, unknown>): void {
    const item = this.itemOf(e);
    if (!item || item.settled || typeof e.delta !== "string") return;
    item.text += e.delta;
    // The model is answering: no reminder is owed.
    this.owesLine = false;
    clearTimeout(this.remindTimer);
  }

  private timestampDelta(e: Record<string, unknown>): void {
    const item = this.itemOf(e);
    if (!item || item.settled || typeof e.audio_offset_ms !== "number" || typeof e.text !== "string") return;
    item.words.push({ atMs: e.audio_offset_ms, text: e.text });
  }

  private audioDelta(e: Record<string, unknown>): void {
    if (typeof e.delta !== "string") return;
    const responseId = typeof e.response_id === "string" ? e.response_id : undefined;
    const item = this.itemOf(e);
    const ms = Buffer.byteLength(e.delta, "base64") / AUDIO_BYTES_PER_MS;
    if (item?.blocked) return;
    if ((responseId && this.staleResponses.has(responseId)) || item?.interrupted) {
      // Output of the interrupted line still in flight: dropped within the setting's window, played after it (or when it is off).
      if (Date.now() < this.droppingStaleUntil) {
        this.staleDropped += 1;
        return;
      }
      return this.play(e.delta, undefined, ms);
    }
    if (item?.settled) return this.play(e.delta, undefined, ms);
    if (this.activeTiming && !this.activeTiming.firstAudioTraced && this.activeTiming.responseId === responseId) {
      this.activeTiming.firstAudioTraced = true;
      const t = this.activeTiming;
      const now = Date.now();
      this.tool(
        "voice_live_reply_timing",
        {
          source: t.source,
          ...(t.callerFinalAt && t.decisionDoneAt ? { decisionMs: t.decisionDoneAt - t.callerFinalAt } : {}),
          ...(t.callerFinalAt && t.responseCreateAt ? { callerFinalToCreateMs: t.responseCreateAt - t.callerFinalAt } : {}),
          ...(t.responseCreateAt ? { createToFirstAudioMs: now - t.responseCreateAt } : {}),
          ...(t.callerFinalAt ? { callerFinalToFirstAudioMs: now - t.callerFinalAt } : {}),
        },
        true,
        t.responseCreateAt ? now - t.responseCreateAt : 0,
      );
    }
    if (!item) return this.play(e.delta, undefined, ms);
    item.audioMs += ms;
    if (this.o.guardAgentLine && !item.opening) {
      // With a line check installed, audio waits for the whole line and the verdict.
      item.held.push(e.delta);
      return;
    }
    this.play(e.delta, item, ms);
  }

  /** Sends audio to the browser and moves the playback clock. */
  private play(b64: string, item: AgentItem | undefined, ms: number): void {
    const now = Date.now();
    const at = Math.max(this.playbackEndsAt, now);
    this.playbackEndsAt = at + ms;
    if (item) {
      item.playStartAt ??= at;
      item.playEndAt = this.playbackEndsAt;
    }
    this.o.onAudio(b64);
  }

  private async transcriptDone(e: Record<string, unknown>): Promise<void> {
    const item = this.itemOf(e);
    if (!item || item.settled) return;
    if (typeof e.transcript === "string") item.text = e.transcript;
    item.textDone = true;
    const raw = item.text.trim();
    let line: string | null = raw;
    // The opening disclosure is fixed text and must be heard: it is not held for the line check (as on the Deepgram path).
    if (this.o.guardAgentLine && !item.opening) {
      item.guarding = true;
      const began = Date.now();
      try {
        line = await this.o.guardAgentLine(raw);
      } catch {
        line = null;
      }
      item.guarding = false;
      this.tool("guard_agent_line", { chars: raw.length }, line !== null, Date.now() - began, line === null ? "agent_line_blocked" : undefined);
      if (this.ended || item.settled) return;
      const held = item.held;
      item.held = [];
      if (line === null) {
        // Never heard: the model's own memory of the line goes too.
        item.blocked = true;
        this.truncate(item, 0);
        this.settle(item);
        return;
      }
      for (const chunk of held) this.play(chunk, item, Buffer.byteLength(chunk, "base64") / AUDIO_BYTES_PER_MS);
    }
    if (item.opening) this.checkDisclosure(raw);
    item.finalLine = line ?? raw;
    this.scheduleRecord(item);
  }

  /** The line enters the record when its audio has played out (or now, when it had none). */
  private scheduleRecord(item: AgentItem): void {
    clearTimeout(item.recordTimer);
    const wait = Math.max(0, (item.playEndAt ?? 0) - Date.now());
    item.recordTimer = setTimeout(() => this.recordHeard(item), wait);
    item.recordTimer.unref();
  }

  private recordHeard(item: AgentItem): void {
    if (item.settled || this.ended) return;
    // Audio that came after the transcript (Voice Live sends both at once, but not always) moves the end.
    if ((item.playEndAt ?? 0) > Date.now() + 5) return this.scheduleRecord(item);
    const text = item.finalLine ?? item.text.trim();
    // With the interim response on, an assistant item followed by another one in the same response is the filler.
    if (this.interimSent && this.itemOrder.some((i) => i !== item && i.responseId === item.responseId && this.itemOrder.indexOf(i) > this.itemOrder.indexOf(item))) {
      // The console reads interim lines as interim_response rows: the words, the tool running then, how long it played.
      this.tool("interim_response", { text, ...(item.toolRunning ? { tool: item.toolRunning } : {}) }, true, Math.round(item.audioMs));
    } else {
      this.recordAgentLine(text, false, item.responseId);
    }
    this.settle(item);
    if (item.opening) this.switchInterimOn();
  }

  /** Once the opening has been heard, a text model gets its interim response (a second session.update). */
  private switchInterimOn(): void {
    if (this.interimSent || this.ended) return;
    const settings = voiceLiveInterimSettings(this.o.model);
    if (!settings) return;
    this.interimSent = true;
    this.sendSessionUpdate(settings);
    this.tool("voice_live_interim_on", { model: VOICE_LIVE_INTERIM_RESPONSE.model, latencyThresholdMs: VOICE_LIVE_INTERIM_RESPONSE.latency_threshold_ms }, true, 0);
  }

  private settle(item: AgentItem): void {
    item.settled = true;
    clearTimeout(item.recordTimer);
    item.resolveDone();
  }

  private outputItemDone(e: Record<string, unknown>): void {
    const item = (e.item ?? {}) as Record<string, unknown>;
    if (item.type !== "function_call" || typeof item.call_id !== "string" || typeof item.name !== "string") return;
    const responseId = typeof e.response_id === "string" ? e.response_id : this.activeResponseId;
    let args: unknown = {};
    if (typeof item.arguments === "string" && item.arguments.trim()) {
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") args = {};
    if (responseId && this.staleResponses.has(responseId)) {
      // The caller talked over the turn that asked for it: it is not run, and the model is told so it does not wait for it.
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify({ ok: false, refused: { code: "interrupted", reason: "caller_spoke_over" } }) } });
      this.tool("voice_live_tool_call", { name: item.name, callId: item.call_id, args: tracedArgs(args), responseId }, false, 0, "interrupted");
      return;
    }
    // The step-by-step conversation: a transition moves the call; a step's tool may run under the engine's name and move it after.
    const step = this.o.flow && this.flowNode ? this.o.flow.call(this.flowNode, item.name) : undefined;
    if (step?.transitionOnly && step.to) return this.enterNode(item.call_id, item.name, step.to, responseId);
    this.pendingToolCalls.add(item.call_id);
    this.runningTools.set(item.call_id, item.name);
    const callId = item.call_id;
    const name = item.name;
    const run = () => this.runToolCall(callId, step?.runs ?? name, args, responseId, step ? { as: name, ...(step.to ? { to: step.to } : {}), ...(step.failedTo ? { failedTo: step.failedTo } : {}), onlyIfOk: step.onlyIfOk } : undefined);
    if (!this.o.flow || !responseId) return void run();
    // Step by step: one response's calls run in the order the model made them.
    const next = (this.callChains.get(responseId) ?? Promise.resolve()).then(run, run);
    this.callChains.set(responseId, next.catch(() => undefined));
  }

  private async runToolCall(callId: string, name: string, args: unknown, responseId?: string, move?: { as: string; to?: string; failedTo?: string; onlyIfOk: boolean }): Promise<void> {
    const began = Date.now();
    let result: { output: string; ok: boolean; refusedCode?: string; endCall?: boolean };
    if (!this.o.tools) {
      result = { output: JSON.stringify({ ok: false, refused: { code: "no_tools", reason: "no_tools" } }), ok: false, refusedCode: "no_tools" };
    } else {
      try {
        result = await this.o.tools.call(name, args);
      } catch {
        result = { output: JSON.stringify({ ok: false, refused: { code: "run_failed", reason: "error" } }), ok: false, refusedCode: "run_failed" };
      }
    }
    this.tool(
      "voice_live_tool_call",
      { name, ...(move && move.as !== name ? { as: move.as } : {}), callId, ok: result.ok, args: tracedArgs(args), ...(responseId ? { responseId } : {}), ...(result.endCall ? { endCall: true } : {}) },
      result.ok,
      Date.now() - began,
      result.refusedCode,
    );
    this.pendingToolCalls.delete(callId);
    this.runningTools.delete(callId);
    if (this.ended) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: result.output } });
    if (result.endCall) {
      // The call is ending: no reply to the result. If the turn that ended it said nothing, one goodbye, no tools.
      this.toolOutputsWaiting = false;
      this.toolOutputs = [];
      const saidSomething = this.itemOrder.some((i) => i.responseId === responseId && (i.audioMs > 0 || i.text.trim().length > 0));
      if (!saidSomething) {
        this.systemItem("Say only: Thanks for your time. Goodbye.");
        this.requestResponse({ source: "goodbye" }, { tool_choice: "none" });
      }
      return;
    }
    this.toolOutputs.push({ name, ok: result.ok, ...(responseId ? { responseId } : {}) });
    this.toolOutputsWaiting = true;
    if (this.o.flow && result.ok) {
      if (name === "book_producer") this.flowOutcome = "booked";
      else if (name === "save_message" && this.flowOutcome !== "booked") this.flowOutcome = this.flowNode === "callback" ? "callback" : "message_taken";
    }
    const target = result.ok || !move?.onlyIfOk ? move?.to : move?.failedTo;
    if (target && !this.ended) return this.moveTo(target, move!.as, responseId);
    this.afterTools();
  }

  /**
   * Once every call of the turn has its output and the response that asked is done, the model answers with the
   * results, with no tool this time (so a check cannot chain straight into a booking). Not when the turn only saved
   * facts and already asked its next question: a second reply would only repeat it.
   */
  private afterTools(): void {
    if (!this.toolOutputsWaiting || this.pendingToolCalls.size || this.activeResponseId || this.responseRequested) return;
    if (this.nodeEntered) {
      // The new node's first line, once Voice Live has its update, with its tools (no tool_choice none). It covers any
      // save of the same turn too. Not when the turn that moved already asked its question: the caller answers that.
      if (this.nodeUpdateWaiting) return;
      const by = this.nodeEnteredBy;
      this.nodeEntered = false;
      this.nodeEnteredBy = undefined;
      this.toolOutputsWaiting = false;
      this.toolOutputs = [];
      // The question is open only if the caller has not answered since it was asked (a slow tool can return after that).
      const askedAt = by ? this.responseCreatedAt.get(by) : undefined;
      const answered = askedAt !== undefined && (this.lastCommitAt > askedAt || this.lastTypedAt > askedAt);
      if (by && !answered && this.itemOrder.some((i) => i.responseId === by && !i.interrupted && (i.finalLine ?? i.text).trim().endsWith("?"))) {
        this.tool("voice_live_node_reply_skipped", { node: this.flowNode ?? null }, true, 0);
        return;
      }
      this.oweLine();
      this.requestResponse({ source: "node_entry" });
      return;
    }
    const outputs = this.toolOutputs;
    const callers = new Set(outputs.map((o) => o.responseId).filter((id): id is string => Boolean(id)));
    const askedNext =
      outputs.length > 0 &&
      outputs.every((o) => o.ok && SAVE_TOOLS.has(o.name)) &&
      callers.size > 0 &&
      [...callers].every((id) => this.itemOrder.some((i) => i.responseId === id && !i.interrupted && (i.finalLine ?? i.text).trim().endsWith("?")));
    if (askedNext) {
      this.toolOutputsWaiting = false;
      this.toolOutputs = [];
      this.tool("voice_live_tool_reply_skipped", { tools: outputs.map((o) => o.name) }, true, 0);
      return;
    }
    this.oweLine();
    this.requestResponse(this.waitingTiming ?? { source: "tool_result" }, { tool_choice: "none" });
  }

  private responseDone(e: Record<string, unknown>): void {
    const r = (e.response ?? {}) as Record<string, unknown>;
    if (r.status === "failed") {
      const details = (r.status_details ?? {}) as Record<string, unknown>;
      this.tool("voice_provider_warning", {}, false, 0, typeof (details.error as Record<string, unknown> | undefined)?.code === "string" && CODE.test(String((details.error as Record<string, unknown>).code)) ? String((details.error as Record<string, unknown>).code) : "response_failed");
    }
    if (typeof r.id === "string" && r.id !== this.activeResponseId) return;
    const wasOpening = this.activeTiming?.source === "opening";
    this.activeResponseId = undefined;
    this.activeTiming = undefined;
    if (this.ended) return;
    // The opening said (or cut off once heard): the step-by-step conversation moves to its start node.
    if (wasOpening || this.o.flow) this.openFlow();
    if (this.toolOutputsWaiting && !this.pendingToolCalls.size) return this.afterTools();
    // Tool outputs still coming: their response.create covers the waiting reply too.
    if (this.pendingToolCalls.size) return;
    if (this.responseWanted) this.requestResponse(this.waitingTiming ?? { source: "unknown" }, this.waitingOptions);
  }

  /**
   * With automatic replies, Voice Live does not start a reply of its own while another response is still active
   * (for example one being cancelled by a barge-in), so a finished caller turn could go unanswered (a test call of
   * 2026-10-21: nothing for 20 seconds after "$700,000"). When no fresh reply has started 1.2 seconds after the
   * turn ended, the harness asks for one.
   */
  private checkReplyComes(turnEndedAt: number): void {
    clearTimeout(this.replyCheckTimer);
    clearTimeout(this.goodbyeTimer);
    this.replyCheckTimer = setTimeout(() => {
      const last = this.lastResponseCreated;
      const replied = last !== undefined && last.at >= turnEndedAt && !this.staleResponses.has(last.id);
      if (this.ended || replied || this.responseRequested) return;
      // The caller started speaking again: their turn is not over, so do not answer the fragment.
      if (this.lastSpeechStartedAt !== undefined && this.lastSpeechStartedAt > turnEndedAt) return;
      if (this.activeResponseId && !this.staleResponses.has(this.activeResponseId)) return;
      this.tool("voice_live_reply_missing", { waitedMs: Date.now() - turnEndedAt }, true, 0);
      this.oweLine();
      this.requestResponse({ source: "auto_reply_retry", callerFinalAt: turnEndedAt });
    }, 2000);
    this.replyCheckTimer.unref();
  }

  /** Whether any agent audio is still playing in the browser. */
  private audible(): boolean {
    return this.playbackEndsAt > Date.now();
  }

  /** The item being heard now, by the playback clock. */
  private itemPlayingNow(now: number): AgentItem | undefined {
    return this.itemOrder.find((i) => !i.settled && i.playStartAt !== undefined && i.playStartAt <= now && (i.playEndAt ?? 0) > now);
  }

  private traceIgnoredBargeIn(reason: string): void {
    if (this.bargeInIgnoredTraced.has(reason)) return;
    this.bargeInIgnoredTraced.add(reason);
    this.tool("barge_in_ignored", {}, true, 0, reason);
  }

  /**
   * The caller talked (or typed) over the agent. Ignored while the opening
   * disclosure plays. Otherwise: playback is cleared, a response still being
   * made is cancelled, the item being heard is truncated at the milliseconds
   * played and recorded with the words heard, and items not yet heard are
   * truncated to nothing, so Voice Live's memory of the call is what was heard.
   */
  private bargeInFrom(reason: string): void {
    if (this.ended || !this.startedAt) return;
    const now = Date.now();
    const making = Boolean(this.activeResponseId);
    if (!this.audible() && !making) return;
    const playing = this.itemPlayingNow(now);
    // The opening is interruptible like any other line on Voice Live : a caller who talks over it stops it.
    this.o.onClearPlayback();
    this.playbackEndsAt = now;
    this.tool("clear_playback", { reason }, true, 0);
    if (making && this.activeResponseId) {
      this.staleResponses.add(this.activeResponseId);
      this.send({ type: "response.cancel" });
    }
    this.startDroppingStale();
    for (const item of this.itemOrder) {
      if (item.settled) continue;
      if (item === playing) {
        const playedMs = Math.max(0, now - (item.playStartAt ?? now));
        item.interrupted = true;
        this.truncate(item, playedMs);
        this.recordAgentLine(heardWords(item, playedMs), true);
      } else if (item.playStartAt !== undefined && item.playStartAt <= now) {
        // Fully played but not yet recorded (its record timer was about to run).
        this.recordAgentLine(item.finalLine ?? item.text.trim(), false);
      } else {
        item.interrupted = true;
        this.truncate(item, 0);
      }
      this.settle(item);
    }
  }

  /** Cuts the item's audio in Voice Live's conversation at what was heard, inside its length. */
  private truncate(item: AgentItem, playedMs: number): void {
    if (item.audioMs <= 0) return;
    const endMs = Math.floor(Math.min(playedMs, Math.max(0, item.audioMs - TRUNCATE_MARGIN_MS)));
    this.send({ type: "conversation.item.truncate", item_id: item.id, content_index: 0, audio_end_ms: endMs });
    this.tool("truncate_agent_line", { playedMs: Math.round(playedMs), audioMs: Math.round(item.audioMs), audioEndMs: endMs }, true, 0);
  }

  /** Output of the interrupted line still arriving is dropped for at most the setting's number of turn gaps (none when it is off). */
  private startDroppingStale(): void {
    const capGaps = this.o.staleOutputCapGaps ?? DEFAULT_STALE_OUTPUT_CAP_GAPS;
    const windowMs = (this.o.turnGapMs ?? 900) * capGaps;
    this.droppingStaleUntil = Date.now() + windowMs;
    clearTimeout(this.staleCapTimer);
    if (windowMs <= 0) return;
    this.staleCapTimer = setTimeout(() => this.stopDroppingStale(), windowMs);
    this.staleCapTimer.unref();
  }

  private stopDroppingStale(): void {
    clearTimeout(this.staleCapTimer);
    this.droppingStaleUntil = 0;
    if (this.staleDropped) this.tool("drop_stale_agent_audio", { chunks: this.staleDropped }, true, 0);
    this.staleDropped = 0;
  }

  private checkDisclosure(spoken: string): void {
    if (this.disclosureChecked) return;
    this.disclosureChecked = true;
    // Both directions: every expected word was said, and nothing substantial was added to it.
    const score = Math.min(overlap(this.o.disclosure, spoken), overlap(spoken, this.o.disclosure));
    this.tool("disclosure_check", { overlap: Number(score.toFixed(2)) }, score >= 0.9, 0, score >= 0.9 ? undefined : "disclosure_text_mismatch");
  }

  /** One more than the highest turn number already recorded for this call, so lines from the dialog and the voice model interleave. */
  private nextTurnIndex(): number {
    let max = -1;
    for (const e of traceBus.history()) {
      if (e.callId === this.o.trace.callId && (e.type === "transcript_final" || e.type === "turn") && typeof e.data.turnIndex === "number") {
        max = Math.max(max, e.data.turnIndex);
      }
    }
    return max + 1;
  }

  private recordAgentLine(text: string, interrupted: boolean, responseId?: string): void {
    // A goodbye heard in full (or the end step's own line heard in full), then no caller speech for a few seconds:
    // the call ends rather than sit in silence. The end step's line also records the call's disposition.
    const endStepLine = responseId !== undefined && this.endStepResponses.has(responseId) && text.trim().length > 0;
    if (!interrupted && endStepLine) this.sendFlowDisposition();
    if (!interrupted && (GOODBYE.test(text) || endStepLine)) {
      clearTimeout(this.goodbyeTimer);
      this.goodbyeTimer = setTimeout(() => {
        if (this.ended) return;
        this.tool("agent_goodbye_hang_up", { waitedMs: GOODBYE_HANG_UP_MS }, true, 0);
        this.finish("agent_goodbye");
      }, GOODBYE_HANG_UP_MS);
      this.goodbyeTimer.unref();
    }
    if (!text) return;
    const data = { role: "agent", text, turnIndex: this.nextTurnIndex(), spoken: !interrupted, source: "voice_module" };
    if (!interrupted && this.intent) {
      const score = overlap(this.intent, text);
      this.tool("spoken_vs_intended", { intended: this.intent, spoken: text, overlap: Number(score.toFixed(2)), diverged: score < 0.3 }, true, 0);
    }
    if (!interrupted) this.intent = undefined;
    this.emit(this.o.dialogOwnsTranscript ? "turn" : "transcript_final", data);
  }

  /**
   * A finished caller line waits for every agent line whose audio started
   * before it to be recorded (or interrupted), so the record keeps the order
   * the lines were heard in, then runs alone, in arrival order.
   */
  private queueCallerLine(text: string, how: "spoken" | "typed"): void {
    if (how === "typed") this.lastTypedAt = Date.now();
    // With automatic replies the reply may start before the transcription arrives: order by when the turn ended.
    const heardAt = this.o.autoReply && how === "spoken" && this.lastCommitAt ? this.lastCommitAt : Date.now();
    const before = this.itemOrder.filter((i) => !i.settled && i.playStartAt !== undefined && i.playStartAt <= heardAt).map((i) => i.done);
    this.callerQueue = this.callerQueue
      .then(() => Promise.race([Promise.all(before), new Promise<void>((r) => setTimeout(r, RECORD_WAIT_CAP_MS).unref())]))
      .then(() => this.callerFinal(text, how, heardAt))
      .catch(() => undefined);
  }

  private async callerFinal(text: string, how: "spoken" | "typed", heardAt: number): Promise<void> {
    if (this.ended) return;
    if (!this.o.onCallerFinal) this.emit("transcript_final", { role: "caller", text, turnIndex: this.nextTurnIndex(), source: "voice_module" });
    if (this.o.autoReply) {
      // Voice Live answers a spoken turn itself; a typed line is an item, which it does not answer on its own.
      if (how === "typed") {
        this.oweLine();
        this.requestResponse({ source: "typed_caller_line", callerFinalAt: heardAt });
      }
      await this.sendContextUpdate();
      return;
    }
    let guidance: string | undefined;
    if (this.o.onCallerFinal) {
      try {
        guidance = await this.o.onCallerFinal(text);
      } catch {
        this.tool("decision_step", {}, false, 0, "decision_step_failed");
      }
    }
    const decisionDoneAt = Date.now();
    if (this.ended) return;
    if (guidance) {
      const steer = `The decision module chose what to say next. Say this in your own natural words, keeping its meaning: "${guidance}"`;
      this.intent = guidance;
      this.tool("steer_voice_model", { instruction: steer }, true, 0);
      this.systemItem(steer);
    }
    // Voice Live never answers on its own here: the reply is always the harness's call.
    this.oweLine();
    this.requestResponse({ source: how === "typed" ? "typed_caller_line" : "caller_line", callerFinalAt: heardAt, decisionDoneAt });
    await this.sendContextUpdate();
  }

  /**
   * Information for the agent, apart from the guidance: never words to say. It can take a second or more (the
   * lead store), so no reply waits for it; it lands as its own system item for the replies after this one.
   */
  private async sendContextUpdate(): Promise<void> {
    if (this.o.contextUpdate) {
      const began = Date.now();
      try {
        const update = await this.o.contextUpdate();
        if (update && !this.ended) {
          this.tool("call_context_update", { chars: update.length }, true, Date.now() - began);
          this.systemItem(update);
        }
      } catch {
        this.tool("call_context_update", {}, false, Date.now() - began, "call_context_update_failed");
      }
    }
  }

  private finish(reason: VoiceLiveEndReason | string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.nodeUpdateWaiting?.timer);
    this.nodeUpdateWaiting = undefined;
    this.o.signal?.removeEventListener("abort", this.onAbort);
    this.cancelPendingSocket?.();
    clearTimeout(this.capTimer);
    clearTimeout(this.remindTimer);
    clearTimeout(this.staleCapTimer);
    clearTimeout(this.replyCheckTimer);
    const durationMs = this.durationMs;
    const now = Date.now();
    // Whatever was heard before the end still belongs in the record; a line cut by the end is not fully spoken.
    if (this.startedAt) {
      for (const item of this.itemOrder) {
        if (item.settled) continue;
        clearTimeout(item.recordTimer);
        if (!item.blocked && !item.guarding && item.playStartAt !== undefined && item.playStartAt <= now) {
          const full = (item.playEndAt ?? 0) <= now && item.textDone;
          this.recordAgentLine(full ? item.finalLine ?? item.text.trim() : heardWords(item, now - item.playStartAt), !full);
        }
        item.settled = true;
        item.resolveDone();
      }
    }
    this.pendingToolCalls.clear();
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    // Only Voice Live closing the connection is its failure; the caller leaving (or a stop) during the start is not.
    this.onStartFailed(new Error(reason === "voice_live_closed" ? "azure_voice_live_closed_before_start" : "voice_session_ended"));
    // Event kinds and counts only, never content: what Voice Live sent over the whole call.
    if (this.startedAt) this.tool("voice_session_close", { reason, eventKinds: this.eventKinds, inputAudioAppends: this.inputAudioAppends }, true, durationMs);
    this.o.onEnd({ durationMs, reason });
  }
}

/** A tool call's arguments for the trace: string values cut to 200 characters, at most 12 keys. */
/**
 * The words of an item heard within `playedMs` of its audio: from the word
 * timestamps when Voice Live sent them, else the same share of the transcript
 * as of the audio, cut at a word.
 */
export function heardWords(item: { text: string; textDone?: boolean; words: Array<{ atMs: number; text: string }>; audioMs: number }, playedMs: number): string {
  const lastWordAt = item.words.length ? item.words[item.words.length - 1]!.atMs : -1;
  if (item.words.length && ((item as { textDone?: boolean }).textDone || lastWordAt >= playedMs)) {
    let out = "";
    for (const w of item.words) {
      if (w.atMs >= playedMs) break;
      out += /^[,.;:!?]$/.test(w.text) ? w.text : `${out ? " " : ""}${w.text}`;
    }
    return out.trim();
  }
  const text = item.text.trim();
  if (!text || item.audioMs <= 0) return "";
  const share = Math.min(1, Math.max(0, playedMs / item.audioMs));
  const words = text.split(/\s+/);
  return words.slice(0, Math.floor(words.length * share)).join(" ");
}

/** Share of the intended line's longer words that the spoken line also uses (0 to 1). */
function overlap(intended: string, spoken: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z']{4,}/g) ?? []);
  const want = words(intended);
  if (!want.size) return 1;
  const got = words(spoken);
  let hit = 0;
  for (const w of want) if (got.has(w)) hit += 1;
  return hit / want.size;
}
