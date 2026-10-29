/**
 * The decision module contract. Input: the conversation so far, the current
 * node and a typed question with a closed list of answers. Output: one answer
 * from that list, a confidence from 0 to 1, and a reason.
 */

import type { TranscriptTurn } from "../provider/interface.js";

export interface DecisionRequest {
  nodeId: string;
  question: string;
  /** The closed list. Always includes "unclear". */
  answers: string[];
  /** The conversation so far, ending with the caller's latest line. */
  transcript: TranscriptTurn[];
  /** Extra keyword cues per answer from the tree, used by the keyword mocks. */
  cues?: Record<string, string[]>;
  /**
   * What each answer means, in plain words, from the tree. Only answers that
   * have a meaning appear. Models that take criteria send these; the keyword
   * modules ignore them. Never put them in a trace event or a log.
   */
  answerCriteria?: Record<string, string>;
  /** What the harness knows about the call, for modules that can use it. */
  context?: { missedCalls: number; lead?: LeadFacts };
}

/** What the lead record says about who is expected on the line. The caller's words still decide. */
export interface LeadFacts {
  name?: string;
  business?: string;
}

export interface DecisionResult {
  answer: string;
  /** 0 to 1. */
  confidence: number;
  reason: string;
  /** Confidence for each allowed answer, including ones that were not chosen. */
  scores?: Array<{ answer: string; confidence: number }>;
}

export interface DecisionModuleConfig {
  enabled: boolean;
  /** Simulated time for one typed question. Recorded on the decision event, never slept. */
  latencyMs: number;
}

export interface DecisionModule {
  readonly id: string;
  readonly label: string;
  getConfig(): DecisionModuleConfig;
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /** Optional: a module with settings the registry may change. Modules without it are left as they are. */
  updateConfig?(patch: Partial<DecisionModuleConfig>): DecisionModuleConfig;
  setEnabled?(enabled: boolean): void;
}
