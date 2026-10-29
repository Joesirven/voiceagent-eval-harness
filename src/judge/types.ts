/**
 * The judge gate. Before every destructive action a judge looks at the action,
 * the conversation so far and the enforcement rules, and either allows it or
 * refuses it. A refusal blocks the action and is logged. The judge is
 * swappable: anything that fits `Judge` can replace the local rule-based one.
 */

import type { TranscriptTurn } from "../provider/interface.js";

export const JUDGE_ACTIONS = [
  "transfer",
  "save_details",
  "save_quote_field",
  "book",
  "send_text",
  "end_with_disposition",
  // The flow tool catalog's actions (src/flow-tools/catalog.json).
  "send_email",
  "start_quote",
  "set_eligibility",
  "cancel_booking",
] as const;

export type JudgeAction = (typeof JUDGE_ACTIONS)[number];

export interface JudgePayload {
  /** save_quote_field: the field name, its value, and the caller words that back it. */
  field?: string;
  value?: string;
  evidenceSpan?: string;
  /** save_details: what kind of detail, and the text to save (the caller's own words). */
  kind?: string;
  body?: string;
  /** book: the slot as a timestamp string and as spoken back to the caller. */
  slotIso?: string;
  slotWords?: string;
  /**
   * transfer: "caller_requested" or "repeated_unclear". end_with_disposition:
   * "repeated_unclear" when the ending is the tree's escalation after the
   * clarifying lines were used up, with the same two counts.
   */
  reason?: string;
  clarifyCount?: number;
  maxClarifications?: number;
  /** send_email: the document; set_eligibility: the reason given; start_quote: the line of business. */
  document?: string;
  line?: string;
  /** end_with_disposition: the tree's disposition name and whether it is durable. */
  disposition?: string;
  durable?: boolean;
}

export interface JudgeRequest {
  action: JudgeAction;
  nodeId: string;
  direction: "inbound" | "outbound";
  /** The conversation so far, including the disclosure and the caller's latest line. */
  transcript: TranscriptTurn[];
  /** Destructive actions already carried out earlier in this call. */
  completed: JudgeAction[];
  payload: JudgePayload;
  now: Date;
  /**
   * The disclosure parts this call must open with, word for word, as the
   * harness fixed them when the call started (`CallOpening.disclosure`).
   * Missing means nothing was recorded: the plain disclosure is expected.
   */
  expectedDisclosure?: string[];
}

export interface JudgeScoreLine {
  criterion: string;
  /** 0 (failed) to 1 (passed). */
  score: number;
  note: string;
}

export interface JudgeVerdict {
  allowed: boolean;
  /** One plain sentence; never repeats the caller's words. */
  reason: string;
  scores: JudgeScoreLine[];
}

export interface Judge {
  readonly id: string;
  judge(request: JudgeRequest): Promise<JudgeVerdict>;
}
