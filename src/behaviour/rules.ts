/**
 * The enforcement rules as data (imported from the reviewed enforcement table),
 * plus the hand-written map from each rule to the code that enforces it.
 */

import { readDataFile } from "./data-files.js";
import type { EnforcementRule, GuardFamily, RuleLayer } from "./types.js";

interface RulesFile {
  rules: EnforcementRule[];
}

const loaded = readDataFile<RulesFile>("enforcement-rules.json").rules;

export const ENFORCEMENT_RULES: readonly EnforcementRule[] = loaded;

export function getRule(id: string): EnforcementRule {
  const rule = ENFORCEMENT_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown_rule:${id}`);
  return rule;
}

/** The named checks that enforce rules. Every one is exercised by a test. */
export type CheckId =
  | `speech:${GuardFamily}`
  | "opening_disclosure"
  | "opening_recording_notice"
  | "identity_question"
  | "opt_out"
  | "objection_counter"
  | "wrong_number"
  | "loss_report"
  | "handoff_validation"
  | "quote_field_allowlist"
  | "redact_summaries"
  | "sender_identified"
  | "agreed_time_window"
  | "caller_id"
  | "transcript_audit"
  | "model_audit";

export interface RuleEnforcement {
  layer: RuleLayer;
  /** Code checks that enforce the rule. Prompt text is never the only layer for a never rule. */
  checks: CheckId[];
  /**
   * Set when the rule cannot be fully decided by patterns. The phrase-list checks
   * above still run; the rest needs the model-graded audit, run offline.
   */
  fuzzy?: string;
}

/**
 * Layer "legal" marks the legal blocks: the recording notice, the calling window and
 * agreed-time bound, no message to a voicemail, caller identification, and the opt-out
 * footer on texts. Everything else is a behaviour rule and stays on in every mode.
 */
export const RULE_ENFORCEMENT: Record<string, RuleEnforcement> = {
  "Never-01": { layer: "behaviour", checks: ["opening_disclosure", "identity_question", "speech:identity", "sender_identified", "transcript_audit"] },
  "Never-02": { layer: "legal", checks: ["opening_recording_notice", "transcript_audit"] },
  "Never-03": { layer: "behaviour", checks: ["speech:pretext", "transcript_audit"] },
  "Never-04": { layer: "behaviour", checks: ["speech:quote_claim", "handoff_validation", "transcript_audit"] },
  "Never-05": { layer: "behaviour", checks: ["speech:bound_or_covered", "transcript_audit"] },
  "Never-06": { layer: "behaviour", checks: ["speech:urgency", "transcript_audit"], fuzzy: "urgency worded in ways the phrase list does not know" },
  "Never-07": { layer: "behaviour", checks: ["speech:fear", "transcript_audit"], fuzzy: "manufactured loss scenarios in free wording" },
  "Never-08": { layer: "behaviour", checks: ["opt_out", "transcript_audit"] },
  "Never-09": { layer: "behaviour", checks: ["objection_counter", "transcript_audit"] },
  "Never-10": { layer: "legal", checks: ["agreed_time_window"] },
  "Never-11": { layer: "legal", checks: ["speech:voicemail_speech"] },
  "Never-12": { layer: "behaviour", checks: ["speech:superlative_or_savings", "transcript_audit"] },
  "Never-13": { layer: "behaviour", checks: ["speech:invented_experience", "model_audit"], fuzzy: "invented stories have no fixed wording" },
  "Never-14": { layer: "behaviour", checks: ["speech:record_access", "transcript_audit"] },
  "Never-15": { layer: "behaviour", checks: ["speech:guessed_figure", "handoff_validation", "quote_field_allowlist", "transcript_audit"] },
  "Never-16": { layer: "behaviour", checks: ["speech:inducement", "transcript_audit"] },
  "Never-17": { layer: "behaviour", checks: ["speech:identifier", "quote_field_allowlist", "transcript_audit"] },
  "Never-18": { layer: "behaviour", checks: ["speech:sensitive_recall", "speech:account_facts_before_authority", "redact_summaries", "transcript_audit"] },
  "Never-19": { layer: "legal", checks: ["caller_id"] },
  "Never-20": { layer: "behaviour", checks: ["wrong_number", "transcript_audit"] },
  "Never-21": { layer: "behaviour", checks: ["speech:turnaround", "handoff_validation", "transcript_audit"] },
  "Producer-only-01": { layer: "behaviour", checks: ["speech:price", "transcript_audit"] },
  "Producer-only-02": { layer: "behaviour", checks: ["speech:coverage_advice", "transcript_audit"] },
  "Producer-only-03": { layer: "behaviour", checks: ["speech:comparison", "transcript_audit"] },
  "Producer-only-04": { layer: "behaviour", checks: ["speech:eligibility", "transcript_audit"] },
  "Producer-only-05": { layer: "behaviour", checks: ["speech:bound_or_covered", "transcript_audit"] },
  "Producer-only-06": { layer: "behaviour", checks: ["speech:payment", "quote_field_allowlist", "transcript_audit"] },
  "Producer-only-07": { layer: "behaviour", checks: ["speech:policy_change", "transcript_audit"] },
  "Producer-only-08": { layer: "behaviour", checks: ["speech:certificate_issue", "transcript_audit"] },
  "Producer-only-09": { layer: "behaviour", checks: ["speech:quote_claim", "transcript_audit"] },
  "Producer-only-10": { layer: "behaviour", checks: ["speech:close", "transcript_audit"] },
  "Producer-only-11": { layer: "behaviour", checks: ["speech:product_recommendation", "model_audit"], fuzzy: "a recommendation can be worded without naming a line" },
  "Producer-only-12": { layer: "behaviour", checks: ["speech:discount", "quote_field_allowlist", "transcript_audit"] },
  "Producer-only-13": { layer: "behaviour", checks: ["speech:identifier", "quote_field_allowlist", "transcript_audit"] },
  "Producer-only-14": { layer: "behaviour", checks: ["speech:coverage_advice", "loss_report", "transcript_audit"] },
  "Producer-only-15": { layer: "behaviour", checks: ["speech:product_description", "model_audit"], fuzzy: "product features and tax claims have no fixed wording" },
};

export function ruleLayer(id: string): RuleLayer {
  const entry = RULE_ENFORCEMENT[id];
  if (!entry) throw new Error(`unknown_rule:${id}`);
  return entry.layer;
}
