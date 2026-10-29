/**
 * A scripted lead for whole-call judging: deterministic, no network, no clock.
 * The same facts and the same agent lines always give the same lead lines, so
 * a test can say exactly what the lead will answer.
 *
 * It follows the same ideas as the training archive's lead personas
 * (lead-scripts.json, "how_a_simulated_lead_uses_a_persona"), in its own words:
 *   - answer only what the agent just asked, and only from the facts;
 *   - a fact the call never learned stays unknown ("I am not sure");
 *   - raise the objections one at a time, in order, each once, and only after
 *     the agent has had a few turns to move on;
 *   - if the agent states a price, an estimate or a quote, ask for the number
 *     and remember that it happened (`priceStatedByAgent`);
 *   - say yes to a read-back of a time the lead itself proposed;
 *   - hang up when the agent says goodbye or the turn limit is reached.
 */

import { MAX_TURN_CAP, type LeadFacts, type SimulatedLead } from "./types.js";

export interface ScriptedLeadOptions {
  /** The most lead lines before the lead hangs up. The archive's cap is twenty-five. */
  maxLeadTurns?: number;
  /** What the lead says when asked for a day and time. */
  preferredTime?: string;
  /** Lead lines before the first objection may be raised. Default 3. */
  objectionAfterTurns?: number;
  /** Lead lines between two objections. Default 3. */
  objectionSpacing?: number;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Month and day of a date written as 2026-12-14, "December 14th", "14 Dec" or 12/14, as "MM-DD"; null when none is found. */
export function monthDayOf(text: string): string | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;
  const iso = /\b\d{4}-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (iso && valid(Number(iso[1]), Number(iso[2]))) return `${pad(Number(iso[1]))}-${pad(Number(iso[2]))}`;
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(text);
  if (slash && valid(Number(slash[1]), Number(slash[2]))) return `${pad(Number(slash[1]))}-${pad(Number(slash[2]))}`;
  const names = MONTHS.map((m) => m.slice(0, 3).toLowerCase());
  const monthWord = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const lower = text.toLowerCase();
  const monthFirst = new RegExp(`\\b${monthWord}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(lower);
  if (monthFirst) {
    const month = names.indexOf(monthFirst[1]!.slice(0, 3)) + 1;
    if (valid(month, Number(monthFirst[2]))) return `${pad(month)}-${pad(Number(monthFirst[2]))}`;
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthWord}\\b`).exec(lower);
  if (dayFirst) {
    const month = names.indexOf(dayFirst[2]!.slice(0, 3)) + 1;
    if (valid(month, Number(dayFirst[1]))) return `${pad(month)}-${pad(Number(dayFirst[1]))}`;
  }
  return null;
}

/** A renewal date as a person would say it: "December 14th" for 2026-12-14; any other text is passed through. */
export function spokenDate(renewalDate: string): string {
  const monthDay = monthDayOf(renewalDate);
  if (!monthDay) return renewalDate;
  const [month, day] = monthDay.split("-").map(Number) as [number, number];
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${MONTHS[month - 1]} ${day}${suffix}`;
}

/** Whether a line states a price: a dollar figure, an estimate, or a quote that is ready. */
export function statesPrice(line: string): boolean {
  return /\$\s?\d|\b\d[\d,]*\s*(?:dollars|bucks)\b|\b(?:estimate|ballpark)\b|\bquote (?:is|was) (?:ready|done|sent)\b|\bpremium (?:is|would be|will be)\b/i.test(line);
}

/** The last question the agent asked, or the whole line when it asked none. */
function lastQuestion(line: string): string {
  const sentences = line.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const questions = sentences.filter((s) => s.endsWith("?"));
  return (questions.at(-1) ?? line).toLowerCase();
}

/** What the scripted lead does when an option is not given. The database writer records these values. */
export const SCRIPTED_LEAD_DEFAULTS = {
  preferredTime: "tomorrow at 3 pm",
  objectionAfterTurns: 3,
  objectionSpacing: 3,
} as const;

export class ScriptedSimulatedLead implements SimulatedLead {
  /** True once the agent stated a price, an estimate or a ready quote. */
  priceStatedByAgent = false;
  /** The lead's lines so far, in order. */
  readonly said: string[] = [];

  private readonly maxLeadTurns: number;
  private readonly preferredTime: string;
  private readonly objectionAfterTurns: number;
  private readonly objectionSpacing: number;
  private objectionsRaised = 0;
  private lastObjectionTurn = Number.NEGATIVE_INFINITY;
  private proposedTime = false;

  constructor(
    readonly facts: LeadFacts,
    options: ScriptedLeadOptions = {},
  ) {
    this.maxLeadTurns = Math.min(options.maxLeadTurns ?? MAX_TURN_CAP, MAX_TURN_CAP);
    this.preferredTime = options.preferredTime ?? SCRIPTED_LEAD_DEFAULTS.preferredTime;
    this.objectionAfterTurns = options.objectionAfterTurns ?? SCRIPTED_LEAD_DEFAULTS.objectionAfterTurns;
    this.objectionSpacing = options.objectionSpacing ?? SCRIPTED_LEAD_DEFAULTS.objectionSpacing;
  }

  async next(agentLine: string): Promise<string | null> {
    if (this.said.length >= this.maxLeadTurns) return null;
    if (this.said.length > 0 && /\bgoodbye\b|\bbye\b/i.test(agentLine)) return null;
    const line = this.reply(agentLine);
    this.said.push(line);
    return line;
  }

  private reply(agentLine: string): string {
    const turn = this.said.length;
    if (statesPrice(agentLine)) {
      this.priceStatedByAgent = true;
      return "Great, what is the number?";
    }
    const asked = lastQuestion(agentLine);
    const readBack = /\bconfirm\b|\bshall i book\b|\bbook that\b/.test(asked);
    // A read-back is agreed to only when the time is one the lead itself proposed.
    if (readBack) return this.proposedTime ? "Yes, that works." : "No, that is not a time I asked for.";

    const objection = this.facts.objections[this.objectionsRaised];
    const mayObject =
      objection !== undefined && turn >= this.objectionAfterTurns && turn - this.lastObjectionTurn >= this.objectionSpacing && !readBack;
    if (mayObject) {
      this.objectionsRaised += 1;
      this.lastObjectionTurn = turn;
      return objection;
    }
    return this.answer(asked, turn);
  }

  /** Keyword answers from the facts, most specific question first. */
  private answer(asked: string, turn: number): string {
    const f = this.facts;
    if (/\bwhat day\b|\bwhat time\b|\bday and time\b|\bwhen works\b|\bwhich day\b/.test(asked)) {
      this.proposedTime = true;
      return this.preferredTime;
    }
    if (/\brenew|\bexpire|\bx-date\b|\bpolicy date\b/.test(asked)) {
      return f.renewalDate ? `It renews on ${spokenDate(f.renewalDate)}.` : "I am not sure of the exact date.";
    }
    if (/\bpayroll\b/.test(asked)) {
      return f.annualPayroll ? `Our annual payroll is ${f.annualPayroll}.` : "I do not have the payroll figure handy.";
    }
    if (/\bemployee|\bstaff\b|\bhow many (?:people|workers)\b/.test(asked)) {
      return f.employeeCount !== undefined ? `We have ${f.employeeCount} employees.` : "I am not sure of the exact headcount.";
    }
    if (/\bcarrier\b|\binsured with\b|\bwho do you (?:have|use)\b/.test(asked)) {
      return f.currentCarrier ? `We are with ${f.currentCarrier}.` : "I do not remember the carrier name.";
    }
    if (/\bwhat (?:kind|type) of business\b|\bwhat do you do\b|\bwhat line of work\b|\bwhat trade\b/.test(asked)) {
      return f.businessType ? `We are a ${f.businessType} business.` : "It is a small business.";
    }
    if (/\banything else\b|\belse i can help\b/.test(asked)) return "No, that is all, thank you.";
    if (turn === 0 || /\bam i speaking\b|\bis this\b|\bwho am i\b/.test(asked)) return "Hi, yes, this is me. Go ahead.";
    if (/\bwould you like\b|\bdo you want\b|\bshall i\b|\bshould i\b|\bcontinue\b/.test(asked)) return "Yes, go ahead.";
    return "Okay, go on.";
  }
}
