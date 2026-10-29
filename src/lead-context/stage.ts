import type { FlowStep } from "../decision-tree/types.js";
import type { StageInfo } from "./types.js";

export const STAGE_MEANINGS: Record<FlowStep | "unknown", string> = {
  disclosure: "The opening: the artificial intelligence disclosure is being given or has just been given.",
  recognize_lead: "Working out who the caller is and whether they are the named person.",
  discovery: "Learning what the caller wants and about their business.",
  quote_fields: "Collecting the details needed to build a quote.",
  objection: "Handling a concern or a reason the caller is hesitating.",
  booking: "Setting up a time with a producer.",
  message: "Taking a message for the agency.",
  handoff: "Passing the caller to a person.",
  unknown: "The call has not reached its first step yet.",
};

export function stageInfo(flowStep: FlowStep | undefined): StageInfo {
  const key = flowStep && flowStep in STAGE_MEANINGS ? flowStep : "unknown";
  return { flowStep: key, meaning: STAGE_MEANINGS[key], held: false };
}
