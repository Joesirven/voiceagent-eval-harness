/**
 * One live speech-to-speech session with the Azure gpt-live-1 deployment.
 * It speaks the same session protocol as the reference voice bridge (start,
 * audio in, instructions appended, transcript and audio deltas out), written
 * fresh here. The socket is injected, so tests use a fake and never touch the
 * network. All audio is G.711 mu-law at 8 kilohertz, as base64 text.
 *
 * The session never talks to a browser itself: it hands audio and lines to
 * callbacks. Everything it learns goes onto the trace bus for the call.
 */

import { traceBus, type TraceContext } from "../trace/index.js";
import type { LiveThinker } from "../server/voice/live-thinker.js";

export interface LiveSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
}

/** Opens the secure websocket. Rejects with a fixed code, never with provider text. */
export type LiveSocketFactory = (url: string, apiKey: string) => Promise<LiveSocket>;

export interface LiveSessionOptions {
  socketFactory: LiveSocketFactory;
  credentials: () => { liveUrl: string; apiKey: string };
  trace: TraceContext;
  model: string;
  voice: string;
  /** Full system prompt, lead context included. */
  instructions: string;
  /** The agent's first turn, said word for word. */
  disclosure: string;
  /** Hard cap on one session. */
  maxMs: number;
  /** Quiet time that ends a spoken turn. */
  turnGapMs?: number;
  /**
   * After a barge-in, drop the interrupted line's output still in flight for at
   * most this many turn gaps: 0 turns the drop off, 1 is the default (0.9
   * seconds at the default gap), 2 is the earlier behaviour (1.8 seconds).
   */
  staleOutputCapGaps?: StaleOutputCapGaps;
  /** One deadline for the whole start: opening the socket and Azure's session start together. */
  startTimeoutMs?: number;
  /** Aborted when whoever opened the session goes away (the browser left). Stops the session, or a start still pending. */
  signal?: AbortSignal;
  /** When the dialog owns the transcript lines, spoken agent lines are recorded as turn events instead. */
  dialogOwnsTranscript: boolean;
  /** Optional check on each complete agent line before it is played. Return the line to allow it (possibly edited) or null to block. Absent means no check. */
  guardAgentLine?: (line: string) => string | null | Promise<string | null>;
  /** Called with each finished caller line; may return what the decision module wants said next. */
  onCallerFinal?: (text: string) => Promise<string | undefined>;
  /** Which orchestrator runs the call (direct, or pipecat around this session), recorded on the voice_session_open row. */
  orchestrator?: "direct" | "pipecat";
  /** Call context for the agent (stage, quote checklist, days to renewal); text only when it changed since the last one. Information, never lines to say. */
  contextUpdate?: () => Promise<string | undefined>;
  onAudio: (base64: string) => void;
  onClearPlayback: () => void;
  /** Fixed provider or relay code for the browser status line (no secrets). */
  /** A provider error during the call, with Azure's own type and code when Azure gave them (identifier tokens only). */
  onProviderError?: (code: string, azureDetail?: string) => void;
  onEnd: (summary: { durationMs: number; reason: string }) => void;
  /**
   * The reasoning model Azure runs for gpt-live-1 through a "responses"
   * delegation, holding the flow tool catalog; its function calls run through
   * the flow tool dispatcher. Absent means gpt-live-1 answers alone.
   */
  thinker?: LiveThinker;
}

/** Quiet time after a function result before `response.create`, so a second call of the same turn can land first. */
export const THINKER_SETTLE_MS = 250;

/** Tools that save a fact the caller said: when the turn already asked its next question, no second reply is asked for (both Azure paths). */
export const SAVE_TOOLS: ReadonlySet<string> = new Set(["write_quote_field", "save_contact_detail", "add_callback_number", "record_decision_maker", "save_message"]);

/** A goodbye line; with no caller speech for GOODBYE_HANG_UP_MS after it, the call ends (both Azure paths). */
export const GOODBYE = /\b(goodbye|bye|have a (great|good|nice) (day|one|afternoon|evening|night))\b/i;
export const GOODBYE_HANG_UP_MS = 5000;

/** Tool arguments as traced: at most 12 keys, strings cut to 200 characters (both Azure paths). */
export function tracedArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 12)) out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  return out;
}

/** One caller line's reply timing: line final, decision answered, guidance steer sent, first speech. Epoch milliseconds. */
interface ReplyTiming {
  callerFinalAt: number;
  decisionDoneAt?: number;
  createAt?: number;
  /** No decision step: gpt-live-1 replies by itself, so the clock starts at the caller's last transcript piece. */
  fromLastCallerPiece?: boolean;
}

export type LiveEndReason = "caller_hangup" | "session_cap" | "azure_closed" | "azure_error" | "start_failed" | "start_timeout" | "server_stop" | "agent_goodbye";

const FRAME_VOICE_PREFIX = "voice_";

/** One mu-law byte as linear amplitude (the standard G.711 expansion), 0 to 32124. */
export function muLawMagnitude(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  return ((mantissa << 3) + 0x84 << exponent) - 0x84;
}

/** Mean linear amplitude above which a chunk counts as speech; a low noise floor stays well under it. */
export const SPEECH_FLOOR = 300;

/**
 * Whether a base64 mu-law chunk carries speech, by its mean linear amplitude,
 * so the near-silence Azure streams between lines (digital silence or a low
 * noise floor) reads as quiet. Shared with the simulator
 * (src/simulator/live-text-session.ts, where research note wrote it).
 */
export function isSpeech(b64: string): boolean {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) return false;
  let sum = 0;
  for (const b of bytes) sum += muLawMagnitude(b);
  return sum / bytes.length > SPEECH_FLOOR;
}

/**
 * gpt-live-1 can let an instruction append pass without acting on it when it
 * arrives while the model is still speaking (simulator batch verify-live-4: 2 of
 * 3 calls skipped the first steer; verify-live-5, holding until 600
 * milliseconds without speech: 0 of 17). A steer waits for that quiet gap,
 * never longer than the cap.
 */
export const STEER_QUIET_MS = 600;
export const STEER_HOLD_CAP_MS = 3000;
/** Silence after a steer (or the opening) before the model is reminded once. */
export const REMIND_AFTER_MS = 12_000;

/**
 * A fixed code for an Azure error event, read only from its code, type and
 * status fields (never the message text). Anything unrecognized stays azure_error.
 */
export function classifyAzureError(
  error: unknown,
): "azure_auth_failed" | "azure_model_not_deployed" | "azure_deployment_not_found" | "azure_rate_limited" | "azure_error" {
  if (!error || typeof error !== "object") return "azure_error";
  const e = error as Record<string, unknown>;
  const fields = [e.code, e.type, e.status].filter((v): v is string | number => typeof v === "string" || typeof v === "number");
  const text = fields.map((v) => String(v).toLowerCase()).join(" ");
  if (/\b(401|403)\b|invalid_api_key|authentication|unauthori[sz]ed|access_denied|permission/.test(text)) return "azure_auth_failed";
  // The session start named a model this resource has not deployed: a settings choice, not a broken resource.
  if (/model_?not_?deployed/.test(text)) return "azure_model_not_deployed";
  if (/\b404\b|deployment_?not_?found|model_?not_?found|not_found/.test(text)) return "azure_deployment_not_found";
  if (/\b429\b|rate_?limit|too_many_requests|quota/.test(text)) return "azure_rate_limited";
  return "azure_error";
}

/**
 * Azure's own error type and code, for the voice error detail: only short
 * identifier-shaped tokens (never the message text, which can echo a host).
 */
export function azureErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  const tokens = [e.type, e.code].filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v));
  return tokens.length ? tokens.join(" / ") : undefined;
}

/** A start failure that carries Azure's own error type and code when Azure gave them. */
export class AzureStartError extends Error {
  constructor(message: string, readonly azureDetail?: string) {
    super(message);
    this.name = "AzureStartError";
  }
}

/**
 * The live protocol has no way to cancel a response and no response ids: the
 * model notices being talked over by itself, and output that was already in
 * flight keeps arriving for a moment. After a barge-in that output is dropped
 * until the agent's transcript has been quiet for one turn gap, and never for
 * longer than this many turn gaps, so a fresh reply is never held back.
 */
export type StaleOutputCapGaps = 0 | 1 | 2;
export const DEFAULT_STALE_OUTPUT_CAP_GAPS: StaleOutputCapGaps = 1;

export class AzureLiveSession {
  private socket: LiveSocket | undefined;
  private startedAt = 0;
  private ended = false;
  private capTimer: NodeJS.Timeout | undefined;
  private agentText = "";
  private agentHeld: string[] = [];
  private agentTimer: NodeJS.Timeout | undefined;
  private lastAgentAt = 0;
  private callerText = "";
  private callerTimer: NodeJS.Timeout | undefined;
  /** Bumped by a barge-in so a line still being checked is never played. */
  private turnToken = 0;
  /** What the decision module (or the opening) wants the next agent line to mean. */
  private intent: string | undefined;
  private readonly eventCounts: Record<string, number> = {};
  private inputAudioAppends = 0;
  /** Set by a barge-in while output from the interrupted line may still arrive. */
  private droppingStale = false;
  private staleQuietTimer: NodeJS.Timeout | undefined;
  /** When the model's output last carried speech. */
  private lastSpeechAt = 0;
  /** Instruction appends waiting for the quiet gap, in order, and since when. */
  private heldSteers: string[] = [];
  private heldSince = 0;
  private steerTimer: NodeJS.Timeout | undefined;
  /** The agent owes a line (after the opening or a steer) and has said nothing yet. */
  private owesLine = false;
  private reminded = false;
  private remindTimer: NodeJS.Timeout | undefined;
  private staleCapTimer: NodeJS.Timeout | undefined;
  private staleDropped = 0;
  /** Settles a start still waiting for its socket; set only while it waits. */
  private cancelPendingSocket: (() => void) | undefined;
  /** The delegation JSON last sent to Azure (session.start or session.update), so an unchanged one is never sent again. */
  private lastDelegationJson: string | undefined;
  /** The thinker's function calls of the current turn still waiting for their result. */
  private readonly pendingThinkerCalls = new Set<string>();
  private thinkerResponseTimer: NodeJS.Timeout | undefined;
  /**
   * One caller line's reply timing, the same fields as the Voice Live path's row: when the caller's line
   * was final, when the decision step answered, when the steer carrying the guidance went out (the live
   * protocol's equivalent of a response request), then the first chunk of speech after it.
   */
  private replyTiming: ReplyTiming | undefined;
  /** The decision module's latest guidance and the latest context note, both folded into the thinker's delegation. */
  private guidance: string | undefined;
  private contextNote: string | undefined;
  private goodbyeTimer: NodeJS.Timeout | undefined;
  /** The agent has said something since the caller last spoke, and its last full line since then. */
  private agentSpokeSinceCaller = false;
  private lastAgentLineSinceCaller = "";
  /** The thinker called end_call: no more replies are asked of it. */
  private endingCall = false;
  /** The thinker's results of the current turn, for the decision whether it is asked for a reply. */
  private thinkerOutputs: Array<{ name: string; ok: boolean }> = [];
  /** When the caller's last transcript piece came, and the agent's first speech after it. */
  private lastCallerPieceAt = 0;
  private speechSinceCallerAt: number | undefined;
  /** An instruction append waiting for quiet owes a line (a steer), not only information (a context note). */
  private heldOwed = false;
  private readonly onAbort = () => this.finish("caller_hangup");

  constructor(private readonly o: LiveSessionOptions) {}

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

  private emit(type: "tool_call" | "transcript_partial" | "transcript_final" | "turn", data: Record<string, unknown>): void {
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
    this.socket?.send(JSON.stringify(message));
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
    let creds: { liveUrl: string; apiKey: string };
    try {
      creds = this.o.credentials();
      this.socket = await this.openSocket(creds, deadline);
    } catch (err) {
      const code = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "azure_connect_failed";
      this.tool("voice_session_open", this.openInputs(), false, Date.now() - began, code);
      this.finish(code === "azure_start_timeout" ? "start_timeout" : "start_failed");
      throw new Error(code);
    }
    const started = new Promise<void>((resolve, reject) => {
      this.onStarted = resolve;
      this.onStartFailed = reject;
    });
    this.socket.onMessage((raw) => this.handle(raw));
    this.socket.onClose(() => this.finish("azure_closed"));
    const delegation = this.o.thinker?.delegation();
    if (delegation) this.lastDelegationJson = JSON.stringify(delegation);
    this.send({
      type: "session.start",
      event_id: "start",
      session: {
        model: this.o.model,
        instructions: this.o.instructions,
        audio: {
          format: { type: "audio/pcmu", rate: 8000 },
          output: { voice: this.o.voice.startsWith(FRAME_VOICE_PREFIX) ? { id: this.o.voice } : this.o.voice },
        },
        ...(delegation ? { delegation } : {}),
      },
    });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("azure_start_timeout")), Math.max(0, deadline - Date.now()));
      t.unref();
      void started.finally(() => clearTimeout(t)).catch(() => undefined);
    });
    try {
      await Promise.race([started, timeout]);
    } catch (err) {
      const code = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "azure_start_failed";
      this.tool("voice_session_open", this.openInputs(), false, Date.now() - began, code);
      this.finish(code === "azure_start_timeout" ? "start_timeout" : "start_failed");
      throw new AzureStartError(code, err instanceof AzureStartError ? err.azureDetail : undefined);
    }
    this.startedAt = Date.now();
    this.tool(
      "voice_session_open",
      { ...this.openInputs(), staleOutputCapGaps: this.o.staleOutputCapGaps ?? DEFAULT_STALE_OUTPUT_CAP_GAPS },
      true,
      Date.now() - began,
    );
    this.capTimer = setTimeout(() => this.finish("session_cap"), this.o.maxMs);
    this.capTimer.unref();
    this.intent = this.o.disclosure;
    this.steer(`The call just connected. Speak first: say exactly "${this.o.disclosure}" and then stop and listen.`, true);
  }

  /**
   * An instruction append. It goes out at once when the model has been quiet
   * for STEER_QUIET_MS, else when it falls quiet, else at STEER_HOLD_CAP_MS.
   * `owed` marks that the agent now owes a line, which arms the one reminder.
   */
  private steer(content: string, owed: boolean): void {
    if (this.ended) return;
    if (owed) this.oweLine();
    if (owed) this.heldOwed = true;
    this.heldSteers.push(content);
    if (this.heldSteers.length === 1) this.heldSince = Date.now();
    this.flushSteers();
  }

  private flushSteers(): void {
    clearTimeout(this.steerTimer);
    this.steerTimer = undefined;
    if (this.ended || !this.heldSteers.length) return;
    const now = Date.now();
    const quietFor = now - this.lastSpeechAt;
    const heldMs = now - this.heldSince;
    if (quietFor < STEER_QUIET_MS && heldMs < STEER_HOLD_CAP_MS) {
      this.steerTimer = setTimeout(() => this.flushSteers(), Math.min(STEER_QUIET_MS - quietFor, STEER_HOLD_CAP_MS - heldMs));
      this.steerTimer.unref();
      return;
    }
    const steers = this.heldSteers;
    this.heldSteers = [];
    if (heldMs > 0) this.tool("steer_held_for_quiet", { heldMs, count: steers.length, capped: quietFor < STEER_QUIET_MS }, true, heldMs);
    // Only a steer the agent must answer counts as the reply request; a context note is information.
    if (this.heldOwed && this.replyTiming && this.replyTiming.createAt === undefined) this.replyTiming.createAt = now;
    this.heldOwed = false;
    for (const content of steers) this.send({ type: "session.instructions.append", delegation_id: null, content });
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

  /** The caller is waiting and the model has not answered: ask it once more to say its line now. */
  remind(): void {
    if (this.ended || !this.startedAt || !this.owesLine || this.reminded) return;
    this.reminded = true;
    clearTimeout(this.remindTimer);
    // The disclosure is said word for word; any other line keeps its meaning in the model's own words.
    const line = !this.intent
      ? " Reply to them now."
      : this.intent === this.o.disclosure
        ? ` Say exactly "${this.intent}" now.`
        : ` Say this in your own natural words, keeping its meaning: "${this.intent}"`;
    this.tool("remind_voice_model", {}, true, 0);
    this.steer(`The caller is waiting for your reply.${line}`, false);
  }

  /**
   * The socket, or a rejection at the deadline or on stop, whichever comes
   * first. A socket that arrives after that is closed at once and never used.
   */
  private openSocket(creds: { liveUrl: string; apiKey: string }, deadline: number): Promise<LiveSocket> {
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
      const timer = setTimeout(() => settle(new Error("azure_start_timeout")), Math.max(0, deadline - Date.now()));
      timer.unref();
      this.cancelPendingSocket = () => settle(new Error("voice_session_ended"));
      Promise.resolve()
        .then(() => this.o.socketFactory(creds.liveUrl, creds.apiKey))
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
          (err: unknown) => settle(err instanceof Error ? err : new Error("azure_connect_failed")),
        );
    });
  }

  /** What a session open is traced with, the same on success and failure: never the instruction text, only its length. */
  private openInputs(): Record<string, unknown> {
    return {
      model: this.o.model,
      voice: this.o.voice,
      instructionsChars: this.o.instructions.length,
      // Whether the decision tree ran before each reply on this call (the rating board reads it, not today's switch),
      // the router that implies, and the orchestrator, as on Voice Live.
      decisionTree: this.o.onCallerFinal ? "on" : "off",
      decisionRouter: this.o.onCallerFinal ? "decision_model" : "none",
      orchestrator: this.o.orchestrator ?? "direct",
      thinker: this.o.thinker ? "on" : "off",
    };
  }

  private onStarted: () => void = () => undefined;
  private onStartFailed: (err: Error) => void = () => undefined;

  /** Caller audio from the browser: mu-law at 8 kilohertz, base64. */
  sendAudio(base64: string): void {
    if (this.ended || !this.startedAt) return;
    this.inputAudioAppends += 1;
    this.send({ type: "session.input_audio.append", audio: base64 });
  }

  /** A typed caller line (no microphone). It goes through the same path as a transcribed line. */
  async sendCallerText(text: string): Promise<void> {
    if (this.ended) throw new Error("voice_session_ended");
    clearTimeout(this.goodbyeTimer);
    this.agentSpokeSinceCaller = false;
    this.lastAgentLineSinceCaller = "";
    this.callerText = "";
    this.noteCallerLine(text);
    await this.callerFinal(text, true);
  }

  /**
   * Information for the agent, never a line to say (the objectives judge's update, Pat 2026-10-21): appended to
   * gpt-live-1's instructions (it refuses instructions on session.update) and folded into the thinker's delegation.
   */
  sendContextNote(text: string, source: string): void {
    if (this.ended || !this.startedAt || !text.trim()) return;
    this.steer(text, false);
    this.tool("call_context_update", { chars: text.length, source }, true, 0);
    this.contextNote = text;
    this.updateDelegation(this.guidance);
  }

  /** The browser heard the caller start talking over the agent: drop playback now. */
  bargeIn(): void {
    if (this.ended) return;
    this.clearAgentPlayback("caller_spoke_over");
  }

  stop(reason: LiveEndReason = "caller_hangup"): void {
    this.finish(reason);
  }

  private handle(raw: string): void {
    let e: { type?: string; delta?: string; error?: unknown; event?: unknown; session?: unknown; delegation?: unknown };
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    const kind = typeof e.type === "string" ? e.type : "unknown";
    this.eventCounts[kind] = (this.eventCounts[kind] ?? 0) + 1;
    switch (kind) {
      case "session.started":
        this.onStarted();
        return;
      case "session.delegation.created": {
        // For a responses delegation Azure runs the thinker itself; nothing is owed but the trace.
        const d = e.delegation && typeof e.delegation === "object" ? (e.delegation as Record<string, unknown>) : {};
        this.tool("delegation_opened", { target: typeof d.target === "string" ? d.target : "unknown" }, true, 0);
        return;
      }
      case "response.event":
        try {
          this.thinkerEvent(e.event);
        } catch {
          this.tool("thinker_event", {}, false, 0, "thinker_event_failed");
        }
        return;
      case "error": {
        const code = classifyAzureError(e.error);
        if (!this.startedAt) this.onStartFailed(new AzureStartError(code === "azure_error" ? "azure_session_rejected" : code, azureErrorDetail(e.error)));
        else {
          this.tool("voice_provider_error", {}, false, 0, code);
          this.o.onProviderError?.(code, azureErrorDetail(e.error));
          this.finish("azure_error");
        }
        return;
      }
      case "session.closed":
        this.finish("azure_closed");
        return;
      case "session.output_audio.delta":
        if (typeof e.delta !== "string") return;
        if (isSpeech(e.delta)) {
          this.lastSpeechAt = Date.now();
          if (!this.droppingStale) {
            if (this.speechSinceCallerAt === undefined && this.lastCallerPieceAt) this.speechSinceCallerAt = this.lastSpeechAt;
            this.traceReplyTiming();
          }
        }
        if (this.droppingStale) this.staleDropped += 1;
        else this.agentAudio(e.delta);
        return;
      case "session.output_transcript.delta":
        if (typeof e.delta !== "string") return;
        if (this.droppingStale) this.dropStaleText();
        else this.agentDelta(e.delta);
        return;
      case "session.input_transcript.delta":
        if (typeof e.delta === "string") this.callerDelta(e.delta);
        return;
      default:
        return;
    }
  }

  /**
   * One event from the thinker Azure runs, unwrapped from `response.event`. A
   * finished `function_call` item runs through the thinker (the flow tool
   * dispatcher); a finished message or a completed response means the thinker
   * answered with words, which gpt-live-1 speaks itself, so nothing is owed.
   */
  private thinkerEvent(inner: unknown): void {
    if (!this.o.thinker || !inner || typeof inner !== "object") return;
    const ev = inner as { type?: unknown; item?: unknown };
    if (ev.type !== "response.output_item.done" || !ev.item || typeof ev.item !== "object") return;
    const item = ev.item as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (item.type !== "function_call" || typeof item.call_id !== "string" || typeof item.name !== "string") return;
    let args: unknown = {};
    if (typeof item.arguments === "string" && item.arguments.trim()) {
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== "object") args = {};
    clearTimeout(this.thinkerResponseTimer);
    this.pendingThinkerCalls.add(item.call_id);
    void this.runThinkerCall(item.call_id, item.name, args);
  }

  private async runThinkerCall(callId: string, name: string, args: unknown): Promise<void> {
    const thinker = this.o.thinker!;
    const began = Date.now();
    let result: Awaited<ReturnType<LiveThinker["call"]>>;
    try {
      result = await thinker.call(name, args);
    } catch {
      result = { output: JSON.stringify({ ok: false, refused: { code: "run_failed", reason: "error" } }), endCall: false, ok: false, refusedCode: "run_failed" };
    }
    this.tool("thinker_tool_call", { name, callId, ok: result.ok, args: tracedArgs(args), ...(result.endCall ? { endCall: true } : {}) }, result.ok, Date.now() - began, result.refusedCode);
    this.pendingThinkerCalls.delete(callId);
    if (this.ended) return;
    this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: callId, output: result.output } });
    if (result.endCall && !this.endingCall) {
      // As on Voice Live: the call is ending, so the thinker is not asked for a reply to this result or any other.
      // Only when gpt-live-1 has said nothing since the caller last spoke (nothing heard, nothing in flight) does it
      // say one goodbye. The disposition this records starts the call's closing wait (socket-route.ts).
      this.endingCall = true;
      clearTimeout(this.thinkerResponseTimer);
      if (!this.agentSpokeSinceCaller && !this.agentText.trim()) {
        this.intent = "Thanks for your time. Goodbye.";
        this.steer('The call is ending. Say only: "Thanks for your time. Goodbye."', true);
      }
      return;
    }
    this.thinkerOutputs.push({ name, ok: result.ok });
    if (this.endingCall || this.pendingThinkerCalls.size) return;
    clearTimeout(this.thinkerResponseTimer);
    this.thinkerResponseTimer = setTimeout(() => {
      this.thinkerResponseTimer = undefined;
      if (this.ended || this.endingCall || this.pendingThinkerCalls.size) return;
      const outputs = this.thinkerOutputs;
      this.thinkerOutputs = [];
      // As on Voice Live: when the turn only saved facts and the agent already asked its next question, a reply to
      // the results would only ask it again.
      const line = this.agentText.trim() || this.lastAgentLineSinceCaller;
      if (outputs.length && outputs.every((o) => o.ok && SAVE_TOOLS.has(o.name)) && line.endsWith("?")) {
        this.tool("thinker_tool_reply_skipped", { tools: outputs.map((o) => o.name) }, true, 0);
        return;
      }
      this.send({ type: "response.create" });
    }, THINKER_SETTLE_MS);
    this.thinkerResponseTimer.unref();
  }

  /**
   * The thinker's instructions carry the current step guidance; when that
   * changes the delegation is replaced with session.update. Azure refuses
   * `instructions` on session.update, so only the delegation goes.
   */
  private updateDelegation(guidance: string | undefined): void {
    this.guidance = guidance;
    if (!this.o.thinker || this.ended) return;
    const delegation = this.o.thinker.delegation(guidance, this.contextNote);
    const json = JSON.stringify(delegation);
    if (json === this.lastDelegationJson) return;
    this.lastDelegationJson = json;
    this.send({ type: "session.update", session: { delegation } });
    this.tool("thinker_delegation_updated", { chars: json.length }, true, 0);
  }

  /**
   * Azure streams audio at the pace of speech and keeps sending silence between
   * lines, as a phone line would, so audio never marks the end of a turn: only
   * the transcript does. With a line check installed, audio is held until the
   * line is complete; silence before the first words keeps only a short lead-in.
   */
  private agentAudio(b64: string): void {
    if (!this.o.guardAgentLine) return this.o.onAudio(b64);
    this.agentHeld.push(b64);
    if (!this.agentText) this.agentHeld = this.agentHeld.slice(-3);
  }

  private agentDelta(delta: string): void {
    this.agentSpokeSinceCaller = true;
    this.lastAgentAt = Date.now();
    this.lastSpeechAt = this.lastAgentAt;
    // The model is answering: no reminder is owed.
    this.owesLine = false;
    clearTimeout(this.remindTimer);
    this.agentText += delta;
    this.armAgentTimer();
  }

  private armAgentTimer(): void {
    clearTimeout(this.agentTimer);
    this.agentTimer = setTimeout(() => void this.finishAgentTurn(), this.o.turnGapMs ?? 900);
    this.agentTimer.unref();
  }

  private async finishAgentTurn(): Promise<void> {
    const token = this.turnToken;
    const raw = this.agentText.trim();
    const held = this.agentHeld;
    this.agentText = "";
    this.agentHeld = [];
    if (!raw && !held.length) return;
    let line: string | null = raw;
    if (this.o.guardAgentLine) {
      const began = Date.now();
      try {
        line = await this.o.guardAgentLine(raw);
      } catch {
        line = null;
      }
      this.tool("guard_agent_line", { chars: raw.length }, line !== null, Date.now() - began, line === null ? "agent_line_blocked" : undefined);
      if (this.ended || token !== this.turnToken) return;
      if (line !== null) for (const chunk of held) this.o.onAudio(chunk);
    }
    if (line === null) return;
    this.recordAgentLine(line, false);
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

  private recordAgentLine(text: string, interrupted: boolean): void {
    if (!text) return;
    // As on Voice Live: a goodbye heard in full, then no caller speech for a few seconds, and the call ends.
    if (!interrupted) this.lastAgentLineSinceCaller = text;
    if (!interrupted && GOODBYE.test(text) && !this.ended) {
      clearTimeout(this.goodbyeTimer);
      this.goodbyeTimer = setTimeout(() => {
        if (this.ended) return;
        this.tool("agent_goodbye_hang_up", { waitedMs: GOODBYE_HANG_UP_MS }, true, 0);
        this.finish("agent_goodbye");
      }, GOODBYE_HANG_UP_MS);
      this.goodbyeTimer.unref();
    }
    const index = this.nextTurnIndex();
    const data = { role: "agent", text, turnIndex: index, spoken: !interrupted, source: "voice_module" };
    if (!interrupted && this.intent) {
      const score = overlap(this.intent, text);
      this.tool("spoken_vs_intended", { intended: this.intent, spoken: text, overlap: Number(score.toFixed(2)), diverged: score < 0.3 }, true, 0);
    }
    if (!interrupted) this.intent = undefined;
    if (this.o.dialogOwnsTranscript) this.emit("turn", data);
    else this.emit("transcript_final", data);
  }

  private clearAgentPlayback(reason: string): void {
    const speaking = Date.now() - this.lastAgentAt < 4000 || this.agentText;
    if (!speaking) return;
    clearTimeout(this.agentTimer);
    this.turnToken += 1;
    const partial = this.agentText.trim();
    this.agentText = "";
    this.agentHeld = [];
    this.o.onClearPlayback();
    this.lastAgentAt = 0;
    this.tool("clear_playback", { reason }, true, 0);
    this.recordAgentLine(partial, true);
    this.startDroppingStale();
  }

  /** Drops the interrupted line's output still in flight; see staleOutputCapGaps. */
  private startDroppingStale(): void {
    const capGaps = this.o.staleOutputCapGaps ?? DEFAULT_STALE_OUTPUT_CAP_GAPS;
    if (capGaps === 0) return;
    const gap = this.o.turnGapMs ?? 900;
    this.droppingStale = true;
    this.staleDropped = 0;
    clearTimeout(this.staleCapTimer);
    this.staleCapTimer = setTimeout(() => this.stopDroppingStale(), gap * capGaps);
    this.staleCapTimer.unref();
    this.dropStaleText();
  }

  /** Each stale transcript fragment pushes the quiet gap back, up to the cap. */
  private dropStaleText(): void {
    clearTimeout(this.staleQuietTimer);
    this.staleQuietTimer = setTimeout(() => this.stopDroppingStale(), this.o.turnGapMs ?? 900);
    this.staleQuietTimer.unref();
  }

  private stopDroppingStale(): void {
    if (!this.droppingStale) return;
    this.droppingStale = false;
    clearTimeout(this.staleQuietTimer);
    clearTimeout(this.staleCapTimer);
    if (this.staleDropped) this.tool("drop_stale_agent_audio", { chunks: this.staleDropped }, true, 0);
    this.staleDropped = 0;
  }

  private callerDelta(delta: string): void {
    // The caller is still talking: no goodbye hang-up.
    clearTimeout(this.goodbyeTimer);
    this.agentSpokeSinceCaller = false;
    this.lastAgentLineSinceCaller = "";
    this.lastCallerPieceAt = Date.now();
    this.speechSinceCallerAt = undefined;
    // The caller talking while the agent is audible is a barge-in.
    this.clearAgentPlayback("caller_spoke_over");
    this.callerText += delta;
    clearTimeout(this.callerTimer);
    this.callerTimer = setTimeout(() => {
      const text = this.callerText.trim();
      this.callerText = "";
      if (text) void this.callerFinal(text, false);
    }, this.o.turnGapMs ?? 900);
    this.callerTimer.unref();
  }

  private noteCallerLine(text: string): void {
    if (!this.o.onCallerFinal) {
      const index = this.nextTurnIndex();
      this.emit("transcript_final", { role: "caller", text, turnIndex: index, source: "voice_module" });
    }
  }

  private async callerFinal(text: string, typed: boolean): Promise<void> {
    if (!typed) this.noteCallerLine(text);
    // With no decision step gpt-live-1 is already answering by now (it starts tens of milliseconds after the caller
    // stops), so the clock starts at the caller's last transcript piece, and a reply already under way is traced at once.
    const selfReply = !this.o.onCallerFinal && !typed && this.lastCallerPieceAt > 0;
    const timing: ReplyTiming = selfReply ? { callerFinalAt: this.lastCallerPieceAt, fromLastCallerPiece: true } : { callerFinalAt: Date.now() };
    this.replyTiming = timing;
    if (selfReply && this.speechSinceCallerAt !== undefined) this.traceReplyTiming(this.speechSinceCallerAt);
    let guidance: string | undefined;
    if (this.o.onCallerFinal) {
      try {
        guidance = await this.o.onCallerFinal(text);
      } catch {
        this.tool("decision_step", {}, false, 0, "decision_step_failed");
      }
    }
    if (this.replyTiming === timing) timing.decisionDoneAt = Date.now();
    if (this.ended) return;
    // The thinker reads the step guidance through its delegation, before the speaker is steered.
    this.updateDelegation(guidance);
    // Its own append, apart from the guidance: this is information for the agent, not words to say.
    if (this.o.contextUpdate) {
      try {
        const update = await this.o.contextUpdate();
        if (update && !this.ended) {
          this.tool("call_context_update", { chars: update.length }, true, 0);
          this.steer(update, false);
        }
      } catch {
        this.tool("call_context_update", {}, false, 0, "call_context_update_failed");
      }
    }
    const said = typed ? `The caller said: "${text}". ` : "";
    const next = guidance
      ? `${said}The decision module chose what to say next. Say this in your own natural words, keeping its meaning: "${guidance}"`
      : typed
        ? `${said}Reply to them naturally.`
        : undefined;
    if (next) {
      this.intent = guidance ?? this.intent;
      this.tool("steer_voice_model", { instruction: next }, true, 0);
      this.steer(next, true);
    }
  }

  /** The `reply_timing` row for the caller line waiting on its first speech, then forgets it. */
  private traceReplyTiming(at?: number): void {
    const t = this.replyTiming;
    if (!t) return;
    this.replyTiming = undefined;
    const now = at ?? Date.now();
    this.tool(
      "reply_timing",
      {
        source: "azure_gpt_live",
        ...(t.fromLastCallerPiece ? { measuredFrom: "caller_last_transcript_piece" } : {}),
        ...(t.decisionDoneAt ? { decisionMs: t.decisionDoneAt - t.callerFinalAt } : {}),
        ...(t.createAt ? { callerFinalToCreateMs: t.createAt - t.callerFinalAt, createToFirstAudioMs: now - t.createAt } : {}),
        callerFinalToFirstAudioMs: now - t.callerFinalAt,
      },
      true,
      now - t.callerFinalAt,
    );
  }

  private finish(reason: LiveEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.o.signal?.removeEventListener("abort", this.onAbort);
    this.cancelPendingSocket?.();
    clearTimeout(this.staleQuietTimer);
    clearTimeout(this.staleCapTimer);
    clearTimeout(this.capTimer);
    clearTimeout(this.agentTimer);
    clearTimeout(this.callerTimer);
    clearTimeout(this.steerTimer);
    clearTimeout(this.remindTimer);
    clearTimeout(this.thinkerResponseTimer);
    clearTimeout(this.goodbyeTimer);
    this.pendingThinkerCalls.clear();
    const durationMs = this.durationMs;
    // Whatever was said but not yet closed by a quiet gap still belongs in the record.
    if (this.startedAt) {
      if (!this.o.guardAgentLine) this.recordAgentLine(this.agentText.trim(), false);
      const heard = this.callerText.trim();
      if (heard) this.noteCallerLine(heard);
    }
    try {
      this.send({ type: "session.close" });
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.onStartFailed(new Error("azure_closed_before_start"));
    // Event kinds and counts only, never content, as on Voice Live.
    if (this.startedAt) this.tool("voice_session_close", { reason, eventKinds: { ...this.eventCounts }, inputAudioAppends: this.inputAudioAppends }, true, durationMs);
    this.o.onEnd({ durationMs, reason });
  }
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
