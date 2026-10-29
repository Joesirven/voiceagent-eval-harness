/**
 * Azure OpenAI gpt-live-1 voice module (the reference stack, the
 * default). Scripted calls (scenarios, tests) still use the mock session so the
 * lead packet is inspectable through azureGetContextPacket. `openLiveSession`
 * is the real path: a live relay to Azure that the dev server drives for a call
 * the harness has already cleared.
 */

import { isClearedInteractiveCall } from "../decision/interactive-call.js";
import type { CallSession } from "../provider/interface.js";
import { azureCloseSession, azureCreateSession } from "./azure-realtime.js";
import { MockVoiceModule, type ModuleConfig, type ModuleConfigPatch, type ModuleInfo } from "./base-module.js";
import { DEFAULT_LIVE_DEPLOYMENTS } from "../server/voice/azure-credentials.js";
import { isAllowedLiveVoice, LIVE_VOICES, liveModelIds } from "./azure-catalog.js";
import { AzureLiveSession, type LiveSessionOptions } from "./azure-live-session.js";

export class AzureGptLiveModule extends MockVoiceModule {
  readonly id = "azure-gpt-live";
  readonly label = "Azure OpenAI gpt-live-1";
  protected readonly callPrefix = "call";

  constructor() {
    super(
      {
        enabled: true,
        voice: "verse",
        // The first entry of the model menu (the same list the checks read), so a fresh server never starts on a model it refuses.
        model: liveModelIds()[0] ?? DEFAULT_LIVE_DEPLOYMENTS[0]!,
        latency: { firstResponseMs: 450, endpointingMs: 280 },
      },
      {
        models: [...DEFAULT_LIVE_DEPLOYMENTS],
        voices: [...LIVE_VOICES],
      },
    );
  }

  /**
   * Only a live deployment the resource has (the Azure catalog) can be chosen:
   * Azure refuses a session start naming any other model.
   */
  override updateConfig(patch: ModuleConfigPatch): ModuleConfig {
    // Only a change is checked: saving the voice or latency with the model unchanged always works.
    const current = this.getConfig();
    if (patch.model !== undefined && patch.model !== current.model && !liveModelIds().includes(patch.model)) {
      throw new Error("azure_model_not_deployed");
    }
    // The five voices gpt-live-1 started a session with (probe, 2026-10-20), or a custom voice id (voice_...).
    if (patch.voice !== undefined && patch.voice !== current.voice && !isAllowedLiveVoice(patch.voice)) {
      throw new Error("voice_not_offered");
    }
    return super.updateConfig(patch);
  }

  /**
   * The model menu lists the live deployments in the Azure catalog, and nothing
   * else. modelAllowed is false (with a plain reason) when the current model is
   * not one of them: the next call would be refused until another is chosen.
   */
  override info(): ModuleInfo & { modelAllowed: boolean; modelNotAllowedReason?: string } {
    const allowed = liveModelIds();
    const model = this.getConfig().model;
    const ok = allowed.includes(model);
    return {
      ...super.info(),
      modelChoices: allowed,
      modelAllowed: ok,
      ...(ok ? {} : { modelNotAllowedReason: `${model} is not one of the live deployments this server allows (${allowed.join(", ") || "none"}). Choose another model before the next call.` }),
    };
  }

  /**
   * Opens a live session with the module's current voice and model. The caller
   * proves the call is cleared by passing a connected call from the harness.
   */
  openLiveSession(
    call: { status?: string },
    options: Omit<LiveSessionOptions, "model" | "voice">,
  ): AzureLiveSession {
    if (!isClearedInteractiveCall(call) || call.status !== "connected") throw new Error("call_not_cleared");
    const cfg = this.getConfig();
    if (!cfg.enabled) throw new Error(`module_disabled:${this.id}`);
    return new AzureLiveSession({ ...options, model: cfg.model, voice: cfg.voice });
  }

  protected override onCallStarted(callId: string, session: CallSession): void {
    azureCreateSession(callId, session.contextPacket);
  }

  protected override onCallEnded(callId: string): void {
    azureCloseSession(callId);
  }
}
