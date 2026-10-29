import type { CallFlowStep, DecisionRecord, DecisionRecorder } from "../trace/extensions.js";

/** Keeps every decision record of one call. The engine also attaches each to its `decision` trace event. */
export class CallDecisionRecorder implements DecisionRecorder {
  readonly records: Array<{ step: CallFlowStep; decision: DecisionRecord }> = [];

  record(step: CallFlowStep, decision: DecisionRecord): void {
    this.records.push({ step, decision });
  }
}
