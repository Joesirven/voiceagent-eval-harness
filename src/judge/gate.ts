/**
 * The one choke point for destructive actions. Every action goes through
 * `guardedAction`: the judge runs, a `judge_verdict` event is emitted, and the
 * action runs only when the verdict allows it. A refusal is logged and the
 * action never runs. A judge that throws, or returns an invalid verdict, does
 * not stop the action: it proceeds and the failure is recorded as a trace event
 * carrying a code only, never text from the error.
 */

import { RuleBasedJudge } from "./rule-judge.js";
import { logCommunication } from "../store/call-log.js";
import { emitTrace } from "../trace/events.js";
import type { Judge, JudgeRequest, JudgeVerdict } from "./types.js";

export interface GateContext {
  judge: Judge;
  leadId: string;
  callId: string;
}

export type GuardedResult<T> = { allowed: true; verdict: JudgeVerdict; value: T } | { allowed: false; verdict: JudgeVerdict };

class GateJudgeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function guardedAction<T>(
  gate: GateContext,
  request: JudgeRequest,
  run: () => Promise<T>,
): Promise<GuardedResult<T>> {
  // The code rules always run and always refuse: if they themselves fail, the action is refused.
  let verdict: JudgeVerdict;
  try {
    verdict = await new RuleBasedJudge().judge(request);
  } catch {
    verdict = {
      allowed: false,
      reason: "the code rules could not run, so the action was refused",
      scores: [{ criterion: "rules_available", score: 0, note: "the code rules failed" }],
    };
  }
  // An injected judge only adds refusals. If it throws or answers badly, the action goes ahead
  // and the failure is recorded as a code (never text from the error).
  if (verdict.allowed && !(gate.judge instanceof RuleBasedJudge)) {
    try {
      const injected = await gate.judge.judge(request);
      if (!injected || typeof injected.allowed !== "boolean" || !Array.isArray(injected.scores)) throw new GateJudgeError("judge_invalid_verdict");
      verdict = injected;
    } catch (error) {
      const code = error instanceof GateJudgeError ? error.code : "judge_threw";
      emitTrace("judge_error", { action: request.action, code });
      verdict = {
        allowed: true,
        reason: "the judge could not answer, so the action went ahead",
        scores: [...verdict.scores, { criterion: "judge_available", score: 0, note: `the judge failed (${code}); the action went ahead` }],
      };
    }
  }
  emitTrace("judge_verdict", {
    action: request.action,
    allowed: verdict.allowed,
    reason: verdict.reason,
    scores: verdict.scores,
  });
  if (!verdict.allowed) {
    logCommunication({
      leadId: gate.leadId,
      callId: gate.callId,
      channel: "call",
      direction: request.direction,
      outcome: "blocked",
      reason: `judge_refused:${request.action}`,
    });
    return { allowed: false, verdict };
  }
  return { allowed: true, verdict, value: await run() };
}
