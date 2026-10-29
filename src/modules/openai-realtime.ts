/**
 * Mock OpenAI gpt-realtime voice module (no network). Its model menu is the
 * Azure catalog's live deployments, like azure-gpt-live: no hardcoded list.
 */

import { MockVoiceModule, type ModuleInfo } from "./base-module.js";
import { liveModelIds } from "./azure-catalog.js";
import { DEFAULT_LIVE_DEPLOYMENTS } from "../server/voice/azure-credentials.js";

export class OpenAiRealtimeModule extends MockVoiceModule {
  readonly id = "openai-realtime";
  readonly label = "OpenAI gpt-realtime";
  protected readonly callPrefix = "oai";

  constructor() {
    super(
      {
        enabled: false,
        voice: "marin",
        // The first entry of its own menu (the live deployments), never a model the menu lacks.
        model: liveModelIds()[0] ?? DEFAULT_LIVE_DEPLOYMENTS[0]!,
        latency: { firstResponseMs: 400, endpointingMs: 250 },
      },
      { voices: ["marin", "alloy", "verse", "coral", "shimmer"] },
    );
  }

  override info(): ModuleInfo {
    return { ...super.info(), modelChoices: liveModelIds() };
  }
}
