/**
 * The decision model contract: a fast model that answers one closed, typed
 * question about a conversation. Input: the conversation so far, the current
 * tree node, and the question with its closed list of answers. Output: one
 * answer from that list, a confidence from 0 to 1, a short reason, and the
 * measured latency.
 *
 * This sits beside the tree engine's `DecisionModule` (src/decision/types.ts):
 * `asDecisionModule` in ./bridge.ts turns any model here into one, so the
 * engine can use Jev, OpenAI or the rest without changing.
 *
 * A model never throws. A missing credential, a timeout, a provider error or a
 * reply outside the closed list comes back as `{ ok: false }` with a reason.
 */

import type { DecisionRequest } from "../decision/types.js";

export interface DecisionModelRequest extends DecisionRequest {
  /** Extra instructions for the question, sent once before the criteria. */
  instructions?: string;
}

export interface DecisionModelCallOptions {
  /** Give up after this long and return `{ ok: false, reason: "timeout" }`. */
  timeoutMs?: number;
}

export interface DecisionModelAnswer {
  ok: true;
  /** Always one of the request's `answers`. */
  answer: string;
  /** 0 to 1: the provider's probability for the answer when it sends one, otherwise the model's own estimate. */
  confidence: number;
  /** One short sentence. May echo the conversation, so never put it in a trace event or a log. */
  reason: string;
  /** Wall-clock milliseconds for the whole ask, measured by the harness. Mocks report their simulated latency. */
  latencyMs: number;
  /** The model that answered, as the provider named it. */
  modelId: string;
  /** Per-answer probabilities when the provider sends a distribution. */
  probabilities?: Record<string, number>;
}

export type DecisionModelFailureReason =
  /** No credential, or the model is switched off. */
  | "off"
  | "timeout"
  /** The conversation is larger than the model takes. */
  | "too_large"
  /** The provider answered outside the closed list, or with something unreadable. */
  | "invalid_answer"
  | "error";

export interface DecisionModelFailure {
  ok: false;
  reason: DecisionModelFailureReason;
  latencyMs: number;
  modelId: string;
  /** A short code (for example "auth", "rate_limit", "http_500"). Never raw error text, never conversation text. */
  code?: string;
}

export type DecisionModelOutcome = DecisionModelAnswer | DecisionModelFailure;

export interface DecisionModel {
  /** Stable id, for example "jev", "jev-mock", "openai". */
  readonly id: string;
  readonly label: string;
  /** "mock" never touches the network. */
  readonly kind: "mock" | "real";
  decide(request: DecisionModelRequest, options?: DecisionModelCallOptions): Promise<DecisionModelOutcome>;
}
