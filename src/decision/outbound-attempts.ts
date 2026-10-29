/**
 * The outbound pattern. The system places at most two outbound attempts that
 * go unanswered, and on voicemail or no answer it hangs up and leaves no
 * message in an artificial voice. When the lead calls back, that is an inbound
 * call and the tree runs with the inbound disclosure. If a person answers an
 * attempt, the normal outbound flow runs, with every gate applying to each
 * attempt.
 */

import type { CallHarness, RunOutboundResult, ScenarioRunOptions } from "../harness/call-harness.js";
import type { DialOutcome } from "../provider/interface.js";
import { recordStore } from "../trace/records.js";

export const MAX_UNANSWERED_ATTEMPTS = 2;

/** How many outbound attempts to this lead for this agreed slot rang out or hit voicemail, from the durable records. */
export function countUnansweredAttempts(leadId: string, slot: string): number {
  return recordStore
    .list()
    .filter(
      (r) =>
        r.kind === "call" &&
        r.leadId === leadId &&
        r.direction === "outbound" &&
        r.outcome?.status === "not_answered" &&
        r.outcome.slot === slot,
    ).length;
}

export interface AttemptSequenceOptions extends Omit<ScenarioRunOptions, "attempt" | "dialOutcome" | "idempotencyKey"> {
  /** What happens on each attempt, in order. Missing entries are answered. */
  outcomes: DialOutcome[];
  idempotencyKey: string;
}

/**
 * Places attempts one after another until a person answers, a gate blocks one,
 * or the two-attempt limit is reached. A third attempt is never placed.
 */
export async function placeOutboundAttempts(
  harness: CallHarness,
  leadId: string,
  opts: AttemptSequenceOptions,
): Promise<RunOutboundResult[]> {
  const results: RunOutboundResult[] = [];
  const { outcomes, ...rest } = opts;
  for (let attempt = 1; attempt <= MAX_UNANSWERED_ATTEMPTS; attempt += 1) {
    const result = await harness.runOutbound(leadId, "", {
      ...rest,
      attempt,
      dialOutcome: outcomes[attempt - 1] ?? "answered",
    });
    results.push(result);
    if (result.status !== "not_answered") break;
  }
  return results;
}
