/**
 * What the adapters send and how they read an answer back. Shared so every
 * provider sees the same conversation text and the same question, and so the
 * answer rules (closed list, confidence from the probability) live in one place.
 */

import { redactText } from "./redact.js";
import type { DecisionModelRequest } from "./types.js";

/** The one question name every request uses; the reply is read back by this key. */
export const QUESTION_NAME = "answer";

export interface ChoiceQuestion {
  instructions: string;
  /** One plain-words meaning per answer, in the request's order. */
  criteria: Record<string, string>;
}

const UNCLEAR_CRITERION = "the caller's words do not settle the question";
const WHO_COUNTS = "Only the caller's words count as the caller's answer.";

/**
 * What the lead record says, as one line, so an answer such as "names a
 * different business than the record" has something to compare against.
 * Empty when the request carries no lead facts.
 */
export function leadFactsLine(request: DecisionModelRequest): string {
  const lead = request.context?.lead;
  if (!lead) return "";
  const clean = (text: string | undefined) => redactText(text ?? "").replace(/\s+/g, " ").trim();
  const name = clean(lead.name);
  const business = clean(lead.business);
  return `On record (the caller's words still decide): name ${name || "not on record"}; business ${business || "not on record"}.`;
}

/**
 * The conversation as plain lines, redacted, plus the node id and the lead
 * facts when the request has them. Only spoken turns: system turns are not
 * part of the conversation, and an agent line cut off by barge-in
 * (spoken === false) was never heard.
 */
export function buildState(request: DecisionModelRequest): string {
  const lines: string[] = [];
  const lead = leadFactsLine(request);
  if (lead) lines.push(lead);
  for (const turn of request.transcript) {
    if (turn.role === "system" || turn.spoken === false) continue;
    const text = redactText(turn.text).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${turn.role === "caller" ? "Caller" : "Agent"}: ${text}`);
  }
  return [`Node: ${request.nodeId}`, ...lines].join("\n");
}

/** The closed question: instructions and a criterion for every answer, "unclear" included. */
export function buildQuestion(request: DecisionModelRequest): ChoiceQuestion {
  const base = (request.instructions ?? request.question).trim();
  const instructions = `${base} ${WHO_COUNTS}`.trim();
  const criteria: Record<string, string> = {};
  for (const answer of request.answers) {
    const given = request.answerCriteria?.[answer]?.trim();
    if (given) criteria[answer] = given;
    else if (answer === "unclear") criteria[answer] = UNCLEAR_CRITERION;
    else criteria[answer] = `the caller's words mean "${answer}"`;
  }
  if (!("unclear" in criteria)) criteria.unclear = request.answerCriteria?.unclear?.trim() || UNCLEAR_CRITERION;
  return { instructions, criteria };
}

export interface ParsedChoice {
  answer: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Check a provider's choice against the closed list and pick the confidence:
 * the probability for the chosen answer when a distribution came, otherwise the
 * provider's own confidence if it sent a usable one, otherwise 0.5. The
 * provider's "confidence" is never preferred over the probability, because
 * TypeSafe and Kev define it as a normalized margin, not a probability.
 * Returns null when the choice is outside the list.
 */
export function resolveChoice(
  request: DecisionModelRequest,
  choice: unknown,
  probabilities: unknown,
  providerConfidence: unknown,
): ParsedChoice | null {
  if (typeof choice !== "string" || !request.answers.includes(choice)) return null;
  let distribution: Record<string, number> | undefined;
  if (probabilities && typeof probabilities === "object" && !Array.isArray(probabilities)) {
    const kept: Record<string, number> = {};
    for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
      if (isProbability(value)) kept[key] = value;
    }
    if (Object.keys(kept).length > 0) distribution = kept;
  }
  const fromDistribution = distribution?.[choice];
  const confidence = isProbability(fromDistribution)
    ? fromDistribution
    : isProbability(providerConfidence)
      ? providerConfidence
      : 0.5;
  return distribution ? { answer: choice, confidence, probabilities: distribution } : { answer: choice, confidence };
}
