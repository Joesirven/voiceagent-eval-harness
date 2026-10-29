import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  azureCredentialsStatus,
  ConnectorCredentialError,
  deepgramCredentialsStatus,
  DeepgramCredentialError,
  loadDeepgramCredentials,
  loadAzureCredentials,
  loadGatewayCredentials,
  type ConnectorFs,
} from "../../src/connectors/credentials.js";
import { createDecisionModelCatalog } from "../../src/decision-models/catalog.js";
import { loadDecisionCredentials } from "../../src/decision-models/credentials.js";
import { loadAzureLiveCredentials, peekAzureModuleWiring } from "../../src/server/voice/azure-credentials.js";

const KEY = "SECRETKEYVALUE123";
const GATEWAY_KEY = "GATEWAYSECRET456";
const URL_OK = "https://example-test.openai.azure.com/openai/v1";
const MAIN = "/secrets/dev.env";
const ENV = { VOICE_HARNESS_DEV_ENV_FILE: MAIN };

/** Files by path; `modes` overrides the default 0600; a missing path fails like a missing file. */
function files(contents: Record<string, string>, modes: Record<string, number> = {}): ConnectorFs {
  return {
    mode(path) {
      if (!(path in contents)) throw new Error(`ENOENT ${path}`);
      return modes[path] ?? 0o600;
    },
    read(path) {
      const text = contents[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
  };
}

const azureFile = (extra = "") => `AZURE_FOUNDRY_URL=${URL_OK}\nAZURE_FOUNDRY_KEY=${KEY}\n${extra}`;

describe("loadAzureCredentials", () => {
  it("matches /openai/v1 as a whole path segment", () => {
    const load = (path: string) =>
      loadAzureCredentials(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=https://example-test.openai.azure.com${path}\nAZURE_FOUNDRY_KEY=${KEY}` }));
    expect(load("/openai/v1/").foundryUrl).toBe(URL_OK);
    expect(() => load("/xopenai/v1")).toThrow("url_invalid");
    expect(() => load("/v1")).toThrow("url_invalid");
  });

  it("returns the typed shape with every deployment name and the derived decision URL", () => {
    const creds = loadAzureCredentials(
      ENV,
      files({
        [MAIN]: azureFile(
          [
            "export AZURE_FAST_DEPLOYMENT=fast-1",
            "AZURE_LONG_DEPLOYMENT=long-1",
            "AZURE_REPLY_DEPLOYMENT='reply-1'",
            'AZURE_DECISION_DEPLOYMENT="decision-1"',
            "AZURE_JUDGE_DEPLOYMENT=judge-1",
            "AZURE_TRANSCRIBE_DEPLOYMENT=transcribe-1",
            "AZURE_REALTIME_DEPLOYMENT=realtime-1",
          ].join("\n"),
        ),
      }),
    );
    expect(creds).toMatchObject({
      foundryUrl: URL_OK,
      decisionUrl: "https://example-test.openai.azure.com/providers/microsoft/v1/systemone",
      fastDeployment: "fast-1",
      longDeployment: "long-1",
      replyDeployment: "reply-1",
      decisionDeployment: "decision-1",
      judgeDeployment: "judge-1",
      transcribeDeployment: "transcribe-1",
      realtimeDeployment: "realtime-1",
    });
    expect(creds.apiKey).toBe(KEY);
  });

  it("leaves a deployment undefined when the file does not name it, and honors AZURE_FOUNDRY_DECISION_URL", () => {
    const creds = loadAzureCredentials(
      ENV,
      files({ [MAIN]: azureFile("AZURE_FOUNDRY_DECISION_URL=https://other.services.ai.azure.com/providers/x/\n") }),
    );
    expect(creds.realtimeDeployment).toBeUndefined();
    expect(creds.decisionUrl).toBe("https://other.services.ai.azure.com/providers/x");
  });

  it("holds the key as a non-enumerable property", () => {
    const creds = loadAzureCredentials(ENV, files({ [MAIN]: azureFile() }));
    expect(JSON.stringify(creds)).not.toContain(KEY);
    expect(inspect(creds)).not.toContain(KEY);
    expect(Object.keys(creds)).not.toContain("apiKey");
    expect({ ...creds }).not.toHaveProperty("apiKey");
  });

  it("fails with fixed codes that never carry a value, a path or a line", () => {
    const code = (env: Record<string, string>, fs: ConnectorFs) => {
      try {
        loadAzureCredentials(env, fs);
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorCredentialError);
        expect((err as Error).message).toBe((err as ConnectorCredentialError).code);
        return (err as ConnectorCredentialError).code;
      }
      return "no error";
    };
    expect(code({}, files({}))).toBe("env_file_not_configured");
    expect(code(ENV, files({ [MAIN]: azureFile() }, { [MAIN]: 0o644 }))).toBe("env_file_permissions_too_open");
    expect(code(ENV, files({ [MAIN]: azureFile() }, { [MAIN]: 0o640 }))).toBe("env_file_permissions_too_open");
    expect(code(ENV, files({}))).toBe("env_file_unreadable");
    expect(code(ENV, { mode: () => 0o600, read: () => { throw new Error(`${MAIN} ${KEY}`); } })).toBe("env_file_unreadable");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_KEY=${KEY}` }))).toBe("missing_azure_url");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=${URL_OK}` }))).toBe("missing_azure_key");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=http://x.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=${KEY}` }))).toBe("url_invalid");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=https://x.openai.azure.com/v1\nAZURE_FOUNDRY_KEY=${KEY}` }))).toBe("url_invalid");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=https://evil.example.com/openai/v1\nAZURE_FOUNDRY_KEY=${KEY}` }))).toBe("url_not_azure");
    expect(code(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=https://x.openai.azure.com.evil.com/openai/v1\nAZURE_FOUNDRY_KEY=${KEY}` }))).toBe("url_not_azure");
  });
});

describe("azureCredentialsStatus", () => {
  it("reports availability or a code, and never throws or returns a value", () => {
    expect(azureCredentialsStatus(ENV, files({ [MAIN]: azureFile() }))).toEqual({ available: true });
    expect(azureCredentialsStatus({}, files({}))).toEqual({ available: false, code: "env_file_not_configured" });
    expect(azureCredentialsStatus(ENV, files({ [MAIN]: azureFile() }, { [MAIN]: 0o666 }))).toEqual({
      available: false,
      code: "env_file_permissions_too_open",
    });
    const odd: ConnectorFs = { mode: () => { throw "not an Error"; }, read: () => "" };
    expect(azureCredentialsStatus(ENV, odd)).toEqual({ available: false, code: "env_file_unreadable" });
  });
});

describe("loadGatewayCredentials and the decision-models fallback", () => {
  const FALLBACK = "/home/me/decision-models.env";
  const env = { ...ENV, DECISION_MODELS_ENV_FILE: FALLBACK };

  it("reads the Gateway key from the main file first", () => {
    const creds = loadGatewayCredentials(env, files({ [MAIN]: `AI_GATEWAY_API_KEY=${GATEWAY_KEY}`, [FALLBACK]: "AI_GATEWAY_API_KEY=other" }));
    expect(creds.apiKey).toBe(GATEWAY_KEY);
    expect(JSON.stringify(creds)).not.toContain(GATEWAY_KEY);
    expect(inspect(creds)).not.toContain(GATEWAY_KEY);
  });

  it("falls back to the decision-models file, with or without a main file configured", () => {
    const fs = files({ [MAIN]: azureFile(), [FALLBACK]: `AI_GATEWAY_API_KEY=${GATEWAY_KEY}` });
    expect(loadGatewayCredentials(env, fs).apiKey).toBe(GATEWAY_KEY);
    expect(loadGatewayCredentials({ DECISION_MODELS_ENV_FILE: FALLBACK }, fs).apiKey).toBe(GATEWAY_KEY);
  });

  it("fails with fixed codes when there is no key or a file is too open", () => {
    const code = (e: Record<string, string>, fs: ConnectorFs) => {
      try {
        loadGatewayCredentials(e, fs);
      } catch (err) {
        return (err as ConnectorCredentialError).code;
      }
      return "no error";
    };
    expect(code(env, files({ [MAIN]: azureFile() }))).toBe("missing_gateway_key");
    expect(code(env, files({ [MAIN]: azureFile(), [FALLBACK]: `AI_GATEWAY_API_KEY=${GATEWAY_KEY}` }, { [FALLBACK]: 0o644 }))).toBe("env_file_permissions_too_open");
    expect(code(env, files({ [MAIN]: `AI_GATEWAY_API_KEY=${GATEWAY_KEY}` }, { [MAIN]: 0o604 }))).toBe("env_file_permissions_too_open");
  });

  it("still refuses a too-open decision-models file when the main file holds every name", () => {
    const all = "OPENAI_API_KEY=o\nTYPESAFE_API_KEY=t\nKEV_BASE_URL=https://kev.example.test\nKEV_API_KEY=k\nAI_GATEWAY_API_KEY=g";
    expect(() => loadDecisionCredentials(env, files({ [MAIN]: all, [FALLBACK]: "OPENAI_API_KEY=x" }, { [FALLBACK]: 0o644 }))).toThrow(
      "decision_models_env_file_permissions_too_open",
    );
  });

  it("builds the catalog without throwing when the main file is missing or too open, and falls back to the decision-models file", () => {
    const cases: ConnectorFs[] = [
      files({}),
      files({ [MAIN]: azureFile() }, { [MAIN]: 0o644 }),
      files({ [FALLBACK]: `AI_GATEWAY_API_KEY=${GATEWAY_KEY}` }),
    ];
    for (const fs of cases) {
      const catalog = createDecisionModelCatalog({ env, fs });
      expect(catalog.get("jev")).toBeDefined();
    }
    expect(createDecisionModelCatalog({ env, fs: cases[2]! }).get("jev")).toMatchObject({ fellBackToMock: false });
    expect(createDecisionModelCatalog({ env, fs: cases[0]! }).get("jev")).toMatchObject({ fellBackToMock: true, reason: "no_credential" });
    expect(createDecisionModelCatalog({ env, fs: cases[1]! }).get("azure-decision")).toMatchObject({ fellBackToMock: true });
    // A too-open decision-models file keeps throwing its own code.
    expect(() =>
      createDecisionModelCatalog({ env, fs: files({ [FALLBACK]: "OPENAI_API_KEY=o" }, { [FALLBACK]: 0o644 }) }),
    ).toThrow("decision_models_env_file_permissions_too_open");
  });

  it("never reads an Anthropic key", () => {
    const creds = loadDecisionCredentials(
      env,
      files({ [MAIN]: "ANTHROPIC_API_KEY=a\nOPENAI_API_KEY=o", [FALLBACK]: "ANTHROPIC_API_KEY=b\nTYPESAFE_API_KEY=t\nKEV_BASE_URL=https://kev.example.test" }),
    );
    expect(creds.OPENAI_API_KEY).toBe("o");
    expect(creds.TYPESAFE_API_KEY).toBe("t");
    expect(creds.KEV_BASE_URL).toBe("https://kev.example.test");
    expect((creds as Record<string, string | undefined>)["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(JSON.stringify(creds)).toBe('{"KEV_BASE_URL":"https://kev.example.test"}');
  });

  it("returns nothing when no file exists, and keeps the decision-models permission codes", () => {
    expect(loadDecisionCredentials({ DECISION_MODELS_ENV_FILE: FALLBACK }, files({}))).toEqual({});
    expect(() => loadDecisionCredentials({ DECISION_MODELS_ENV_FILE: FALLBACK }, files({ [FALLBACK]: "OPENAI_API_KEY=o" }, { [FALLBACK]: 0o644 }))).toThrow(
      "decision_models_env_file_permissions_too_open",
    );
    expect(() =>
      loadDecisionCredentials({ DECISION_MODELS_ENV_FILE: FALLBACK }, { mode: () => 0o600, read: () => { throw new Error("x"); } }),
    ).toThrow("decision_models_env_file_unreadable");
  });
});

describe("the older entry points are thin wrappers over the same loader", () => {
  it("maps the live voice credentials to their own codes and a secure websocket URL", () => {
    const live = loadAzureLiveCredentials(ENV, files({ [MAIN]: azureFile() }));
    expect(live).toEqual({ liveUrl: "wss://example-test.openai.azure.com/openai/v1/live/sessions", apiKey: KEY });
    expect(() => loadAzureLiveCredentials({}, files({}))).toThrow("azure_env_file_not_configured");
    expect(() => loadAzureLiveCredentials(ENV, files({ [MAIN]: azureFile() }, { [MAIN]: 0o644 }))).toThrow("azure_env_file_permissions_too_open");
    expect(() => loadAzureLiveCredentials(ENV, files({ [MAIN]: `AZURE_FOUNDRY_KEY=${KEY}` }))).toThrow("azure_settings_missing_url");
    expect(() => loadAzureLiveCredentials(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=${URL_OK}` }))).toThrow("azure_settings_missing_key");
  });

  it("keeps the lenient live URL rules: any https or wss URL on any host and path", () => {
    const live = (url: string) => loadAzureLiveCredentials(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=${url}\nAZURE_FOUNDRY_KEY=${KEY}` }));
    expect(live("wss://relay.example.test/custom/path/").liveUrl).toBe("wss://relay.example.test/custom/path/live/sessions");
    expect(live("https://example.test").liveUrl).toBe("wss://example.test/live/sessions");
    expect(() => live("http://example.test/openai/v1")).toThrow("azure_live_url_not_secure");
    expect(() => live("not a url")).toThrow("azure_live_url_invalid");
    // The strict Foundry loader still refuses what the live path accepts.
    expect(() => loadAzureCredentials(ENV, files({ [MAIN]: `AZURE_FOUNDRY_URL=wss://relay.example.test/x\nAZURE_FOUNDRY_KEY=${KEY}` }))).toThrow();
  });

  it("peeks at wiring without validating the URL", () => {
    expect(peekAzureModuleWiring(ENV, files({ [MAIN]: azureFile() }, { [MAIN]: 0o644 }))).toEqual({
      backend: "mock",
      missingEnv: ["VOICE_HARNESS_DEV_ENV_FILE (mode 600)"],
    });
    expect(peekAzureModuleWiring(ENV, files({}))).toEqual({ backend: "mock", missingEnv: ["VOICE_HARNESS_DEV_ENV_FILE"] });
  });
});

describe("loadDeepgramCredentials", () => {
  const DG_KEY = "DEEPGRAMSECRET789";
  const env = { ...ENV };

  it("reads the key from the main file, hidden from enumeration and printing", () => {
    const creds = loadDeepgramCredentials(env, files({ [MAIN]: `DEEPGRAM_API_KEY=${DG_KEY}\n` }));
    expect(creds.apiKey).toBe(DG_KEY);
    expect(JSON.stringify(creds)).not.toContain(DG_KEY);
    expect(inspect(creds)).not.toContain(DG_KEY);
  });

  it("fails with a fixed code when the main file has no key", () => {
    expect(() => loadDeepgramCredentials(env, files({ [MAIN]: azureFile() }))).toThrow(DeepgramCredentialError);
    expect(deepgramCredentialsStatus(env, files({ [MAIN]: azureFile() }))).toEqual({ available: false, code: "missing_deepgram_key" });
  });

  it("refuses a main file that is too open", () => {
    const fs = files({ [MAIN]: `DEEPGRAM_API_KEY=${DG_KEY}\n` }, { [MAIN]: 0o644 });
    expect(deepgramCredentialsStatus(env, fs)).toEqual({ available: false, code: "env_file_permissions_too_open" });
  });
});
