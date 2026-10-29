/**
 * Harness live session where Pipecat PipelineWorker owns ordering and cancellation,
 * and Azure gpt-live-1 is the speech model service behind it.
 */

import type { LiveEndReason } from "../../modules/azure-live-session.js";
import { AzureLiveSession, type LiveSessionOptions } from "../../modules/azure-live-session.js";
import type { HarnessLiveSession } from "../../modules/open-live-session.js";
import { PipecatVoiceRuntime } from "./pipecat-voice-runtime.js";

export type VoiceSessionMode =
  | "pipecat_microphone"
  | "pipecat_text_stand_in"
  | "direct_azure_microphone"
  | "direct_azure_text"
  | "direct_azure_fallback";

export class PipecatOrchestratedLiveSession implements HarnessLiveSession {
  readonly sessionMode: VoiceSessionMode;
  private readonly azure: AzureLiveSession;
  private runtime: PipecatVoiceRuntime;
  private readonly makeRuntime: () => PipecatVoiceRuntime;
  private readonly onRestart?: (code: string) => void;
  private restarted = false;
  private restarting = false;
  private stopping = false;
  private readonly browserOnAudio: (base64: string) => void;
  private readonly browserOnClear: () => void;
  private pipecatReady = false;
  private callerFramesFromBrowser = 0;
  private readonly callId: string;
  private readonly onProviderError?: (code: string, azureDetail?: string) => void;

  constructor(
    sessionMode: VoiceSessionMode,
    azureOptions: LiveSessionOptions,
    browserOnAudio: (base64: string) => void,
    browserOnClear: () => void,
    callId?: string,
    extra: { runtimeFactory?: () => PipecatVoiceRuntime; onRestart?: (code: string) => void } = {},
  ) {
    this.sessionMode = sessionMode;
    this.callId = callId ?? azureOptions.trace.callId ?? "unknown";
    this.onProviderError = azureOptions.onProviderError;
    this.browserOnAudio = browserOnAudio;
    this.browserOnClear = browserOnClear;
    this.makeRuntime = extra.runtimeFactory ?? (() => new PipecatVoiceRuntime());
    this.onRestart = extra.onRestart;
    this.runtime = this.makeRuntime();
    const wrappedOnAudio = (base64: string) => {
      if (this.sessionMode === "pipecat_microphone" && this.pipecatReady) {
        this.runtime.relayModelAudio(base64);
      }
      this.browserOnAudio(base64);
    };
    const wrappedOnClear = () => {
      this.browserOnClear();
    };
    this.azure = new AzureLiveSession({ ...azureOptions, onAudio: wrappedOnAudio, onClearPlayback: wrappedOnClear });
  }

  get isEnded(): boolean {
    return this.azure.isEnded;
  }

  async start(): Promise<void> {
    await this.azure.start();
    if (this.sessionMode === "pipecat_microphone") {
      try {
        await this.runtime.start(this.runtimeHandlers());
      } catch (err) {
        // Azure is already open; do not leave it running for a call that never goes live.
        this.stopping = true;
        this.azure.stop("start_failed");
        throw err;
      }
      this.pipecatReady = true;
    }
  }

  private runtimeHandlers() {
    return {
      onToModel: (data: string) => this.azure.sendAudio(data),
      onFromModel: () => undefined,
      onCleared: () => this.browserOnClear(),
      onFailure: (code: string) => void this.onRuntimeFailure(code),
    };
  }

  /**
   * The relay holds no conversation state (Azure keeps it), so a crashed helper
   * is restarted once while the call stays open. A second failure ends the call.
   */
  private async onRuntimeFailure(code: string): Promise<void> {
    if (this.stopping || this.azure.isEnded) return;
    this.pipecatReady = false;
    if (!this.restarted) {
      this.restarted = true;
      this.restarting = true;
      this.logRelayCounts("restarting", code);
      this.onRestart?.(code);
      try {
        this.runtime = this.makeRuntime();
        await this.runtime.start(this.runtimeHandlers());
        this.pipecatReady = true;
        this.restarting = false;
        return;
      } catch (err) {
        this.restarting = false;
        code = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "pipecat_failed";
      }
    }
    if (this.stopping || this.azure.isEnded) return;
    this.logRelayCounts("failed", code);
    this.onProviderError?.(code);
    this.stop("pipecat_failed" as LiveEndReason);
  }

  private logRelayCounts(phase: string, code?: string): void {
    const suffix = code ? ` code=${code}` : "";
    console.log(
      `voice pipecat relay call=${this.callId} phase=${phase} browser_frames=${this.callerFramesFromBrowser} to_model=${this.runtime.toModelFrames} azure_append=${this.azure.inputAudioAppendCount}${suffix}`,
    );
  }

  stop(reason: LiveEndReason = "caller_hangup"): void {
    this.stopping = true;
    if (this.sessionMode === "pipecat_microphone") this.logRelayCounts("stop");
    void this.runtime.stop().catch(() => undefined);
    this.azure.stop(reason);
  }

  sendAudio(base64: string): void {
    if (this.sessionMode !== "pipecat_microphone") return;
    if (this.restarting || this.stopping) return;
    if (this.runtime.isStopped) {
      this.logRelayCounts("failed", "pipecat_stopped");
      this.onProviderError?.("pipecat_stopped");
      this.stop("pipecat_failed" as LiveEndReason);
      return;
    }
    this.callerFramesFromBrowser += 1;
    const n = this.callerFramesFromBrowser;
    if (n === 1 || n % 50 === 0) this.logRelayCounts("live");
    this.runtime.sendCallerAudio(base64);
  }

  bargeIn(): void {
    if (this.sessionMode === "pipecat_microphone" && this.pipecatReady) this.runtime.bargeIn();
    this.azure.bargeIn();
  }

  remind(): void {
    this.azure.remind();
  }

  async sendCallerText(text: string): Promise<void> {
    await this.azure.sendCallerText(text);
  }
}
