import { describe, expect, it } from "vitest";
import { peekAzureModuleWiring } from "../../src/server/voice/azure-credentials.js";
import type { ConnectorFs as DevEnvFs } from "../../src/connectors/credentials.js";

function fsWith(body: string, mode = 0o600): DevEnvFs {
  return {
    mode: () => mode,
    read: () => body,
  };
}

describe("azure-gpt-live wiring from VOICE_HARNESS_DEV_ENV_FILE", () => {
  it("is mock when the env file path is unset", () => {
    expect(peekAzureModuleWiring({})).toEqual({ backend: "mock", missingEnv: ["VOICE_HARNESS_DEV_ENV_FILE"] });
  });

  it("is live when Foundry url and key are present", () => {
    const env = { VOICE_HARNESS_DEV_ENV_FILE: "/secrets" };
    const fs = fsWith("AZURE_FOUNDRY_URL=https://x.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=k\n");
    expect(peekAzureModuleWiring(env, fs)).toEqual({ backend: "live", missingEnv: [] });
  });

  it("reports a missing key", () => {
    const env = { VOICE_HARNESS_DEV_ENV_FILE: "/secrets" };
    const fs = fsWith("AZURE_FOUNDRY_URL=https://x.openai.azure.com/openai/v1\n");
    expect(peekAzureModuleWiring(env, fs).missingEnv).toEqual(["AZURE_FOUNDRY_KEY"]);
  });
});
