/**
 * Installs the behaviour-layer system prompt builder into the harness prompt-setup slot.
 */

import {
  buildSystemPrompt as buildBehaviourSystemPrompt,
  getPromptSetupRegistry,
  promptContextFromPacket,
} from "./prompt/index.js";
import { getLegalBlocks } from "./switches.js";
import { getHarnessConfig, setPromptSetupId } from "../config.js";
import { callOpening, openingFactsFor } from "../compliance/disclosures.js";
import { setSystemPromptBuilder } from "../modules/prompt-setup.js";

let installed = false;

export function installBehaviourPromptBuilder(): void {
  if (installed) return;
  setSystemPromptBuilder((setupId, call, packet) => {
    const resolvedSetup = setupId === "default" ? getPromptSetupRegistry().selectedId() : setupId;
    // The call's own opening. A call that reaches here without one is taken as a call to the known lead
    // A test call got the generic inbound section: the names on the record, and the harness's
    // opening identity when set, so the opening the prompt quotes is the opening the call says.
    const opening =
      call.opening ??
      callOpening(openingFactsFor({ name: packet.name, ...(packet.briefing ? { briefing: packet.briefing } : {}) }, call.direction, { knownLead: true }));
    // The opening identity (src/config.ts), when set, names the producer and agency for every lead, as the
    // opening does, so it wins over the record's producer and the call's agency in the slots too.
    const identity = getHarnessConfig().openingIdentity;
    const ctx = {
      ...promptContextFromPacket(packet, {
        direction: call.direction,
        agencyName: call.agencyName,
        publishedNumber: call.publishedNumber,
        opening,
      }),
      ...(identity ? { agencyName: identity.agencyName, producerFirstName: identity.producerFirstName } : {}),
      // The earlier call notes are printed once, in the lead context block every call appends after these rules
      // (src/modules/prompt-setup.ts), so the facts section here does not repeat them.
      priorNotes: [],
    };
    return buildBehaviourSystemPrompt(resolvedSetup, ctx, { legalBlocks: getLegalBlocks() }).text;
  });
  installed = true;
}

export function resetBehaviourPromptInstall(): void {
  installed = false;
}

/** The environment variable that selects the prompt setup every call starts with. */
export const PROMPT_SETUP_ENV = "VOICE_HARNESS_PROMPT_SETUP";

/**
 * Selects the prompt setup named by VOICE_HARNESS_PROMPT_SETUP (for example
 * lab-natural) and records it in the harness configuration. Unset or empty
 * leaves the default. An unknown id is refused and the default stays.
 */
export function selectPromptSetup(id: string): { selected: string } {
  const setup = getPromptSetupRegistry().select(id);
  setPromptSetupId(setup.id);
  return { selected: setup.id };
}

export function selectPromptSetupFromEnv(env: Record<string, string | undefined> = process.env): { requested: string | null; selected: string; refused?: string } {
  const requested = env[PROMPT_SETUP_ENV]?.trim() || null;
  if (!requested) return { requested: null, selected: getPromptSetupRegistry().selectedId() };
  try {
    return { requested, ...selectPromptSetup(requested) };
  } catch (err) {
    return { requested, selected: getPromptSetupRegistry().selectedId(), refused: err instanceof Error ? err.message : "setup_unknown" };
  }
}
