/**
 * The decision model on the configured system's Azure AI Foundry, through the one
 * FoundryClient. Two routes, picked by configuration:
 *
 *   1. AZURE_DECISION_DEPLOYMENT set: `FoundryClient.decide`, the typed System
 *      One question to the decision deployment (Microsoft-Decision-1), which
 *      answers with per-choice probabilities.
 *   2. Only AZURE_FAST_DEPLOYMENT set: `FoundryClient.complete` with a strict
 *      json_schema reply whose `answer` is an enum of the request's answers.
 *      A chat model sends no distribution, so the confidence is the one the
 *      model states in its reply, or the fallback 0.5 when it states none.
 *
 * With neither deployment the model is unusable and the catalog hands out the
 * mock (reason no_credential). A model never throws: every Foundry error code
 * becomes a failure with a short code, and no provider text or conversation
 * text is kept.
 */

import type { FoundryClient } from "../models/foundry.js";
import { systemClock, type Clock } from "../types/clock.js";
import { DEFAULT_TIMEOUT_MS } from "./http.js";
import { buildQuestion, buildState, QUESTION_NAME, resolveChoice } from "./state.js";
import type {
  DecisionModel,
  DecisionModelCallOptions,
  DecisionModelFailure,
  DecisionModelOutcome,
  DecisionModelRequest,
} from "./types.js";

export const AZURE_DECISION_ADAPTER_ID = "azure-decision";

export interface AzureDecisionDeployments {
  /** AZURE_DECISION_DEPLOYMENT: the typed decision route. */
  decision?: string;
  /** AZURE_FAST_DEPLOYMENT: the chat fallback. */
  fast?: string;
}

const FAILURES: Record<string, { reason: DecisionModelFailure["reason"]; code: string }> = {
  foundry_timeout: { reason: "timeout", code: "timeout" },
  foundry_too_large: { reason: "too_large", code: "too_large" },
  foundry_deployment_not_configured: { reason: "off", code: "no_credential" },
  foundry_reply_truncated: { reason: "error", code: "reply_truncated" },
  foundry_reply_not_json: { reason: "invalid_answer", code: "invalid_answer" },
  foundry_bad_response: { reason: "invalid_answer", code: "invalid_answer" },
  foundry_content_filtered: { reason: "error", code: "content_filtered" },
  foundry_auth: { reason: "error", code: "auth" },
  foundry_rate_limited: { reason: "error", code: "rate_limit" },
  foundry_deployment_not_found: { reason: "error", code: "model" },
  foundry_bad_request: { reason: "error", code: "bad_request" },
  foundry_unavailable: { reason: "error", code: "unavailable" },
  foundry_unreachable: { reason: "error", code: "unreachable" },
};

export class AzureDecisionModel implements DecisionModel {
  readonly id = AZURE_DECISION_ADAPTER_ID;
  readonly label: string;
  readonly kind = "real" as const;

  constructor(
    private readonly client: FoundryClient | undefined,
    private readonly deployments: AzureDecisionDeployments,
    private readonly clock: Clock = systemClock,
  ) {
    this.label = deployments.decision
      ? "Decision model on Azure AI Foundry (typed decision route)"
      : "Fast chat model on Azure AI Foundry (closed-list reply)";
  }

  private get modelId(): string {
    return this.deployments.decision ?? this.deployments.fast ?? "azure-decision";
  }

  async decide(request: DecisionModelRequest, options: DecisionModelCallOptions = {}): Promise<DecisionModelOutcome> {
    const startedAt = this.clock.now().getTime();
    const elapsed = () => Math.max(0, this.clock.now().getTime() - startedAt);
    const fail = (reason: DecisionModelFailure["reason"], code: string): DecisionModelFailure => ({
      ok: false,
      reason,
      latencyMs: elapsed(),
      modelId: this.modelId,
      code,
    });
    const { decision, fast } = this.deployments;
    if (!this.client || (!decision && !fast)) return fail("off", "no_credential");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const raw = decision
        ? await this.askTyped(this.client, decision, request, timeoutMs)
        : await this.askChat(this.client, fast!, request, timeoutMs);
      const parsed = raw ? resolveChoice(request, raw.choice, raw.probabilities, raw.confidence) : null;
      if (!parsed) return fail("invalid_answer", "invalid_answer");
      return { ok: true, ...parsed, reason: `${this.id} answered ${parsed.answer}`, latencyMs: elapsed(), modelId: this.modelId };
    } catch (err) {
      const mapped = FAILURES[err instanceof Error ? err.message : ""];
      return mapped ? fail(mapped.reason, mapped.code) : fail("error", "error");
    }
  }

  private async askTyped(client: FoundryClient, deployment: string, request: DecisionModelRequest, timeoutMs: number) {
    const result = await client.decide({
      deployment,
      state: buildState(request),
      questions: { [QUESTION_NAME]: { type: "choice", ...buildQuestion(request) } },
      timeoutMs,
    });
    const answer = result.answers[QUESTION_NAME];
    return answer?.type === "choice"
      ? { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence }
      : null;
  }

  private async askChat(client: FoundryClient, deployment: string, request: DecisionModelRequest, timeoutMs: number) {
    const question = buildQuestion(request);
    const criteria = request.answers.map((answer) => [answer, question.criteria[answer]] as const).map(([answer, meaning]) => `- ${answer}: ${meaning}`);
    const completion = await client.complete({
      deployment,
      messages: [
        {
          role: "system",
          content: [question.instructions, "Reply with exactly one of these answers, and a confidence from 0 to 1 for how sure you are it is the right one (use below 0.5 when the line does not fit any answer):", ...criteria].join("\n"),
        },
        { role: "user", content: buildState(request) },
      ],
      responseFormat: {
        type: "json_schema",
        name: "choice",
        schema: {
          type: "object",
          properties: {
            answer: { type: "string", enum: [...request.answers] },
            confidence: { type: "number" },
          },
          required: ["answer", "confidence"],
          additionalProperties: false,
        },
      },
      // A reasoning-capable fast deployment spends tokens thinking before the
      // one-word answer; 64 would cut it off (foundry_reply_truncated).
      maxTokens: 512,
      timeoutMs,
    });
    const reply = completion.json as { answer?: unknown; confidence?: unknown } | null;
    // A chat model sends no distribution; its own stated confidence is used (resolveChoice falls back to 0.5 when it is unusable).
    return { choice: reply?.answer, probabilities: undefined, confidence: reply?.confidence };
  }
}
