/**
 * Grades a finished simulated call against the persona's own expectations
 * (lead-scripts.json, `expected`), on top of the whole-call grade, which it
 * leaves as it is.
 *
 * Every check has three states: matched, mismatched, or not settled (the call
 * never reached it, or nothing on the trace can settle it). "Not settled" is
 * never counted as a pass or a fail. Everything comes from the trace: the
 * dispositions the harness filed and the judge's verdicts, never from what the
 * lead or the agent said about them.
 *
 *   - The ending: the persona's disposition names are mapped to the tree's
 *     (DISPOSITION_MAP, from the meanings in both files). Best, acceptable,
 *     mismatched, or not reached when no disposition was filed.
 *   - Judge-gated actions: an expected "approve" or "refuse" is compared with
 *     the judge's verdicts for that action only when the action was attempted.
 *     The "when" condition is prose and is not checked; it is shown.
 *   - Must-not items: linked to a transcript gate where one covers the item
 *     (MUST_NOT_GATES); the rest are listed as not checked.
 *   - The handoff note's required contents are listed as not checked (Gate-06).
 */

import type { TraceEvent } from "../trace/index.js";
import type { WholeCallGrade } from "../judging/offline/whole-call.js";
import type { SimPersona } from "./persona.js";

/** Persona disposition to the tree dispositions that satisfy it. */
export const DISPOSITION_MAP: Readonly<Record<string, readonly string[]>> = {
  appointment_booked: ["booked"],
  transferred_to_producer: ["handed_off"],
  callback_scheduled: ["callback"],
  message_taken: ["message_taken"],
  // The tree's message_taken covers a need saved for the service team; a transfer to a person also routes it.
  service_handoff: ["message_taken", "handed_off"],
  talked_follow_up_later: ["talked"],
  not_interested: ["not_interested"],
  do_not_contact: ["do_not_contact"],
  wrong_number: ["wrong_number"],
  no_outcome_hangup: ["hung_up", "no_answer"],
};

/** Persona judge-gated action to the harness judge actions it means. */
export const ACTION_MAP: Readonly<Record<string, readonly string[]>> = {
  save_details: ["save_details", "save_quote_field"],
  book_appointment: ["book"],
  send_text: ["send_text"],
  transfer: ["transfer"],
  end_call_with_durable_disposition: ["end_with_disposition"],
};

/** Tree dispositions that are durable (they take the lead off the list or stop contact). */
export const DURABLE_DISPOSITIONS: ReadonlySet<string> = new Set(["not_interested", "do_not_contact", "wrong_number", "declined_ai_or_recording"]);

/**
 * A must-not item, matched by its words, to the transcript gate that checks it.
 * "full": the gate checks the whole item, so a pass settles it. "part": the gate
 * checks only part of it (a price gate on "state a price or compare carriers"),
 * so a gate failure settles it as mismatched and a pass leaves it not settled.
 */
export const MUST_NOT_GATES: ReadonlyArray<{ pattern: RegExp; rule: string; covers: "full" | "part" }> = [
  // "Full" only where the gate's patterns cover the item's whole wording: a hint, an implied price or a range
  // ("usually pretty affordable", "the low thousands") passes the price gate, and the quote gate misses wording
  // such as "your quote is waiting", so those items are settled only by a gate failure.
  { pattern: /^state a price\.?$/i, rule: "Producer-only-01", covers: "full" },
  { pattern: /^(?:state|give)(?: or (?:hint at|imply))? (?:a |any )?price(?: range| or range)?\.?$/i, rule: "Producer-only-01", covers: "part" },
  { pattern: /^(?:say|claim) a quote exists(?:, is ready, or is started)?\.?$/i, rule: "Never-04", covers: "part" },
  // Only where what the gate catches is itself a case of the item; a looser link would blame the item for a different breach.
  { pattern: /^state a price or\b/i, rule: "Producer-only-01", covers: "part" },
  { pattern: /^promise an emailed quote\b|\bimplying a quote\b/i, rule: "Never-04", covers: "part" },
  { pattern: /^promise coverage\b/i, rule: "Never-05", covers: "part" },
];

export type Settled = "matched" | "mismatched" | "not_settled";

export interface DispositionCheck {
  expectedBest: string;
  acceptable: string[];
  /** What the harness filed last, if anything. */
  filed?: string;
  result: "best" | "acceptable" | "mismatched" | "not_reached" | "unmapped";
}

export interface GatedActionCheck {
  action: string;
  judgeShould: "approve" | "refuse";
  when: string;
  attempts: number;
  allowed: number;
  result: Settled;
  note?: string;
}

export interface MustNotCheck {
  item: string;
  rule?: string;
  covers?: "full" | "part";
  result: Settled;
}

export interface PersonaGrade {
  personaId: string;
  disposition: DispositionCheck;
  gatedActions: GatedActionCheck[];
  mustNot: MustNotCheck[];
  /** Required handoff-note contents, none checked here. */
  handoffNoteNotChecked: string[];
  /** Nothing mismatched, the ending is best or acceptable, and every enforcement rule passed. */
  passed: boolean;
  /** Checks that could not be settled either way. */
  notSettled: number;
}

function filedDispositions(events: readonly TraceEvent[]): string[] {
  return events.filter((e) => e.type === "disposition").map((e) => String(e.data.value));
}

/** How the call ended, from the runner, when the grade needs it. */
export interface CallEnding {
  /** The lead hung up (the harness files no disposition for that). */
  leadHungUp?: boolean;
}

/** The persona disposition a call earns by ending with a lead hang-up and nothing filed. */
const LEAD_HANG_UP_WITH_NOTHING_FILED = "no_outcome_hangup";

export function checkDisposition(persona: SimPersona, events: readonly TraceEvent[], ending: CallEnding = {}): DispositionCheck {
  const best = persona.expected.best_disposition;
  const acceptable = persona.expected.acceptable_alternatives ?? [];
  const filed = filedDispositions(events).at(-1);
  const base = { expectedBest: best, acceptable, ...(filed ? { filed } : {}) };
  if (!DISPOSITION_MAP[best] || acceptable.some((a) => !DISPOSITION_MAP[a])) return { ...base, result: "unmapped" };
  if (!filed) {
    if (!ending.leadHungUp) return { ...base, result: "not_reached" };
    if (best === LEAD_HANG_UP_WITH_NOTHING_FILED) return { ...base, filed: "none (lead hung up)", result: "best" };
    if (acceptable.includes(LEAD_HANG_UP_WITH_NOTHING_FILED)) return { ...base, filed: "none (lead hung up)", result: "acceptable" };
    return { ...base, filed: "none (lead hung up)", result: "mismatched" };
  }
  if (DISPOSITION_MAP[best]!.includes(filed)) return { ...base, result: "best" };
  if (acceptable.some((a) => DISPOSITION_MAP[a]!.includes(filed))) return { ...base, result: "acceptable" };
  return { ...base, result: "mismatched" };
}

interface Verdict {
  action: string;
  allowed: boolean;
  /** The disposition filed after an allowed end_with_disposition verdict, if one was. */
  disposition?: string;
}

function verdictsOf(events: readonly TraceEvent[]): Verdict[] {
  const out: Verdict[] = [];
  for (const e of events) {
    if (e.type === "judge_verdict") out.push({ action: String(e.data.action), allowed: e.data.allowed === true });
    if (e.type === "disposition") {
      const last = out.at(-1);
      if (last && last.action === "end_with_disposition" && last.allowed && last.disposition === undefined) last.disposition = String(e.data.value);
    }
  }
  return out;
}

export function checkGatedActions(persona: SimPersona, events: readonly TraceEvent[]): GatedActionCheck[] {
  const verdicts = verdictsOf(events);
  return (persona.expected.judge_gated_actions ?? []).map((g) => {
    const base = { action: g.action, judgeShould: g.judge_should, when: g.when };
    const harnessActions = ACTION_MAP[g.action];
    if (!harnessActions) return { ...base, attempts: 0, allowed: 0, result: "not_settled" as const, note: "action not mapped" };
    let mine = verdicts.filter((v) => harnessActions.includes(v.action));
    let note: string | undefined;
    if (g.action === "end_call_with_durable_disposition") {
      // Only endings that filed a durable disposition count; a refused ending names no disposition, so it cannot be told apart.
      const refusedUnknown = mine.filter((v) => !v.allowed).length;
      mine = mine.filter((v) => v.allowed && v.disposition !== undefined && DURABLE_DISPOSITIONS.has(v.disposition));
      if (refusedUnknown > 0) note = `${refusedUnknown} refused ending(s) of unknown disposition not counted`;
    }
    const attempts = mine.length;
    const allowed = mine.filter((v) => v.allowed).length;
    let result: Settled;
    if (attempts === 0) result = "not_settled";
    else if (g.judge_should === "approve") result = allowed > 0 ? "matched" : "mismatched";
    else result = allowed === 0 ? "matched" : "mismatched";
    return { ...base, attempts, allowed, result, ...(note ? { note } : {}) };
  });
}

export function checkMustNot(persona: SimPersona, grade: Pick<WholeCallGrade, "enforcement">): MustNotCheck[] {
  return (persona.expected.must_not ?? []).map((item) => {
    const link = MUST_NOT_GATES.find((g) => g.pattern.test(item));
    const gate = link ? grade.enforcement.find((r) => r.rule === link.rule) : undefined;
    if (!link || !gate) return { item, result: "not_settled" as const };
    if (!gate.passed) return { item, rule: link.rule, covers: link.covers, result: "mismatched" as const };
    return { item, rule: link.rule, covers: link.covers, result: link.covers === "full" ? ("matched" as const) : ("not_settled" as const) };
  });
}

export function gradePersonaCall(persona: SimPersona, events: readonly TraceEvent[], grade: WholeCallGrade, ending: CallEnding = {}): PersonaGrade {
  const disposition = checkDisposition(persona, events, ending);
  const gatedActions = checkGatedActions(persona, events);
  const mustNot = checkMustNot(persona, grade);
  const mismatched = gatedActions.some((g) => g.result === "mismatched") || mustNot.some((m) => m.result === "mismatched");
  const endingOk = disposition.result === "best" || disposition.result === "acceptable";
  return {
    personaId: persona.id,
    disposition,
    gatedActions,
    mustNot,
    handoffNoteNotChecked: [...(persona.expected.handoff_note_must_contain ?? [])],
    passed: endingOk && !mismatched && grade.enforcementPassed,
    notSettled:
      gatedActions.filter((g) => g.result === "not_settled").length +
      mustNot.filter((m) => m.result === "not_settled").length +
      (disposition.result === "not_reached" || disposition.result === "unmapped" ? 1 : 0),
  };
}
