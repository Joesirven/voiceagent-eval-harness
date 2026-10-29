/** Mock ElevenLabs Agents voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class ElevenLabsAgentsModule extends MockVoiceModule {
  readonly id = "elevenlabs-agents";
  readonly label = "ElevenLabs Agents";
  protected readonly callPrefix = "el";

  constructor() {
    super(
      {
        enabled: false,
        voice: "Rachel",
        model: "eleven-flash",
        latency: { firstResponseMs: 500, endpointingMs: 300 },
      },
      {
        models: ["eleven-flash", "eleven-turbo", "eleven-multilingual"],
        voices: ["Rachel", "Adam", "Bella"],
      },
    );
  }
}
