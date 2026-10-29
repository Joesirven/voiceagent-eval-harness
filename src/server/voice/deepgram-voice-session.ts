/**
 * Live session on the Deepgram path: a Pipecat sidecar runs Deepgram speech to
 * text, the Azure reply driven by the agent instruction, and Deepgram speech.
 * This class is the Node side. It records the same trace events as
 * AzureLiveSession (transcripts or turns, clear_playback, spoken_vs_intended,
 * voice_session_open and close), runs the decision hook on each finished
 * caller line, applies the line guard, and enforces the session cap.
 */

import { traceBus, type TraceContext } from "../../trace/index.js";
import type { StaleOutputCapGaps } from "../../modules/azure-live-session.js";
import type { HarnessLiveSession } from "../../modules/open-live-session.js";
import { DeepgramVoiceRuntime, type DeepgramSidecarMessage } from "./deepgram-voice-runtime.js";
import { chosenDecisionRouter } from "./decision-router.js";

export const DEEPGRAM_MODE = "deepgram_pipecat" as const;
/** A cleared message right after our own clear is the sidecar echoing it: relayed, but not traced twice. */
const CLEAR_ECHO_MS = 400;
/** The agent counts as audible for this long after its last audio. */
const AUDIBLE_MS = 4000;
/** Agent audio is mu-law at 8 kilohertz: one byte per sample, so 8 bytes a millisecond. */
const AUDIO_BYTES_PER_MS = 8;
/** The browser starts and buffers playback a little after Node sends the audio. */
const DISCLOSURE_MARGIN_MS = 250;
const CLEAR_REASONS = new Set(["interim_transcript", "final_transcript", "typed_text", "host_barge_in", "reply_failed"]);
const METRIC_STAGES = new Set(["speech_to_text", "reply", "text_to_speech"]);
const METRIC_KINDS = new Set(["time_to_first_byte", "processing"]);
const CODE = /^[a-z][a-z0-9_]{0,60}$/;

export interface DeepgramSessionOptions {
  trace: TraceContext;
  instructions: string;
  disclosure: string;
  maxMs: number;
  turnGapMs?: number;
  staleOutputCapGaps?: StaleOutputCapGaps;
  /** An Aura-2 voice id (sidecar default when absent). */
  voice?: string;
  /** A Deepgram speech to text model (sidecar default when absent). */
  sttModel?: string;
  startTimeoutMs?: number;
  signal?: AbortSignal;
  dialogOwnsTranscript: boolean;
  guardAgentLine?: (line: string) => string | null | Promise<string | null>;
  onCallerFinal?: (text: string) => Promise<string | undefined>;
  /** Call context for the agent; text only when it changed since the last one. Sent beside the guidance, never inside it. */
  contextUpdate?: () => Promise<string | undefined>;
  onAudio: (base64: string) => void;
  onClearPlayback: () => void;
  /** Same shape as the Azure session's; the Deepgram helper sends fixed codes only. */
  onProviderError?: (code: string, azureDetail?: string) => void;
  onEnd: (summary: { durationMs: number; reason: string }) => void;
  /** Tests inject a runtime bound to a fake sidecar. */
  runtime?: DeepgramVoiceRuntime;
}

/** Same limit the sidecar applies before it plays a line with no guard verdict. */
const GUARD_TIMEOUT_MS = 2000;

export class DeepgramLiveSession implements HarnessLiveSession {
  readonly sessionMode = DEEPGRAM_MODE;
  private readonly runtime: DeepgramVoiceRuntime;
  private startedAt = 0;
  private ended = false;
  private capTimer: NodeJS.Timeout | undefined;
  private intent: string | undefined;
  /** The sidecar may report the disclosure (line 0) once; later line-0 messages are ignored and traced. */
  private disclosureSeen = false;
  private lastAudioAt = 0;
  /** Like lastAudioAt, but never reset by a clear: the caller_partial timing in the dev log uses it. */
  private lastAgentAudioAt = 0;
  /** When the browser will have played every agent audio chunk sent so far, at real time. */
  private playbackEndsAt = 0;
  /** Set from agent_line 0: the end of the disclosure's audible window. Until then the disclosure is protected. */
  private disclosureEndsAt: number | undefined;
  private bargeInIgnoredTraced = false;
  private lastClearAt = 0;
  /**
   * A sidecar cleared that arrived while the disclosure was still playing in
   * the browser waits for its end, and the audio that came after it (fresh)
   * waits with it, so the clear cannot cut the end of the disclosure.
   */
  private deferredClear: { reason: string; audio: string[]; timer?: NodeJS.Timeout } | undefined;
  private lineQueue: Promise<void> = Promise.resolve();
  /** Settles once the disclosure (line 0) is recorded; it has no guard, so this is quick. */
  private disclosureRecorded: Promise<void> = Promise.resolve();
  private readonly onAbort = () => this.finish("caller_hangup");

  constructor(private readonly o: DeepgramSessionOptions) {
    this.runtime = o.runtime ?? new DeepgramVoiceRuntime();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
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

  async start(): Promise<void> {
    const began = Date.now();
    if (this.ended) throw new Error("voice_session_ended");
    if (this.o.signal?.aborted) {
      this.finish("caller_hangup");
      throw new Error("voice_session_ended");
    }
    this.o.signal?.addEventListener("abort", this.onAbort, { once: true });
    const gaps = this.o.staleOutputCapGaps ?? 1;
    // Which router picks the tree node on this call, so the record says what ran.
    const decisionRouter = chosenDecisionRouter("deepgram");
    // The disclosure is recorded when the sidecar reports it (agent_line 0), which can arrive before start() returns.
    this.intent = this.o.disclosure;
    try {
      await this.runtime.start(
        {
          instructions: this.o.instructions,
          disclosure: this.o.disclosure,
          turn_gap_ms: this.o.turnGapMs ?? 900,
          stale_output_cap_gaps: gaps,
          guard: Boolean(this.o.guardAgentLine),
          ...(this.o.voice ? { voice: this.o.voice } : {}),
          ...(this.o.sttModel ? { stt_model: this.o.sttModel } : {}),
        },
        { onMessage: (m) => this.handle(m), onFailure: (code) => this.failed(code) },
        this.o.startTimeoutMs,
      );
    } catch (err) {
      const code = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "deepgram_start_failed";
      this.tool("voice_session_open", { provider: "deepgram", decisionRouter }, false, Date.now() - began, code);
      this.finish(code === "deepgram_start_timeout" ? "start_timeout" : "start_failed");
      throw new Error(code);
    }
    if (this.ended) throw new Error("voice_session_ended");
    this.startedAt = Date.now();
    this.tool("voice_session_open", { provider: "deepgram", staleOutputCapGaps: gaps, decisionRouter }, true, Date.now() - began);
    this.capTimer = setTimeout(() => this.finish("session_cap"), this.o.maxMs);
    this.capTimer.unref();
  }

  sendAudio(base64: string): void {
    if (this.ended || !this.startedAt) return;
    this.runtime.sendCallerAudio(base64);
  }

  /** A typed caller line: the sidecar answers with caller_final, so it takes the spoken path from there. */
  async sendCallerText(text: string): Promise<void> {
    if (this.ended) throw new Error("voice_session_ended");
    this.runtime.sendCallerText(text);
  }

  /**
   * The browser heard the caller talking over the agent. Ignored until the
   * disclosure has finished playing: the sidecar reports line 0 at its stop
   * frame, before the browser has played it all, so the protection lasts to
   * the end of its audio at real time. This and the sidecar's gates stand in
   * for Pipecat's MuteUntilFirstBotCompleteUserMuteStrategy and
   * MinWordsUserTurnStartStrategy, which need an output transport (later work).
   */
  bargeIn(): void {
    if (this.ended) return;
    if (this.disclosureProtected()) {
      if (!this.bargeInIgnoredTraced) this.tool("barge_in_ignored", {}, true, 0, "disclosure_playing");
      this.bargeInIgnoredTraced = true;
      return;
    }
    this.runtime.bargeIn();
    if (Date.now() - this.lastAudioAt < AUDIBLE_MS) {
      this.lastClearAt = Date.now();
      this.clearPlayback("browser_loudness");
    }
  }

  private disclosureProtected(): boolean {
    return this.disclosureEndsAt === undefined || Date.now() < this.disclosureEndsAt;
  }

  stop(reason: string = "caller_hangup"): void {
    this.finish(reason);
  }

  private clearPlayback(reason: string, traced = true): void {
    this.lastAudioAt = 0;
    this.playbackEndsAt = 0;
    this.o.onClearPlayback();
    if (traced) this.tool("clear_playback", { reason }, true, 0);
  }

  private handle(m: DeepgramSidecarMessage): void {
    if (this.ended) return;
    switch (m.type) {
      case "audio_out":
        if (typeof m.data !== "string") return;
        if (this.deferredClear) {
          this.deferredClear.audio.push(m.data);
          return;
        }
        this.noteAudio(m.data);
        this.o.onAudio(m.data);
        return;
      case "cleared": {
        // Always relayed: the sidecar's clear marks where stale audio ends. Only the trace of an echo of our own clear is dropped.
        const reason = typeof m.reason === "string" && CLEAR_REASONS.has(m.reason) ? m.reason : "sidecar_clear";
        const traced = Date.now() - this.lastClearAt >= CLEAR_ECHO_MS;
        // A cleared behind a deferred one waits with it (it may arrive after the disclosure's end, before the timer has run).
        if (this.disclosureProtected() || this.deferredClear) {
          // The sidecar's protection ends when its audio was sent; the browser plays it later. Traced now, cleared at the disclosure's end.
          if (traced) this.tool("clear_playback", { reason }, true, 0);
          // Audio held behind an earlier deferred clear is stale now.
          if (this.deferredClear) this.deferredClear.audio = [];
          else this.deferredClear = { reason, audio: [] };
          this.scheduleDeferredClear();
          return;
        }
        this.clearPlayback(reason, traced);
        return;
      }
      case "caller_partial":
        if (typeof m.text !== "string") return;
        // Timing and a word count only, never the caller's words.
        console.log(
          `voice deepgram caller_partial call=${this.o.trace.callId} words=${m.text.trim().split(/\s+/).filter(Boolean).length} since_agent_audio_ms=${this.lastAgentAudioAt ? Date.now() - this.lastAgentAudioAt : -1}`,
        );
        return;
      case "stats": {
        const count = (v: unknown) => (Number.isInteger(v) ? v : -1);
        console.log(`voice deepgram stats call=${this.o.trace.callId} audio_in=${count(m.audio_in)} stt_final=${count(m.stt_final)} tts_chunks=${count(m.tts_chunks)}`);
        return;
      }
      case "metrics":
        if (Number.isInteger(m.turn) && METRIC_STAGES.has(m.stage) && METRIC_KINDS.has(m.kind) && Number.isInteger(m.milliseconds)) {
          this.tool("voice_metrics", { turn: m.turn, stage: m.stage, kind: m.kind, milliseconds: m.milliseconds }, true, 0);
        }
        return;
      case "warning":
        // Non-fatal: the sidecar keeps the call going (and may speak a fallback line), so the session does not end.
        this.tool("voice_provider_warning", {}, false, 0, typeof m.code === "string" && CODE.test(m.code) ? m.code : "deepgram_warning");
        return;
      case "caller_final":
        if (typeof m.text === "string" && typeof m.turn === "number" && m.text.trim()) {
          const { turn, text } = m;
          // A caller line held during the disclosure arrives right behind agent_line 0, so it waits for that record.
          void this.disclosureRecorded.then(() => this.callerFinal(turn, text.trim()));
        }
        return;
      case "agent_line":
        // Line 0 ends the disclosure's protection at the end of its audio, whatever its text; the record waits in the queue.
        // Any later line means the disclosure is over too, so a missing line 0 cannot turn barge-in off for the whole call.
        if (typeof m.line_id === "number" && this.disclosureEndsAt === undefined) {
          this.disclosureEndsAt = Math.max(this.playbackEndsAt, Date.now()) + DISCLOSURE_MARGIN_MS;
          this.scheduleDeferredClear();
        }
        if (typeof m.text === "string" && typeof m.line_id === "number") {
          const { line_id: id, text } = m;
          // One line at a time, in arrival order, so a slow guard cannot reorder lines.
          this.lineQueue = this.lineQueue.then(() => this.agentLine(id, text.trim(), m.interrupted === true));
          if (id === 0) this.disclosureRecorded = this.lineQueue;
        }
        return;
      case "stale_dropped":
        if (typeof m.chunks === "number" && m.chunks > 0) this.tool("drop_stale_agent_audio", { chunks: m.chunks }, true, 0);
        return;
      case "error": {
        const code = typeof m.code === "string" && CODE.test(m.code) ? m.code : "deepgram_failed";
        this.tool("voice_provider_error", {}, false, 0, code);
        this.o.onProviderError?.(code);
        this.finish("deepgram_error");
        return;
      }
      case "ended":
        this.finish("server_stop");
        return;
      default:
        return;
    }
  }

  /** Runs a deferred clear once the disclosure's end is known and reached, then plays the audio held behind it. */
  private scheduleDeferredClear(): void {
    const pending = this.deferredClear;
    if (!pending || pending.timer || this.disclosureEndsAt === undefined) return;
    pending.timer = setTimeout(() => {
      if (this.ended || this.deferredClear !== pending) return;
      this.deferredClear = undefined;
      this.clearPlayback(pending.reason, false);
      for (const data of pending.audio) {
        this.noteAudio(data);
        this.o.onAudio(data);
      }
    }, Math.max(0, this.disclosureEndsAt - Date.now()));
    pending.timer.unref();
  }

  private noteAudio(base64: string): void {
    const now = Date.now();
    this.lastAudioAt = now;
    this.lastAgentAudioAt = now;
    this.playbackEndsAt = Math.max(this.playbackEndsAt, now) + Buffer.byteLength(base64, "base64") / AUDIO_BYTES_PER_MS;
  }

  private failed(code: string): void {
    // While starting, the start call reports the failure itself.
    if (this.ended || !this.startedAt) return;
    this.tool("voice_provider_error", {}, false, 0, code);
    this.o.onProviderError?.(code);
    this.finish("deepgram_error");
  }

  private nextTurnIndex(): number {
    let max = -1;
    for (const e of traceBus.history()) {
      if (e.callId === this.o.trace.callId && (e.type === "transcript_final" || e.type === "turn") && typeof e.data.turnIndex === "number") {
        max = Math.max(max, e.data.turnIndex);
      }
    }
    return max + 1;
  }

  private async callerFinal(turn: number, text: string): Promise<void> {
    // With the dialog installed, it records the caller line itself.
    if (!this.o.onCallerFinal) this.emit("transcript_final", { role: "caller", text, turnIndex: this.nextTurnIndex(), source: "voice_module" });
    let guidance: string | undefined;
    if (this.o.onCallerFinal) {
      try {
        guidance = await this.o.onCallerFinal(text);
      } catch {
        this.tool("decision_step", {}, false, 0, "decision_step_failed");
      }
    }
    if (this.ended) return;
    let context: string | undefined;
    if (this.o.contextUpdate) {
      try {
        context = await this.o.contextUpdate();
        if (context) this.tool("call_context_update", { chars: context.length }, true, 0);
      } catch {
        this.tool("call_context_update", {}, false, 0, "call_context_update_failed");
      }
    }
    if (guidance) {
      this.intent = guidance;
      this.tool("steer_voice_model", { instruction: guidance }, true, 0);
    }
    this.runtime.sendGuidance(turn, guidance ?? null, context);
  }

  private async agentLine(lineId: number, raw: string, interrupted: boolean): Promise<void> {
    if (!raw && lineId === 0 && !this.disclosureSeen) {
      // Text to speech failed before any word of the disclosure: nothing was heard, so nothing is recorded as said.
      this.disclosureSeen = true;
      this.tool("disclosure_check", { lineId, interrupted }, false, 0, "disclosure_not_spoken");
      return;
    }
    if (!raw) return;
    if (lineId === 0) {
      if (this.disclosureSeen) {
        this.tool("disclosure_check", { lineId }, false, 0, "duplicate_disclosure_line");
        return;
      }
      this.disclosureSeen = true;
      // The record is only as good as the sidecar's report, so say plainly when it is not the disclosure.
      // Both directions: every expected word was said, and nothing substantial was added to it.
      const score = Math.min(overlap(this.o.disclosure, raw), overlap(raw, this.o.disclosure));
      this.tool("disclosure_check", { overlap: Number(score.toFixed(2)), interrupted }, score >= 0.9 && !interrupted, 0, score >= 0.9 ? (interrupted ? "disclosure_cut_off" : undefined) : "disclosure_text_mismatch");
    }
    let line: string | null = raw;
    if (this.o.guardAgentLine && !interrupted && lineId !== 0) {
      const began = Date.now();
      let timedOut = false;
      try {
        // The sidecar plays a line after GUARD_TIMEOUT_MS without a verdict, so Node does not wait longer either.
        line = await Promise.race([
          Promise.resolve(this.o.guardAgentLine(raw)),
          new Promise<string>((resolve) => setTimeout(() => {
            timedOut = true;
            resolve(raw);
          }, GUARD_TIMEOUT_MS).unref()),
        ]);
      } catch {
        line = null;
      }
      this.tool(
        "guard_agent_line",
        { chars: raw.length },
        line !== null,
        Date.now() - began,
        timedOut ? "guard_timeout" : line === null ? "agent_line_blocked" : undefined,
      );
      if (this.ended) return;
      this.runtime.sendLineVerdict(lineId, line);
    }
    if (line === null) return;
    this.recordAgentLine(line, interrupted);
  }

  private recordAgentLine(text: string, interrupted: boolean): void {
    const data = { role: "agent", text, turnIndex: this.nextTurnIndex(), spoken: !interrupted, source: "voice_module" };
    if (!interrupted && this.intent) {
      const score = overlap(this.intent, text);
      this.tool("spoken_vs_intended", { intended: this.intent, spoken: text, overlap: Number(score.toFixed(2)), diverged: score < 0.3 }, true, 0);
    }
    if (!interrupted) this.intent = undefined;
    this.emit(this.o.dialogOwnsTranscript ? "turn" : "transcript_final", data);
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.o.signal?.removeEventListener("abort", this.onAbort);
    clearTimeout(this.capTimer);
    clearTimeout(this.deferredClear?.timer);
    this.deferredClear = undefined;
    const durationMs = this.durationMs;
    if (reason === "server_stop" || reason === "deepgram_error") this.runtime.cancel();
    else this.runtime.stop();
    if (this.startedAt) this.tool("voice_session_close", { reason }, true, durationMs);
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
