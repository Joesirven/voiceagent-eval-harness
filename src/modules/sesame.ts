/** Mock Sesame voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class SesameModule extends MockVoiceModule {
  readonly id = "sesame";
  readonly label = "Sesame";
  protected readonly callPrefix = "sesame";

  constructor() {
    super(
      {
        enabled: false,
        voice: "maya",
        model: "sesame-csm",
        latency: { firstResponseMs: 500, endpointingMs: 300 },
      },
      {
        models: ["sesame-csm"],
        voices: ["maya", "conversational"],
      },
    );
  }
}
