/**
 * Shared contracts for the behaviour layers: the enforcement rules, the speech
 * guard, the transcript audit, the prompt builder and the grading rubric.
 */

export type Direction = "inbound" | "outbound";

export type RuleKind = "never" | "producer_only";

/**
 * "behaviour" rules never switch off: no price, no coverage advice, no binding, no
 * pressure, never hiding that the caller is speaking with an artificial intelligence.
 * "legal" rules are the legal blocks (recording notice, calling window, voicemail,
 * caller identification, opt-out footer on texts); they sit behind the legal blocks
 * switch (see switches.ts).
 */
export type RuleLayer = "behaviour" | "legal";

export type LegalBlocksMode = "enforced" | "suspended";

export type EnforcementLayer = "runtime" | "prompt" | "transcript";

export interface EnforcementRule {
  id: string;
  kind: RuleKind;
  statement: string;
  pendingLegalResearch: boolean;
  example: string;
  sources: string;
  layers: EnforcementLayer[];
  proposedCheck: string;
  scenarioNumbers: number[];
  scenarioTitles: string[];
}

/** The pattern families the speech guard checks, one per kind of forbidden line. */
export const GUARD_FAMILIES = [
  "identity",
  "price",
  "quote_claim",
  "bound_or_covered",
  "urgency",
  "fear",
  "superlative_or_savings",
  "comparison",
  "eligibility",
  "coverage_advice",
  "policy_change",
  "certificate_issue",
  "turnaround",
  "payment",
  "close",
  "identifier",
  "pretext",
  "record_access",
  "invented_experience",
  "inducement",
  "sensitive_recall",
  "account_facts_before_authority",
  "product_recommendation",
  "product_description",
  "discount",
  "guessed_figure",
  "voicemail_speech",
] as const;

export type GuardFamily = (typeof GUARD_FAMILIES)[number];

export interface Finding {
  /** The rule identifiers this finding breaks. The first is the primary rule. */
  ruleIds: string[];
  /** A speech guard family, or the name of the sequence check that raised it. */
  family: string;
  /** "block" stops a line before it is spoken; "flag" is recorded after the fact. */
  severity: "block" | "flag";
  layer: RuleLayer;
  turnIndex?: number;
  /** The words that triggered it, verbatim from the checked text. */
  excerpt: string;
  note: string;
}

/** What the lead record backs. Absent or false means: do not say it. */
export interface RecordFacts {
  /** The lead agreed by text to a call at a set time. */
  textAgreement: boolean;
  /** A written message from the agency to this person really went out. */
  emailSent: boolean;
  /** A real, trackable referral exists for this lead. */
  referral: boolean;
  /** A quote was really prepared for this lead by a producer. */
  priorQuote: boolean;
}

export interface GuardContext {
  direction: Direction;
  /** A line spoken on a call, or the body of a written message. Default "speech". */
  channel?: "speech" | "text";
  record?: Partial<RecordFacts>;
  /** False until the named contact has been confirmed (outbound). Default true. */
  rightPersonConfirmed?: boolean;
  /** Everything the caller has said so far this call, one entry per turn. */
  callerSaid?: string[];
  /** Phone numbers the agent may read back (the lead's, the agency's published one). */
  knownNumbers?: string[];
  /** Carrier names on the record, kept off the line until the right person is confirmed. */
  carrierNames?: string[];
  agencyName?: string;
  /** Who picked up an outbound attempt. Speech to a voicemail is blocked (legal layer). */
  answeredBy?: "person" | "voicemail" | "unknown";
  /** Overrides the process-wide switch for this check. */
  legalBlocks?: LegalBlocksMode;
  /** Whether this is the agent's first turn of the call. */
  firstAgentTurn?: boolean;
}

export interface GuardResult {
  allowed: boolean;
  /** The text to speak: the original when allowed, otherwise the fallback line. */
  spokenText: string;
  findings: Finding[];
}

/** One scored line, the same shape the judges already use (criterion, 0 to 1, note). */
export interface ScoreLine {
  criterion: string;
  score: number;
  note: string;
}
