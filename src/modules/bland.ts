/** Mock Bland AI voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class BlandModule extends MockVoiceModule {
  readonly id = "bland";
  readonly label = "Bland AI";
  protected readonly callPrefix = "bland";

  constructor() {
    super(
      {
        enabled: false,
        voice: "maya",
        model: "bland-base",
        latency: { firstResponseMs: 800, endpointingMs: 450 },
      },
      {
        models: ["bland-base", "bland-enhanced"],
        voices: ["maya", "josh", "florian"],
      },
    );
  }
}
