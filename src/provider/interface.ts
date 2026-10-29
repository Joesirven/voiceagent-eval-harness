import type { LeadContextPacket } from "../memory/context.js";
import type { CallClearance } from "./clearance.js";

export type CallDirection = "inbound" | "outbound";

/** How a mock outbound dial ends: a person answers, voicemail picks up, or nobody does. */
export type DialOutcome = "answered" | "voicemail" | "no_answer";

export interface CallSession {
  callId: string;
  leadId: string;
  direction: CallDirection;
  idempotencyKey: string;
  startedAt: string;
  /** Modules that participated in this session. */
  stack: string[];
  /** Read-only lead packet injected at call start. */
  contextPacket: LeadContextPacket;
  /** Standing rules plus lead packet; same string as live Azure and Pipecat orchestration. */
  systemInstruction?: string;
  /** Outbound only: who or what picked up. Absent means answered. */
  dialOutcome?: DialOutcome;
  /** Module settings in force when the call started. */
  moduleSnapshot?: {
    moduleId: string;
    voice: string;
    model: string;
    latency: { firstResponseMs: number; endpointingMs: number };
  };
}

export interface TranscriptTurn {
  role: "caller" | "agent" | "system";
  text: string;
  turnIndex: number;
  /** Set when this turn survived barge-in (spoken only). */
  spoken?: boolean;
}

export interface TranscriptEvent {
  type: "partial" | "final" | "barge_in" | "playback_cleared";
  turn?: TranscriptTurn;
}

export interface StartInboundParams {
  leadId: string;
  fromNumber: string;
  idempotencyKey: string;
  contextPacket: LeadContextPacket;
  systemInstruction?: string;
  /** Issued by CallHarness after every compliance gate passed. */
  clearance: CallClearance;
}

export interface StartOutboundParams {
  leadId: string;
  toNumber: string;
  idempotencyKey: string;
  contextPacket: LeadContextPacket;
  systemInstruction?: string;
  clearance: CallClearance;
  scheduledReason?: string;
  /** Mock telephony only: how this dial ends. Defaults to answered. */
  simulatedOutcome?: DialOutcome;
}

export interface EndCallResult {
  finalTranscript: TranscriptTurn[];
  session: CallSession;
}

/**
 * Common provider interface for all voice approaches.
 */
export interface VoiceProvider {
  readonly name: string;

  startInboundCall(params: StartInboundParams): Promise<CallSession>;

  startOutboundCall(params: StartOutboundParams): Promise<CallSession>;

  /** Drive the call with scripted caller/agent lines; yields transcript events. */
  streamTranscript(
    session: CallSession,
    script: TranscriptTurn[],
  ): AsyncGenerator<TranscriptEvent, void, undefined>;

  endCall(session: CallSession, finalTranscript: TranscriptTurn[]): Promise<EndCallResult>;
}
