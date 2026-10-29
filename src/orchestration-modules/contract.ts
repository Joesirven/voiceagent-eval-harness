/** Orchestration owns ordering and lifecycle, independently of voice and decisions. */
export type OrchestrationId = "own-infrastructure" | "pipecat";
export type SessionMode = "live" | "simulator";
export type SessionState = "created" | "starting" | "active" | "ending" | "ended" | "cancelled" | "failed";
export type ErrorCode = "unavailable" | "unsupported_capability" | "invalid_config" | "invalid_state" | "provider_failed" | "protocol_error" | "timeout" | "cancelled";
export class OrchestrationError extends Error {
  constructor(readonly code: ErrorCode) { super(`orchestration_${code}`); }
}

/** Identifiers only. Credentials, prompts and mutable service objects never enter snapshots. */
export interface SessionConfig {
  orchestrationId: OrchestrationId;
  mode: SessionMode;
  input: "text" | "audio";
  voiceProviderId: string;
  decisionModelId: string;
  promptSetupId: string;
  decisionRoute: "deterministic" | "azure-foundry";
  configurationRevision: string;
}
export interface ConfigSnapshot extends Readonly<SessionConfig> {
  readonly snapshotId: string;
}
export interface Capabilities {
  readonly moduleId: OrchestrationId;
  readonly liveText: boolean;
  readonly simulatorText: boolean;
  readonly liveAudio: boolean;
  readonly simulatorAudio: boolean;
  readonly cancellation: true;
  readonly gracefulEnd: true;
  readonly unavailableReason?: string;
}
export interface DecisionContext {
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly traceId: string;
  readonly snapshot: ConfigSnapshot;
  /** Standing rules plus lead packet; same content as Azure `session.start` instructions on voice paths. */
  readonly systemInstruction: string;
}
/** Server-installed only. Azure implementation must use the existing frozen Foundry client. */
export interface DecisionRuntime {
  readonly route: "deterministic" | "azure-foundry";
  reply(callerText: string, context: DecisionContext): Promise<string>;
}
export interface SessionEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly snapshotId: string;
  readonly moduleId: OrchestrationId;
  readonly type: "starting" | "started" | "caller_text" | "agent_text" | "ending" | "ended" | "cancelled" | "error";
  readonly text?: string;
  readonly code?: ErrorCode;
}

/** Stable transport seam. Text today; audio implementations must explicitly advertise support.
 * A transport owns its runtime resources. close and cancel must be safe after partial open.
 * reply runs inside the orchestration path, never a substitute provider on failure.
 */
export interface OrchestrationTransport {
  open(signal: AbortSignal, onFailure: (code: ErrorCode) => void): Promise<void>;
  exchange(text: string, reply: (text: string) => Promise<string>, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
  cancel(): Promise<void>;
}
export interface OrchestrationModule {
  readonly id: OrchestrationId;
  capabilities(): Capabilities;
  createTransport(): OrchestrationTransport;
}
