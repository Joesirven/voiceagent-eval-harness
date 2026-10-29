/**
 * The live pre-action judge. It implements the gate's `Judge`, so it can replace
 * the rule-based judge anywhere (`setActionJudge`, or the harness `judge` option).
 *
 * Order: the code rules run first and a refusal stops there, with no model
 * asked. Otherwise the decision model is asked, with a per attempt budget and
 * an overall action deadline. A timeout or an error is retried (default two
 * retries, a short backoff between them) while time remains before the
 * deadline; an answer, an invalid answer, or "off" is never retried. The
 * action goes ahead by default. It is blocked only when the model answered
 * "block" with a confidence at or above that action's block threshold. An
 * "allow", an "unclear", a "block" below the threshold, and a model that cannot
 * answer (off, too slow, over budget, an error, an invalid answer, a thrown
 * error) all let the action proceed; a failure is recorded in the trace event
 * as the failure reason, with the policy applied named "proceed".
 *
 * The verdict reason is written here, never taken from the model, since the
 * model's reason may repeat the caller's words. The trace event carries codes
 * and numbers only, for the same reason.
 */

import { emitTrace } from "../trace/events.js";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../decision-models/types.js";
import { RuleBasedJudge } from "../judge/rule-judge.js";
import type { TranscriptTurn } from "../provider/interface.js";
import type { Judge, JudgeAction, JudgeRequest, JudgeScoreLine, JudgeVerdict } from "../judge/types.js";
import { liveQuestionFor } from "./live-questions.js";

/** A model, or a function that finds one when asked. Null means none is configured, which counts as "off". */
export type LiveModelSource = DecisionModel | (() => DecisionModel | null);

export interface LiveJudgeOptions {
  /** Default: the rule-based judge. */
  rules?: Judge;
  model: LiveModelSource;
  /** Per attempt budget in milliseconds. Default 3000. Each attempt gets the lesser of this and the time left. */
  attemptBudgetMs?: number;
  /** The same as `attemptBudgetMs`, kept so older callers still work. */
  budgetMs?: number;
  /** The whole decision, every attempt and backoff included, in milliseconds. Default 6000. */
  deadlineMs?: number;
  /** Retries after the first attempt, on a timeout or an error only. Default 2. */
  retries?: number;
  /** Waits before each retry in milliseconds. Default 150 then 300. */
  backoffMs?: number[];
  /** Waits this long; injectable so tests never really wait. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Per action block thresholds, replacing the default. A "block" answer blocks only at or above it. */
  blockThresholds?: Partial<Record<JudgeAction, number>>;
  /** Milliseconds, for measuring latency. Default: the wall clock. */
  clock?: () => number;
}

export const DEFAULT_ATTEMPT_BUDGET_MS = 3000;
export const DEFAULT_DEADLINE_MS = 6000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = [150, 300];

/** One model attempt as recorded in the trace: codes and numbers only. */
export interface JudgeAttempt {
  n: number;
  /** "answered", or the failure reason: "timeout", "error", "off", "invalid_answer", "too_large". */
  outcome: string;
  latencyMs: number;
}

const RETRYABLE = new Set(["timeout", "error"]);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** One threshold for every action: the model must be at least this confident in "block" before an action is stopped. */
export const DEFAULT_BLOCK_THRESHOLD = 0.7;

export function defaultBlockThreshold(_action: JudgeAction): number {
  return DEFAULT_BLOCK_THRESHOLD;
}

/** Only turns that were really spoken, and never the system's own lines, go to the model. */
function conversationFor(transcript: TranscriptTurn[]): TranscriptTurn[] {
  return transcript.filter((t) => t.role !== "system" && t.spoken !== false);
}

function describeModel(model: DecisionModel | null): { id: string; kind: string } {
  return model ? { id: model.id, kind: model.kind } : { id: "none", kind: "none" };
}

/** A confidence as a plain number with two decimals. */
function two(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "unknown";
}

function lineFor(note: string, ok: boolean): JudgeScoreLine {
  return { criterion: "decision_model", score: ok ? 1 : 0, note };
}

export class LiveJudge implements Judge {
  readonly id = "live-decision-model";
  private readonly rules: Judge;
  private readonly source: LiveModelSource;
  private readonly attemptBudgetMs: number;
  private readonly deadlineMs: number;
  private readonly retries: number;
  private readonly backoffMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly blockThresholds: Partial<Record<JudgeAction, number>>;
  private readonly clock: () => number;

  constructor(options: LiveJudgeOptions) {
    this.rules = options.rules ?? new RuleBasedJudge();
    this.source = options.model;
    this.attemptBudgetMs = options.attemptBudgetMs ?? options.budgetMs ?? DEFAULT_ATTEMPT_BUDGET_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = options.sleep ?? wait;
    this.blockThresholds = options.blockThresholds ?? {};
    this.clock = options.clock ?? (() => Date.now());
  }

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    const ruled = await this.rules.judge(req);
    if (!ruled.allowed) {
      return {
        allowed: false,
        reason: ruled.reason,
        scores: [...ruled.scores, lineFor("not asked: the rules refused this action first", false)],
      };
    }

    const blockThreshold = this.blockThresholds[req.action] ?? defaultBlockThreshold(req.action);
    const model = typeof this.source === "function" ? this.source() : this.source;
    const { id: modelId, kind: modelKind } = describeModel(model);

    // Attempts: the first call plus retries on a timeout or error, all inside the deadline.
    // Elapsed time is the sum of attempt latencies and backoffs, so it follows the injected clock.
    const attempts: JudgeAttempt[] = [];
    let outcome: { result: DecisionModelOutcome; latencyMs: number; measuredMs: number } | null = null;
    let latencyMs = 0;
    let overBudget = false;
    let attemptBudget = this.attemptBudgetMs;
    let answered: Extract<DecisionModelOutcome, { ok: true }> | null = null;
    let elapsed = 0;
    let stoppedBy = model ? "retries_exhausted" : "off";
    for (let n = 1; model && n <= this.retries + 1; n++) {
      if (n > 1) {
        const backoff = this.backoffMs[n - 2] ?? this.backoffMs[this.backoffMs.length - 1] ?? 0;
        if (elapsed + backoff >= this.deadlineMs) {
          stoppedBy = "deadline";
          break;
        }
        await this.sleep(backoff);
        elapsed += backoff;
      }
      attemptBudget = Math.max(1, Math.min(this.attemptBudgetMs, this.deadlineMs - elapsed));
      outcome = await this.ask(model, req, attemptBudget);
      // A mock reports a simulated latency and does not wait; a real model is timed by the injected clock.
      latencyMs = modelKind === "mock" ? outcome.latencyMs : outcome.measuredMs;
      overBudget = latencyMs > attemptBudget;
      elapsed += Math.min(latencyMs, attemptBudget);
      answered = outcome.result.ok && !overBudget ? outcome.result : null;
      const code = answered ? "answered" : outcome.result.ok ? "timeout" : outcome.result.reason;
      attempts.push({ n, outcome: code, latencyMs });
      if (answered) {
        stoppedBy = "answered";
        break;
      }
      if (!RETRYABLE.has(code)) {
        stoppedBy = "not_retryable";
        break;
      }
    }

    const failureReason = answered
      ? null
      : !outcome
        ? "off"
        : outcome.result.ok
          ? "timeout"
          : outcome.result.reason;

    const tries = attempts.length > 1 ? `, after ${attempts.length} attempts` : "";
    const timing = `${latencyMs} milliseconds of a ${attemptBudget} millisecond attempt budget${tries}`;
    const who = modelId === "none" ? "no decision model" : `decision model ${modelId}`;
    let blocked = false;
    let reason: string;
    let note: string;
    if (answered) {
      blocked = answered.answer === "block" && Number.isFinite(answered.confidence) && answered.confidence >= blockThreshold;
      reason = blocked
        ? "the decision model said to block the action with enough confidence"
        : answered.answer === "block"
          ? "the decision model leaned toward blocking the action but was not confident enough, so it went ahead"
          : "the decision model did not ask to block the action, so it went ahead";
      note = `${who} answered ${answered.answer} with confidence ${two(answered.confidence)} against a block threshold of ${two(blockThreshold)}, in ${timing}`;
    } else {
      reason = "the decision model could not answer, so the action went ahead";
      note = `${who} gave no answer (${failureReason}) in ${timing}; the action goes ahead, block threshold ${two(blockThreshold)}`;
    }
    const allowed = !blocked;

    emitTrace("decision", {
      kind: "live_judge",
      action: req.action,
      nodeId: req.nodeId,
      modelId,
      modelKind,
      ok: answered !== null,
      answer: answered ? answered.answer : null,
      confidence: answered ? answered.confidence : null,
      blockThreshold,
      latencyMs,
      attemptBudgetMs: this.attemptBudgetMs,
      deadlineMs: this.deadlineMs,
      attemptCount: attempts.length,
      attempts,
      stoppedBy,
      totalMs: elapsed,
      overBudget,
      failureReason,
      policyApplied: answered ? "none" : "proceed",
      blocked,
      allowed,
    });

    return { allowed, reason, scores: [...ruled.scores, lineFor(note, allowed)] };
  }

  /** One call, timed. A model that throws (it should not) counts as an error. */
  private async ask(
    model: DecisionModel,
    req: JudgeRequest,
    timeoutMs: number,
  ): Promise<{ result: DecisionModelOutcome; latencyMs: number; measuredMs: number }> {
    const q = liveQuestionFor(req.action, req.payload);
    const request: DecisionModelRequest = {
      nodeId: req.nodeId,
      question: q.question,
      answers: q.answers,
      transcript: conversationFor(req.transcript),
      answerCriteria: q.criteria,
      instructions: q.instructions,
    };
    const startedAt = this.clock();
    let result: DecisionModelOutcome;
    try {
      // The model is asked to honour the timeout, but a model that ignores it cannot hold the call past it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<DecisionModelOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout", latencyMs: timeoutMs, modelId: model.id, code: "deadline" }), timeoutMs);
      });
      try {
        result = await Promise.race([model.decide(request, { timeoutMs }), late]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      result = { ok: false, reason: "error", latencyMs: 0, modelId: model.id, code: "threw" };
    }
    const measuredMs = Math.max(0, this.clock() - startedAt);
    // A reply outside the closed list is unreadable, not a vote.
    if (result.ok && !q.answers.includes(result.answer)) {
      result = { ok: false, reason: "invalid_answer", latencyMs: result.latencyMs, modelId: result.modelId };
    }
    return { result, latencyMs: result.latencyMs, measuredMs };
  }
}
