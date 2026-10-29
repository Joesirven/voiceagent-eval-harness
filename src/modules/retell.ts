/** Mock Retell AI voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class RetellModule extends MockVoiceModule {
  readonly id = "retell";
  readonly label = "Retell AI";
  protected readonly callPrefix = "retell";

  constructor() {
    super(
      {
        enabled: false,
        voice: "11labs-Adrian",
        model: "retell-default",
        latency: { firstResponseMs: 600, endpointingMs: 350 },
      },
      {
        models: ["retell-default", "gpt-4o", "gpt-4o-mini"],
        voices: ["11labs-Adrian", "11labs-Amy", "cartesia-default"],
      },
    );
  }
}
