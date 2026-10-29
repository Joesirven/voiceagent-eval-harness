/**
 * The pieces of a play-a-lead call that do not need the harness: the live
 * caller-line queue and the call handle. A handle exists only for a call the
 * harness has cleared; making one without a genuine, unused clearance throws
 * `call_not_cleared`, the same as a voice module does.
 */

import { redeemClearance, type CallClearance } from "../provider/clearance.js";
import type { CallDirection } from "../provider/interface.js";

/** Where the dialog gets the caller's next line. `null` means the caller hung up. */
export interface CallerSource {
  next(): Promise<string | null>;
  /** True when the page ended the call because nobody spoke for too long. */
  readonly abandoned?: boolean;
}

export function sourceFromLines(lines: string[]): CallerSource {
  const queue = [...lines];
  return { next: async () => queue.shift() ?? null };
}

/** Live caller lines pushed from outside; `whenIdle` resolves once the dialog is waiting for the next one. */
export class CallerQueue implements CallerSource {
  abandoned = false;
  private lines: Array<string | null> = [];
  private waiting: ((line: string | null) => void) | undefined;
  private idleWaiters: Array<() => void> = [];

  push(line: string | null): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(line);
    } else {
      this.lines.push(line);
    }
  }

  next(): Promise<string | null> {
    for (const release of this.idleWaiters.splice(0)) release();
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

/** What a person playing a lead holds. Replies, decisions and verdicts arrive as trace events. */
export interface InteractiveCall {
  readonly callId: string;
  /** "blocked": a compliance check stopped the call from starting, and `blockedReason` says which. */
  readonly status: "connected" | "ended" | "blocked";
  readonly blockedReason?: string;
  say(callerText: string): Promise<void>;
  /** `abandoned` marks a call the page ended because nobody spoke for too long. */
  hangUp(reason?: "abandoned"): Promise<void>;
}

export interface ClearedCallParams {
  /** Proof the harness ran every gate for this call. Required. */
  clearance: CallClearance;
  callId: string;
  leadId: string;
  direction: CallDirection;
  idempotencyKey: string;
  queue: CallerQueue;
  /** Settles when the harness run for this call has finished. */
  done: Promise<unknown>;
  /** A call nobody speaks on or hangs up is ended after this long. */
  idleTimeoutMs?: number;
}

/** Calls this file built from a redeemed clearance. Holding one is the proof; looking like one is not. */
const genuineCalls = new WeakSet<object>();

export function isClearedInteractiveCall(call: unknown): call is ClearedInteractiveCall {
  return typeof call === "object" && call !== null && genuineCalls.has(call);
}

export class ClearedInteractiveCall implements InteractiveCall {
  readonly callId: string;
  private finished = false;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly p: ClearedCallParams) {
    redeemClearance(p.clearance, { leadId: p.leadId, direction: p.direction, idempotencyKey: p.idempotencyKey });
    this.callId = p.callId;
    genuineCalls.add(this);
    p.done.then(() => {
      this.finished = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
    });
    this.touch();
  }

  get status(): "connected" | "ended" {
    return this.finished ? "ended" : "connected";
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.p.queue.push(null), this.p.idleTimeoutMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }

  async say(callerText: string): Promise<void> {
    if (this.finished) throw new Error("call_ended");
    this.touch();
    const idle = this.p.queue.whenIdle();
    this.p.queue.push(callerText);
    await Promise.race([idle, this.p.done]);
  }

  async hangUp(reason?: "abandoned"): Promise<void> {
    if (!this.finished) {
      if (reason === "abandoned") this.p.queue.abandoned = true;
      this.p.queue.push(null);
    }
    await this.p.done;
  }
}

/** The result of a start the harness refused. Nothing was dialled and nothing can be said. */
export class BlockedInteractiveCall implements InteractiveCall {
  readonly status = "blocked" as const;
  constructor(
    readonly callId: string,
    readonly blockedReason: string,
  ) {}

  async say(): Promise<void> {
    throw new Error(`call_not_started:${this.blockedReason}`);
  }

  async hangUp(): Promise<void> {}
}
