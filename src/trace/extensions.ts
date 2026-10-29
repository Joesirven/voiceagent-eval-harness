/**
 * Extension points for later work. Interfaces only: nothing here is
 * implemented or called. A later child fills these from the training playbook
 * and the scoring rubric.
 */

/** The steps of a call, in the order a good call moves through them. */
export type CallFlowStep =
  | "disclosure"
  | "recognize_lead"
  | "discovery"
  | "quote_fields"
  | "objection"
  | "booking"
  | "message"
  | "handoff";

/**
 * A per-step structured decision record: what the agent noticed, what it
 * chose, and which rule or playbook item it used. Attach to a trace event's
 * `decision` field.
 */
export interface DecisionRecord {
  step: string;
  noticed: string;
  chose: string;
  /** Identifier of the rule or training playbook item that drove the choice. */
  ruleOrPlaybookItem: string;
}

/** A post-call judge score, stored on the record once a judge has run. */
export interface JudgeScore {
  judgedAt: string;
  /** Overall score on the rubric's own scale. */
  score: number;
  /** One line per rubric criterion, in plain language. */
  criteria: Array<{ criterion: string; score: number; note: string }>;
}

/** Scores a finished call from its record. */
export interface PostCallJudge {
  judge(record: import("./records.js").HarnessRecord): Promise<JudgeScore>;
}

/** Produces decision records while a call runs. */
export interface DecisionRecorder {
  record(step: CallFlowStep, decision: DecisionRecord): void;
}
