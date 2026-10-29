/**
 * Applying a setup: one call that points the harness at the chosen voice
 * module, decision module, prompt setup and lead profile, and
 * remembers a full snapshot of what that resolved to so a run can say exactly
 * what it used.
 *
 * What applying changes, all in this process only:
 * - the selected voice module (module registry, switched on if it was off) and
 *   decision module (catalog);
 * - the mock lead store, seeded with the chosen profile;
 * - the harness's AI-calling flag for the lead's agency, because the first
 *   gate refuses a lead whose agency is not switched on.
 * The profile reader is injected. The harness does not include a CRM adapter.
 */

import { createHash } from "node:crypto";
import { setAiCallingEnabled } from "../config.js";
import type { LeadBriefing } from "../memory/briefing.js";
import type { LeadContextPacket } from "../memory/context.js";
import { getModuleRegistry } from "../modules/registry.js";
import type { ModuleInfo } from "../modules/base-module.js";
import type { DbClient } from "../store/database-client.js";
import { seedLead } from "../store/lead-store.js";
import { getDecisionCatalog, type DecisionCatalogEntry } from "./decision-catalog.js";
import { readLeadProfile, type LeadProfile } from "./lead-profile.js";
import { buildPersonaCard, choosePersona, loadLeadScripts, type LeadScripts, type PersonaCard } from "./persona-card.js";
import { getPromptSetup, renderAgentPrompt, type PromptSetup } from "./prompt-setups.js";
import type { NamedSetup, SetupInput } from "./setup-store.js";
import { validateSetupInput } from "./setup-store.js";

/** Everything a run needs to be compared with another run, frozen at apply time. */
export interface SetupSnapshot {
  name: string;
  appliedAt: string;
  direction: "inbound" | "outbound";
  voiceModule: ModuleInfo;
  decisionModule: DecisionCatalogEntry;
  promptSetup: PromptSetup;
  /** The instructions the agent started with: rules plus the lead record when included. */
  renderedPrompt: string;
  renderedPromptSha256: string;
  lead: { leadId: string; agencyId: string; businessName: string; trade?: string; xDate?: string; stage?: string; callCount: number };
  /** What the agent was told about the lead; null for the control prompt that carries none. */
  briefingGiven: LeadBriefing | null;
  persona?: { personaId: string; title: string; situation: string };
}

export interface ActiveSetup {
  snapshot: SetupSnapshot;
  profile: LeadProfile;
  card: PersonaCard;
}

export interface ApplyDeps {
  db?: () => DbClient;
  now?: () => Date;
  /** The lead scripts, or undefined when the file is not there yet (the card then lists facts only). */
  scripts?: () => LeadScripts | undefined;
}

let active: ActiveSetup | null = null;

export function getActiveSetup(): ActiveSetup | null {
  return active;
}

export function clearActiveSetup(): void {
  active = null;
}

/** No remote profile source is built in. Callers can inject one. */
export function createProfileDb(): DbClient {
  throw new Error("lead_profile_source_not_configured");
}

function defaultScripts(): LeadScripts | undefined {
  try {
    return loadLeadScripts();
  } catch {
    return undefined;
  }
}

export interface ApplyResult {
  snapshot: SetupSnapshot;
  card: PersonaCard;
  /** Text of the prompt as the agent will get it, for the page to show. */
  promptPreview: string;
  /** The agency whose AI-calling flag this switched on in the harness. */
  aiCallingEnabledForAgency: string;
}

export async function applySetup(setup: NamedSetup | (SetupInput & { savedAt?: string }), deps: ApplyDeps = {}): Promise<ApplyResult> {
  validateSetupInput(setup);
  const now = deps.now ?? (() => new Date());
  const registry = getModuleRegistry();
  const catalog = getDecisionCatalog();
  // Every choice is checked before anything is switched, so a bad name changes nothing.
  const voice = registry.get(setup.voiceModuleId);
  if (!catalog.list().some((d) => d.id === setup.decisionModuleId)) throw new Error(`unknown_decision_module:${setup.decisionModuleId}`);
  const promptSetup = getPromptSetup(setup.promptSetupId);

  const profile = await readLeadProfile((deps.db ?? createProfileDb)(), setup.leadId, now);
  if (!profile) throw new Error("lead_not_found");

  const scripts = (deps.scripts ?? defaultScripts)();
  const script = scripts ? choosePersona(scripts, profile.leadId, profile.briefing, { personaId: setup.personaId }) : undefined;
  const card = buildPersonaCard(profile.briefing, script, { briefingInAgentPacket: promptSetup.includesBriefing });

  const briefingGiven = promptSetup.includesBriefing ? profile.briefing : null;
  const renderedPrompt = renderAgentPrompt(promptSetup, { name: profile.briefing.ownerName ?? profile.briefing.business, briefing: briefingGiven ?? undefined });
  const decisionModule = catalog.list().find((d) => d.id === setup.decisionModuleId)!;
  const snapshot: SetupSnapshot = {
    name: setup.name,
    appliedAt: now().toISOString(),
    direction: setup.direction,
    voiceModule: structuredClone(registry.list().find((m) => m.id === voice.id)!),
    decisionModule,
    promptSetup,
    renderedPrompt,
    renderedPromptSha256: createHash("sha256").update(renderedPrompt).digest("hex"),
    lead: {
      leadId: profile.leadId,
      agencyId: profile.agencyId,
      businessName: profile.briefing.business,
      trade: profile.briefing.trade,
      xDate: profile.briefing.xDate?.date,
      stage: profile.stage,
      callCount: profile.callCount,
    },
    briefingGiven: briefingGiven ? structuredClone(briefingGiven) : null,
    ...(script ? { persona: { personaId: script.id, title: script.title, situation: script.situation } } : {}),
  };

  // Past this point the choices are valid. Seed only synthetic contact data.
  seedLead({
    id: profile.leadId,
    agencyId: profile.agencyId,
    name: profile.briefing.ownerName ?? profile.briefing.business,
    phone: "+15550100",
    smsConsentAt: now().toISOString(),
    voiceConsentAt: now().toISOString(),
    artificialVoiceConsent: { at: now().toISOString(), basis: "lead_written" },
    dncStatus: "clear",
    priorCallSummaries: [],
    quoteFields: {},
    handoffNotes: [],
    messages: [],
    bookings: [],
    ...(briefingGiven ? { briefing: structuredClone(briefingGiven) } : {}),
  });
  registry.select(voice.id);
  // A chosen module that is switched off would silently fall back to normal answering.
  registry.setEnabled(voice.id, true);
  catalog.select(decisionModule.id);
  setAiCallingEnabled(profile.agencyId, true);
  active = { snapshot, profile, card };
  return { snapshot, card, promptPreview: renderedPrompt, aiCallingEnabledForAgency: profile.agencyId };
}

/** The instructions for a call under the active setup, or undefined when no setup is applied. Voice modules call this. */
export function activePromptFor(packet: Pick<LeadContextPacket, "name" | "briefing" | "leadId">): string | undefined {
  if (!active || active.profile.leadId !== packet.leadId) return undefined;
  return renderAgentPrompt(active.snapshot.promptSetup, packet);
}
