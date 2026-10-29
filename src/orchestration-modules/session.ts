import { createHash, randomUUID } from "node:crypto";
import { validateAgentSystemInstruction } from "../modules/agent-instructions.js";
import { OrchestrationError, type ConfigSnapshot, type DecisionRuntime, type ErrorCode,
  type OrchestrationModule, type OrchestrationTransport, type SessionConfig, type SessionEvent, type SessionState } from "./contract.js";

function snapshotOf(config: SessionConfig): ConfigSnapshot {
  const clean: SessionConfig = {
    orchestrationId: config.orchestrationId, mode: config.mode, input: config.input,
    voiceProviderId: config.voiceProviderId, decisionModelId: config.decisionModelId,
    promptSetupId: config.promptSetupId, decisionRoute: config.decisionRoute,
    configurationRevision: config.configurationRevision,
  };
  for (const value of Object.values(clean)) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new OrchestrationError("invalid_config");
  }
  if (!["live", "simulator"].includes(clean.mode) || !["text", "audio"].includes(clean.input)
    || !["deterministic", "azure-foundry"].includes(clean.decisionRoute)) throw new OrchestrationError("invalid_config");
  return Object.freeze({ ...clean, snapshotId: createHash("sha256").update(JSON.stringify(clean)).digest("hex") });
}

export interface SessionOptions {
  traceId?: string;
  timeoutMs?: number;
  onEvent?: (event: SessionEvent) => void;
  /** Standing rules plus lead packet; required for every session (Pipecat DecisionBridge and own adapter). */
  systemInstruction: string;
}

export class OrchestrationSession {
  readonly sessionId = randomUUID();
  readonly traceId: string;
  readonly snapshot: ConfigSnapshot;
  private currentState: SessionState = "created";
  private failureCode?: ErrorCode;
  private history: SessionEvent[] = [];
  private transport: OrchestrationTransport;
  private controller = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private endPromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private accepting = false;
  private readonly timeoutMs: number;
  readonly systemInstruction: string;

  constructor(module: OrchestrationModule, config: SessionConfig, private decision: DecisionRuntime, private options: SessionOptions) {
    this.snapshot = snapshotOf(config);
    this.traceId = options.traceId ?? randomUUID();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(this.traceId)) throw new OrchestrationError("invalid_config");
    try {
      validateAgentSystemInstruction(options.systemInstruction);
    } catch {
      throw new OrchestrationError("invalid_config");
    }
    this.systemInstruction = options.systemInstruction;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000
      || module.id !== this.snapshot.orchestrationId || decision.route !== this.snapshot.decisionRoute) throw new OrchestrationError("invalid_config");
    const caps = module.capabilities();
    if (caps.unavailableReason) throw new OrchestrationError("unavailable");
    const supported = this.snapshot.input === "audio"
      ? (this.snapshot.mode === "live" ? caps.liveAudio : caps.simulatorAudio)
      : (this.snapshot.mode === "live" ? caps.liveText : caps.simulatorText);
    if (!supported) throw new OrchestrationError("unsupported_capability");
    this.transport = module.createTransport();
  }
  get state(): SessionState { return this.currentState; }
  events(): SessionEvent[] { return this.history.map((event) => ({ ...event })); }
  private emit(type: SessionEvent["type"], fields: { text?: string; code?: ErrorCode } = {}) {
    const event = Object.freeze({ sequence: this.history.length + 1, occurredAt: new Date().toISOString(),
      sessionId: this.sessionId, traceId: this.traceId, snapshotId: this.snapshot.snapshotId,
      moduleId: this.snapshot.orchestrationId, type, ...fields });
    this.history.push(event);
    // Observers cannot change lifecycle or turn a successfully delivered line into a failed turn.
    try { this.options.onEvent?.(event); } catch { /* caller owns observer failures */ }
  }
  private terminal() { return ["ended", "cancelled", "failed"].includes(this.currentState); }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) throw new OrchestrationError("cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
        abort = () => reject(new OrchestrationError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new OrchestrationError("timeout")), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  private async failed(error: unknown): Promise<never> {
    const code = error instanceof OrchestrationError ? error.code : "provider_failed";
    if (!this.terminal()) {
      this.currentState = "failed";
      this.failureCode = code;
      this.accepting = false;
      this.emit("error", { code });
      this.controller.abort();
      await this.cleanup();
    }
    throw new OrchestrationError(this.currentState === "cancelled" ? "cancelled" : this.failureCode ?? code);
  }
  private async cleanup() {
    // A defective transport must not make cancellation or failure hang indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(() => this.transport.cancel()).catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  }
  async start(): Promise<void> {
    if (this.currentState !== "created") throw new OrchestrationError("invalid_state");
    this.currentState = "starting"; this.emit("starting");
    try {
      await this.bounded(() => this.transport.open(this.controller.signal, (code) => {
        if (!this.terminal()) void this.failed(new OrchestrationError(code)).catch(() => {});
      }));
      if (this.terminal()) throw new OrchestrationError("cancelled");
      this.currentState = "active"; this.accepting = true; this.emit("started");
    } catch (error) { await this.failed(error); }
  }
  /** Manual text and the canonical automated lead both enter this same ordered path. */
  say(text: string): Promise<string> {
    if (!this.accepting || this.currentState !== "active") return Promise.reject(new OrchestrationError("invalid_state"));
    if (typeof text !== "string" || !text.trim() || text.length > 32_000) return Promise.reject(new OrchestrationError("invalid_config"));
    const operation = this.tail.then(async () => {
      if (this.terminal()) throw new OrchestrationError("cancelled");
      this.emit("caller_text", { text });
      try {
        const answer = await this.bounded(() => this.transport.exchange(text, async (callerText) => {
          if (this.controller.signal.aborted) throw new OrchestrationError("cancelled");
          const answer = await this.decision.reply(callerText, { signal: this.controller.signal,
            sessionId: this.sessionId, traceId: this.traceId, snapshot: this.snapshot, systemInstruction: this.systemInstruction });
          if (typeof answer !== "string" || !answer.trim() || answer.length > 32_000) throw new OrchestrationError("protocol_error");
          return answer;
        }, this.controller.signal));
        if (this.terminal()) throw new OrchestrationError("cancelled");
        this.emit("agent_text", { text: answer });
        return answer;
      } catch (error) { return this.failed(error); }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    if (this.currentState === "ended") return Promise.resolve();
    if (this.currentState !== "active") return Promise.reject(new OrchestrationError("invalid_state"));
    this.accepting = false;
    this.endPromise = (async () => {
      await this.tail;
      if (this.terminal()) return;
      this.currentState = "ending"; this.emit("ending");
      try {
        await this.bounded(() => this.transport.close());
        if (this.terminal()) return;
        this.currentState = "ended"; this.emit("ended");
      } catch (error) { await this.failed(error); }
    })();
    return this.endPromise;
  }
  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.terminal()) return Promise.resolve();
    this.accepting = false; this.currentState = "cancelled";
    this.controller.abort(); this.emit("cancelled");
    this.cancelPromise = this.cleanup();
    return this.cancelPromise;
  }
}
