/**
 * The JSON client the offline judge scripts build, from the single credential
 * loader: the Vercel AI Gateway for "provider/model" ids, plus Azure AI Foundry
 * when its credentials are available. Throws `gateway_key_missing` when there is
 * no Gateway key; the message a script shows names the variables, never a value.
 */

import {
  azureCredentialsStatus,
  gatewayCredentialsStatus,
  loadAzureCredentials,
  loadGatewayCredentials,
  type ConnectorEnv,
  type ConnectorFs,
} from "../../connectors/credentials.js";
import { createJsonModelClient, type JsonModelClient } from "../../connectors/json-client.js";
import { createFoundryClient, foundryConfigFromCredentials } from "../../models/foundry.js";

export const GATEWAY_KEY_MISSING_MESSAGE =
  "The Gateway connector could not be set up. Set AI_GATEWAY_API_KEY in the file named by VOICE_HARNESS_DEV_ENV_FILE, and keep that file readable by you only (mode 600). Nothing was read or sent. Reason code:";

export function buildJudgeJsonClient(env?: ConnectorEnv, fs?: ConnectorFs, fetchImpl?: typeof fetch): JsonModelClient {
  if (!gatewayCredentialsStatus(env, fs).available) throw new Error("gateway_key_missing");
  const gateway = { apiKey: loadGatewayCredentials(env, fs).apiKey, fetch: fetchImpl };
  const azure = azureCredentialsStatus(env, fs).available
    ? createFoundryClient(foundryConfigFromCredentials(loadAzureCredentials(env, fs)), { fetch: fetchImpl })
    : undefined;
  return createJsonModelClient({ gateway, azure });
}
