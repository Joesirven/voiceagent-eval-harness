/**
 * Named-key reads from the dotenv file at VOICE_HARNESS_DEV_ENV_FILE, for the test
 * phone and the Vapi test call. A thin wrapper: the only code that reads
 * secrets from disk is readConnectorValues in src/connectors/credentials.ts.
 * Values are never logged. The old error codes are kept.
 */

import { ConnectorCredentialError, readConnectorValues, type ConnectorFs } from "../../connectors/credentials.js";

export type DevEnvFs = ConnectorFs;

const OLD_CODES: Record<string, string> = {
  env_file_not_configured: "dev_env_file_not_configured",
  env_file_permissions_too_open: "dev_env_file_permissions_too_open",
  env_file_unreadable: "dev_env_file_unreadable",
};

function read(names: readonly string[], env: Record<string, string | undefined>, fs?: DevEnvFs): Record<string, string> {
  try {
    return readConnectorValues(names, env, fs);
  } catch (err) {
    const code = err instanceof ConnectorCredentialError ? err.code : "env_file_unreadable";
    throw new Error(OLD_CODES[code] ?? "dev_env_file_unreadable");
  }
}

/** Throws the old codes when the file is not configured, too open or unreadable. */
export function readDevEnvFile(env: Record<string, string | undefined> = process.env, fs?: DevEnvFs): { path: string } {
  read([], env, fs);
  return { path: env.VOICE_HARNESS_DEV_ENV_FILE as string };
}

/** Non-empty values for the requested keys only. An unconfigured file yields empty. */
export function peekDevEnvValues(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
  fs?: DevEnvFs,
): Partial<Record<string, string>> {
  if (!env.VOICE_HARNESS_DEV_ENV_FILE) return {};
  return read(names, env, fs);
}

export function readDevEnvValue(
  name: string,
  env: Record<string, string | undefined> = process.env,
  fs?: DevEnvFs,
): string | undefined {
  return peekDevEnvValues([name], env, fs)[name];
}
