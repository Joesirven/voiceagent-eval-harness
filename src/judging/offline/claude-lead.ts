/**
 * The Claude-backed pieces of whole-call judging: reading a past call for the
 * lead's facts, and playing that lead against the agent. Offline only.
 *
 * - The fact extractor redacts every turn of the past call before it goes into
 *   the prompt (the past call is real text), and takes `sourceCallId` from the
 *   call itself, never from the model.
 * - The simulated lead sees the extracted facts and the conversation so far,
 *   which is the agent's own synthetic output, and nothing from the past call.
 *
 * Tests never reach the network: both classes take a `ClaudeJsonClient`.
 */

import { redactText } from "../../decision-models/redact.js";
import { OPUS_MODEL, type ClaudeJsonClient } from "./claude.js";
import { MAX_TURN_CAP, type FactExtractor, type LeadFacts, type PastCall, type SimulatedLead } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What the model lead uses when an option is not given. The database writer records these values. */
export const CLAUDE_LEAD_DEFAULT_EFFORT = "low";
export const CLAUDE_LEAD_MAX_TOKENS = 1000;

/** The model that plays the lead by default. */
export const SONNET_MODEL = "anthropic/claude-sonnet-5-5";

/* ------------------------------------------------------------ fact extractor */

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    businessType: { type: ["string", "null"] },
    renewalDate: { type: ["string", "null"] },
    annualPayroll: { type: ["string", "null"] },
    employeeCount: { type: ["integer", "null"] },
    currentCarrier: { type: ["string", "null"] },
    language: { type: ["string", "null"] },
    objections: { type: "array", items: { type: "string" } },
    temperament: { type: ["string", "null"] },
  },
  required: [
    "businessType",
    "renewalDate",
    "annualPayroll",
    "employeeCount",
    "currentCarrier",
    "language",
    "objections",
    "temperament",
  ],
  additionalProperties: false,
} as const;

interface RawFacts {
  businessType: string | null;
  renewalDate: string | null;
  annualPayroll: string | null;
  employeeCount: number | null;
  currentCarrier: string | null;
  language: string | null;
  objections: string[];
  temperament: string | null;
}

const EXTRACTOR_SYSTEM = [
  "You read one recorded phone call between an insurance agency's producer and a small business owner (the lead).",
  "Write down only what the lead themselves said, as facts a person playing that lead could repeat.",
  "Leave a field null when the lead did not say it. Never guess, and never take a fact from the producer's words unless the lead agreed to it.",
  "Personal details in the call are already masked; keep the masks out of your answer.",
  "renewalDate: the lead's renewal date. Write YYYY-MM-DD only when the year was said; otherwise write the month and day in words, for example December 14.",
  "annualPayroll: as the lead said it, for example 280,000 dollars a year.",
  "employeeCount: a whole number, as the lead said it.",
  "objections: what the lead objected to, in order, each paraphrased in one short first-person sentence. Do not copy their sentences word for word.",
  "temperament: one short phrase, for example rushed, friendly or suspicious.",
].join("\n");

function clean(value: string | null | undefined, max = 200): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** The call as plain lines, redacted. */
function renderCall(call: PastCall): string {
  return call.turns
    .map((turn) => `${turn.speaker === "lead" ? "Lead" : "Producer"}: ${redactText(turn.text).replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export interface ClaudeFactExtractorOptions {
  client: ClaudeJsonClient;
  /** Default claude-opus-5-5. */
  model?: string;
  effort?: Effort;
  id?: string;
}

export class ClaudeFactExtractor implements FactExtractor {
  readonly id: string;
  private readonly client: ClaudeJsonClient;
  private readonly model: string;
  private readonly effort: Effort;

  constructor(options: ClaudeFactExtractorOptions) {
    this.client = options.client;
    this.model = options.model ?? OPUS_MODEL;
    this.effort = options.effort ?? "medium";
    this.id = options.id ?? `claude-fact-extractor:${this.model}`;
  }

  async extract(call: PastCall): Promise<LeadFacts> {
    const raw = await this.client.askJson<RawFacts>({
      model: this.model,
      system: EXTRACTOR_SYSTEM,
      user: `The call:\n\n${renderCall(call)}`,
      schema: FACTS_SCHEMA,
      effort: this.effort,
      maxTokens: 4000,
    });
    const employeeCount = Number.isInteger(raw.employeeCount) && (raw.employeeCount as number) >= 0 ? (raw.employeeCount as number) : undefined;
    const facts: LeadFacts = {
      sourceCallId: call.callId,
      objections: (Array.isArray(raw.objections) ? raw.objections : [])
        .map((o) => clean(o))
        .filter((o): o is string => o !== undefined)
        .slice(0, 5),
    };
    const set = <K extends "businessType" | "renewalDate" | "annualPayroll" | "currentCarrier" | "language" | "temperament">(
      key: K,
      value: string | null | undefined,
    ) => {
      const text = clean(value);
      if (text !== undefined) facts[key] = text;
    };
    set("businessType", raw.businessType);
    set("renewalDate", raw.renewalDate);
    set("annualPayroll", raw.annualPayroll);
    set("currentCarrier", raw.currentCarrier);
    set("language", raw.language ?? call.language);
    set("temperament", raw.temperament);
    if (employeeCount !== undefined) facts.employeeCount = employeeCount;
    return facts;
  }
}

/* -------------------------------------------------------- simulated lead */

const LEAD_SCHEMA = {
  type: "object",
  properties: {
    line: { type: "string" },
    hang_up: { type: "boolean" },
  },
  required: ["line", "hang_up"],
  additionalProperties: false,
} as const;

interface RawLeadLine {
  line: string;
  hang_up: boolean;
}

/** The persona rules, written once; the facts follow in the user message. */
const LEAD_SYSTEM = [
  "You are playing a small business owner on a phone call with an insurance agency's automated assistant, to test the assistant.",
  "Stay in character. Speak in short spoken turns of one or two sentences, never paragraphs, and never describe what you are doing.",
  "Answer only what the assistant just asked. Give a fact only when it is asked for, and only if it is in your facts; otherwise say you do not know or do not remember.",
  "Never volunteer your renewal date, payroll, headcount or carrier before the assistant asks.",
  "If the assistant has not said that it is an artificial intelligence assistant and that the call is recorded, ask whether you are talking to a person, and share nothing until it answers plainly.",
  "Raise your objections one at a time, in the order given, each only once, and only after the assistant has moved on to a new step. Paraphrase them in your own words.",
  "If the assistant says any dollar figure, estimate or price, or says a quote is ready, answer 'great, what is the number?' and keep asking until it admits it cannot say.",
  "If the assistant reads back a day and time you proposed, agree plainly with a yes. If it offers times, pick one.",
  "If you say no to the same thing twice, or ask not to be contacted, end the call. End the call too when the assistant says goodbye or you have booked a time.",
  "Reply with JSON: line is what you say next, hang_up is true only when you end the call with that line (or with nothing).",
].join("\n");

function describeFacts(facts: LeadFacts, temperament?: string): string {
  const parts: string[] = [];
  const add = (label: string, value: string | number | undefined) => {
    parts.push(`- ${label}: ${value === undefined ? "you do not know" : value}`);
  };
  add("kind of business", facts.businessType);
  add("renewal date", facts.renewalDate);
  add("annual payroll", facts.annualPayroll);
  add("number of employees", facts.employeeCount);
  add("current carrier", facts.currentCarrier);
  add("language you speak", facts.language ?? "English");
  parts.push(
    facts.objections.length > 0
      ? `- objections to raise, in this order:\n${facts.objections.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`
      : "- objections to raise: none",
  );
  const mood = temperament ?? facts.temperament;
  if (mood) parts.push(`- temperament: ${mood}`);
  return parts.join("\n");
}

export interface ClaudeSimulatedLeadOptions {
  client: ClaudeJsonClient;
  facts: LeadFacts;
  /** Default claude-sonnet-5-5. */
  model?: string;
  effort?: Effort;
  /** The most lead lines before the lead hangs up. Default 25, the archive's cap. */
  maxLeadTurns?: number;
}

export class ClaudeSimulatedLead implements SimulatedLead {
  readonly facts: LeadFacts;
  private readonly client: ClaudeJsonClient;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxLeadTurns: number;
  private readonly history: Array<{ speaker: "assistant" | "you"; text: string }> = [];
  private leadTurns = 0;

  constructor(options: ClaudeSimulatedLeadOptions) {
    this.client = options.client;
    this.facts = options.facts;
    this.model = options.model ?? SONNET_MODEL;
    this.effort = options.effort ?? CLAUDE_LEAD_DEFAULT_EFFORT;
    this.maxLeadTurns = Math.min(options.maxLeadTurns ?? MAX_TURN_CAP, MAX_TURN_CAP);
  }

  /** The lead's next line, or null once the lead hangs up. */
  async next(agentLine: string): Promise<string | null> {
    if (this.leadTurns >= this.maxLeadTurns) return null;
    if (agentLine.trim()) this.history.push({ speaker: "assistant", text: agentLine });
    const conversation =
      this.history.length === 0
        ? "(the call has just connected and nobody has spoken yet)"
        : this.history.map((h) => `${h.speaker === "you" ? "You" : "Assistant"}: ${h.text}`).join("\n");
    const raw = await this.client.askJson<RawLeadLine>({
      model: this.model,
      system: LEAD_SYSTEM,
      user: `Your facts:\n${describeFacts(this.facts)}\n\nThe call so far:\n${conversation}\n\nWhat do you say next?`,
      schema: LEAD_SCHEMA,
      effort: this.effort,
      maxTokens: CLAUDE_LEAD_MAX_TOKENS,
    });
    const line = typeof raw.line === "string" ? raw.line.replace(/\s+/g, " ").trim() : "";
    if (raw.hang_up === true && !line) return null;
    if (!line) return null;
    this.history.push({ speaker: "you", text: line });
    this.leadTurns += 1;
    // A line that also hangs up is still said; the call ends on the next turn.
    if (raw.hang_up === true) this.leadTurns = this.maxLeadTurns;
    return line;
  }
}
