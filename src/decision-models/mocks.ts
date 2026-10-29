/**
 * One deterministic mock per adapter, id plus "-mock". Each looks for the same
 * keyword cues the tree engine's mocks use (src/decision/lexicon.ts) in the
 * caller's latest line, has its own calibration, and reports a simulated
 * latency typical of the real model. Nothing here touches the network and
 * nothing waits: the latency is a number on the answer, not a delay.
 */

import { matchWeight } from "../decision/lexicon.js";
import type {
  DecisionModel,
  DecisionModelOutcome,
  DecisionModelRequest,
} from "./types.js";
import { gatewayAdapterId, JEV_GATEWAY_MODEL } from "./gateway.js";

export interface MockCalibration {
  /** Confidence when the best answer scores 1. */
  base: number;
  /** Added per extra point of score. */
  step: number;
  /** Taken off per rival answer that also matched. */
  rivalPenalty: number;
  cap: number;
}

export interface MockSpec {
  /** The real adapter's id; the mock's id adds "-mock". */
  adapterId: string;
  label: string;
  latencyMs: number;
  calibration: MockCalibration;
  /** The model name reported on answers. */
  providerModel: string;
}

export class KeywordDecisionModel implements DecisionModel {
  readonly id: string;
  readonly label: string;
  readonly kind = "mock" as const;

  constructor(private readonly spec: MockSpec) {
    this.id = `${spec.adapterId}-mock`;
    this.label = spec.label;
  }

  async decide(request: DecisionModelRequest): Promise<DecisionModelOutcome> {
    const { latencyMs, providerModel, calibration } = this.spec;
    const caller = [...request.transcript].reverse().find((t) => t.role === "caller")?.text ?? "";
    const scored = request.answers
      .filter((answer) => answer !== "unclear")
      .map((answer, order) => ({ answer, order, weight: matchWeight(caller, answer, request.cues?.[answer]) }))
      .filter((s) => s.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.order - b.order);

    let answer: string;
    let confidence: number;
    if (scored.length === 0) {
      if (!request.answers.includes("unclear")) {
        return { ok: false, reason: "invalid_answer", latencyMs, modelId: providerModel, code: "invalid_answer" };
      }
      answer = "unclear";
      confidence = 0.2;
    } else {
      const best = scored[0]!;
      const rivals = scored.length - 1;
      const raw = calibration.base + calibration.step * (best.weight - 1) - calibration.rivalPenalty * rivals;
      answer = best.answer;
      confidence = Math.round(Math.min(calibration.cap, Math.max(0.05, raw)) * 100) / 100;
    }

    // The rest of the probability is shared evenly, so the distribution sums to 1.
    const others = request.answers.filter((a) => a !== answer);
    const share = others.length > 0 ? (1 - confidence) / others.length : 0;
    const probabilities: Record<string, number> = { [answer]: confidence };
    for (const other of others) probabilities[other] = Math.round(share * 1000) / 1000;

    return {
      ok: true,
      answer,
      confidence,
      reason: `${this.id} matched cues for ${answer}`,
      latencyMs,
      modelId: providerModel,
      probabilities,
    };
  }
}

const JEV: MockSpec = {
  adapterId: "jev",
  label: "Jev through the Vercel AI Gateway (mock): about 100 milliseconds",
  latencyMs: 100,
  calibration: { base: 0.8, step: 0.1, rivalPenalty: 0.12, cap: 0.97 },
  providerModel: JEV_GATEWAY_MODEL,
};

const JEV_DIRECT: MockSpec = {
  adapterId: "jev-direct",
  label: "Jev direct from TypeSafe AI (mock): about 90 milliseconds",
  latencyMs: 90,
  calibration: { base: 0.78, step: 0.1, rivalPenalty: 0.12, cap: 0.96 },
  providerModel: "jev-latest",
};

const OPENAI_DECISIONS: MockSpec = {
  adapterId: "openai-decisions",
  label: "OpenAI Decisions API (mock): about 180 milliseconds, more cautious",
  latencyMs: 180,
  calibration: { base: 0.72, step: 0.12, rivalPenalty: 0.15, cap: 0.95 },
  providerModel: "gpt-6-luna",
};

const KEV: MockSpec = {
  adapterId: "kev",
  label: "Kev, self-hosted (mock): about 60 milliseconds",
  latencyMs: 60,
  calibration: { base: 0.7, step: 0.1, rivalPenalty: 0.15, cap: 0.93 },
  providerModel: "kev-latest",
};

const AZURE_DECISION: MockSpec = {
  adapterId: "azure-decision",
  label: "Decision model on Azure AI Foundry (mock): about 150 milliseconds",
  latencyMs: 150,
  calibration: { base: 0.74, step: 0.1, rivalPenalty: 0.14, cap: 0.94 },
  providerModel: "azure-decision",
};

export function createAzureDecisionMock(): DecisionModel {
  return new KeywordDecisionModel(AZURE_DECISION);
}
export function createJevMock(): DecisionModel {
  return new KeywordDecisionModel(JEV);
}
export function createJevDirectMock(): DecisionModel {
  return new KeywordDecisionModel(JEV_DIRECT);
}
export function createOpenAiDecisionsMock(): DecisionModel {
  return new KeywordDecisionModel(OPENAI_DECISIONS);
}
export function createKevMock(): DecisionModel {
  return new KeywordDecisionModel(KEV);
}

/** Mock for any Gateway model other than Jev (150 milliseconds); Jev's own model gets the Jev mock. */
export function createGatewayMock(modelId: string): DecisionModel {
  if (modelId === JEV_GATEWAY_MODEL) return createJevMock();
  return new KeywordDecisionModel({
    adapterId: gatewayAdapterId(modelId),
    label: `${modelId} through the Vercel AI Gateway (mock): about 150 milliseconds`,
    latencyMs: 150,
    calibration: { base: 0.68, step: 0.1, rivalPenalty: 0.15, cap: 0.92 },
    providerModel: modelId,
  });
}
