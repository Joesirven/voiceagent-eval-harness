/**
 * The address and key of the Azure resource that runs Voice Live (Azure's
 * hosted speech agent API, /voice-live/realtime): AZURE_VOICE_LIVE_URL and
 * AZURE_VOICE_LIVE_KEY in the file named by VOICE_HARNESS_DEV_ENV_FILE. The same
 * rules as azure-credentials.ts: read through the one credential reader
 * (src/connectors/credentials.ts), refuse a file other users can read, keep no
 * other name, fail with fixed codes from the voice error catalog. This is the
 * only module allowed to use the Voice Live key.
 *
 * It is a different resource from AZURE_FOUNDRY_URL (the gpt-live resource,
 * whose openai.azure.com address cannot run Voice Live), so a failure here
 * never touches the Azure block that refuses new calls: it only makes the
 * Azure Voice Live path unavailable, with the code as the reason.
 */

import { ConnectorCredentialError, readConnectorValues, type ConnectorEnv, type ConnectorFs } from "../../connectors/credentials.js";

/** The Voice Live API version the harness speaks (probed on 2026-10-20). */
export const VOICE_LIVE_API_VERSION = "2026-04-10";

export interface AzureVoiceLiveCredentials {
  /** The resource origin, https, no path (for example https://name.services.ai.azure.com). */
  readonly resourceUrl: string;
  /** Non-enumerable: sent only as the api-key header on the Voice Live connection; never printed, logged or serialized. */
  readonly apiKey: string;
}

/** Voice Live runs on these resource hosts; an openai.azure.com address only offers the OpenAI routes. */
const VOICE_LIVE_HOST = /^[a-z0-9-]+\.(services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/;

const CODES = {
  env_file_not_configured: "azure_voice_live_env_file_not_configured",
  env_file_permissions_too_open: "azure_voice_live_env_file_permissions_too_open",
  env_file_unreadable: "azure_voice_live_env_file_unreadable",
} as const;

/** Checks the address and returns its origin. Throws azure_voice_live_url_invalid. */
export function voiceLiveResourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("azure_voice_live_url_invalid");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password || url.port) throw new Error("azure_voice_live_url_invalid");
  if (!/^\/*$/.test(url.pathname) || !VOICE_LIVE_HOST.test(host)) throw new Error("azure_voice_live_url_invalid");
  return `https://${host}`;
}

/** The secure websocket address of one Voice Live session; the model is chosen at connect time. */
export function voiceLiveSocketUrl(resourceUrl: string, model: string): string {
  const host = new URL(resourceUrl).host;
  return `wss://${host}/voice-live/realtime?api-version=${VOICE_LIVE_API_VERSION}&model=${encodeURIComponent(model)}`;
}

export function loadAzureVoiceLiveCredentials(env: ConnectorEnv = process.env, fs?: ConnectorFs): AzureVoiceLiveCredentials {
  let v: Record<string, string>;
  try {
    v = readConnectorValues(["AZURE_VOICE_LIVE_URL", "AZURE_VOICE_LIVE_KEY"], env, fs);
  } catch (err) {
    const code = err instanceof ConnectorCredentialError && err.code in CODES ? CODES[err.code as keyof typeof CODES] : CODES.env_file_unreadable;
    throw new Error(code);
  }
  if (!v.AZURE_VOICE_LIVE_URL) throw new Error("azure_voice_live_missing_url");
  if (!v.AZURE_VOICE_LIVE_KEY) throw new Error("azure_voice_live_missing_key");
  const result = { resourceUrl: voiceLiveResourceUrl(v.AZURE_VOICE_LIVE_URL) } as AzureVoiceLiveCredentials;
  Object.defineProperty(result, "apiKey", { value: v.AZURE_VOICE_LIVE_KEY, enumerable: false, writable: false });
  return Object.freeze(result);
}

/** Why the Azure Voice Live path cannot run now, as a fixed code, or undefined when it can. Never throws, never returns a value. */
export function voiceLiveUnavailableReason(env: ConnectorEnv = process.env, fs?: ConnectorFs): string | undefined {
  try {
    loadAzureVoiceLiveCredentials(env, fs);
    return undefined;
  } catch (err) {
    return err instanceof Error && /^azure_voice_live_[a-z_]+$/.test(err.message) ? err.message : CODES.env_file_unreadable;
  }
}
