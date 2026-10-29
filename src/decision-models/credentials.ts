/**
 * Credentials for the decision models, read through the one credential loader
 * (src/connectors/credentials.ts). The main file is the dotenv named by
 * VOICE_HARNESS_DEV_ENV_FILE; for backward compatibility the names it lacks fall
 * back to the file named by DECISION_MODELS_ENV_FILE, defaulting to
 * ~/.config/voiceagent-eval-harness/decision-models.env.
 *
 * A missing file is not an error: every model then reports "off" and the
 * harness runs on the mocks. No Anthropic key is read; the offline judges
 * go through the Vercel AI Gateway key.
 */

import {
  DECISION_CREDENTIAL_NAMES,
  ConnectorCredentialError,
  decisionModelsFilePath,
  loadDecisionCredentialValues,
  type ConnectorFs,
} from "../connectors/credentials.js";

export const CREDENTIAL_NAMES = DECISION_CREDENTIAL_NAMES;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];
export type DecisionCredentials = Partial<Record<CredentialName, string>>;

export type CredentialFileSystem = ConnectorFs;

export function defaultCredentialPath(env: Record<string, string | undefined> = process.env): string {
  return decisionModelsFilePath(env);
}

/**
 * The credentials present. Throws `decision_models_env_file_permissions_too_open`
 * when another user can read a file and `decision_models_env_file_unreadable`
 * when one exists but cannot be read.
 */
export function loadDecisionCredentials(
  env: Record<string, string | undefined> = process.env,
  fs?: CredentialFileSystem,
): DecisionCredentials {
  try {
    return loadDecisionCredentialValues(env, fs);
  } catch (err) {
    if (err instanceof ConnectorCredentialError) {
      throw new Error(
        err.code === "env_file_permissions_too_open"
          ? "decision_models_env_file_permissions_too_open"
          : "decision_models_env_file_unreadable",
      );
    }
    throw err;
  }
}
