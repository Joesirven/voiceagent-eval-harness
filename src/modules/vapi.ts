/** Mock Vapi voice module (no network). */

import { MockVoiceModule } from "./base-module.js";

export class VapiModule extends MockVoiceModule {
  readonly id = "vapi";
  readonly label = "Vapi";
  protected readonly callPrefix = "vapi";

  constructor() {
    super(
      {
        enabled: false,
        voice: "alloy",
        model: "gpt-4o-mini",
        latency: { firstResponseMs: 700, endpointingMs: 400 },
      },
      {
        models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"],
        voices: ["alloy", "marin", "verse", "coral"],
      },
    );
  }
}
