/**
 * The decision router chosen for each voice path, from
 * POST /api/voice/decision-router, and which routers each path can use now.
 * It imports only types, so the Deepgram session and the options builder can
 * both read it without an import cycle. Choices last until the server restarts.
 */

import type { DecisionRouterId, DecisionRouterOption } from "./voice-options.js";

interface RouterEntry {
  label: string;
  /** True when the router runs inside a cascaded pipeline (speech to text, reply, speech), so a speech to speech path cannot use it. */
  needsCascade: boolean;
  /** Plain reason shown while the router is listed but its runtime is not wired in. */
  notWired: string;
}

/** Every router, in menu order. A new router is one entry here (and one id in the contract). */
const ROUTERS: Record<DecisionRouterId, RouterEntry> = {
  decision_model: {
    label: "Decision model",
    needsCascade: false,
    notWired: "The decision model is not wired in.",
  },
  pipecat_flows: {
    label: "Pipecat Flows",
    needsCascade: true,
    notWired: "The Pipecat Flows runtime is not wired into the Deepgram sidecar yet.",
  },
  pipecat_classifier: {
    label: "Pipecat classifier",
    needsCascade: true,
    notWired: "The Pipecat classifier runtime is not wired into the Deepgram sidecar yet.",
  },
};

export const DECISION_ROUTER_IDS = Object.keys(ROUTERS) as DecisionRouterId[];
export const DEFAULT_DECISION_ROUTER: DecisionRouterId = "decision_model";

/**
 * The routers whose runtime is wired in. A router listed here is available on
 * every path that can use it; wiring a router later is adding its id here.
 */
export const WIRED_DECISION_ROUTERS = new Set<DecisionRouterId>(["decision_model"]);

/** Voice paths with a cascaded pipeline; any other known path is speech to speech. */
const CASCADED_PATHS: readonly string[] = ["deepgram"];
const KNOWN_PATHS: readonly string[] = ["azure_gpt_live", "azure_voice_live", ...CASCADED_PATHS];

export function isDecisionRouterId(id: unknown): id is DecisionRouterId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ROUTERS, id);
}

/** The routers a voice path can use, each with whether it can run now. Empty for an unknown path. */
export function decisionRouterOptions(voicePathId: string): DecisionRouterOption[] {
  if (!KNOWN_PATHS.includes(voicePathId)) return [];
  const cascaded = CASCADED_PATHS.includes(voicePathId);
  return DECISION_ROUTER_IDS.filter((id) => cascaded || !ROUTERS[id].needsCascade).map((id) => {
    const available = WIRED_DECISION_ROUTERS.has(id);
    return { id, label: ROUTERS[id].label, available, ...(available ? {} : { detail: ROUTERS[id].notWired }) };
  });
}

const choices = new Map<string, DecisionRouterId>();

/** The router the path runs: the stored choice while it is still offered and available, else decision_model. */
export function chosenDecisionRouter(voicePathId: string): DecisionRouterId {
  const stored = choices.get(voicePathId);
  if (stored && decisionRouterOptions(voicePathId).some((o) => o.id === stored && o.available)) return stored;
  return DEFAULT_DECISION_ROUTER;
}

/** Stores a choice the caller has already checked against decisionRouterOptions. */
export function storeDecisionRouter(voicePathId: string, id: DecisionRouterId): void {
  choices.set(voicePathId, id);
}

export function resetDecisionRouterChoices(): void {
  choices.clear();
}
