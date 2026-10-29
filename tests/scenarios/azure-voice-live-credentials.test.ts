import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { ConnectorFs } from "../../src/connectors/credentials.js";
import {
  loadAzureVoiceLiveCredentials,
  VOICE_LIVE_API_VERSION,
  voiceLiveResourceUrl,
  voiceLiveSocketUrl,
  voiceLiveUnavailableReason,
} from "../../src/server/voice/azure-voice-live-credentials.js";
import { isVoiceErrorCode } from "../../src/server/voice/voice-errors.js";

const KEY = "VOICELIVESECRET123";
const URL_OK = "https://example-voice-live.services.ai.azure.com";
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

const voiceLiveFile = (url = URL_OK, extra = "") => `AZURE_VOICE_LIVE_URL=${url}\nAZURE_VOICE_LIVE_KEY=${KEY}\n${extra}`;

/** The fixed code the loader throws, checked to carry no key and no path. */
function codeOf(env: Record<string, string>, fs: ConnectorFs): string {
  try {
    loadAzureVoiceLiveCredentials(env, fs);
  } catch (err) {
    const message = (err as Error).message;
    expect(message).toMatch(/^azure_voice_live_[a-z_]+$/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(MAIN);
    return message;
  }
  return "no error";
}

const urlCode = (url: string) => codeOf(ENV, files({ [MAIN]: voiceLiveFile(url) }));

describe("loadAzureVoiceLiveCredentials", () => {
  it("returns the resource origin and the key from the settings file", () => {
    const creds = loadAzureVoiceLiveCredentials(ENV, files({ [MAIN]: voiceLiveFile() }));
    expect(creds.resourceUrl).toBe(URL_OK);
    expect(creds.apiKey).toBe(KEY);
    // The same dotenv rules as every other loader: an export prefix and quotes are read.
    const quoted = loadAzureVoiceLiveCredentials(ENV, files({ [MAIN]: `export AZURE_VOICE_LIVE_URL="${URL_OK}/"\nAZURE_VOICE_LIVE_KEY='${KEY}'\n` }));
    expect(quoted.resourceUrl).toBe(URL_OK);
    expect(quoted.apiKey).toBe(KEY);
  });

  it("holds the key as a non-enumerable property of a frozen object", () => {
    const creds = loadAzureVoiceLiveCredentials(ENV, files({ [MAIN]: voiceLiveFile() }));
    expect(JSON.stringify(creds)).not.toContain(KEY);
    expect(inspect(creds)).not.toContain(KEY);
    expect(Object.keys(creds)).toEqual(["resourceUrl"]);
    expect({ ...creds }).not.toHaveProperty("apiKey");
    expect(Object.isFrozen(creds)).toBe(true);
  });

  it("reads only its two names: other names in the file are not returned, and the gpt-live names are no fallback", () => {
    const creds = loadAzureVoiceLiveCredentials(
      ENV,
      files({ [MAIN]: voiceLiveFile(URL_OK, "AZURE_FOUNDRY_URL=https://other.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=other-key\nAZURE_VOICE_LIVE_MODEL=gpt-realtime\n") }),
    );
    expect(Object.getOwnPropertyNames(creds)).toEqual(["resourceUrl", "apiKey"]);
    expect(inspect(creds, { showHidden: true })).not.toContain("other-key");
    expect(codeOf(ENV, files({ [MAIN]: "AZURE_FOUNDRY_URL=https://other.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=other-key\n" }))).toBe("azure_voice_live_missing_url");
  });

  it("fails with fixed codes for the settings file: not configured, readable by others, unreadable", () => {
    expect(codeOf({}, files({}))).toBe("azure_voice_live_env_file_not_configured");
    expect(codeOf({ VOICE_HARNESS_DEV_ENV_FILE: "" }, files({}))).toBe("azure_voice_live_env_file_not_configured");
    expect(codeOf(ENV, files({ [MAIN]: voiceLiveFile() }, { [MAIN]: 0o644 }))).toBe("azure_voice_live_env_file_permissions_too_open");
    expect(codeOf(ENV, files({ [MAIN]: voiceLiveFile() }, { [MAIN]: 0o640 }))).toBe("azure_voice_live_env_file_permissions_too_open");
    expect(codeOf(ENV, files({}))).toBe("azure_voice_live_env_file_unreadable");
    expect(codeOf(ENV, { mode: () => 0o600, read: () => { throw new Error(`${MAIN} ${KEY}`); } })).toBe("azure_voice_live_env_file_unreadable");
  });

  it("fails with fixed codes for a missing address or key", () => {
    expect(codeOf(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_KEY=${KEY}\n` }))).toBe("azure_voice_live_missing_url");
    expect(codeOf(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_URL=${URL_OK}\n` }))).toBe("azure_voice_live_missing_key");
    expect(codeOf(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_URL=${URL_OK}\nAZURE_VOICE_LIVE_KEY=\n` }))).toBe("azure_voice_live_missing_key");
  });
});

describe("the Voice Live address rules", () => {
  it("accepts an https Foundry or Cognitive Services resource address, with no path, and keeps only its origin", () => {
    expect(loadAzureVoiceLiveCredentials(ENV, files({ [MAIN]: voiceLiveFile("https://name.services.ai.azure.com") })).resourceUrl).toBe("https://name.services.ai.azure.com");
    expect(loadAzureVoiceLiveCredentials(ENV, files({ [MAIN]: voiceLiveFile("https://name.cognitiveservices.azure.com/") })).resourceUrl).toBe("https://name.cognitiveservices.azure.com");
    expect(voiceLiveResourceUrl("https://Name-2.Services.AI.Azure.com")).toBe("https://name-2.services.ai.azure.com");
  });

  it.each([
    ["the resource's OpenAI address", "https://name.openai.azure.com"],
    ["another host", "https://evil.example.com"],
    ["a look-alike host", "https://name.services.ai.azure.com.evil.com"],
    ["a host with two labels before the Azure domain", "https://a.b.services.ai.azure.com"],
    ["the bare Azure domain", "https://services.ai.azure.com"],
    ["a path", "https://name.services.ai.azure.com/voice-live/realtime"],
    ["a port", "https://name.services.ai.azure.com:8443"],
    ["a query", "https://name.services.ai.azure.com/?api-version=2026-04-10"],
    ["a fragment", "https://name.services.ai.azure.com/#x"],
    ["a user name", "https://user:pass@name.services.ai.azure.com"],
    ["http", "http://name.services.ai.azure.com"],
    ["a secure websocket address", "wss://name.services.ai.azure.com"],
    ["text that is not a URL", "not a url"],
  ])("refuses %s as azure_voice_live_url_invalid", (_what, url) => {
    expect(urlCode(url)).toBe("azure_voice_live_url_invalid");
    expect(() => voiceLiveResourceUrl(url)).toThrow(/^azure_voice_live_url_invalid$/);
  });
});

describe("voiceLiveSocketUrl", () => {
  it("builds the secure websocket address of one session, with the model chosen at connect time", () => {
    expect(VOICE_LIVE_API_VERSION).toBe("2026-04-10");
    expect(voiceLiveSocketUrl(URL_OK, "gpt-realtime")).toBe(
      "wss://example-voice-live.services.ai.azure.com/voice-live/realtime?api-version=2026-04-10&model=gpt-realtime",
    );
    expect(voiceLiveSocketUrl("https://name.cognitiveservices.azure.com", "gpt-4.1-mini")).toBe(
      "wss://name.cognitiveservices.azure.com/voice-live/realtime?api-version=2026-04-10&model=gpt-4.1-mini",
    );
    // The model is encoded: it can never add a query parameter or a path.
    expect(voiceLiveSocketUrl(URL_OK, "gpt realtime&api-version=1/x")).toBe(
      "wss://example-voice-live.services.ai.azure.com/voice-live/realtime?api-version=2026-04-10&model=gpt%20realtime%26api-version%3D1%2Fx",
    );
  });
});

describe("voiceLiveUnavailableReason", () => {
  it("is undefined when the settings load, and the fixed code otherwise, never a value", () => {
    expect(voiceLiveUnavailableReason(ENV, files({ [MAIN]: voiceLiveFile() }))).toBeUndefined();
    const reasons = [
      voiceLiveUnavailableReason({}, files({})),
      voiceLiveUnavailableReason(ENV, files({ [MAIN]: voiceLiveFile() }, { [MAIN]: 0o644 })),
      voiceLiveUnavailableReason(ENV, files({})),
      voiceLiveUnavailableReason(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_KEY=${KEY}\n` })),
      voiceLiveUnavailableReason(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_URL=${URL_OK}\n` })),
      voiceLiveUnavailableReason(ENV, files({ [MAIN]: voiceLiveFile("https://name.openai.azure.com") })),
    ];
    expect(reasons).toEqual([
      "azure_voice_live_env_file_not_configured",
      "azure_voice_live_env_file_permissions_too_open",
      "azure_voice_live_env_file_unreadable",
      "azure_voice_live_missing_url",
      "azure_voice_live_missing_key",
      "azure_voice_live_url_invalid",
    ]);
    for (const r of reasons) {
      expect(r).not.toContain(KEY);
      expect(r).not.toContain("example-voice-live");
    }
  });

  it("never throws, even when the file system throws something that is not an Error", () => {
    const odd: ConnectorFs = { mode: () => { throw "not an Error"; }, read: () => "" };
    expect(voiceLiveUnavailableReason(ENV, odd)).toBe("azure_voice_live_env_file_unreadable");
  });
});

describe("the codes and the voice error catalog", () => {
  it("every code the loader throws is a key of the voice error catalog", () => {
    const codes = new Set([
      codeOf({}, files({})),
      codeOf(ENV, files({ [MAIN]: voiceLiveFile() }, { [MAIN]: 0o644 })),
      codeOf(ENV, files({})),
      codeOf(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_KEY=${KEY}\n` })),
      codeOf(ENV, files({ [MAIN]: `AZURE_VOICE_LIVE_URL=${URL_OK}\n` })),
      urlCode("https://name.openai.azure.com"),
    ]);
    expect([...codes].sort()).toEqual([
      "azure_voice_live_env_file_not_configured",
      "azure_voice_live_env_file_permissions_too_open",
      "azure_voice_live_env_file_unreadable",
      "azure_voice_live_missing_key",
      "azure_voice_live_missing_url",
      "azure_voice_live_url_invalid",
    ]);
    for (const code of codes) expect(isVoiceErrorCode(code), code).toBe(true);
  });
});
