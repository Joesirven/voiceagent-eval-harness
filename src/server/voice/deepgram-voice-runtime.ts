/**
 * One Python sidecar process per Deepgram voice session (Pipecat: Deepgram
 * speech to text, Azure reply, Deepgram speech). Node talks to it in JSON
 * lines on standard input and output; the protocol is in
 * docs/orchestration-modules.md. Credentials reach the child only through its
 * allowlisted environment, never through a message.
 */

import { deepgramReplyDeployment } from "./path-model-choices.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pipecatDevtoolsEnv, resolvePipecatPython } from "../../orchestration-modules/pipecat-config.js";
import { DeepgramCredentialError, loadAzureCredentials, loadDeepgramCredentials, type ConnectorFs } from "../../connectors/credentials.js";

const STDOUT_LINE_CAP = 8 * 1024 * 1024;
const MAX_RAW_AUDIO_BYTES = 48_000;
/** Standard error lines longer than this are cut; a noisy child cannot flood the dev log. */
const STDERR_LINE_CHARS = 300;
const STDERR_LINES_PER_SECOND = 20;
/** Spawn environment names whose values are credentials (the URL's host is scrubbed too). */
const SECRET_ENV = ["DEEPGRAM_API_KEY", "AZURE_FOUNDRY_KEY", "AZURE_FOUNDRY_URL"] as const;

const deepgramSidecarFile = fileURLToPath(new URL("../../orchestration-modules/pipecat/sidecar_deepgram.py", import.meta.url));

export interface SidecarCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Messages the sidecar sends to Node (fixed shapes; see docs/orchestration-modules.md). */
export type DeepgramSidecarMessage =
  | { type: "audio_out"; data: string }
  | { type: "cleared"; reason: DeepgramClearReason }
  | { type: "caller_partial"; text: string }
  | { type: "caller_final"; turn: number; text: string }
  | { type: "agent_line"; line_id: number; text: string; interrupted?: boolean }
  | { type: "stale_dropped"; chunks: number }
  | { type: "stats"; audio_in?: number; stt_final?: number; tts_chunks?: number }
  | { type: "metrics"; turn: number; stage: DeepgramMetricStage; kind: DeepgramMetricKind; milliseconds: number }
  | { type: "warning"; code: string }
  | { type: "error"; code: string }
  | { type: "ended" };

/** What made the sidecar clear its queued speech. */
export type DeepgramClearReason = "interim_transcript" | "final_transcript" | "typed_text" | "host_barge_in";
export type DeepgramMetricStage = "speech_to_text" | "reply" | "text_to_speech";
export type DeepgramMetricKind = "time_to_first_byte" | "processing";

/**
 * Removes every credential value of the spawn environment, the Azure host, and
 * anything shaped like an authorization header from one line of standard error.
 */
export function scrubSidecarLine(line: string, env: Record<string, string>): string {
  const secrets: string[] = [];
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (!value) continue;
    secrets.push(value);
    if (name === "AZURE_FOUNDRY_URL") {
      try {
        const url = new URL(value);
        secrets.push(url.host, url.hostname);
      } catch {
        /* not a URL: the whole value is already scrubbed */
      }
    }
  }
  let out = line;
  // Longest first, so a host inside the full URL does not leave the rest of the URL behind.
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out
    .replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(api[-_]?key|authorization|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[redacted]");
}

export type DeepgramStartConfig = {
  instructions: string;
  disclosure: string;
  turn_gap_ms: number;
  stale_output_cap_gaps: 0 | 1 | 2;
  guard: boolean;
  /** An Aura-2 voice id; the sidecar defaults and validates it. */
  voice?: string;
  /** A Deepgram speech to text model (the `model` query value); the sidecar defaults it to nova-3-general and validates it. */
  stt_model?: string;
};

export type DeepgramRuntimeHandlers = {
  onMessage: (message: DeepgramSidecarMessage) => void;
  onFailure: (code: string) => void;
};

export function deepgramSidecarPath(): string {
  return deepgramSidecarFile;
}

/** The pinned interpreter plus the Deepgram sidecar file, or undefined when either is missing. */
export function resolveDeepgramSidecar(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const python = resolvePipecatPython(env);
  if (!python || !existsSync(deepgramSidecarFile)) return undefined;
  return python;
}

export function deepgramUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!resolvePipecatPython(env)) return "pipecat_interpreter_not_configured";
  if (!existsSync(deepgramSidecarFile)) return "deepgram_sidecar_missing";
  return undefined;
}

/** The real command: pinned Python in isolated mode with an allowlisted environment. Throws a fixed code. */
export function defaultSidecarCommand(processEnv: NodeJS.ProcessEnv = process.env, fs?: ConnectorFs): SidecarCommand {
  const python = resolveDeepgramSidecar(processEnv);
  if (!python) throw new Error(deepgramUnavailableReason(processEnv) ?? "deepgram_sidecar_missing");
  // Allowlisted child environment: only these names, values from the one credential reader.
  let env: Record<string, string>;
  try {
    const azure = loadAzureCredentials(processEnv, fs);
    // The configured harness settings file is the only Deepgram key source.
    const DEEPGRAM_API_KEY = loadDeepgramCredentials(processEnv, fs).apiKey;
    // Always explicit, so the sidecar's own built-in default never decides (it can differ from the options).
    const reply = deepgramReplyDeployment(azure.replyDeployment);
    env = {
      PATH: "/usr/bin:/bin",
      PYTHONIOENCODING: "utf-8",
      ...pipecatDevtoolsEnv(processEnv),
      DEEPGRAM_API_KEY,
      AZURE_FOUNDRY_URL: azure.foundryUrl,
      AZURE_FOUNDRY_KEY: azure.apiKey,
      // The reply deployment chosen in Settings (POST /api/voice/path-models), else the one in the settings file.
      ...(reply ? { AZURE_REPLY_DEPLOYMENT: reply } : {}),
    };
  } catch (err) {
    throw new Error(err instanceof DeepgramCredentialError && err.code === "missing_deepgram_key" ? "deepgram_key_missing" : "deepgram_credentials_unreadable");
  }
  return { command: python, args: ["-I", "-u", deepgramSidecarFile], env };
}

function splitAudio(base64: string): string[] {
  const raw = Buffer.from(base64, "base64");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += MAX_RAW_AUDIO_BYTES) out.push(raw.subarray(i, i + MAX_RAW_AUDIO_BYTES).toString("base64"));
  return out;
}

export class DeepgramVoiceRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stopped = false;
  private handlers?: DeepgramRuntimeHandlers;
  private audioInFrames = 0;
  private onLine: (raw: string) => void = () => undefined;
  private stderrBuffer = "";
  private stderrWindowStart = 0;
  private stderrWindowLines = 0;
  private stderrDropped = 0;
  private stderrSkipping = false;
  /** Set only while waiting for the ready line, so an early exit ends the wait at once. */
  private rejectReady?: (err: Error) => void;

  constructor(private readonly resolveCommand: () => SidecarCommand = defaultSidecarCommand) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  get audioInCount(): number {
    return this.audioInFrames;
  }

  /** Spawns the sidecar, waits for its ready line, then sends the start configuration. */
  async start(config: DeepgramStartConfig, handlers: DeepgramRuntimeHandlers, readyTimeoutMs = 20_000): Promise<void> {
    const cmd = this.resolveCommand();
    this.handlers = handlers;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      timer = setTimeout(() => reject(new Error("deepgram_start_timeout")), readyTimeoutMs);
      timer.unref();
      this.onLine = (raw) => {
        let message: { id?: number; type?: string; error?: string };
        try {
          message = JSON.parse(raw);
        } catch {
          this.fail("protocol_error");
          reject(new Error("protocol_error"));
          return;
        }
        if (message.error) {
          reject(new Error(message.error === "unavailable" ? "deepgram_unavailable" : "deepgram_failed"));
          return;
        }
        if (message.id === 0 && message.type === "ready") {
          this.onLine = (line) => this.dispatch(line);
          resolve();
          return;
        }
        this.dispatch(raw);
      };
    });
    ready.catch(() => undefined);
    this.child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("error", () => this.fail("deepgram_unavailable"));
    this.child.stdin.on("error", () => this.fail("deepgram_failed"));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.forwardStderr(chunk, cmd.env));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > STDOUT_LINE_CAP) return this.fail("protocol_error");
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    this.child.once("close", () => {
      // A last line without a newline is still shown.
      if (!this.stderrSkipping) this.warnLine(this.stderrBuffer, cmd.env);
      this.stderrBuffer = "";
      this.fail("deepgram_closed");
    });
    try {
      this.write({ type: "start", ...config });
      await ready;
    } catch (err) {
      this.kill();
      throw err;
    } finally {
      clearTimeout(timer);
      this.rejectReady = undefined;
    }
  }

  /** Standard error goes to the dev log at warning level, line by line, scrubbed, cut to length and rate limited. */
  private forwardStderr(chunk: string, env: Record<string, string>): void {
    this.stderrBuffer += chunk;
    let newline: number;
    while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (this.stderrSkipping) this.stderrSkipping = false;
      else this.warnLine(line, env);
    }
    // A line with no end in sight is shown once, cut, and the rest of it is dropped up to its newline,
    // so the buffer stays bounded and no later piece can start with the tail of a key.
    if (!this.stderrSkipping && this.stderrBuffer.length > 4 * STDERR_LINE_CHARS) {
      this.warnLine(this.stderrBuffer, env);
      this.stderrSkipping = true;
    }
    if (this.stderrSkipping) this.stderrBuffer = "";
  }

  private warnLine(raw: string, env: Record<string, string>): void {
    if (!raw.trim()) return;
    const now = Date.now();
    if (now - this.stderrWindowStart >= 1000) {
      if (this.stderrDropped) console.warn(`voice deepgram sidecar stderr: ${this.stderrDropped} lines not shown (more than ${STDERR_LINES_PER_SECOND} a second)`);
      this.stderrWindowStart = now;
      this.stderrWindowLines = 0;
      this.stderrDropped = 0;
    }
    if (this.stderrWindowLines >= STDERR_LINES_PER_SECOND) {
      this.stderrDropped += 1;
      return;
    }
    this.stderrWindowLines += 1;
    // Scrubbed before it is cut, so a cut cannot leave part of a key that no longer matches.
    const line = scrubSidecarLine(raw.trimEnd(), env);
    console.warn(`voice deepgram sidecar stderr: ${line.length > STDERR_LINE_CHARS ? `${line.slice(0, STDERR_LINE_CHARS)}...` : line}`);
  }

  private dispatch(raw: string): void {
    if (this.stopped || !this.handlers) return;
    let message: DeepgramSidecarMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return this.fail("protocol_error");
    }
    if (!message || typeof message.type !== "string") return this.fail("protocol_error");
    this.handlers.onMessage(message);
  }

  private write(message: object): void {
    if (!this.child || this.stopped || !this.child.stdin.writable) throw new Error("deepgram_unavailable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private send(message: object): void {
    if (this.stopped) return;
    try {
      this.write(message);
    } catch {
      this.fail("deepgram_failed");
    }
  }

  sendCallerAudio(base64: string): void {
    this.audioInFrames += 1;
    for (const data of splitAudio(base64)) this.send({ type: "audio_in", data });
  }

  sendCallerText(text: string): void {
    this.send({ type: "caller_text", text });
  }

  /** `context` is information for the agent for the next turn (a separate system message), never part of the line to say. */
  sendGuidance(turn: number, text: string | null, context?: string): void {
    this.send({ type: "guidance", turn, text, ...(context ? { context } : {}) });
  }

  sendLineVerdict(lineId: number, text: string | null): void {
    this.send({ type: "line_verdict", line_id: lineId, text });
  }

  bargeIn(): void {
    this.send({ type: "barge_in" });
  }

  /** Graceful end: the sidecar drains and closes. */
  stop(): void {
    this.finish("end");
  }

  cancel(): void {
    this.finish("cancel");
  }

  private finish(type: "end" | "cancel"): void {
    if (this.stopped || !this.child) return;
    try {
      this.write({ type });
      this.stopped = true;
      this.child.stdin.end();
    } catch {
      this.stopped = true;
      this.kill();
    }
    // A sidecar that does not exit on its own is not left running.
    const child = this.child;
    const t = setTimeout(() => child.kill("SIGKILL"), 2000);
    t.unref();
    child.once("close", () => clearTimeout(t));
  }

  private kill(): void {
    this.stopped = true;
    this.child?.kill("SIGKILL");
  }

  private fail(code: string): void {
    if (this.stopped) return;
    this.kill();
    this.rejectReady?.(new Error(code));
    this.handlers?.onFailure(code);
  }
}
