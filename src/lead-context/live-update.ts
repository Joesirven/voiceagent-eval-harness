/**
 * Keeps the live agent's call context current. After each caller line the
 * session asks for an update: the stage (the latest flowStep the tree entered)
 * and the quote checklist (the lead's quote fields as they fill) with the
 * days until renewal. Text comes back only when it changed since the last
 * one sent. It is information for the agent, never lines to recite, and it
 * travels on its own channel, never inside the "say this" guidance.
 */

import { buildLeadContextPacket } from "../memory/context.js";
import type { LeadRecord } from "../store/lead-store.js";
import type { TraceEvent } from "../trace/events.js";
import type { FlowStep } from "../decision-tree/types.js";
import { buildLeadContextJson, CONFIRMATION_GATE, leadContextGateOn, renderUpdateText } from "./build.js";
import type { LeadContextJson } from "./types.js";

/**
 * Steps reached only after the named person is confirmed. Before the tree
 * gets here the update carries the stage alone, so the account and the
 * renewal date stay held, matching the confirmation gate at session start.
 */
const CONFIRMED_STEPS: ReadonlySet<FlowStep> = new Set<FlowStep>(["discovery", "quote_fields"]);

export const UPDATE_HEADING = "Call context update (information for you, not lines to say):";

/** Steps whose update may carry account facts (the named person is confirmed by then). */
export function stepIsConfirmed(step: FlowStep | undefined): boolean {
  return step !== undefined && CONFIRMED_STEPS.has(step);
}

/** The update body for a lead context json: stage alone with the gate sentence before confirmation, else stage, checklist and renewal. */
export function updateBodyFor(json: LeadContextJson): string {
  return json.confirmed
    ? renderUpdateText(json)
    : [`Call direction: ${json.direction}.`, `Call stage: ${json.stage.flowStep}. ${json.stage.meaning}`, CONFIRMATION_GATE].join("\n");
}

export interface ContextUpdaterOptions {
  callId: string;
  leadId: string;
  direction: "inbound" | "outbound";
  agencyName?: string;
  subscribe: (listener: (event: TraceEvent) => void) => () => void;
  getLead: (leadId: string) => Promise<LeadRecord | undefined> | LeadRecord | undefined;
  now?: () => Date;
}

export interface ContextUpdater {
  /** The update to send now, or undefined when nothing changed since the last one. */
  next: () => Promise<string | undefined>;
  stop: () => void;
}

export function createContextUpdater(o: ContextUpdaterOptions): ContextUpdater {
  let flowStep: FlowStep | undefined;
  let lastSent: string | undefined;
  const unsubscribe = o.subscribe((event) => {
    if (event.type === "node_enter" && event.callId === o.callId && event.flowStep) flowStep = event.flowStep as FlowStep;
  });
  return {
    stop: unsubscribe,
    next: async () => {
      if (flowStep === undefined) return undefined;
      const lead = await o.getLead(o.leadId);
      if (!lead) return undefined;
      const json = buildLeadContextJson({
        packet: buildLeadContextPacket(lead),
        direction: o.direction,
        flowStep,
        confirmed: stepIsConfirmed(flowStep) || !leadContextGateOn(),
        now: (o.now ?? (() => new Date()))(),
        ...(o.agencyName ? { agencyName: o.agencyName } : {}),
      });
      // Before confirmation only the stage goes out, with the gate sentence: no checklist, no record values, no renewal.
      const body = updateBodyFor(json);
      if (body === lastSent) return undefined;
      lastSent = body;
      return `${UPDATE_HEADING}\n${body}`;
    },
  };
}
