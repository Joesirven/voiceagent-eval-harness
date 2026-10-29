/**
 * The Azure realtime endpoint and key for azure-gpt-live. Thin wrappers over
 * the one credential loader (src/connectors/credentials.ts), keeping this
 * module's own error codes. Nothing here is ever logged.
 */

import {
  ConnectorCredentialError,
  readConnectorValues,
  type ConnectorFs,
} from "../../connectors/credentials.js";

export interface AzureLiveCredentials {
  /** Secure websocket URL of the live sessions endpoint. */
  liveUrl: string;
  /** Sent only as the api-key header on that connection. */
  apiKey: string;
}

export type CredentialFs = ConnectorFs;

/** The resource URL ends in /openai/v1; the live endpoint is that plus /live/sessions over a secure websocket. */
export function liveUrlFrom(resourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    throw new Error("azure_live_url_invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") throw new Error("azure_live_url_not_secure");
  return `wss://${url.host}${url.pathname.replace(/\/+$/, "")}/live/sessions`;
}

export interface AzureModuleWiring {
  backend: "mock" | "live";
  missingEnv: string[];
}

/** Whether azure-gpt-live can open a browser relay (names only, never values). */
export function peekAzureModuleWiring(
  env: Record<string, string | undefined> = process.env,
  fs?: CredentialFs,
): AzureModuleWiring {
  let values: Record<string, string>;
  try {
    values = readConnectorValues(["AZURE_FOUNDRY_URL", "AZURE_FOUNDRY_KEY"], env, fs);
  } catch (err) {
    const code = err instanceof ConnectorCredentialError ? err.code : "env_file_unreadable";
    const file = code === "env_file_permissions_too_open" ? "VOICE_HARNESS_DEV_ENV_FILE (mode 600)" : "VOICE_HARNESS_DEV_ENV_FILE";
    return { backend: "mock", missingEnv: [file] };
  }
  const missing: string[] = [];
  if (!values.AZURE_FOUNDRY_URL?.trim()) missing.push("AZURE_FOUNDRY_URL");
  if (!values.AZURE_FOUNDRY_KEY?.trim()) missing.push("AZURE_FOUNDRY_KEY");
  return { backend: missing.length ? "mock" : "live", missingEnv: missing };
}

const LIVE_CODES = {
  env_file_not_configured: "azure_env_file_not_configured",
  env_file_permissions_too_open: "azure_env_file_permissions_too_open",
  env_file_unreadable: "azure_env_file_unreadable",
  missing_azure_url: "azure_settings_missing_url",
  missing_azure_key: "azure_settings_missing_key",
  url_invalid: "azure_live_url_invalid",
  url_not_azure: "azure_live_url_not_azure",
  missing_gateway_key: "azure_env_file_unreadable",
} as const;

/**
 * The live endpoint is deliberately lenient: it accepts any https or wss URL
 * on any host and path, as it always has. The strict Foundry rules (Azure
 * hosts only, /openai/v1 path) live in loadAzureCredentials. Both go through
 * the one disk reader and the one parser.
 */
export function loadAzureLiveCredentials(
  env: Record<string, string | undefined> = process.env,
  fs?: CredentialFs,
): AzureLiveCredentials {
  try {
    const v = readConnectorValues(["AZURE_FOUNDRY_URL", "AZURE_FOUNDRY_KEY"], env, fs);
    if (!v.AZURE_FOUNDRY_URL) throw new ConnectorCredentialError("missing_azure_url");
    if (!v.AZURE_FOUNDRY_KEY) throw new ConnectorCredentialError("missing_azure_key");
    return { liveUrl: liveUrlFrom(v.AZURE_FOUNDRY_URL), apiKey: v.AZURE_FOUNDRY_KEY };
  } catch (err) {
    if (err instanceof ConnectorCredentialError) throw new Error(LIVE_CODES[err.code]);
    throw err;
  }
}

/** The live deployment when the settings file names none: the module default. */
export const DEFAULT_LIVE_DEPLOYMENTS: readonly string[] = ["gpt-live-1"];

/**
 * The deployments the live voice session can use, from AZURE_REALTIME_DEPLOYMENT
 * in the settings file (one name, or several separated by commas). Only names
 * this resource has deployed and that speak the live protocol belong there:
 * Azure refuses a session start naming any other model. Never throws; an
 * unreadable or absent setting gives the default.
 */
export function liveDeployments(env: Record<string, string | undefined> = process.env, fs?: CredentialFs): string[] {
  let raw: string | undefined;
  try {
    raw = readConnectorValues(["AZURE_REALTIME_DEPLOYMENT"], env, fs, { requireMainFile: false, ignoreMainFileErrors: true }).AZURE_REALTIME_DEPLOYMENT;
  } catch {
    raw = undefined;
  }
  const names = (raw ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(n));
  return names.length ? [...new Set(names)] : [...DEFAULT_LIVE_DEPLOYMENTS];
}
