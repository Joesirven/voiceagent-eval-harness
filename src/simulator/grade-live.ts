/**
 * Grading adjustments for calls where the agent speaks its own live words.
 * The existing whole-call grade was written for the tree's template lines:
 *
 *   - The opening: a live model may say the disclosure in two lines with a pause.
 *     Every agent line before the first caller line is one opening turn, so the
 *     disclosure gates read all of it.
 *   - disclosure_first: the rule-based post-call judge asks for the inbound
 *     opening script word for word, which live words never match. Here it is
 *     settled by meaning instead: the opening turn says the caller is speaking
 *     with an artificial intelligence assistant and that the call is recorded
 *     (the same tests as Never-01 and Never-02), and comes before the caller
 *     speaks. Every other criterion is the rule-based judge's own.
 *
 * The record itself is never changed; only what the grade reads.
 */

import { RuleBasedPostCallJudge } from "../judge/post-call.js";
import { transcriptGates } from "../judging/offline/whole-call.js";
import type { PostCallJudge } from "../trace/extensions.js";
import type { HarnessRecord, TranscriptLine } from "../trace/index.js";

/** Joins the agent lines before the first caller line into one opening turn. */
export function mergeOpening<T extends Pick<TranscriptLine, "role" | "text">>(transcript: readonly T[]): T[] {
  const firstCaller = transcript.findIndex((t) => t.role === "caller");
  const head = firstCaller < 0 ? transcript.length : firstCaller;
  const opening = transcript.slice(0, head).filter((t) => t.role === "agent");
  if (opening.length < 2 || transcript.slice(0, head).some((t) => t.role !== "agent")) return [...transcript];
  return [{ ...opening[0]!, text: opening.map((t) => t.text).join(" ") }, ...transcript.slice(head)];
}

export class LiveWordsPostCallJudge implements PostCallJudge {
  constructor(private readonly base: PostCallJudge = new RuleBasedPostCallJudge()) {}

  async judge(record: HarnessRecord): Promise<Awaited<ReturnType<PostCallJudge["judge"]>>> {
    const score = await this.base.judge(record);
    const merged = mergeOpening(record.transcript);
    const opens = merged[0]?.role === "agent";
    const gates = new Map(transcriptGates(merged.slice(0, 1)).map((g) => [g.rule, g.passed]));
    const ok = opens && gates.get("Never-01") === true && gates.get("Never-02") === true;
    const criteria = score.criteria.map((c) =>
      c.criterion === "disclosure_first"
        ? {
            criterion: c.criterion,
            score: ok ? 1 : 0,
            note: ok
              ? "the call opened with the AI disclosure and the recording notice (live words, judged by meaning)"
              : "the call did not open with the AI disclosure and a plain recording notice before the caller spoke (live words, judged by meaning)",
          }
        : c,
    );
    const total = criteria.reduce((sum, c) => sum + c.score, 0);
    return { ...score, criteria, score: Math.round((total / Math.max(1, criteria.length)) * 100) };
  }
}
