/**
 * Shared shapes for the offline judges. Nothing here runs during a live call.
 *
 * Imported call fixtures come from an explicit local file: the
 * cleaned, speaker-separated table the diarization workstream is building when
 * it exists, the raw transcripts until then.
 */

/** The most lead lines in one simulated call. Enforced here and in the database. */
export const MAX_TURN_CAP = 25;

export type PastSpeaker = "producer" | "lead";

export interface PastTurn {
  speaker: PastSpeaker;
  text: string;
  /** Milliseconds from the call start, when the source has timings. */
  startMs?: number;
}

export interface PastCall {
  /** The source table's own id for the call. */
  callId: string;
  /** Where the turns came from. "diarized" is the cleaned table. */
  source: "diarized" | "dialer" | "quo";
  /**
   * Whether the producer and lead labels can be trusted. Dialer rows come from
   * separate transcription tracks ("track"); Quo turns need checking
   * ("unverified"); the diarized table says so itself.
   */
  attribution: "track" | "diarized" | "unverified";
  turns: PastTurn[];
  language?: string;
  /** Turn indexes the source marks clean enough for turn-level judging. Absent means unknown. */
  cleanTurns?: number[];
  /** The id of the source table's row for this call, when the reader had it (crm_quo_call.id for Quo). */
  sourceRowId?: string;
}

/** Read-only access to past calls. Implementations must not write anything. */
export interface PastCallSource {
  readonly id: string;
  /** Call ids, newest first. */
  listCallIds(limit: number): Promise<string[]>;
  getCall(callId: string): Promise<PastCall | null>;
}

/* ------------------------------------------------------- turn-level judge */

/** Produces the agent's one reply to a call cut off just before a producer turn. */
export interface ReplyAgent {
  readonly id: string;
  /** `history` ends with the lead's turn the producer was about to answer. */
  reply(history: PastTurn[]): Promise<string>;
}

/** "first" or "second" names the reply shown first or second; the judge never learns which one is the producer's. */
export type PairwisePick = "first" | "second" | "same";

export interface PairwiseJudge {
  readonly id: string;
  compare(input: { history: PastTurn[]; first: string; second: string }): Promise<PairwisePick>;
}

/** The agent's reply against the producer's, after both orders. "inconsistent" verdicts are not counted. */
export type TurnVerdict = "better" | "worse" | "same" | "inconsistent";

export interface TurnJudgement {
  callId: string;
  /** Index of the producer turn in the call. */
  turnIndex: number;
  agentReply: string;
  producerReply: string;
  /** Agent shown first, then producer shown first. */
  picks: [PairwisePick, PairwisePick];
  verdict: TurnVerdict;
}

/* ------------------------------------------------------- whole-call judge */

/** What a simulated lead knows, taken from one past call. Unknown facts stay undefined. */
export interface LeadFacts {
  sourceCallId: string;
  /** The trade or class of work (roofing, plumbing), when known apart from the business type. */
  trade?: string;
  businessType?: string;
  /** As the lead said it, normalized to YYYY-MM-DD when a full date was given. */
  renewalDate?: string;
  annualPayroll?: string;
  employeeCount?: number;
  currentCarrier?: string;
  language?: string;
  /** Objections the lead raised, in order, paraphrased. */
  objections: string[];
  /** One line on temperament: rushed, friendly, suspicious. */
  temperament?: string;
}

export interface FactExtractor {
  readonly id: string;
  extract(call: PastCall): Promise<LeadFacts>;
}

/** Plays the lead. Returns the lead's next line, or null to hang up. */
export interface SimulatedLead {
  readonly facts: LeadFacts;
  next(agentLine: string): Promise<string | null>;
}

export interface WholeCallOutcome {
  renewalDateConfirmed: boolean;
  payrollCaptured: boolean;
  employeeCountCaptured: boolean;
  booked: boolean;
}

export interface EnforcementResult {
  /** Rule identifier from the enforcement table (for example "Never-01") or the post-call judge's criterion name. */
  rule: string;
  passed: boolean;
  note: string;
}

export interface WholeCallJudgement {
  sourceCallId: string;
  outcome: WholeCallOutcome;
  enforcement: EnforcementResult[];
  /** Every enforcement rule passed. */
  enforcementPassed: boolean;
  turns: number;
}
