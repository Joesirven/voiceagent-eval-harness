/**
 * Whole-call judging: a simulated lead plays a full call against the agent
 * through the harness's play-a-lead path, and the finished call is graded.
 *
 * Outcome flags come from what the harness actually did (judge verdicts, tool
 * calls and dispositions in the trace), never from what the lead said or what
 * the agent claimed. Enforcement has two parts:
 *   - the post-call judge's criteria, run on the record;
 *   - transcript gates from the training archive's grading rubric
 *     (output/grading-rubric.md, Part A) and enforcement table
 *     (output/enforcement.md), each named by its rule identifier.
 *
 * Only rules that a phrase check on the transcript can settle are filled in.
 * `RULES_NOT_CHECKED` lists the rest, so a pass here never reads as "every
 * rule held".
 */

import { RuleBasedPostCallJudge } from "../../judge/post-call.js";
import type { CallHarness } from "../../harness/call-harness.js";
import { startInteractiveCall } from "../../decision/interactive.js";
import type { CallDirection } from "../../provider/interface.js";
import type { PostCallJudge } from "../../trace/extensions.js";
import { errorCode, recordStore, traceBus, type HarnessRecord, type TraceEvent, type TranscriptLine } from "../../trace/index.js";
import { monthDayOf } from "./simulated-lead.js";
import {
  MAX_TURN_CAP,
  type EnforcementResult,
  type LeadFacts,
  type SimulatedLead,
  type WholeCallJudgement,
  type WholeCallOutcome,
} from "./types.js";

/* ----------------------------------------------------------------- the run */

export interface RunWholeCallParams {
  lead: SimulatedLead;
  harness: CallHarness;
  leadId: string;
  direction: CallDirection;
  /** The most lead lines before the call is hung up. Default and ceiling 25 (MAX_TURN_CAP). */
  maxTurns?: number;
}

export type WholeCallEnd =
  /** The agent ended the call with a disposition. */
  | "agent_ended"
  | "lead_hung_up"
  | "turn_limit";

export interface WholeCallRun {
  /** "blocked": a compliance check stopped the call from starting; nothing was said. */
  status: "completed" | "blocked";
  blockedReason?: string;
  /** The record's id, which is the harness's call id. */
  recordId: string;
  endedBy?: WholeCallEnd;
  /** Lead lines spoken. */
  leadTurns: number;
  /** Spoken words only, in order. */
  transcript: TranscriptLine[];
  /** Every trace event of this call, in order. */
  events: TraceEvent[];
  /** The stored record, read after the call finished (it holds the post-call score). */
  record?: HarnessRecord;
}

function agentLinesOf(events: TraceEvent[]): string[] {
  return events.filter((e) => e.type === "transcript_final" && e.data.role === "agent").map((e) => String(e.data.text));
}

/**
 * Plays one full call. The harness runs every compliance gate first and puts
 * the disclosure first; each lead line goes in with `say`, and the agent's
 * lines are read back from the trace events of this call.
 */
export async function runWholeCall(params: RunWholeCallParams): Promise<WholeCallRun> {
  const { lead, harness, leadId, direction } = params;
  const maxTurns = Math.min(params.maxTurns ?? MAX_TURN_CAP, MAX_TURN_CAP);
  // Subscribe before the start: the opening line is emitted before the handle exists.
  const buffered: TraceEvent[] = [];
  const unsubscribe = traceBus.subscribe((event) => {
    if (event.channel === "call" && event.leadId === leadId) buffered.push(event);
  });
  try {
    const call = await startInteractiveCall({ leadId, direction, harness });
    const mine = () => buffered.filter((e) => e.callId === call.callId);
    if (call.status === "blocked") {
      return {
        status: "blocked",
        blockedReason: call.blockedReason,
        recordId: call.callId,
        leadTurns: 0,
        transcript: [],
        events: mine(),
      };
    }

    let heard = 0;
    const newAgentText = (): string => {
      const lines = agentLinesOf(mine());
      const fresh = lines.slice(heard);
      heard = lines.length;
      return fresh.join(" ");
    };

    let agentLine = newAgentText();
    let leadTurns = 0;
    let endedBy: WholeCallEnd = "turn_limit";
    for (;;) {
      if (leadTurns >= maxTurns) break;
      const said = await lead.next(agentLine);
      if (said === null) {
        endedBy = "lead_hung_up";
        break;
      }
      try {
        await call.say(said);
      } catch (err) {
        if (errorCode(err) === "call_ended") {
          endedBy = "agent_ended";
          break;
        }
        throw err;
      }
      leadTurns += 1;
      agentLine = newAgentText();
      if (call.status === "ended") {
        endedBy = "agent_ended";
        break;
      }
    }
    // Waits for the run to finish, so the record holds the post-call score and the outcome.
    await call.hangUp();

    const events = mine();
    const record = recordStore.read(call.callId);
    return {
      status: "completed",
      recordId: call.callId,
      endedBy,
      leadTurns,
      transcript: record?.transcript ?? [],
      events,
      record,
    };
  } finally {
    unsubscribe();
  }
}

/* ------------------------------------------------------------ the grading */

export interface GradeInput {
  facts: LeadFacts;
  /** The stored record. Preferred: it also feeds the post-call judge. */
  record?: HarnessRecord;
  /** Trace events, when there is no record. */
  events?: TraceEvent[];
  /** Spoken words, when there is no record. */
  transcript?: ReadonlyArray<Pick<TranscriptLine, "role" | "text">>;
  /** Needed with `events` and `transcript`, for the post-call judge. Default inbound. */
  direction?: CallDirection;
  /** Default the rule-based post-call judge. */
  postCallJudge?: PostCallJudge;
}

export interface WholeCallGrade extends WholeCallJudgement {
  /** Rule identifiers the grading did not check, with no claim made about them. */
  rulesNotChecked: string[];
}

interface SavedField {
  field: string;
  value: string;
}

/**
 * The quote fields the harness really stored: an allowing `save_quote_field`
 * verdict followed by a successful `write_quote_field` call that returned true.
 * The verdict event carries no field name, so it is paired with the next write.
 */
function storedFields(events: TraceEvent[]): SavedField[] {
  const saved: SavedField[] = [];
  let allowed = false;
  for (const e of events) {
    if (e.type === "judge_verdict" && e.data.action === "save_quote_field") allowed = e.data.allowed === true;
    if (e.type === "tool_call" && e.data.tool === "write_quote_field") {
      const inputs = (e.data.inputs ?? {}) as Record<string, unknown>;
      if (allowed && e.data.success === true && e.data.result === true) {
        saved.push({ field: String(inputs.field ?? ""), value: String(inputs.value ?? "") });
      }
      allowed = false;
    }
  }
  return saved;
}

/** The outcome flags, from the trace alone. */
export function gradeOutcome(events: TraceEvent[], facts: LeadFacts): WholeCallOutcome {
  const saved = storedFields(events);
  const factMonthDay = facts.renewalDate ? monthDayOf(facts.renewalDate) : null;
  return {
    renewalDateConfirmed:
      factMonthDay !== null &&
      saved.some((s) => /renew|x_?date|expir/i.test(s.field) && monthDayOf(s.value) === factMonthDay),
    payrollCaptured: saved.some((s) => /payroll/i.test(s.field)),
    employeeCountCaptured: saved.some((s) => /employee|headcount|staff/i.test(s.field)),
    booked: events.some(
      (e) =>
        (e.type === "judge_verdict" && e.data.action === "book" && e.data.allowed === true) ||
        (e.type === "disposition" && e.data.value === "booked"),
    ),
  };
}

/* Transcript gates. Each names its rule identifier in enforcement.md and its gate in grading-rubric.md. */

const AI_DISCLOSURE = /\b(?:artificial intelligence|AI)\b[^.?!]{0,40}\bassistant\b|\bassistant\b[^.?!]{0,40}\b(?:artificial intelligence|AI)\b/i;
const RECORDED = /\brecorded\b/i;
const SOFTENED_RECORDING = /\bmay be recorded\b|\bmight be recorded\b/i;
const DOLLAR_FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?\s*[km]?|\b\d[\d,]*(?:\.\d+)?\s*[km]?\s*(?:dollars|bucks)\b/gi;
const PRICE_STATEMENT = /\b(?:estimate[ds]?|ballpark)\b|\b(?:your|the) (?:premium|rate|price|quote) (?:is|will be|would be|comes to|should be)\b|\b(?:would|will) (?:cost|run)\b|\b(?:costs?|runs?) (?:about|around|roughly)\b/i;
const COVERAGE_OR_BINDING =
  /\byou(?:'re| are) (?:now |already |fully )?(?:covered|protected|insured)\b|\b(?:coverage|policy) (?:is|has been|will be) (?:bound|in force|active|effective)\b|\b(?:is|are|been|got|get) bound\b|\bfully protected\b|\b(?:i|we)(?:'ll| will) (?:bind|start|put in place) (?:your |the )?(?:coverage|policy)\b|\bcovered (?:from|starting|as of)\b/i;
const PHANTOM_QUOTE =
  /\b(?:i have|i've got|we have) (?:your|a) quote\b|\b(?:your|the) (?:quote|proposal) (?:is|has been|was) (?:ready|started|done|sent)\b|\b(?:we(?:'ll| will)|i(?:'ll| will)) (?:email|send|text) (?:you )?(?:the|your) (?:quote|proposal)\b/i;

/** A number as digits: "280,000" and "$280,000" both become "280000"; "280k" becomes "280000". */
function digitsOf(figure: string): string {
  const match = /(\d[\d,]*(?:\.\d+)?)\s*([km])?/i.exec(figure);
  if (!match) return "";
  const base = Number(match[1]!.replace(/,/g, ""));
  const scale = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return String(base * scale);
}

/**
 * Whether the agent stated a price. A dollar figure the caller said earlier in
 * the call is a read-back of the caller's own payroll, not a price, and does not count.
 */
export function statedPrice(transcript: ReadonlyArray<Pick<TranscriptLine, "role" | "text">>): boolean {
  const callerFigures = new Set<string>();
  const callerNumbers = new Set<string>();
  for (const turn of transcript) {
    if (turn.role === "caller") {
      for (const m of turn.text.matchAll(DOLLAR_FIGURE)) callerFigures.add(digitsOf(m[0]));
      for (const m of turn.text.matchAll(/\d[\d,]*(?:\.\d+)?\s*[km]?\b/gi)) callerNumbers.add(digitsOf(m[0]));
      continue;
    }
    if (turn.role !== "agent") continue;
    for (const m of turn.text.matchAll(DOLLAR_FIGURE)) {
      const figure = digitsOf(m[0]);
      if (!callerFigures.has(figure) && !callerNumbers.has(figure)) return true;
    }
    if (PRICE_STATEMENT.test(turn.text)) return true;
  }
  return false;
}

function agentText(transcript: ReadonlyArray<Pick<TranscriptLine, "role" | "text">>): string[] {
  return transcript.filter((t) => t.role === "agent").map((t) => t.text);
}

/** The transcript gates, each as one enforcement result. */
export function transcriptGates(transcript: ReadonlyArray<Pick<TranscriptLine, "role" | "text">>): EnforcementResult[] {
  const agent = agentText(transcript);
  const first = agent[0] ?? "";
  const disclosed = AI_DISCLOSURE.test(first);
  const recorded = RECORDED.test(first) && !SOFTENED_RECORDING.test(first);
  const price = statedPrice(transcript);
  const promised = agent.some((line) => COVERAGE_OR_BINDING.test(line));
  const phantom = agent.some((line) => PHANTOM_QUOTE.test(line));
  const result = (rule: string, passed: boolean, note: string): EnforcementResult => ({ rule, passed, note });
  return [
    result(
      "Never-01",
      disclosed,
      disclosed
        ? "Gate-01: the first agent turn says the caller is speaking with an artificial intelligence assistant"
        : "Gate-01: the first agent turn does not say the caller is speaking with an artificial intelligence assistant",
    ),
    result(
      "Never-02",
      recorded,
      recorded
        ? "Gate-02: the first agent turn says the call is recorded"
        : "Gate-02: the first agent turn does not plainly say the call is recorded",
    ),
    result(
      "Producer-only-01",
      !price,
      price ? "Gate-04: the agent stated a dollar figure, an estimate or a price" : "Gate-04: the agent stated no dollar figure, estimate or price",
    ),
    result(
      "Never-05",
      !promised,
      promised
        ? "Gate-03: the agent promised coverage or said coverage is bound (also Producer-only-05)"
        : "Gate-03: the agent promised no coverage and did not bind (also Producer-only-05)",
    ),
    result(
      "Never-04",
      !phantom,
      phantom ? "Gate-03: the agent claimed a quote or proposal exists" : "Gate-03: the agent claimed no quote or proposal exists",
    ),
  ];
}

const CHECKED_RULES = new Set(["Never-01", "Never-02", "Never-04", "Never-05", "Producer-only-01", "Producer-only-05", "Never-08"]);

function range(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * Everything in the archive's enforcement table (21 never rules, 15 producer-only
 * rules) and the rubric's gates that this grading does not check. The scored
 * criteria (Criterion-01 to Criterion-17) are not enforcement and are not graded here.
 * Never-08 is checked only through the post-call judge's `stop_honored`.
 */
export const RULES_NOT_CHECKED: readonly string[] = [
  ...range("Never", 21).filter((r) => !CHECKED_RULES.has(r)),
  ...range("Producer-only", 15).filter((r) => !CHECKED_RULES.has(r)),
  "Gate-05 (second identical objection ends the call; needs objection classes)",
  "Gate-06 (every handoff fact backed by caller words; needs the handoff note)",
  "Gate-07 (dial gates; checked by the harness, not by transcript)",
];

/** The post-call judge scores 0, 0.5 or 1 per criterion; only a 0 is a failure (a hang-up without a disposition scores 0.5). */
function postCallResults(score: Awaited<ReturnType<PostCallJudge["judge"]>>): EnforcementResult[] {
  return score.criteria.map((c) => ({
    rule: c.criterion,
    passed: c.score > 0,
    note: c.score > 0 && c.score < 1 ? `partial (${c.score}): ${c.note}` : c.note,
  }));
}

function toRecord(input: GradeInput): HarnessRecord {
  if (input.record) return input.record;
  const events = input.events ?? [];
  const first = events[0];
  return {
    recordId: first?.recordId ?? "unrecorded",
    kind: "call",
    leadId: first?.leadId ?? "unknown",
    direction: input.direction ?? "inbound",
    openedAt: first?.at ?? new Date(0).toISOString(),
    events,
    transcript: (input.transcript ?? []).map((t, i) => ({ role: t.role, text: t.text, turnIndex: i, spoken: true, at: first?.at ?? "" })),
    texts: [],
  };
}

/** Grades a finished call: outcome from the trace, enforcement from the post-call judge plus the transcript gates. */
export async function gradeWholeCall(input: GradeInput): Promise<WholeCallGrade> {
  const record = toRecord(input);
  const events = input.events ?? record.events;
  const transcript = input.transcript ?? record.transcript;
  const postCall = await (input.postCallJudge ?? new RuleBasedPostCallJudge()).judge(record);
  const enforcement = [...postCallResults(postCall), ...transcriptGates(transcript)];
  return {
    sourceCallId: input.facts.sourceCallId,
    outcome: gradeOutcome(events, input.facts),
    enforcement,
    enforcementPassed: enforcement.every((r) => r.passed),
    turns: transcript.filter((t) => t.role === "caller").length,
    rulesNotChecked: [...RULES_NOT_CHECKED],
  };
}

/* --------------------------------------------------------------- the totals */

export interface WholeCallTotals {
  /** Calls graded. Every count below is out of this. */
  calls: number;
  renewalDateConfirmed: number;
  payrollCaptured: number;
  employeeCountCaptured: number;
  booked: number;
  enforcementPassed: number;
  /** Calls graded per rule that failed at least once. */
  failuresByRule: Record<string, number>;
}

export function totalsOf(grades: readonly WholeCallJudgement[]): WholeCallTotals {
  const totals: WholeCallTotals = {
    calls: grades.length,
    renewalDateConfirmed: 0,
    payrollCaptured: 0,
    employeeCountCaptured: 0,
    booked: 0,
    enforcementPassed: 0,
    failuresByRule: {},
  };
  for (const g of grades) {
    if (g.outcome.renewalDateConfirmed) totals.renewalDateConfirmed += 1;
    if (g.outcome.payrollCaptured) totals.payrollCaptured += 1;
    if (g.outcome.employeeCountCaptured) totals.employeeCountCaptured += 1;
    if (g.outcome.booked) totals.booked += 1;
    if (g.enforcementPassed) totals.enforcementPassed += 1;
    for (const r of g.enforcement) if (!r.passed) totals.failuresByRule[r.rule] = (totals.failuresByRule[r.rule] ?? 0) + 1;
  }
  return totals;
}
