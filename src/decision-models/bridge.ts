/**
 * Lets the tree engine use any decision model. The engine writes the returned
 * reason into trace events, and a provider's own wording may repeat the
 * caller's words, so the reason here is always a template this file writes
 * from fields it controls: the model id, the answer (checked against the
 * request's closed list), numbers, and short failure codes.
 */

import type { DecisionModule, DecisionModuleConfig, DecisionRequest, DecisionResult } from "../decision/types.js";
import type { DecisionModel, DecisionModelCallOptions, DecisionModelOutcome, DecisionModelRequest } from "./types.js";

export interface BridgedDecisionModule extends DecisionModule {
  readonly model: DecisionModel;
}

/** A failure code is ours (for example "rate_limit"); anything else is left out of the template. */
function safeCode(code: string | undefined): string | undefined {
  return code && /^[a-z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function unavailable(model: DecisionModel, reason: string, code?: string): DecisionResult {
  const detail = safeCode(code);
  const suffix = detail && detail !== reason ? ` (${detail})` : "";
  return { answer: "unclear", confidence: 0, reason: `${model.id} unavailable: ${reason}${suffix}` };
}

export function asDecisionModule(model: DecisionModel, callOptions: DecisionModelCallOptions = {}): BridgedDecisionModule {
  let lastLatencyMs = 0;
  return {
    id: model.id,
    label: model.label,
    model,
    getConfig(): DecisionModuleConfig {
      return { enabled: true, latencyMs: lastLatencyMs };
    },
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      let outcome: DecisionModelOutcome;
      try {
        outcome = await model.decide(request as DecisionModelRequest, callOptions);
      } catch {
        // The contract says a model never throws; this keeps a broken one from stopping a call.
        return unavailable(model, "error");
      }
      lastLatencyMs = Math.max(0, Math.round(outcome.latencyMs));
      if (!outcome.ok) return unavailable(model, outcome.reason, outcome.code);
      if (!request.answers.includes(outcome.answer)) return unavailable(model, "invalid_answer");
      // Clamping would turn a confidence of 2 into a confident 1, and NaN survives Math.min and Math.max.
      const confidence = outcome.confidence;
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return unavailable(model, "invalid_confidence");
      return {
        answer: outcome.answer,
        confidence,
        reason: `${model.id} answered ${outcome.answer} at ${confidence.toFixed(2)} in ${lastLatencyMs} milliseconds`,
      };
    },
  };
}
