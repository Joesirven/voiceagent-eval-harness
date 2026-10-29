import type { GuardFamily } from "../types.js";

/**
 * Which enforcement rules each speech guard family enforces. The first entry is
 * the primary rule. A finding from a family carries all of its rule identifiers.
 */
export const FAMILY_RULES: Record<GuardFamily, string[]> = {
  identity: ["Never-01"],
  price: ["Producer-only-01"],
  quote_claim: ["Never-04", "Producer-only-09"],
  bound_or_covered: ["Never-05", "Producer-only-05"],
  urgency: ["Never-06"],
  fear: ["Never-07"],
  superlative_or_savings: ["Never-12"],
  comparison: ["Producer-only-03"],
  eligibility: ["Producer-only-04"],
  coverage_advice: ["Producer-only-02", "Producer-only-14"],
  policy_change: ["Producer-only-07"],
  certificate_issue: ["Producer-only-08"],
  turnaround: ["Never-21"],
  payment: ["Producer-only-06"],
  close: ["Producer-only-10"],
  identifier: ["Never-17", "Producer-only-13"],
  pretext: ["Never-03"],
  record_access: ["Never-14"],
  invented_experience: ["Never-13"],
  inducement: ["Never-16"],
  sensitive_recall: ["Never-18"],
  account_facts_before_authority: ["Never-18"],
  product_recommendation: ["Producer-only-11"],
  product_description: ["Producer-only-15"],
  discount: ["Producer-only-12"],
  guessed_figure: ["Never-15"],
  voicemail_speech: ["Never-11"],
};

/** Families that belong to the legal layer. Everything else is a behaviour rule and never switches off. */
export const LEGAL_FAMILIES: ReadonlySet<GuardFamily> = new Set<GuardFamily>(["voicemail_speech"]);
