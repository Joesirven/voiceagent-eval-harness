/**
 * The one place the harness reads connector secrets from disk.
 *
 * The file is the dotenv named by VOICE_HARNESS_DEV_ENV_FILE. It must be mode 0600
 * or tighter, or every loader refuses with `env_file_permissions_too_open`.
 * One parser and one permission check serve both connectors:
 *
 *   - Azure AI Foundry: AZURE_FOUNDRY_URL, AZURE_FOUNDRY_KEY,
 *     AZURE_FOUNDRY_DECISION_URL and the AZURE_*_DEPLOYMENT names.
 *   - Vercel AI Gateway: AI_GATEWAY_API_KEY.
 *   - Deepgram (speech to text and text to speech, a direct vendor route that
 *     Pat allowed as an exception to the Azure-only rule on 2026-10-19):
 *     DEEPGRAM_API_KEY.
 *
 * Backward compatibility only: the Gateway key and the other decision
 * credentials (OPENAI_API_KEY, TYPESAFE_API_KEY, KEV_BASE_URL, KEV_API_KEY)
 * can fall back to the file named by DECISION_MODELS_ENV_FILE. That file may
 * be absent. No Anthropic key is read anywhere. DEEPGRAM_API_KEY comes only
 * from the main harness settings file.
 *
 * Secrets are non-enumerable properties, so printing or serializing a result
 * never shows them. Errors are `ConnectorCredentialError` with a code from a
 * closed list, never a value, a path or a line of the file.
 *
 * Node reads the files; any other process (the Pipecat sidecars) receives the
 * values from Node in its spawn environment and never opens a file itself.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ConnectorCredentialErrorCode =
  | "env_file_not_configured"
  | "env_file_permissions_too_open"
  | "env_file_unreadable"
  | "missing_azure_url"
  | "missing_azure_key"
  | "url_invalid"
  | "url_not_azure"
  | "missing_gateway_key";

export class ConnectorCredentialError extends Error {
  readonly code: ConnectorCredentialErrorCode;

  constructor(code: ConnectorCredentialErrorCode) {
    super(code);
    this.name = "ConnectorCredentialError";
    this.code = code;
  }
}

export interface ConnectorFs {
  mode(path: string): number;
  read(path: string): string;
}

export type ConnectorEnv = Record<string, string | undefined>;

const nodeFs: ConnectorFs = {
  mode: (path) => statSync(path).mode,
  read: (path) => readFileSync(path, "utf8"),
};

/* ------------------------------------------------------- the one reader */

const AZURE_NAMES = [
  "AZURE_FOUNDRY_URL",
  "AZURE_FOUNDRY_KEY",
  "AZURE_FOUNDRY_DECISION_URL",
  "AZURE_FAST_DEPLOYMENT",
  "AZURE_LONG_DEPLOYMENT",
  "AZURE_REPLY_DEPLOYMENT",
  "AZURE_DECISION_DEPLOYMENT",
  "AZURE_JUDGE_DEPLOYMENT",
  "AZURE_TRANSCRIBE_DEPLOYMENT",
  "AZURE_REALTIME_DEPLOYMENT",
] as const;

/** Names that may also come from the decision-models file. */
export const DECISION_FALLBACK_NAMES = [
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "TYPESAFE_API_KEY",
  "KEV_BASE_URL",
  "KEV_API_KEY",
] as const;

function parseDotenv(text: string, wanted: ReadonlySet<string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    if (!wanted.has(name)) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (value) found[name] = value;
  }
  return found;
}

/** Reads one file under the permission rule. Throws only a fixed code. */
function readSecretFile(path: string, fs: ConnectorFs, wanted: ReadonlySet<string>): Record<string, string> {
  let text: string;
  try {
    // A file other users can read is not a secret store.
    if ((fs.mode(path) & 0o077) !== 0) throw new ConnectorCredentialError("env_file_permissions_too_open");
    text = fs.read(path);
  } catch (err) {
    if (err instanceof ConnectorCredentialError) throw err;
    throw new ConnectorCredentialError("env_file_unreadable");
  }
  return parseDotenv(text, new Set(wanted));
}

export function decisionModelsFilePath(env: ConnectorEnv = process.env): string {
  return env.DECISION_MODELS_ENV_FILE || join(homedir(), ".config", "voiceagent-eval-harness", "decision-models.env");
}

export interface ReadOptions {
  /** When false, a main file that is not configured yields no values instead of an error. Default true. */
  requireMainFile?: boolean;
  /** When true, a configured main file that is missing, unreadable or too open also yields no values (never its contents). Default false. */
  ignoreMainFileErrors?: boolean;
  /** Read the decision-models file for fallback names the main file lacks. Default false. */
  decisionFallback?: boolean;
}

/**
 * The requested names that have a non-empty value. The only function in the
 * harness that reads secrets from disk; every loader below goes through it.
 */
export function readConnectorValues(
  names: readonly string[],
  env: ConnectorEnv = process.env,
  fs: ConnectorFs = nodeFs,
  options: ReadOptions = {},
): Record<string, string> {
  const wanted = new Set(names);
  const values: Record<string, string> = {};
  const mainPath = env.VOICE_HARNESS_DEV_ENV_FILE;
  if (mainPath) {
    try {
      Object.assign(values, readSecretFile(mainPath, fs, wanted));
    } catch (err) {
      if (!options.ignoreMainFileErrors) throw err;
    }
  } else if (options.requireMainFile !== false) {
    throw new ConnectorCredentialError("env_file_not_configured");
  }
  if (options.decisionFallback) {
    // Always checked when it exists, so a file that is too open is refused even
    // when the main file already holds every name.
    const fallbackWanted = new Set(names.filter((n) => (DECISION_FALLBACK_NAMES as readonly string[]).includes(n)));
    if (fallbackWanted.size > 0) {
      const path = decisionModelsFilePath(env);
      let present = true;
      try {
        fs.mode(path);
      } catch {
        present = false; // The fallback file is optional.
      }
      if (present) {
        for (const [name, value] of Object.entries(readSecretFile(path, fs, fallbackWanted))) values[name] ??= value;
      }
    }
  }
  return values;
}

/** Defines `secrets` on `target` as non-enumerable, read-only properties. */
function hideSecrets<T extends object>(target: T, secrets: Record<string, string | undefined>): T {
  for (const [name, value] of Object.entries(secrets)) {
    if (value !== undefined) Object.defineProperty(target, name, { value, enumerable: false, writable: false });
  }
  return Object.freeze(target);
}

/* -------------------------------------------------------------- Azure */

/** Foundry resources live on these Azure hosts; anything else is refused. */
const FOUNDRY_HOST = /^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/;

/** Checks an https Azure URL and returns it without a trailing slash. Throws `url_invalid` or `url_not_azure`. */
export function normalizeAzureUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorCredentialError("url_invalid");
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new ConnectorCredentialError("url_invalid");
  }
  if (!FOUNDRY_HOST.test(url.hostname.toLowerCase())) throw new ConnectorCredentialError("url_not_azure");
  return `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}

export interface AzureCredentials {
  /** The Foundry resource route, ending in /openai/v1, with no trailing slash. */
  readonly foundryUrl: string;
  /** Where typed decision questions go; the resource origin + /providers/microsoft/v1/systemone unless AZURE_FOUNDRY_DECISION_URL says otherwise. */
  readonly decisionUrl: string;
  /** Non-enumerable: never printed, logged or serialized. */
  readonly apiKey: string;
  readonly fastDeployment: string | undefined;
  readonly longDeployment: string | undefined;
  readonly replyDeployment: string | undefined;
  readonly decisionDeployment: string | undefined;
  readonly judgeDeployment: string | undefined;
  readonly transcribeDeployment: string | undefined;
  readonly realtimeDeployment: string | undefined;
}

export function loadAzureCredentials(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): AzureCredentials {
  const v = readConnectorValues(AZURE_NAMES, env, fs);
  if (!v.AZURE_FOUNDRY_URL) throw new ConnectorCredentialError("missing_azure_url");
  if (!v.AZURE_FOUNDRY_KEY) throw new ConnectorCredentialError("missing_azure_key");
  const foundryUrl = normalizeAzureUrl(v.AZURE_FOUNDRY_URL);
  // A whole path segment match: "/xopenai/v1" is refused.
  if (!/(^|\/)openai\/v1$/.test(new URL(foundryUrl).pathname)) throw new ConnectorCredentialError("url_invalid");
  const decisionUrl = v.AZURE_FOUNDRY_DECISION_URL
    ? normalizeAzureUrl(v.AZURE_FOUNDRY_DECISION_URL)
    : `${new URL(foundryUrl).origin}/providers/microsoft/v1/systemone`;
  const result = {
    foundryUrl,
    decisionUrl,
    fastDeployment: v.AZURE_FAST_DEPLOYMENT,
    longDeployment: v.AZURE_LONG_DEPLOYMENT,
    replyDeployment: v.AZURE_REPLY_DEPLOYMENT,
    decisionDeployment: v.AZURE_DECISION_DEPLOYMENT,
    judgeDeployment: v.AZURE_JUDGE_DEPLOYMENT,
    transcribeDeployment: v.AZURE_TRANSCRIBE_DEPLOYMENT,
    realtimeDeployment: v.AZURE_REALTIME_DEPLOYMENT,
  } as AzureCredentials;
  return hideSecrets(result, { apiKey: v.AZURE_FOUNDRY_KEY });
}

export type AzureCredentialsStatus = { available: true } | { available: false; code: ConnectorCredentialErrorCode };

/** Whether `loadAzureCredentials` would succeed. Never throws, never returns a value. */
export function azureCredentialsStatus(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): AzureCredentialsStatus {
  try {
    loadAzureCredentials(env, fs);
    return { available: true };
  } catch (err) {
    return { available: false, code: err instanceof ConnectorCredentialError ? err.code : "env_file_unreadable" };
  }
}

/* ------------------------------------------------------------ Gateway */

export interface GatewayCredentials {
  /** Non-enumerable: never printed, logged or serialized. */
  readonly apiKey: string;
}

/** The Vercel AI Gateway key, from the main file or else the decision-models file. */
export function loadGatewayCredentials(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): GatewayCredentials {
  const v = readConnectorValues(["AI_GATEWAY_API_KEY"], env, fs, { requireMainFile: false, decisionFallback: true });
  if (!v.AI_GATEWAY_API_KEY) throw new ConnectorCredentialError("missing_gateway_key");
  return hideSecrets({} as GatewayCredentials, { apiKey: v.AI_GATEWAY_API_KEY });
}

export type GatewayCredentialsStatus = { available: true } | { available: false; code: ConnectorCredentialErrorCode };

export function gatewayCredentialsStatus(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): GatewayCredentialsStatus {
  try {
    loadGatewayCredentials(env, fs);
    return { available: true };
  } catch (err) {
    return { available: false, code: err instanceof ConnectorCredentialError ? err.code : "env_file_unreadable" };
  }
}

/* --------------------------------------------- decision credentials set */

export const DECISION_CREDENTIAL_NAMES = DECISION_FALLBACK_NAMES;
export type DecisionCredentialName = (typeof DECISION_CREDENTIAL_NAMES)[number];

/**
 * Every decision credential present, from the main file first and the
 * decision-models file after. Neither file is required: a main file that is
 * missing, unreadable or too open is skipped here (the decision-models file
 * is still checked and still refuses when too open). Secrets are
 * non-enumerable; the Kev base URL is not a secret and stays visible.
 */
export function loadDecisionCredentialValues(
  env: ConnectorEnv = process.env,
  fs: ConnectorFs = nodeFs,
): Partial<Record<DecisionCredentialName, string>> {
  const v = readConnectorValues(DECISION_CREDENTIAL_NAMES, env, fs, {
    requireMainFile: false,
    ignoreMainFileErrors: true,
    decisionFallback: true,
  });
  const { KEV_BASE_URL, ...secrets } = v;
  const out: Partial<Record<DecisionCredentialName, string>> = KEV_BASE_URL ? { KEV_BASE_URL } : {};
  return hideSecrets(out, secrets);
}

/* ----------------------------------------------------------- Deepgram */

export type DeepgramCredentialErrorCode =
  | "env_file_not_configured"
  | "env_file_permissions_too_open"
  | "env_file_unreadable"
  | "missing_deepgram_key";

/** Its own error class so the closed Azure code list above does not grow. */
export class DeepgramCredentialError extends Error {
  readonly code: DeepgramCredentialErrorCode;

  constructor(code: DeepgramCredentialErrorCode) {
    super(code);
    this.name = "DeepgramCredentialError";
    this.code = code;
  }
}

export interface DeepgramCredentials {
  /** Non-enumerable: never printed, logged or serialized. */
  readonly apiKey: string;
}

/**
 * The Deepgram key from the main harness settings file.
 */
export function loadDeepgramCredentials(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): DeepgramCredentials {
  let values: Record<string, string>;
  try {
    values = readConnectorValues(["DEEPGRAM_API_KEY"], env, fs, {
      requireMainFile: true,
    });
  } catch (err) {
    if (err instanceof ConnectorCredentialError && (err.code === "env_file_permissions_too_open" || err.code === "env_file_unreadable")) {
      throw new DeepgramCredentialError(err.code);
    }
    throw new DeepgramCredentialError("env_file_unreadable");
  }
  if (!values.DEEPGRAM_API_KEY) throw new DeepgramCredentialError("missing_deepgram_key");
  return hideSecrets({} as DeepgramCredentials, { apiKey: values.DEEPGRAM_API_KEY });
}

export type DeepgramCredentialsStatus = { available: true } | { available: false; code: DeepgramCredentialErrorCode };

/** Whether `loadDeepgramCredentials` would succeed. Never throws, never returns a value. */
export function deepgramCredentialsStatus(env: ConnectorEnv = process.env, fs: ConnectorFs = nodeFs): DeepgramCredentialsStatus {
  try {
    loadDeepgramCredentials(env, fs);
    return { available: true };
  } catch (err) {
    return { available: false, code: err instanceof DeepgramCredentialError ? err.code : "env_file_unreadable" };
  }
}
