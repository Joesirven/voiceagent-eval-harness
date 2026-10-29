/**
 * One helper for every adapter: post JSON, with a timeout, and turn each way
 * it can go wrong into a short failure code. It never throws and never keeps
 * the provider's error text, which may repeat the caller's words.
 *
 * Mapping: 401 and 403 are "auth", 404 is "model", 413 is "too_large", 422 is
 * "too_large" only when the provider says the input is too big (otherwise
 * "http_422"), 429 is "rate_limit", 529 is "overloaded", any other failing
 * status is "http_<status>". A network failure is "unreachable" and an abort
 * is the "timeout" reason. A 200 that is not JSON is "invalid_answer".
 */

import { systemClock, type Clock } from "../types/clock.js";
import type { DecisionModelFailure } from "./types.js";

export type FetchLike = typeof fetch;

export const DEFAULT_TIMEOUT_MS = 3000;

export interface PostJsonRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  modelId: string;
  fetch?: FetchLike;
  clock?: Clock;
  timeoutMs?: number;
}

export type PostJsonResult = { ok: true; json: unknown; latencyMs: number } | DecisionModelFailure;

const TOO_BIG = /too (?:large|long|big)|exceed|context|token|length/i;

function failure(
  modelId: string,
  latencyMs: number,
  reason: DecisionModelFailure["reason"],
  code?: string,
): DecisionModelFailure {
  return code ? { ok: false, reason, latencyMs, modelId, code } : { ok: false, reason, latencyMs, modelId };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Whether a 422 body says the input was too big. The text is read here and dropped. */
async function bodySaysTooBig(response: Response): Promise<boolean> {
  try {
    return TOO_BIG.test(await response.text());
  } catch {
    return false;
  }
}

export async function postJson(req: PostJsonRequest): Promise<PostJsonResult> {
  const clock = req.clock ?? systemClock;
  const doFetch = req.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = clock.now().getTime();
  const elapsed = () => Math.max(0, clock.now().getTime() - startedAt);
  try {
    let response: Response;
    try {
      response = await doFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (error) {
      return isAbort(error, controller.signal)
        ? failure(req.modelId, elapsed(), "timeout", "timeout")
        : failure(req.modelId, elapsed(), "error", "unreachable");
    }
    if (!response.ok) {
      const status = response.status;
      const latencyMs = elapsed();
      if (status === 401 || status === 403) return failure(req.modelId, latencyMs, "error", "auth");
      if (status === 404) return failure(req.modelId, latencyMs, "error", "model");
      if (status === 413) return failure(req.modelId, latencyMs, "too_large", "too_large");
      if (status === 422 && (await bodySaysTooBig(response))) return failure(req.modelId, latencyMs, "too_large", "too_large");
      if (status === 429) return failure(req.modelId, latencyMs, "error", "rate_limit");
      if (status === 529) return failure(req.modelId, latencyMs, "error", "overloaded");
      return failure(req.modelId, latencyMs, "error", `http_${status}`);
    }
    try {
      const json: unknown = await response.json();
      return { ok: true, json, latencyMs: elapsed() };
    } catch (error) {
      return isAbort(error, controller.signal)
        ? failure(req.modelId, elapsed(), "timeout", "timeout")
        : failure(req.modelId, elapsed(), "invalid_answer", "not_json");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Plain object check for reading provider JSON without trusting its shape. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export { failure as decisionFailure };
