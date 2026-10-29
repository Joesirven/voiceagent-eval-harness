import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { pipecatDevtoolsEnv, resolvePipecatPython } from "./pipecat-config.js";
import { OrchestrationError, type ErrorCode, type OrchestrationModule, type OrchestrationTransport } from "./contract.js";

export interface PipecatOptions {
  /** Absolute interpreter path in the pinned sidecar environment. Never received from a browser. */
  pythonPath: string;
}
interface Pending {
  resolve: (value: string) => void;
  reject: (error: OrchestrationError) => void;
  reply?: (text: string) => Promise<string>;
  decisionRequested?: boolean;
  expected: "ready" | "result" | "closed";
}
const sidecarPath = fileURLToPath(new URL("./pipecat/sidecar.py", import.meta.url));

/** Runtime unavailable/errors always surface. This module never falls back to the own adapter. */
export class PipecatModule implements OrchestrationModule {
  readonly id = "pipecat" as const;
  private options: PipecatOptions;
  constructor(options: PipecatOptions) { this.options = Object.freeze({ pythonPath: options.pythonPath }); }
  capabilities() {
    const configured = isAbsolute(this.options.pythonPath) && existsSync(this.options.pythonPath) && existsSync(sidecarPath);
    const voiceReady = configured && resolvePipecatPython() === this.options.pythonPath;
    return { moduleId: this.id, liveText: true, simulatorText: true, liveAudio: voiceReady,
      simulatorAudio: false, cancellation: true as const, gracefulEnd: true as const,
      ...(configured ? {} : { unavailableReason: "pipecat_interpreter_not_configured" }) };
  }
  createTransport(): OrchestrationTransport { return new PipecatProcessTransport(this.options); }
}

/** One subprocess per session; no HTTP server, port, inherited credentials or application layer. */
class PipecatProcessTransport implements OrchestrationTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private closing = false;
  private onFailure?: (code: ErrorCode) => void;
  private exited: Promise<void> = Promise.resolve();
  private buffer = "";
  constructor(private options: PipecatOptions) {}
  private fail(code: ErrorCode) {
    const notify = !this.stopped && !this.closing;
    this.stopped = true;
    for (const pending of this.pending.values()) pending.reject(new OrchestrationError(code));
    this.pending.clear();
    this.child?.kill("SIGKILL");
    if (notify) this.onFailure?.(code);
  }
  private write(message: object) {
    if (!this.child || this.stopped || !this.child.stdin.writable) throw new OrchestrationError("unavailable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private async receive(raw: string) {
    let message: { id: number; type?: string; error?: string; text?: string; version?: string };
    try { message = JSON.parse(raw); } catch { this.fail("protocol_error"); return; }
    if (!message || typeof message !== "object" || !Number.isInteger(message.id)) { this.fail("protocol_error"); return; }
    if (message.error) { this.fail(message.error === "unavailable" ? "unavailable" : message.error === "timeout" ? "timeout" : "provider_failed"); return; }
    const pending = this.pending.get(message.id);
    if (!pending) { this.fail("protocol_error"); return; }
    if (message.type === "decision") {
      if (!pending.reply || pending.decisionRequested || typeof message.text !== "string" || message.text.length > 32_000) { this.fail("protocol_error"); return; }
      pending.decisionRequested = true;
      try {
        const text = await pending.reply(message.text);
        if (!this.stopped) this.write({ id: message.id, type: "reply", text });
      } catch { this.fail("provider_failed"); }
      return;
    }
    if (message.type !== pending.expected || (message.type === "ready" && message.version !== "1.13.0")
      || (message.type === "result" && (!pending.decisionRequested || typeof message.text !== "string" || message.text.length > 32_000))) {
      this.fail("protocol_error"); return;
    }
    this.pending.delete(message.id);
    pending.resolve(message.text ?? "");
  }
  async open(signal: AbortSignal, onFailure: (code: ErrorCode) => void) {
    this.onFailure = onFailure;
    if (signal.aborted || this.stopped) throw new OrchestrationError("cancelled");
    const ready = new Promise<string>((resolve, reject) => this.pending.set(0, { resolve, reject, expected: "ready" }));
    this.child = spawn(this.options.pythonPath, ["-I", "-u", sidecarPath], {
      // Do not inherit dotenv paths, provider keys, proxy settings, or user Python modules.
      env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", ...pipecatDevtoolsEnv() }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise<void>((resolve) => {
      this.child!.once("close", () => { this.fail("provider_failed"); resolve(); });
    });
    this.child.once("error", () => this.fail("unavailable"));
    this.child.stdin.on("error", () => this.fail("provider_failed"));
    this.child.stderr.resume(); // Drain library logging without forwarding potentially sensitive diagnostics.
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 262_144) { this.fail("protocol_error"); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        void this.receive(line).catch(() => this.fail("protocol_error"));
      }
    });
    await ready;
    if (signal.aborted) { await this.cancel(); throw new OrchestrationError("cancelled"); }
  }
  private request(type: "text" | "end" | "cancel", text?: string, reply?: Pending["reply"]): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, reply, expected: type === "text" ? "result" : "closed" });
      try { this.write({ id, type, ...(text === undefined ? {} : { text }) }); }
      catch { this.pending.delete(id); reject(new OrchestrationError("unavailable")); }
    });
  }
  async exchange(text: string, reply: (text: string) => Promise<string>, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new OrchestrationError("cancelled");
    return this.request("text", text, reply);
  }
  async close() {
    this.closing = true;
    await this.request("end");
    this.child?.stdin.end();
    await this.exited;
  }
  async cancel() {
    if (!this.child || this.stopped) return;
    this.closing = true;
    // Ask Pipecat to propagate CancelFrame first; forcibly reap if the runtime is hung.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.request("cancel").catch(() => {}), new Promise<void>((resolve) => {
        timer = setTimeout(() => { this.fail("cancelled"); resolve(); }, 500);
      })]);
    } finally {
      clearTimeout(timer);
      this.child.stdin.end();
      this.fail("cancelled");
      await this.exited;
    }
  }
}
