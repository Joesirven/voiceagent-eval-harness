/**
 * Shared mock voice module. Every voice option extends this class, so all of
 * them sit behind the one VoiceProvider interface and share one typed config.
 * No network: a module only fabricates call identifiers and replays scripts.
 */

import { eventsFromScript } from "../orchestration/call-loop.js";
import { redeemClearance } from "../provider/clearance.js";
import type {
  CallDirection,
  CallSession,
  EndCallResult,
  StartInboundParams,
  StartOutboundParams,
  TranscriptEvent,
  TranscriptTurn,
  VoiceProvider,
} from "../provider/interface.js";
import {
  twilioClearOnBargeIn,
  twilioConnectStream,
  twilioEndStream,
  twilioEnqueuePlayback,
} from "./twilio-media-streams.js";
import { peekAzureModuleWiring } from "../server/voice/azure-credentials.js";

export type ModuleBackend = "mock" | "live";

export interface LatencySettings {
  /** Simulated delay before the agent starts speaking. Recorded, never slept. */
  firstResponseMs: number;
  /** Silence the module waits for before treating a caller turn as finished. */
  endpointingMs: number;
}

export interface ModuleConfig {
  enabled: boolean;
  voice: string;
  model: string;
  latency: LatencySettings;
}

export type ModuleConfigPatch = Partial<Omit<ModuleConfig, "latency">> & {
  latency?: Partial<LatencySettings>;
};

export interface ModuleChoices {
  models: string[];
  voices: string[];
}

export interface ModuleInfo {
  id: string;
  label: string;
  config: ModuleConfig;
  /** Dropdown options for the control page; always includes the current values. */
  modelChoices: string[];
  voiceChoices: string[];
  /** Live when every required credential is present in VOICE_HARNESS_DEV_ENV_FILE. */
  backend: ModuleBackend;
  missingEnv: string[];
}

export function validateModuleConfig(cfg: ModuleConfig): void {
  if (!cfg.voice.trim()) throw new Error("voice_required");
  if (!cfg.model.trim()) throw new Error("model_required");
  for (const [key, value] of Object.entries(cfg.latency)) {
    if (!Number.isFinite(value) || value < 0 || value > 10_000) {
      throw new Error(`latency_${key}_out_of_range`);
    }
  }
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

let callSeq = 0;

function withCurrent(choices: string[], current: string): string[] {
  const list = [...choices];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

export abstract class MockVoiceModule implements VoiceProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  /** Prefix for the fake provider-side call identifier. */
  protected abstract readonly callPrefix: string;
  private cfg: ModuleConfig;
  private readonly choices: ModuleChoices;

  constructor(defaults: ModuleConfig, choices?: Partial<ModuleChoices>) {
    this.cfg = structuredClone(defaults);
    this.choices = {
      models: choices?.models?.length ? [...choices.models] : [defaults.model],
      voices: choices?.voices?.length ? [...choices.voices] : [defaults.voice],
    };
  }

  get name(): string {
    return this.id;
  }

  getConfig(): ModuleConfig {
    return structuredClone(this.cfg);
  }

  /** Merge a patch; reject (and keep the old config) when the result is invalid. */
  updateConfig(patch: ModuleConfigPatch): ModuleConfig {
    const next: ModuleConfig = {
      ...this.cfg,
      ...definedOnly(patch),
      latency: { ...this.cfg.latency, ...definedOnly(patch.latency ?? {}) },
    };
    validateModuleConfig(next);
    this.cfg = next;
    return this.getConfig();
  }

  setEnabled(enabled: boolean): void {
    this.cfg.enabled = enabled;
  }

  info(): ModuleInfo {
    const wiring =
      this.id === "azure-gpt-live"
        ? peekAzureModuleWiring()
        : { backend: "mock" as ModuleBackend, missingEnv: [] as string[] };
    const cfg = this.getConfig();
    return {
      id: this.id,
      label: this.label,
      config: cfg,
      modelChoices: withCurrent(this.choices.models, cfg.model),
      voiceChoices: withCurrent(this.choices.voices, cfg.voice),
      backend: wiring.backend,
      missingEnv: wiring.missingEnv,
    };
  }

  /** Hooks for module-specific mock behavior. */
  protected onCallStarted(_callId: string, _session: CallSession): void {}
  protected onCallEnded(_callId: string): void {}

  private startCall(
    direction: CallDirection,
    params: StartInboundParams | StartOutboundParams,
  ): CallSession {
    redeemClearance(params.clearance, {
      leadId: params.leadId,
      direction,
      idempotencyKey: params.idempotencyKey,
    });
    if (!this.cfg.enabled) throw new Error(`module_disabled:${this.id}`);
    callSeq += 1;
    const callId = `${this.callPrefix}_${callSeq}`;
    twilioConnectStream(callId);
    const session: CallSession = {
      callId,
      leadId: params.leadId,
      direction,
      idempotencyKey: params.idempotencyKey,
      startedAt: new Date().toISOString(),
      ...(direction === "outbound" ? { dialOutcome: (params as StartOutboundParams).simulatedOutcome ?? "answered" } : {}),
      stack: ["twilio-media-streams", this.id],
      contextPacket: params.contextPacket,
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
      moduleSnapshot: {
        moduleId: this.id,
        voice: this.cfg.voice,
        model: this.cfg.model,
        latency: { ...this.cfg.latency },
      },
    };
    this.onCallStarted(callId, session);
    return session;
  }

  async startInboundCall(params: StartInboundParams): Promise<CallSession> {
    return this.startCall("inbound", params);
  }

  async startOutboundCall(params: StartOutboundParams): Promise<CallSession> {
    return this.startCall("outbound", params);
  }

  async *streamTranscript(
    session: CallSession,
    script: TranscriptTurn[],
  ): AsyncGenerator<TranscriptEvent, void, undefined> {
    // The harness owns the disclosure turn and puts it first in `script`.
    const bargeTurn = script.find(
      (t) => t.role === "agent" && t.spoken === undefined && t.turnIndex >= 0,
    )?.turnIndex;
    for (const ev of eventsFromScript(script, bargeTurn)) {
      if (ev.type === "barge_in" || ev.type === "playback_cleared") {
        twilioClearOnBargeIn(session.callId);
      }
      if (ev.type === "final" && ev.turn?.role === "agent") {
        twilioEnqueuePlayback(session.callId, ev.turn.text);
      }
      yield ev;
    }
  }

  async endCall(session: CallSession, finalTranscript: TranscriptTurn[]): Promise<EndCallResult> {
    twilioEndStream(session.callId);
    this.onCallEnded(session.callId);
    return { session, finalTranscript };
  }
}
