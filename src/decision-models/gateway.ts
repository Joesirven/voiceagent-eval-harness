/**
 * Decision models behind the Vercel AI Gateway: Jev from TypeSafe AI and the
 * other catalog models (Perplexity, Liquid, Microsoft). This is the route
 * the configured system's own Jev calls take through the AI SDK, so the headers follow the
 * `@ai-sdk/gateway` package (version 4.0.85, `gateway-evaluation-model.ts`).
 *
 * Every request carries zero data retention, no prompt training and
 * `only: [<provider slug>]`. Dropping any of them is the one regression that
 * matters, so the wire test pins all three.
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

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
export const JEV_GATEWAY_MODEL = "typesafe-ai/jev";

/** The other decision models in the Gateway catalog. */
export const OTHER_GATEWAY_MODELS = [
  "perplexity/pplx-decider-flash-v1.2",
  "perplexity/pplx-decider-v1.2",
  "liquid/d1",
  "liquid/d1-ultra",
  "microsoft/microsoft-decision-1",
] as const;

/** "jev" for Jev, "gateway:<model id>" for every other Gateway model. */
export function gatewayAdapterId(modelId: string): string {
  return modelId === JEV_GATEWAY_MODEL ? "jev" : `gateway:${modelId}`;
}

export class GatewayDecisionModel implements DecisionModel {
  readonly id: string;
  readonly label: string;
  readonly kind = "real" as const;

  constructor(
    private readonly modelId: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl?: FetchLike,
    private readonly clock: Clock = systemClock,
  ) {
    this.id = gatewayAdapterId(modelId);
    this.label =
      modelId === JEV_GATEWAY_MODEL
        ? "Jev from TypeSafe AI, through the Vercel AI Gateway"
        : `${modelId}, through the Vercel AI Gateway`;
  }

  async decide(request: DecisionModelRequest, options: DecisionModelCallOptions = {}): Promise<DecisionModelOutcome> {
    if (!this.apiKey) return { ok: false, reason: "off", latencyMs: 0, modelId: this.modelId, code: "no_credential" };
    const provider = this.modelId.split("/")[0] ?? this.modelId;
    const result = await postJson({
      url: GATEWAY_URL,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": this.modelId,
        "ai-gateway-auth-method": "api-key",
        "ai-gateway-protocol-version": "0.0.1",
      },
      body: {
        state: buildState(request),
        questions: { [QUESTION_NAME]: { type: "choice", ...buildQuestion(request) } },
        providerOptions: {
          gateway: { zeroDataRetention: true, disallowPromptTraining: true, only: [provider] },
        },
      },
      modelId: this.modelId,
      fetch: this.fetchImpl,
      clock: this.clock,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!result.ok) return result;
    const answer = asRecord(asRecord(asRecord(result.json)?.answers)?.[QUESTION_NAME]);
    const parsed =
      answer?.type === "choice" ? resolveChoice(request, answer.choice, answer.probabilities, answer.confidence) : null;
    if (!parsed) {
      return { ok: false, reason: "invalid_answer", latencyMs: result.latencyMs, modelId: this.modelId, code: "invalid_answer" };
    }
    return {
      ok: true,
      ...parsed,
      reason: `${this.id} answered ${parsed.answer}`,
      latencyMs: result.latencyMs,
      modelId: this.modelId,
    };
  }
}
