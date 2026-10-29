/**
 * Live test path switch: Vapi phone test vs Azure browser Talk. No silent fallback.
 */

import { logModuleChanges } from "./voice/settings-log.js";
import { getModuleRegistry } from "../modules/registry.js";
import { peekAzureModuleWiring } from "./voice/azure-credentials.js";
import {
  azureLiveDeployments,
  DEFAULT_AZURE_LIVE_DEPLOYMENT,
  isKnownAzureDeployment,
} from "./voice/azure-deployments.js";
import { loadAllowlistedTestPhone, peekTestPhoneConfigured } from "./voice/test-phone.js";
import {
  defaultVapiVariables,
  peekVapiWiring,
  placeVapiTestCall,
  type VapiCallVariables,
} from "./voice/vapi-test-call.js";

export type LiveTestPath = "vapi" | "azure";

let selectedPath: LiveTestPath = "azure";
let lastVapiSession: { callId: string; status: string; at: string } | undefined;

export function getLiveTestPath(): LiveTestPath {
  return selectedPath;
}

export function setLiveTestPath(path: LiveTestPath): void {
  if (path !== "vapi" && path !== "azure") throw new Error("bad_live_test_path");
  selectedPath = path;
}

export function assertAzureTalkPath(): void {
  if (selectedPath !== "azure") throw new Error("live_test_path_is_vapi_not_azure");
}

export function assertVapiCallPath(): void {
  if (selectedPath !== "vapi") throw new Error("live_test_path_is_azure_not_vapi");
}

export function liveTestSnapshot(env: Record<string, string | undefined> = process.env) {
  const azureWiring = peekAzureModuleWiring(env);
  const vapiWiring = peekVapiWiring(env);
  const registry = getModuleRegistry();
  const azureModule = registry.get("azure-gpt-live").getConfig();
  const testPhone = peekTestPhoneConfigured(env);
  return {
    path: selectedPath,
    azureDeployments: azureLiveDeployments(),
    selectedAzureDeployment: azureModule.model,
    azure: {
      ready: azureWiring.backend === "live",
      missingEnv: azureWiring.missingEnv,
      sessionKind: azureWiring.backend === "live" ? "real_call" : "blocked_setup",
    },
    vapi: {
      ready: vapiWiring.ready,
      missingEnv: vapiWiring.missingEnv,
      sessionKind: vapiWiring.ready ? "real_call" : "blocked_setup",
    },
    testPhoneConfigured: testPhone,
    lastVapiCall: lastVapiSession,
  };
}

export function setAzureLiveDeployment(name: string, source = "live-test"): void {
  if (!isKnownAzureDeployment(name)) throw new Error("azure_model_not_deployed");
  const before = getModuleRegistry().get("azure-gpt-live").getConfig();
  getModuleRegistry().update("azure-gpt-live", { model: name });
  logModuleChanges("azure-gpt-live", before, getModuleRegistry().get("azure-gpt-live").getConfig(), source);
  if (name !== DEFAULT_AZURE_LIVE_DEPLOYMENT) {
    getModuleRegistry().select("azure-gpt-live");
  }
}

export async function startVapiTestCall(
  firstName: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ callId: string; status: string }> {
  assertVapiCallPath();
  const wiring = peekVapiWiring(env);
  if (!wiring.ready) throw new Error(`vapi_setup_blocked:${wiring.missingEnv.join(",")}`);

  const phone = loadAllowlistedTestPhone(env);
  if (!phone) throw new Error("test_phone_not_configured");

  const variables: VapiCallVariables = defaultVapiVariables(firstName);
  const result = await placeVapiTestCall({ customerPhone: phone, variableValues: variables, env });
  lastVapiSession = { ...result, at: new Date().toISOString() };
  return result;
}

export function resetLiveTestState(): void {
  selectedPath = "azure";
  lastVapiSession = undefined;
}
