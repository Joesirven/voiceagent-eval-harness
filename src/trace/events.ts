/**
 * One trace event model and an in-process event bus. Every step of a call or
 * a text emits an event; the record store writes them to disk and the control
 * page streams them live.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { CallFlowStep, DecisionRecord } from "./extensions.js";

export type TraceEventType =
  | "compliance_check"
  | "tool_call"
  | "turn"
  | "text"
  | "handoff"
  | "call_outcome"
  | "transcript_partial"
  | "transcript_final"
  | "node_enter"
  | "decision"
  | "disposition"
  | "judge_verdict"
  | "judge_error"
  | "judge_score"
  | "voice_error";

export interface TraceEvent {
  /** Order across everything in this process; drives the live stream. */
  seq: number;
  /** Order inside one record, starting at 1 with no gaps, continuing across restarts. */
  recordSeq: number;
  at: string;
  /** Milliseconds since the first event of this record (the call start); lines trace rows up with transcript lines. */
  atMs: number;
  type: TraceEventType;
  leadId: string;
  /** First name only; used for plain-language sentences. */
  leadLabel?: string;
  /** Names the file the event is stored in. */
  recordId: string;
  channel: "call" | "sms";
  direction?: "inbound" | "outbound";
  /** Set on every call event. This is the harness's own id; the voice module's id is `data.providerCallId` on the outcome. */
  callId?: string;
  /** Set on every text event. */
  messageId?: string;
  data: Record<string, unknown>;
  /** Extension points, unused for now. */
  flowStep?: CallFlowStep;
  decision?: DecisionRecord;
}

export type TraceEventInput = Omit<TraceEvent, "seq" | "recordSeq" | "at" | "atMs">;

type Listener = (event: TraceEvent) => void;

const HISTORY_LIMIT = 2000;

export class TraceBus {
  private seq = 0;
  private readonly recordSeqs = new Map<string, number>();
  private readonly recordStarts = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly log: TraceEvent[] = [];
  /** Where a record's counter starts after a restart: how many events its file already holds. */
  seedRecordSeq: (recordId: string) => number = () => 0;
  /** Where a record's clock starts after a restart: the time (epoch milliseconds) of its first stored event. */
  seedRecordStart: (recordId: string) => number | undefined = () => undefined;

  emit(input: TraceEventInput): TraceEvent {
    const recordSeq = (this.recordSeqs.get(input.recordId) ?? this.seedRecordSeq(input.recordId)) + 1;
    this.recordSeqs.set(input.recordId, recordSeq);
    this.seq += 1;
    const now = Date.now();
    const start = this.recordStarts.get(input.recordId) ?? this.seedRecordStart(input.recordId) ?? now;
    this.recordStarts.set(input.recordId, start);
    const event: TraceEvent = { ...input, seq: this.seq, recordSeq, at: new Date(now).toISOString(), atMs: now - start };
    this.log.push(event);
    if (this.log.length > HISTORY_LIMIT) this.log.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // A broken listener (a full disk, a closed browser tab) never stops a call.
        console.error("trace listener failed:", err instanceof Error ? err.message : err);
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recent events, oldest first, for replay to a page that just connected. */
  history(): TraceEvent[] {
    return [...this.log];
  }

  /** Forgets counters and history (tests, and simulating a restart). Listeners stay. */
  reset(): void {
    this.seq = 0;
    this.recordSeqs.clear();
    this.recordStarts.clear();
    this.log.length = 0;
  }
}

export const traceBus = new TraceBus();

export interface TraceContext {
  leadId: string;
  leadLabel?: string;
  recordId: string;
  channel: "call" | "sms";
  direction?: "inbound" | "outbound";
  callId?: string;
  messageId?: string;
  /** The most recent check that blocked; becomes the outcome's reason. */
  lastBlock?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Characters allowed in a record id, so it is always safe as a file name. */
export function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** One record per call attempt, including attempts that were blocked. */
export function newCallContext(leadId: string, direction: "inbound" | "outbound"): TraceContext {
  const callId = newId("call");
  return { leadId, recordId: callId, channel: "call", direction, callId };
}

/** One record per lead for all texts (a thread), one message id per text. */
export function newTextContext(leadId: string, direction: "inbound" | "outbound" = "outbound"): TraceContext {
  return {
    leadId,
    recordId: `text_${safeIdPart(leadId)}`,
    channel: "sms",
    direction,
    messageId: newId("msg"),
  };
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** Emits an event for the current run; does nothing outside a traced run. */
export function emitTrace(
  type: TraceEventType,
  data: Record<string, unknown>,
  extra: { flowStep?: CallFlowStep; decision?: DecisionRecord } = {},
): TraceEvent | undefined {
  const ctx = storage.getStore();
  if (!ctx) return undefined;
  return traceBus.emit({
    type,
    leadId: ctx.leadId,
    leadLabel: ctx.leadLabel,
    recordId: ctx.recordId,
    channel: ctx.channel,
    direction: ctx.direction,
    callId: ctx.callId,
    messageId: ctx.messageId,
    data,
    ...extra,
  });
}

/** Records the lead's first name once the lead is loaded. */
export function setTraceLead(name: string | undefined): void {
  const ctx = storage.getStore();
  if (ctx && name) ctx.leadLabel = name.trim().split(/\s+/)[0];
}

/** A short reason code for an error: its message only when it already is a code, else "error". Raw error text is never stored. */
export function errorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return /^[a-z][a-z0-9_]{0,60}$/.test(message) ? message : "error";
}

/** Round-trips through JSON so events never hold functions, errors or cycles. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** Emits one compliance check and returns the block reason (null when it passed). */
export function traceCheck(check: string, reason: string | null, detail: Record<string, unknown> = {}): string | null {
  emitTrace("compliance_check", { check, passed: reason === null, reason, ...detail });
  const ctx = storage.getStore();
  if (ctx && reason) ctx.lastBlock = reason;
  return reason;
}

/** Runs checks in order, emitting each, and stops at the first block. */
export async function firstBlock(
  checks: Array<[name: string, run: () => string | null | Promise<string | null>]>,
): Promise<string | null> {
  for (const [name, run] of checks) {
    const reason = traceCheck(name, await run());
    if (reason) return reason;
  }
  return null;
}

/** Runs one tool or store call and emits its name, inputs, result, success and duration. */
export async function traceTool<T>(
  tool: string,
  inputs: Record<string, unknown>,
  fn: () => Promise<T> | T,
  /** What to record as the result, when the full return value would be too much. */
  summarize: (result: T) => unknown = (r) => r,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    emitTrace("tool_call", {
      tool,
      inputs: plain(inputs),
      result: plain(summarize(result)),
      success: true,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  } catch (err) {
    emitTrace("tool_call", {
      tool,
      inputs: plain(inputs),
      result: null,
      success: false,
      reason: errorCode(err),
      durationMs: Math.round(performance.now() - started),
    });
    throw err;
  }
}
