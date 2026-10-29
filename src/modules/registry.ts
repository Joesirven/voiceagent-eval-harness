/**
 * Module registry: the one place that knows every voice option. Exactly one
 * module is selected for routing; it must also be enabled to take calls.
 */

import { defaultVoiceStack } from "../config.js";
import { AzureGptLiveModule } from "./azure-gpt-live.js";
import type { MockVoiceModule, ModuleConfigPatch, ModuleInfo } from "./base-module.js";
import { BlandModule } from "./bland.js";
import { ElevenLabsAgentsModule } from "./elevenlabs-agents.js";
import { FishAudioModule } from "./fish-audio.js";
import { OpenAiRealtimeModule } from "./openai-realtime.js";
import { RetellModule } from "./retell.js";
import { SesameModule } from "./sesame.js";
import { VapiModule } from "./vapi.js";

const DEFAULT_MODULE_ID = "azure-gpt-live";

export class ModuleRegistry {
  private modules = new Map<string, MockVoiceModule>();
  private selectedId = DEFAULT_MODULE_ID;

  constructor() {
    for (const m of [
      new AzureGptLiveModule(),
      new OpenAiRealtimeModule(),
      new VapiModule(),
      new RetellModule(),
      new ElevenLabsAgentsModule(),
      new BlandModule(),
      new FishAudioModule(),
      new SesameModule(),
    ]) {
      this.modules.set(m.id, m);
    }
    this.applyVoiceStackDefaults();
  }

  /** Reference defaults: Azure on, every other vendor module off. */
  private applyVoiceStackDefaults(): void {
    const s = defaultVoiceStack;
    this.get("azure-gpt-live").setEnabled(s.azureRealtime);
    this.get("openai-realtime").setEnabled(s.openaiRealtime);
    this.get("retell").setEnabled(s.retell);
    this.get("vapi").setEnabled(s.vapi);
    this.get("elevenlabs-agents").setEnabled(s.elevenLabsAgents);
    this.get("bland").setEnabled(s.bland);
    this.get("fish-audio").setEnabled(s.fishAudio);
    this.get("sesame").setEnabled(s.sesame);
    this.selectedId = DEFAULT_MODULE_ID;
  }

  list(): ModuleInfo[] {
    return [...this.modules.values()].map((m) => m.info());
  }

  get(id: string): MockVoiceModule {
    const m = this.modules.get(id);
    if (!m) throw new Error(`unknown_module:${id}`);
    return m;
  }

  update(id: string, patch: ModuleConfigPatch): ModuleInfo {
    const m = this.get(id);
    m.updateConfig(patch);
    return m.info();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.get(id).setEnabled(enabled);
  }

  select(id: string): void {
    this.get(id);
    this.selectedId = id;
  }

  selectedModuleId(): string {
    return this.selectedId;
  }

  /** The selected module when enabled, otherwise none (callers fall back, logged). */
  activeModule(): MockVoiceModule | null {
    const m = this.get(this.selectedId);
    return m.getConfig().enabled ? m : null;
  }
}

let registry = new ModuleRegistry();

export function getModuleRegistry(): ModuleRegistry {
  return registry;
}

export function resetModuleRegistry(): void {
  registry = new ModuleRegistry();
}
