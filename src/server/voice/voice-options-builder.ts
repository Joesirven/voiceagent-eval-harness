/**
 * Builds GET /api/voice/options (the contract in voice-options.ts) from what
 * is deployed: the Azure catalog, the Deepgram catalog, and the orchestrators
 * and voice paths this server can run now. Only usable combinations appear:
 * an orchestrator that is not available is left out, and so is a voice path.
 */

import { isAllowedLiveVoice, loadAzureCatalog } from "../../modules/azure-catalog.js";
import { getModuleRegistry } from "../../modules/registry.js";
import { loadFoundryConfig } from "../../models/foundry.js";
import { loadDeepgramCatalog } from "../../modules/deepgram-catalog.js";
import { VOICE_LIVE_MODEL, VOICE_LIVE_MODELS, VOICE_LIVE_TRANSCRIPTION, VOICE_LIVE_TRANSCRIPTIONS } from "../../modules/azure-voice-live-session.js";
import { voiceLiveChoice } from "./manager.js";
import { listTalkOrchestrators, listVoicePaths } from "./manager.js";
import { chosenPathModel, deepgramReplyDeployment, storePathModel } from "./path-model-choices.js";
import { chosenDecisionRouter, DEFAULT_DECISION_ROUTER, decisionRouterOptions, isDecisionRouterId, storeDecisionRouter } from "./decision-router.js";
import { logModuleChanges, settingSource } from "./settings-log.js";
import type {
  DecisionRouterChoice,
  ModelOption,
  ModelRole,
  OrchestratorOption,
  PathModelChoice,
  VoiceOptions,
  VoicePathOption,
} from "./voice-options.js";

type Slot = VoicePathOption["slots"][number];

/** A voice the model speaks with: its listed voices, and for an Azure live model also a custom voice id. */
function voiceOffered(model: ModelOption, voice: string): boolean {
  if (model.provider === "azure" && model.role === "speech_to_speech") return isAllowedLiveVoice(voice);
  return Boolean(model.voices?.includes(voice));
}

/** A slot with its usable models, the default, and what is chosen now (only when it is still usable). */
function slot(role: ModelRole, models: ModelOption[], preferred?: string, chosen?: { modelId: string; voice?: string }): Slot {
  const usable = models.filter((m) => m.role === role);
  const defaultId = usable.find((m) => m.id === preferred)?.id ?? usable[0]?.id;
  const selected = chosen ? usable.find((m) => m.id === chosen.modelId) : undefined;
  const selectedVoice = selected && chosen?.voice && voiceOffered(selected, chosen.voice) ? chosen.voice : undefined;
  return {
    role,
    models: usable,
    ...(defaultId ? { defaultId } : {}),
    ...(selected ? { selectedId: selected.id } : {}),
    ...(selectedVoice ? { selectedVoice } : {}),
  };
}

/** The decision routers a path can use, the default, and the one it runs now. */
function decisionRouters(voicePathId: string): NonNullable<VoicePathOption["decisionRouters"]> {
  return { options: decisionRouterOptions(voicePathId), defaultId: DEFAULT_DECISION_ROUTER, selectedId: chosenDecisionRouter(voicePathId) };
}

function configuredReplyDeployment(): string | undefined {
  try {
    return loadFoundryConfig().deployments.reply;
  } catch {
    return undefined;
  }
}

export async function buildVoiceOptions(): Promise<VoiceOptions> {
  const [azure, deepgram] = await Promise.all([loadAzureCatalog(), loadDeepgramCatalog()]);
  const paths = new Map(listVoicePaths().map((p) => [p.id, p]));
  const live = getModuleRegistry().get("azure-gpt-live").getConfig();

  const azureLive: VoicePathOption = {
    id: "azure_gpt_live",
    label: paths.get("azure_gpt_live")?.label ?? "Azure gpt-live",
    // The live session reads the azure-gpt-live module config, so that is what is chosen here.
    slots: [slot("speech_to_speech", azure.models, live.model, { modelId: live.model, voice: live.voice })],
    decisionRouters: decisionRouters("azure_gpt_live"),
  };
  // Deepgram runs on its own Pipecat helper: speech to text and speech from Deepgram, the reply from Azure.
  const deepgramPath: VoicePathOption | undefined = paths.get("deepgram")?.available
    ? {
        id: "deepgram",
        label: paths.get("deepgram")!.label,
        slots: [
          slot("speech_to_text", deepgram.models, undefined, chosenPathModel("deepgram", "speech_to_text")),
          slot("reply", azure.models, deepgramReplyDeployment(configuredReplyDeployment()), chosenPathModel("deepgram", "reply")),
          slot("text_to_speech", deepgram.models, undefined, chosenPathModel("deepgram", "text_to_speech")),
        ],
        decisionRouters: decisionRouters("deepgram"),
      }
    : undefined;

  // Azure Voice Live is its own hosted speech agent, reached directly: listed under Direct only, and only when its settings load.
  // Its models are the fixed list in azure-voice-live-session.ts (Microsoft-hosted, nothing to list); a text model also
  // offers its caller transcription. The voice is fixed, so no voice menu.
  const voiceLiveNow = voiceLiveChoice();
  const voiceLivePath: VoicePathOption | undefined = paths.get("azure_voice_live")?.available
    ? {
        id: "azure_voice_live",
        label: paths.get("azure_voice_live")!.label,
        slots: [
          slot("speech_to_speech", VOICE_LIVE_MODELS.map((m): ModelOption => ({
            id: m.id,
            label: `${m.id} (${m.kind === "speech_to_speech" ? "hears and speaks itself" : "text model, Azure speech in and out, interim responses"}; first audio ${m.probeFirstAudioMs} milliseconds in one probe sample)`,
            role: "speech_to_speech",
            provider: "azure",
          })), VOICE_LIVE_MODEL, chosenPathModel("azure_voice_live", "speech_to_speech")),
          ...(voiceLiveNow.kind === "text"
            ? [slot("speech_to_text", VOICE_LIVE_TRANSCRIPTIONS.map((id): ModelOption => ({
                id,
                label: id === "azure-speech" ? "azure-speech (Azure speech to text)" : "mai-transcribe-2 (Microsoft MAI Transcribe 2, preview)",
                role: "speech_to_text",
                provider: "azure",
              })), VOICE_LIVE_TRANSCRIPTION, chosenPathModel("azure_voice_live", "speech_to_text"))]
            : []),
        ],
        decisionRouters: decisionRouters("azure_voice_live"),
      }
    : undefined;

  const orchestrators: OrchestratorOption[] = listTalkOrchestrators()
    .filter((o) => o.available)
    .map((o) => ({
      id: o.id,
      label: o.label,
      voicePaths:
        o.id === "pipecat"
          ? [azureLive, ...(deepgramPath ? [deepgramPath] : [])]
          : [azureLive, ...(voiceLivePath ? [voiceLivePath] : [])],
    }));
  return { orchestrators, sources: [azure.status, deepgram.status] };
}

const ROLES: readonly ModelRole[] = ["speech_to_speech", "speech_to_text", "reply", "text_to_speech"];

/**
 * POST /api/voice/path-models: store the model (and voice) for one slot of one
 * voice path. Anything not offered by GET /api/voice/options for that slot is
 * refused with a fixed code. Returns the options as they are after the change.
 */
export async function choosePathModel(body: unknown): Promise<VoiceOptions> {
  const c = (body ?? {}) as Partial<PathModelChoice>;
  if (typeof c.voicePathId !== "string" || typeof c.modelId !== "string" || (c.voice !== undefined && typeof c.voice !== "string")) {
    throw new Error("bad_path_model_choice");
  }
  if (!ROLES.includes(c.role as ModelRole)) throw new Error("unknown_model_role");
  const options = await buildVoiceOptions();
  const path = options.orchestrators.flatMap((o) => o.voicePaths).find((p) => p.id === c.voicePathId);
  if (!path) throw new Error("unknown_voice_path");
  const target = path.slots.find((s) => s.role === c.role);
  if (!target) throw new Error("unknown_model_role");
  const model = target.models.find((m) => m.id === c.modelId);
  // An Azure deployment that is not offered is the model error; a Deepgram or Voice Live model that is not offered has its own.
  if (!model) {
    if (path.id === "azure_voice_live") throw new Error("azure_voice_live_model_not_offered");
    throw new Error(path.id === "deepgram" && c.role !== "reply" ? "deepgram_model_not_offered" : "azure_model_not_deployed");
  }
  if (c.voice !== undefined && !voiceOffered(model, c.voice)) throw new Error("voice_not_offered");
  if (path.id === "azure_gpt_live" && c.role === "speech_to_speech") {
    const live = getModuleRegistry().get("azure-gpt-live");
    const before = live.getConfig();
    live.updateConfig({ model: model.id, ...(c.voice ? { voice: c.voice } : {}) });
    logModuleChanges("azure-gpt-live", before, live.getConfig(), settingSource((body as { source?: unknown })?.source));
  } else {
    const before = chosenPathModel(path.id, c.role as ModelRole);
    storePathModel(path.id, c.role as ModelRole, { modelId: model.id, ...(c.voice ? { voice: c.voice } : {}) });
    console.log(
      `path model changed path=${path.id} role=${c.role} old=${before?.modelId ?? "default"}${before?.voice ? `/${before.voice}` : ""} new=${model.id}${c.voice ? `/${c.voice}` : ""} source=${settingSource((body as { source?: unknown })?.source)}`,
    );
  }
  return buildVoiceOptions();
}

export type DecisionRouterRefusal = "decision_router_unknown" | "decision_router_not_supported" | "decision_router_unavailable";

/**
 * POST /api/voice/decision-router: store the decision router for one voice
 * path. A router that is not one of the ids, or a path GET /api/voice/options
 * does not offer, is decision_router_unknown; a router the path cannot use is
 * decision_router_not_supported; a router listed but not able to run now is
 * decision_router_unavailable. A refusal changes nothing and comes back with
 * the options as they are.
 */
export async function chooseDecisionRouter(
  body: unknown,
): Promise<{ ok: true; options: VoiceOptions } | { ok: false; error: DecisionRouterRefusal; options: VoiceOptions }> {
  const c = (body ?? {}) as Partial<DecisionRouterChoice> & { source?: unknown };
  const options = await buildVoiceOptions();
  const refuse = (error: DecisionRouterRefusal) => ({ ok: false as const, error, options });
  if (typeof c.voicePathId !== "string" || !isDecisionRouterId(c.decisionRouterId)) return refuse("decision_router_unknown");
  const path = options.orchestrators.flatMap((o) => o.voicePaths).find((p) => p.id === c.voicePathId);
  if (!path) return refuse("decision_router_unknown");
  const option = decisionRouterOptions(path.id).find((o) => o.id === c.decisionRouterId);
  if (!option) return refuse("decision_router_not_supported");
  if (!option.available) return refuse("decision_router_unavailable");
  const before = chosenDecisionRouter(path.id);
  storeDecisionRouter(path.id, option.id);
  console.log(`decision router changed path=${path.id} old=${before} new=${option.id} source=${settingSource(c.source)}`);
  return { ok: true, options: await buildVoiceOptions() };
}
