import { RuleBasedPostCallJudge } from "./post-call.js";
import { RuleBasedJudge } from "./rule-judge.js";
import type { Judge } from "./types.js";
import type { PostCallJudge } from "../trace/extensions.js";

export * from "./types.js";
export * from "./gate.js";
export { RuleBasedJudge, isExplicitYes } from "./rule-judge.js";
export { RuleBasedPostCallJudge } from "./post-call.js";

let actionJudge: Judge = new RuleBasedJudge();
let postCallJudge: PostCallJudge = new RuleBasedPostCallJudge();

/** The judge every destructive action goes through. Swap it with `setActionJudge`. */
export function getActionJudge(): Judge {
  return actionJudge;
}
export function setActionJudge(judge: Judge): void {
  actionJudge = judge;
}
export function getPostCallJudge(): PostCallJudge {
  return postCallJudge;
}
export function setPostCallJudge(judge: PostCallJudge): void {
  postCallJudge = judge;
}
export function resetJudges(): void {
  actionJudge = new RuleBasedJudge();
  postCallJudge = new RuleBasedPostCallJudge();
}
