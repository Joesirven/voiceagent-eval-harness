/**
 * Installs the post-call scorer on the development server: the Azure decision
 * model, asked once per call after it ends. `VOICE_HARNESS_POST_CALL_SCORE=off`
 * leaves it out.
 */

import { PostCallScorer } from "../judging/post-call-score.js";
import { traceBus } from "../trace/events.js";
import { liveJudgeModel } from "./live-judge-wiring.js";

export const POST_CALL_SCORE_ENV = "VOICE_HARNESS_POST_CALL_SCORE";

let installed: PostCallScorer | undefined;

export function installPostCallScorer(env: NodeJS.ProcessEnv = process.env): PostCallScorer | undefined {
  if ((env[POST_CALL_SCORE_ENV]?.trim().toLowerCase() ?? "") === "off") {
    console.log(`Post-call score: off (${POST_CALL_SCORE_ENV}=off)`);
    return undefined;
  }
  if (installed) return installed;
  installed = new PostCallScorer({
    model: liveJudgeModel,
    subscribe: (listener) => traceBus.subscribe(listener),
    history: () => traceBus.history(),
    emit: (input) => void traceBus.emit(input),
  });
  installed.install();
  console.log(liveJudgeModel() ? "Post-call score: on (one decision model question per call, after it ends)" : "Post-call score: on, rules only (no decision model configured)");
  return installed;
}
