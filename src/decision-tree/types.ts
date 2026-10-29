/**
 * The voice agent's decision tree, as data. Every node waits on one closed
 * typed question that a swappable decision module answers with an answer, a
 * confidence and a reason; every answer carries its own minimum confidence;
 * every destructive action and every ending is judge-gated.
 *
 * Field names follow the tree engine's own types (`src/decision/tree.ts` on
 * the engine branch) so `toEngineTree` is a projection, not a translation.
 * Fields the engine does not read yet (`area`, `situation`, `judge`,
 * `repeatKey`, `interrupts`, `starts`, `closesGaps`, `sources`) ride along.
 *
 * The harness's compliance gates and the AI and recording disclosure always
 * run before the tree. The tree never encodes them.
 */

/** Where a node sits in the call; the live view groups by this. */
export const AREAS = ["entry", "open", "discovery", "objection", "booking", "transfer", "message", "service", "safety"] as const;
export type Area = (typeof AREAS)[number];

/** The steps the trace already knows (`src/trace/extensions.ts`). */
export type FlowStep = "disclosure" | "recognize_lead" | "discovery" | "quote_fields" | "objection" | "booking" | "message" | "handoff";

/** Destructive actions an answer may carry. Ending with a disposition is the sixth, and is gated through the disposition itself. */
export const ACTION_TYPES = ["transfer", "save_details", "save_quote_field", "book", "send_text"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Quote fields the tree may save, each only from the caller's own words. Context pack file 03 section 3.4 sets the priority. */
export const QUOTE_FIELDS = [
  "x_date",
  "current_carrier",
  "payroll",
  "employee_count",
  "owner_only",
  "general_liability",
  "business_class",
  "decision_maker_name",
  "decision_maker_phone",
  "contact_language",
] as const;
export type QuoteField = (typeof QUOTE_FIELDS)[number];

/** The engine's extractors: a year, a time or day, or the caller's whole line. */
export type ExtractKind = "year" | "time" | "caller_line";

/** Caller details the engine takes from the caller's words on any node (src/decision/extract.ts). */
export const COLLECTED_VALUES = ["callerName", "businessName"] as const;
export type CollectedValue = (typeof COLLECTED_VALUES)[number];

/** Template variables a line may use besides the ones an `extract` sets. */
export const BUILT_IN_VARIABLES = ["firstName", ...COLLECTED_VALUES] as const;

/**
 * The caller details a node's line asks for. The engine never asks for one it
 * already has: with one still missing it says `lines[value]` instead of the
 * node's line (once per call), and with nothing left to ask the call moves on
 * to `then`, which is also where an answer that leads to `then` waits for
 * the missing detail first.
 */
export interface Collects {
  values: CollectedValue[];
  lines?: Partial<Record<CollectedValue, string>>;
  then: string;
}

export interface TreeAction {
  type: ActionType;
  /** save_quote_field: which field. */
  field?: QuoteField;
  /** save_details: what kind of detail ("message", "service_request", "callback_time"). */
  kind?: string;
  /** transfer: why. */
  reason?: string;
  /** send_text: the fixed text. */
  body?: string;
  /** The variable holding the value, set by an `extract` on this answer or an earlier one. */
  from?: string;
}

/**
 * The live pre-action judge for one gated answer: code rules first, then one
 * fast decision-module question. Both must allow it.
 */
export interface JudgeSpec {
  /** Plain-language names of the code rules that run first, for example "value is inside the caller's words". */
  codeRules: string[];
  /** A closed yes or no question for the fast decision module. "yes" allows. */
  question: string;
  /** How sure the module must be of "yes". At least 0.85 for a durable ending. */
  minConfidence: number;
}

export interface TreeAnswer {
  answer: string;
  /** What this answer means, in words the decision module reads as the answer's criterion. */
  meaning?: string;
  /** The node entered when this answer is taken with enough confidence. */
  next?: string;
  /** The disposition the call ends with, if this answer ends it. */
  disposition?: string;
  /** How sure the decision module must be before this answer is taken. */
  minConfidence: number;
  action?: TreeAction;
  /** What the agent says, in place of the next node's own line. */
  say?: string;
  /** Ask the next node's question of this same caller line. */
  carry?: boolean;
  extract?: { as: string; with: ExtractKind };
  /** Said (and the optional next node) when the judge refuses. */
  onBlocked?: { say: string; next?: string };
  judge?: JudgeSpec;
  /** Extra keyword cues for the keyword mock decision modules. */
  cues?: string[];
  /** Interrupts only: say `say`, then ask the current node's question again. No next, no disposition. */
  resume?: boolean;
  /** Node answers only: go back to the node the last interrupt left, when there is one; otherwise to `next`. */
  returnToOrigin?: boolean;
  /** Node answers only: on a call that started at `starts.knownLead`, the node entered instead of `next` (a new speaker is confirmed, never asked who they are). */
  knownLeadNext?: string;
  /** Node answers only: once the known lead has said yes at `starts.knownLead`, the node entered instead of `next`. */
  confirmedLeadNext?: string;
}

export interface TreeNode {
  id: string;
  label: string;
  area: Area;
  flowStep?: FlowStep;
  /** What is going on when the call reaches this node. */
  situation: string;
  /** What the agent is trying to get done here. */
  agentGoal: string;
  /**
   * What the agent says on entering. `direction` limits a line to one kind of
   * call. A line marked `confirmedLead` is said only once the known lead has
   * said yes at `starts.knownLead`, in place of the node's other lines.
   */
  agentLines?: Array<{ line: string; direction?: "inbound" | "outbound"; confirmedLead?: boolean }>;
  decision?: { question: string; answers: TreeAnswer[] };
  /** The clarifying line, said on "unclear" or low confidence. */
  clarify?: string;
  /** The caller details this node's line asks for; see `Collects`. */
  collects?: Collects;
  /**
   * For a node without `collects`: the caller details its line asks for, so
   * the engine keeps a bare reply ("Dana Reyes.") as that detail.
   */
  asks?: CollectedValue[];
  /**
   * Where this node ends when the caller is still unclear after the clarifying
   * lines, in place of bringing in a person. For a node where a person must
   * never be handed a caller who may not have meant to talk to one (a stop
   * request still unclear, a possible minor). A non-durable ending.
   */
  escalation?: { say: string; disposition: string };
  /** The fragment's own list of situations that call for a person. Not read by the engine; kept so none is lost. */
  handoffTriggers?: string[];
  /** A node with no question moves straight on. */
  next?: string;
  /** A phrase in this node's line that counts as a promise in the handoff note. */
  promise?: string;
  /** Objection class. The second time the same class comes up in a call, the repeat rule ends it. */
  repeatKey?: string;
  /** Lines the agent must never say here. */
  neverSay?: string[];
  /** Training archive and context pack references that back this node. */
  sources: string[];
  /** Gap numbers from docs/decision-tree.md that this node closes. */
  closesGaps?: number[];
  /** What CRM does today for this situation, if anything. */
  crmEquivalent?: string;
}

export interface TreeDisposition {
  name: string;
  label: string;
  /** A durable ending takes the lead off the list. Needs a bar of at least 0.85. */
  durable: boolean;
  meaning: string;
  /** CRM's `Disposition` this maps to, or "none: <why>". */
  crmEquivalent: string;
}

export interface DecisionTreeData {
  id: string;
  version: string;
  /** The inbound entry; the engine's `start`. Same as `starts.inbound`. */
  start: string;
  /** `knownLead`: where a call to or from a known lead starts, either direction (the confirmation question). */
  starts: { inbound: string; outbound: string; knownLead?: string };
  /** Clarifying lines in a row at one node before a person is brought in. */
  maxClarifications: number;
  escalation: { say: string; disposition: string };
  /**
   * Asked on every caller line before the current node's question, after the
   * harness's own stop check. "none" means carry on with the node.
   */
  interrupts: { question: string; clarify: string; answers: TreeAnswer[] };
  /** Context pack file 18 section 18.1: the second time the same objection class comes up, it is real. End politely. */
  repeatRule: { say: string; disposition: string };
  dispositions: TreeDisposition[];
  nodes: TreeNode[];
}

/** The validated tree, with nodes also indexed by id. */
export interface DecisionTree extends DecisionTreeData {
  byId: ReadonlyMap<string, TreeNode>;
}
