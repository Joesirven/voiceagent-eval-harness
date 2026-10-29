/**
 * System One: the decision route TypeSafe documents (https://docs.typesafe.ai/api)
 * and Kev, Jared Palmer's open decision models, say they follow. Two adapters
 * share it: Jev straight from TypeSafe ("jev-direct") and a self-hosted Kev.
 *
 * Unverified: whether a Kev server reads `questions` as the request key (its
 * README claims System One compatibility). The wire test pins what we send.
 *
 * Kev's base URL comes from configuration, so a plain http address is refused
 * unless the host is this machine: the bearer key and the redacted
 * conversation must not cross an open network.
 */

import { systemClock, type Clock } from "../types/clock.js";
import { asRecord, DEFAULT_TIMEOUT_MS, postJson, type FetchLike } from "./http.js";
import { buildQuestion, buildState, QUESTION_NAME, resolveChoice } from "./state.js";
import type {
  DecisionModel,
  DecisionModelCallOptions,
  DecisionModelOutcome,
  DecisionModelRequest,
} from "./types.js";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

export interface SystemOneConfig {
  id: string;
  label: string;
  /** Without the trailing path; `/v1/systemone` is appended. Undefined means not configured. */
  baseUrl: string | undefined;
  model: string;
  /** Sent as a bearer token when present. */
  apiKey?: string;
  /** Without a key the model is off (TypeSafe). Kev works with none. */
  keyRequired: boolean;
}

/** Whether a base URL may be used: https, or http only to localhost or 127.0.0.1. */
export function isAllowedBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export class SystemOneDecisionModel implements DecisionModel {
  readonly id: string;
  readonly label: string;
  readonly kind = "real" as const;

  constructor(
    private readonly config: SystemOneConfig,
    private readonly fetchImpl?: FetchLike,
    private readonly clock: Clock = systemClock,
  ) {
    this.id = config.id;
    this.label = config.label;
  }

  async decide(request: DecisionModelRequest, options: DecisionModelCallOptions = {}): Promise<DecisionModelOutcome> {
    const { baseUrl, apiKey, model, keyRequired } = this.config;
    const off = (code: string): DecisionModelOutcome => ({ ok: false, reason: "off", latencyMs: 0, modelId: model, code });
    if (!baseUrl || (keyRequired && !apiKey)) return off("no_credential");
    if (!isAllowedBaseUrl(baseUrl)) return off("base_url_refused");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const result = await postJson({
      url: `${baseUrl.replace(/\/+$/, "")}/v1/systemone`,
      headers,
      body: {
        model,
        state: buildState(request),
        questions: { [QUESTION_NAME]: { type: "choice", ...buildQuestion(request) } },
      },
      modelId: model,
      fetch: this.fetchImpl,
      clock: this.clock,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!result.ok) return result;
    const answer = asRecord(asRecord(asRecord(result.json)?.answers)?.[QUESTION_NAME]);
    // The provider's "confidence" is a normalized margin; it is only a fallback when no distribution came.
    const parsed =
      answer?.type === "choice" ? resolveChoice(request, answer.choice, answer.probabilities, answer.confidence) : null;
    if (!parsed) return { ok: false, reason: "invalid_answer", latencyMs: result.latencyMs, modelId: model, code: "invalid_answer" };
    return { ok: true, ...parsed, reason: `${this.id} answered ${parsed.answer}`, latencyMs: result.latencyMs, modelId: model };
  }
}

/** Jev straight from TypeSafe. */
export function createJevDirect(apiKey: string | undefined, fetchImpl?: FetchLike, clock?: Clock): SystemOneDecisionModel {
  return new SystemOneDecisionModel(
    {
      id: "jev-direct",
      label: "Jev from TypeSafe AI, direct",
      baseUrl: TYPESAFE_BASE_URL,
      model: "jev-latest",
      apiKey,
      keyRequired: true,
    },
    fetchImpl,
    clock,
  );
}

/** Kev on the server named by KEV_BASE_URL; the key is optional. */
export function createKev(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  fetchImpl?: FetchLike,
  clock?: Clock,
): SystemOneDecisionModel {
  return new SystemOneDecisionModel(
    { id: "kev", label: "Kev, open decision models (self-hosted)", baseUrl, model: "kev-latest", apiKey, keyRequired: false },
    fetchImpl,
    clock,
  );
}
