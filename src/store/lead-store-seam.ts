/**
 * LeadStore seam: everything the harness needs from lead storage, behind one
 * async interface. The mock store backs tests and the control page. External
 * CRM adapters implement this interface.
 */

import {
  appendHandoffNote,
  bookProducerIdempotent,
  getLead,
  saveMessageIdempotent,
  hasIdempotencyKey,
  releaseIdempotency,
  tryClaimIdempotency,
  writeQuoteField,
  recordStop,
  type HandoffNote,
  type StopRecord,
  type StopResult,
  type LeadRecord,
  type ProducerBooking,
  type SavedMessage,
} from "./lead-store.js";
import type { HarnessRunRow, HarnessRunWriteResult } from "./harness-runs.js";

export interface LeadStore {
  getLead(leadId: string): Promise<LeadRecord | undefined>;
  /**
   * True the first time a key is seen, false on every later delivery. Must be
   * atomic across processes: a database implementation uses a unique-constraint
   * insert, never read-then-write.
   */
  tryClaimIdempotency(key: string): Promise<boolean>;
  /** Optional: whether a key is already claimed, so counts that must survive a purge can read the store. */
  hasClaim?(key: string): Promise<boolean>;
  /** Undo a claim when the call never happened (start failure), so a retry can dial. */
  releaseIdempotency(key: string): Promise<void>;
  /**
   * Stores the field only when the evidence span is a whole-word match inside
   * one of `callerTurns` and the value is inside the span. Every implementation
   * must enforce this, not just the harness.
   */
  writeQuoteField(
    leadId: string,
    field: string,
    value: string,
    evidenceSpan: string,
    callerTurns: string[],
  ): Promise<boolean>;
  appendHandoffNote(leadId: string, note: HandoffNote): Promise<void>;
  /**
   * Record a STOP so the lead is never called or texted again: suppression and
   * a consent revocation together. After this resolves, getLead must report the
   * lead as suppressed and revoked, whether or not the store could persist it.
   */
  recordStop(stop: StopRecord): Promise<StopResult>;
  /**
   * Optional last gate before a call or text: the store's own durable reach
   * rules. Missing means the store has none (the mock store). A store that has
   * one must fail closed: allowed false on any doubt.
   */
  finalReachCheck?(leadId: string, channel: "call" | "text", address?: string): Promise<{ allowed: boolean; reason: string }>;
  /**
   * Optional store-wide hold on every real dial and text: a reason string while
   * held, null when not. Read on each call. Missing means no hold (the mock store).
   */
  outboundHold?(): string | null;
  /**
   * Optional: write one harness run row (see harness-runs.ts). Missing means
   * the local records are the only copy. An implementation returns "local" when
   * the table does not exist or writes are off, and never throws for a missing table.
   */
  recordHarnessRun?(row: HarnessRunRow): Promise<HarnessRunWriteResult>;
  saveMessageIdempotent(leadId: string, callId: string, body: string, kind?: string): Promise<SavedMessage>;
  bookProducerIdempotent(leadId: string, callId: string, slotIso: string): Promise<ProducerBooking>;
}

/** In-memory store (synthetic fixtures only). */
export const mockLeadStore: LeadStore = {
  getLead: async (id) => getLead(id),
  tryClaimIdempotency: async (key) => tryClaimIdempotency(key),
  hasClaim: async (key) => hasIdempotencyKey(key),
  releaseIdempotency: async (key) => releaseIdempotency(key),
  writeQuoteField: async (id, f, v, e, turns) => writeQuoteField(id, f, v, e, turns),
  appendHandoffNote: async (id, n) => appendHandoffNote(id, n),
  recordStop: async (stop) => recordStop(stop),
  saveMessageIdempotent: async (id, c, b, k) => saveMessageIdempotent(id, c, b, k),
  bookProducerIdempotent: async (id, c, s) => bookProducerIdempotent(id, c, s),
};
