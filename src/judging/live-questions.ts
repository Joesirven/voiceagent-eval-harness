/**
 * The closed question the live judge puts to a decision model, one per action.
 *
 * Every question has the same three answers: "allow", "block" and "unclear".
 * The criteria are written from the enforcement idea of each action (who must
 * have said what before the action may run) and always name who has to say it,
 * since a model asked a vague question tends to agree. "unclear" always has its
 * own criterion so the model has a way out.
 *
 * The instructions carry only the non-personal parts of the payload: the action
 * name, the field name, the disposition, the durable flag and the transfer
 * reason. The value and body text are never copied in; the conversation sent
 * beside the question already holds whatever the caller said.
 */

import type { JudgeAction, JudgePayload } from "../judge/types.js";

export const LIVE_ANSWERS = ["allow", "block", "unclear"] as const;
export type LiveAnswer = (typeof LIVE_ANSWERS)[number];

export interface LiveQuestion {
  question: string;
  answers: string[];
  /** What each answer means, in plain words. */
  criteria: Record<LiveAnswer, string>;
  /** Extra instructions: who must have said what, plus the non-personal payload facts. */
  instructions: string;
}

/** Only short lowercase names reach the instructions, so a payload can never smuggle free text into them. */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function safeName(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_NAME.test(value) ? value : undefined;
}

/** True for the actions that are hard to undo: a lasting ending, a booking, a transfer, a text or email sent, a quote started. */
export function isHardToUndo(action: JudgeAction, payload: JudgePayload): boolean {
  if (action === "book" || action === "transfer" || action === "send_text" || action === "send_email" || action === "start_quote") return true;
  return action === "end_with_disposition" && payload.durable === true;
}

interface ActionText {
  allow: string;
  block: string;
  unclear: string;
  /** The rule of thumb stated once before the criteria. */
  rule: string;
}

const ACTION_TEXT: Record<JudgeAction, ActionText> = {
  transfer: {
    rule:
      "Only the caller's words count for a request. A transfer is right when the caller asked for a person, " +
      "or when the agent has already tried to clarify several times and still cannot tell what the caller wants.",
    allow: "the caller clearly asked to speak to a person, or the agent has asked for clarification repeatedly and the caller is still not understood",
    block: "the caller has not asked for a person and the agent has not yet tried clarifying more than once",
    unclear: "it is not possible to tell whether the caller asked for a person",
  },
  save_details: {
    rule:
      "Only the caller's words count. The details to save must be what the caller said, in their own words, " +
      "and not something the agent wrote or guessed.",
    allow: "the details to save are the caller's own words from this conversation",
    block: "the details are the agent's own wording or a guess, or they add something the caller never said",
    unclear: "it is not possible to tell whether the details are the caller's own words",
  },
  save_quote_field: {
    rule:
      "Only the caller's words count. The value must be inside something the caller said, and the agent must not " +
      "have supplied it first.",
    allow: "the value appears inside the caller's own words and the agent did not supply it",
    block: "the value is not in the caller's words, or the agent said it first and the caller only went along",
    unclear: "it is not possible to tell whether the caller gave the value",
  },
  book: {
    rule:
      "A booking needs three things in order: the caller named a time, the agent read the slot back aloud, " +
      "and the caller then said a plain yes. A hedge, a question or silence is not a yes.",
    allow: "the caller named a time, the agent read the slot back to them, and the caller then plainly agreed",
    block: "the caller never named a time, or the agent did not read the slot back, or the caller did not plainly agree",
    unclear: "it is not possible to tell whether all three happened",
  },
  send_text: {
    rule: "Only the caller's words count. The agent must have offered a text and the caller must have agreed to it.",
    allow: "the agent offered to send a text and the caller agreed to receive one",
    block: "no text was offered, or the caller declined or did not agree",
    unclear: "it is not possible to tell whether the caller agreed to a text",
  },
  end_with_disposition: {
    rule:
      "A lasting ending such as not interested or do not contact needs the caller's explicit words saying so. " +
      "Any other ending needs the thing it names to have really happened earlier in the call.",
    allow:
      "for a lasting ending, the caller said so in explicit words; for any other ending, what the ending names did happen in this call",
    block:
      "for a lasting ending, the caller did not say so explicitly (a bare no after an objection is not enough); for any other ending, what it names did not happen",
    unclear: "it is not possible to tell whether the caller said so or whether the named outcome happened",
  },
  send_email: {
    rule: "Only the caller's words count. The caller must have asked for the document by email, or agreed when the agent offered to email it.",
    allow: "the caller asked for this document by email, or agreed to have it emailed when the agent offered",
    block: "the caller did not ask for the document and did not agree to an email",
    unclear: "it is not possible to tell whether the caller wants the document emailed",
  },
  start_quote: {
    rule:
      "Only the caller's words count. The caller must have asked for a quote or agreed to one. Starting a quote is hard to undo, " +
      "and no price may be promised.",
    allow: "the caller asked for a quote or plainly agreed to start one",
    block: "the caller did not ask for a quote and did not agree to one",
    unclear: "it is not possible to tell whether the caller wants a quote started",
  },
  set_eligibility: {
    rule: "Only the caller's words count. The reason the business is outside what the agency insures must be something the caller said.",
    allow: "the caller said something that clearly puts the business outside what the agency insures, for the reason given",
    block: "the caller did not say anything that puts the business outside what the agency insures",
    unclear: "it is not possible to tell whether the caller's words support the reason",
  },
  cancel_booking: {
    rule: "Only the caller's words count. The caller must have asked to cancel the appointment and confirmed it.",
    allow: "the caller asked to cancel the appointment and confirmed it",
    block: "the caller did not ask to cancel, or did not confirm",
    unclear: "it is not possible to tell whether the caller wants the appointment cancelled",
  },
};

/** One plain sentence per fact that is safe to send, joined into the instructions. */
function payloadFacts(action: JudgeAction, payload: JudgePayload): string[] {
  const facts = [`The action is ${action}.`];
  const field = safeName(payload.field);
  if (action === "save_quote_field" && field) facts.push(`The field is ${field}.`);
  const disposition = safeName(payload.disposition);
  if (action === "end_with_disposition") {
    if (disposition) facts.push(`The disposition is ${disposition}.`);
    if (payload.durable !== undefined) facts.push(`The ending is ${payload.durable ? "lasting" : "not lasting"}.`);
  }
  const reason = safeName(payload.reason);
  if (action === "transfer" && reason) facts.push(`The reason given is ${reason}.`);
  if (action === "set_eligibility" && reason) facts.push(`The reason given is ${reason}.`);
  const document = safeName(payload.document);
  if (action === "send_email" && document) facts.push(`The document is ${document}.`);
  return facts;
}

/** Builds the closed question for one action. */
export function liveQuestionFor(action: JudgeAction, payload: JudgePayload): LiveQuestion {
  const text = ACTION_TEXT[action];
  return {
    question: `Should the agent carry out ${action} now?`,
    answers: [...LIVE_ANSWERS],
    criteria: { allow: text.allow, block: text.block, unclear: text.unclear },
    instructions: [...payloadFacts(action, payload), text.rule].join(" "),
  };
}
