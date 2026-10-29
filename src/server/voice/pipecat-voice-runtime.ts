/**
 * One Pipecat PipelineWorker subprocess per live voice session. Azure credentials
 * and the gpt-live websocket stay in Node; this runtime only orders frames and
 * cancellation.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pipecatDevtoolsEnv, pipecatVoiceSidecarPath, resolvePipecatPython } from "../../orchestration-modules/pipecat-config.js";

const STDOUT_LINE_CAP = 8 * 1024 * 1024;
const MAX_RAW_AUDIO_BYTES = 48_000;

function splitMuLawBase64(base64: string): string[] {
  const raw = Buffer.from(base64, "base64");
  if (!raw.length) return [];
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += MAX_RAW_AUDIO_BYTES) {
    out.push(raw.subarray(i, i + MAX_RAW_AUDIO_BYTES).toString("base64"));
  }
  return out;
}

export type VoiceRuntimeHandlers = {
  onToModel: (base64: string) => void;
  onFromModel: (base64: string) => void;
  onCleared: () => void;
  onFailure: (code: string) => void;
};

export class PipecatVoiceRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stopped = false;
  private handlers?: VoiceRuntimeHandlers;
  private callerInFrames = 0;
  private toModelFrameCount = 0;

  get toModelFrames(): number {
    return this.toModelFrameCount;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  static available(): boolean {
    return resolvePipecatPython() !== undefined;
  }

  async start(handlers: VoiceRuntimeHandlers): Promise<void> {
    const pythonPath = resolvePipecatPython();
    if (!pythonPath) throw new Error("pipecat_not_configured");
    this.handlers = handlers;
    const ready = new Promise<void>((resolve, reject) => {
      const onLine = (raw: string) => {
        let message: { id?: number; type?: string; error?: string; data?: string };
        try {
          message = JSON.parse(raw);
        } catch {
          this.fail("protocol_error");
          return;
        }
        if (message.error) {
          reject(new Error(message.error === "unavailable" ? "pipecat_unavailable" : "pipecat_failed"));
          return;
        }
        if (message.id === 0 && message.type === "ready") {
          resolve();
          return;
        }
        this.dispatch(message);
      };
      this.onLine = onLine;
    });
    this.child = spawn(pythonPath, ["-I", "-u", pipecatVoiceSidecarPath()], {
      env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", ...pipecatDevtoolsEnv() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.once("error", () => this.fail("pipecat_unavailable"));
    this.child.stdin.on("error", () => this.fail("pipecat_failed"));
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > STDOUT_LINE_CAP) {
        this.fail("protocol_error");
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.onLine(line);
      }
    });
    this.child.once("close", () => this.fail("pipecat_closed"));
    await ready;
  }

  private onLine: (raw: string) => void = () => undefined;

  private dispatch(message: { type?: string; data?: string }): void {
    if (this.stopped || !this.handlers) return;
    if (message.type === "to_model" && typeof message.data === "string") {
      this.toModelFrameCount += 1;
      if (this.toModelFrameCount === 1 || this.toModelFrameCount % 50 === 0) {
        console.log(`voice pipecat relay to_model_frames=${this.toModelFrameCount} caller_in=${this.callerInFrames}`);
      }
      this.handlers.onToModel(message.data);
    } else if (message.type === "from_model" && typeof message.data === "string") this.handlers.onFromModel(message.data);
    else if (message.type === "cleared") this.handlers.onCleared();
    else if (message.type === "stats") {
      const stats = message as { audio_in?: number; to_model?: number; model_in?: number };
      if (typeof stats.audio_in === "number" && (stats.audio_in === 1 || stats.audio_in % 50 === 0)) {
        console.log(
          `voice pipecat sidecar stats audio_in=${stats.audio_in} to_model=${stats.to_model ?? "?"} model_in=${stats.model_in ?? "?"}`,
        );
      }
    }
  }

  private write(message: object): void {
    if (!this.child || this.stopped || !this.child.stdin.writable) throw new Error("pipecat_unavailable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  sendCallerAudio(base64: string): void {
    if (this.stopped) return;
    this.callerInFrames += 1;
    try {
      for (const chunk of splitMuLawBase64(base64)) this.write({ type: "audio_in", data: chunk });
    } catch {
      this.fail("pipecat_failed");
    }
  }

  relayModelAudio(base64: string): void {
    if (this.stopped) return;
    try {
      for (const chunk of splitMuLawBase64(base64)) this.write({ type: "model_audio", data: chunk });
    } catch {
      this.fail("pipecat_failed");
    }
  }

  bargeIn(): void {
    if (this.stopped) return;
    try {
      this.write({ type: "barge_in" });
    } catch {
      this.fail("pipecat_failed");
    }
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.child) return;
    this.stopped = true;
    try {
      this.write({ id: 1, type: "end" });
      this.child.stdin.end();
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  async cancel(): Promise<void> {
    if (this.stopped || !this.child) return;
    this.stopped = true;
    try {
      this.write({ id: 1, type: "cancel" });
      this.child.stdin.end();
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  private fail(code: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.child?.kill("SIGKILL");
    this.handlers?.onFailure(code);
  }
}
