/**
 * Mock decision modules. Both are deterministic keyword rules with a simulated
 * latency and no network. They find the same answers on clear lines and differ
 * in how sure they sound and how long they take, so swapping one for the other
 * changes confidence and latency and nothing else on clear input.
 *
 * jev-mock stands in for Jev from TypeSafe AI, which CRM already uses:
 * about 100 milliseconds per typed question and a confidence for each answer.
 * openai-mock stands in for a general language model: slower and a little
 * more cautious.
 */

import { matchWeight } from "./lexicon.js";
import type { DecisionModule, DecisionModuleConfig, DecisionRequest, DecisionResult } from "./types.js";

export interface Calibration {
  /** Confidence when the best answer scores 1. */
  base: number;
  /** Added per extra point of score. */
  step: number;
  /** Taken off per rival answer that also matched. */
  rivalPenalty: number;
  cap: number;
}

export type DecisionConfigPatch = Partial<DecisionModuleConfig>;

export function validateDecisionConfig(cfg: DecisionModuleConfig): void {
  if (!Number.isFinite(cfg.latencyMs) || cfg.latencyMs < 0 || cfg.latencyMs > 10_000) {
    throw new Error("latency_out_of_range");
  }
}

export abstract class KeywordDecisionModule implements DecisionModule {
  abstract readonly id: string;
  abstract readonly label: string;
  protected abstract readonly calibration: Calibration;
  private cfg: DecisionModuleConfig;

  constructor(defaults: DecisionModuleConfig) {
    this.cfg = { ...defaults };
  }

  getConfig(): DecisionModuleConfig {
    return { ...this.cfg };
  }

  /** Merge a patch; reject (and keep the old config) when the result is invalid. */
  updateConfig(patch: DecisionConfigPatch): DecisionModuleConfig {
    const next = { ...this.cfg, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as DecisionModuleConfig;
    validateDecisionConfig(next);
    this.cfg = next;
    return this.getConfig();
  }

  setEnabled(enabled: boolean): void {
    this.cfg.enabled = enabled;
  }

  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const caller = [...req.transcript].reverse().find((t) => t.role === "caller")?.text ?? "";
    const scored = req.answers
      .filter((a) => a !== "unclear")
      .map((answer, order) => {
        let weight = matchWeight(caller, answer, req.cues?.[answer]);
        // A lead who was rung and missed it is likely calling back: a weak cue is enough when we know we called.
        if (answer === "returning_missed_calls" && weight > 0 && (req.context?.missedCalls ?? 0) > 0) weight += 1;
        return { answer, order, weight };
      })
      .filter((s) => s.weight > 0);
    const { base, step, rivalPenalty, cap } = this.calibration;
    const scoreOf = (weight: number, rivals: number) =>
      Math.round(Math.min(cap, Math.max(0.05, base + step * (weight - 1) - rivalPenalty * rivals)) * 100) / 100;
    if (scored.length === 0) {
      return {
        answer: "unclear",
        confidence: 0.2,
        reason: "no cue for any allowed answer was found in the caller's words",
        scores: req.answers.filter((a) => a !== "unclear").map((answer) => ({ answer, confidence: 0 })),
      };
    }
    // Highest score wins; a tie goes to the answer listed first in the question.
    scored.sort((a, b) => b.weight - a.weight || a.order - b.order);
    const best = scored[0]!;
    const rivals = scored.length - 1;
    const confidence = scoreOf(best.weight, rivals);
    const reason = rivals > 0 ? `matched cues for "${best.answer}", with ${rivals} other answer(s) also matching` : `matched cues for "${best.answer}"`;
    const scores = req.answers.filter((a) => a !== "unclear").map((answer) => {
      const hit = scored.find((s) => s.answer === answer);
      if (!hit) return { answer, confidence: 0 };
      if (answer === best.answer) return { answer, confidence };
      return { answer, confidence: scoreOf(hit.weight, rivals) };
    });
    return { answer: best.answer, confidence, reason, scores };
  }
}

export class JevMockModule extends KeywordDecisionModule {
  readonly id = "jev-mock";
  readonly label = "Jev (mock): about 100 milliseconds per typed question";
  protected readonly calibration = { base: 0.76, step: 0.11, rivalPenalty: 0.12, cap: 0.97 };
  constructor() {
    super({ enabled: true, latencyMs: 100 });
  }
}

export class OpenAiMockModule extends KeywordDecisionModule {
  readonly id = "openai-mock";
  readonly label = "OpenAI language model (mock): slower, more cautious";
  protected readonly calibration = { base: 0.7, step: 0.12, rivalPenalty: 0.15, cap: 0.95 };
  constructor() {
    super({ enabled: true, latencyMs: 450 });
  }
}

/** Mock modules that exist for tests only: never listed or selectable on the live Call tab. */
export const TEST_ONLY_DECISION_MODULE_IDS: readonly string[] = ["jev-mock", "openai-mock"];

/**
 * The same keyword rules, under a name that says what it is: the fallback that
 * runs only when the Azure decision model has no credential, so the server can
 * still start. It is never described as a model.
 */
export class KeywordUnavailableModule extends KeywordDecisionModule {
  static readonly ID = "keyword-no-credential";
  readonly id = KeywordUnavailableModule.ID;
  readonly label = "Keyword rules (unavailable: no Azure credential)";
  protected readonly calibration = { base: 0.76, step: 0.11, rivalPenalty: 0.12, cap: 0.97 };
  constructor() {
    super({ enabled: true, latencyMs: 0 });
  }
}
