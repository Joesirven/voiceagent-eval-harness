/**
 * One row per call or text attempt, for the harness table in the development
 * database (supabase/harness/001_voice_harness_runs.sql). Placed, answered,
 * skipped, blocked and failed attempts all get a row, with the reason.
 */

export type HarnessRunStatus = "placed" | "answered" | "skipped" | "blocked" | "failed";

/** Every row is tagged, so test runs are always told apart from anything else. */
export const TEST_RUN_SOURCE = "voice-harness-test";
export const REAL_RUN_SOURCE = "voice-harness";

export interface HarnessRunRow {
  /** The call id, or the message id for a text. Unique. */
  attemptId: string;
  recordId: string;
  kind: "call" | "text";
  direction?: "inbound" | "outbound";
  leadId: string;
  status: HarnessRunStatus;
  /** The harness's own status word (for example "not_answered" or "ai_handled"). */
  detailStatus: string;
  reason: string | null;
  transcript: Array<{ role: string; text: string; turnIndex: number; spoken: boolean; at: string }>;
  outcome: Record<string, unknown> | null;
  disposition: string | null;
  handoffNote: Record<string, unknown> | null;
  /** The record file name the full trace is stored in. */
  traceRef: string;
  testRunTag: string;
  testSessionId: string | null;
  voiceSetupId: string | null;
  decisionSetupId: string | null;
  promptSetupId: string | null;
  /** A STOP was heard on this attempt. In test mode it was recorded here only. */
  stopRequested: boolean;
  recordedAt: string;
}

/** "table": written to the harness table. "local": the table is missing or writes are off; the local records hold it. */
export type HarnessRunWriteResult = "table" | "local";
