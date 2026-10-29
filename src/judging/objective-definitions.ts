/**
 * What the agent is meant to accomplish on a call, as closed questions a
 * decision model can answer from the conversation alone. Pure data: the web
 * console imports this file too, so nothing here touches Node, the store or
 * the trace.
 *
 * Each objective belongs to a flow step, so the console can line it up with
 * the stage the call is in. The questions name who must have said what, since
 * a model asked a vague question tends to agree. "unclear" always has its own
 * criterion so the model has a way out.
 */

import type { FlowStep } from "../decision-tree/types.js";

export const OBJECTIVE_ANSWERS = ["done", "not_yet", "unclear"] as const;
export type ObjectiveAnswer = (typeof OBJECTIVE_ANSWERS)[number];

/** What the console shows for an objective. "open" is not yet done; "unclear" is a judged answer the model could not settle. */
export type ObjectiveStatus = "done" | "open" | "unclear";

export interface ObjectiveDefinition {
  id: string;
  /** Short label for the checklist. */
  label: string;
  step: FlowStep;
  question: string;
  criteria: Record<ObjectiveAnswer, string>;
}

/** The stage order the console draws, first to last. */
export const FLOW_STEP_ORDER: readonly FlowStep[] = ["disclosure", "recognize_lead", "discovery", "quote_fields", "objection", "booking", "message", "handoff"];

export const FLOW_STEP_LABELS: Record<FlowStep, string> = {
  disclosure: "Disclosure",
  recognize_lead: "Who is calling",
  discovery: "Discovery",
  quote_fields: "Quote details",
  objection: "Objection",
  booking: "Booking",
  message: "Message",
  handoff: "Handoff",
};

/** The rule stated once before every objective's criteria. */
export const OBJECTIVE_RULE =
  "Judge only what has already been said in the conversation. Only the words of the caller and the agent count; " +
  "never assume what will be said next, and never credit something the agent only promised to do.";

export const CALL_OBJECTIVES: readonly ObjectiveDefinition[] = [
  {
    id: "disclosure",
    label: "AI disclosure given",
    step: "disclosure",
    question: "Has the agent told the caller that it is an AI or automated assistant?",
    criteria: {
      done: "an agent line says, in any words, that the agent is an AI, automated or virtual assistant",
      not_yet: "no agent line has said that the agent is an AI or automated assistant",
      unclear: "it is not possible to tell whether the agent said so",
    },
  },
  {
    id: "identity",
    label: "Right person confirmed",
    step: "recognize_lead",
    question: "Has it been established who is on the line?",
    criteria: {
      done: "the caller said in their own words that they are the named person, or said who they are and the agent went on with them as the right person",
      not_yet: "the agent has not yet established who is on the line, or the caller has not answered the question",
      unclear: "it is not possible to tell whether the caller's identity was established",
    },
  },
  {
    id: "purpose",
    label: "Reason for the call stated",
    step: "discovery",
    question: "Has the agent explained why it is calling, or what it can help with, and has the caller responded to that?",
    criteria: {
      done: "an agent line explained the reason for the call or the help on offer, and the caller then responded to it",
      not_yet: "the agent has not explained the reason for the call, or the caller has not responded to it yet",
      unclear: "it is not possible to tell whether the reason for the call was explained",
    },
  },
  {
    id: "coverage",
    label: "Current coverage learned",
    step: "discovery",
    question: "Has the caller told the agent about their current coverage?",
    criteria: {
      done: "the caller gave their renewal or expiration date, or named their current carrier, or said they have no active policy, in their own words",
      not_yet: "the caller has not given a renewal date, a carrier, or said they have no policy",
      unclear: "it is not possible to tell whether the caller described their current coverage",
    },
  },
  {
    id: "quote_details",
    label: "Quote details gathered",
    step: "quote_fields",
    question: "Has the caller given the details a quote needs?",
    criteria: {
      done: "the caller stated what the business does and at least one of: payroll, number of employees, or that it is owner only, in their own words",
      not_yet: "the caller has not given those details yet",
      unclear: "it is not possible to tell whether the caller gave the quote details",
    },
  },
  {
    id: "next_step",
    label: "Next step agreed",
    step: "booking",
    question: "Has the caller plainly agreed to a specific next step?",
    criteria: {
      done: "the caller plainly agreed to a specific next step: a time to meet or talk, a quote sent by text, a message to be passed on, or being transferred to a person",
      not_yet: "no next step has been proposed, or the caller has not agreed to one",
      unclear: "the caller hedged, asked a question instead, or it is not possible to tell whether they agreed",
    },
  },
  {
    id: "closing",
    label: "Call wrapped up",
    step: "handoff",
    question: "Has the agent wrapped up the call?",
    criteria: {
      done: "the agent said goodbye or summed up what happens next, and the caller was not left with an open question",
      not_yet: "the conversation is still going, or the agent has not wrapped up",
      unclear: "it is not possible to tell whether the call was wrapped up",
    },
  },
];

/** A flow step read from a tree node id when the node carries none, else null. Only confident prefixes are mapped. */
export function inferFlowStep(nodeId: string | null | undefined): FlowStep | null {
  if (!nodeId) return null;
  const id = nodeId.toLowerCase();
  if (id.startsWith("open.")) return id.includes("disclos") ? "disclosure" : "recognize_lead";
  if (id.startsWith("discovery.")) return "discovery";
  if (id.startsWith("quote")) return "quote_fields";
  if (id.startsWith("objection.")) return "objection";
  if (id.includes("book")) return "booking";
  if (id.includes("message")) return "message";
  if (id.includes("transfer") || id.includes("handoff") || id.includes("hand_off")) return "handoff";
  return null;
}
