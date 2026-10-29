/** Mock Fish Audio Agents voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class FishAudioModule extends MockVoiceModule {
  readonly id = "fish-audio";
  readonly label = "Fish Audio Agents";
  protected readonly callPrefix = "fish";

  constructor() {
    super(
      {
        enabled: false,
        voice: "default",
        model: "fish-agent",
        latency: { firstResponseMs: 650, endpointingMs: 350 },
      },
      {
        models: ["fish-agent", "fish-s1"],
        voices: ["default", "friendly", "calm"],
      },
    );
  }
}
