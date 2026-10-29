/**
 * Installs the objectives judge on the development server: the same Azure
 * decision model the live judge uses, asked in the background after each
 * spoken line. `VOICE_HARNESS_OBJECTIVES_JUDGE=off` leaves it out.
 */

import { ObjectivesJudge } from "../judging/objectives.js";
import { traceBus } from "../trace/events.js";
import { liveJudgeModel } from "./live-judge-wiring.js";

export const OBJECTIVES_JUDGE_ENV = "VOICE_HARNESS_OBJECTIVES_JUDGE";

let installed: ObjectivesJudge | undefined;

export function objectivesJudgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[OBJECTIVES_JUDGE_ENV]?.trim().toLowerCase() ?? "") !== "off";
}

/** Starts the judge once; a second call returns the running one. Returns undefined when switched off. */
export function installObjectivesJudge(env: NodeJS.ProcessEnv = process.env): ObjectivesJudge | undefined {
  if (!objectivesJudgeOn(env)) {
    console.log(`Objectives judge: off (${OBJECTIVES_JUDGE_ENV}=off)`);
    return undefined;
  }
  if (installed) return installed;
  installed = new ObjectivesJudge({
    model: liveJudgeModel,
    subscribe: (listener) => traceBus.subscribe(listener),
    history: () => traceBus.history(),
    emit: (input) => void traceBus.emit(input),
  });
  installed.install();
  const model = liveJudgeModel();
  console.log(model ? `Objectives judge: on (decision model ${model.id}, asked in the background after each line)` : "WARNING Objectives judge: on, but no decision model is configured; objectives stay unjudged");
  return installed;
}

/** For tests: stops and forgets the installed judge. */
export function resetObjectivesJudge(): void {
  installed?.stop();
  installed = undefined;
}
