/**
 * The live deployments the live-test route offers: the same list as the
 * Settings model menu (the Azure catalog's live deployments, or the settings
 * names when Azure cannot be listed). It used to be a hardcoded list copied
 * from voice-harness that named two chat models as live.
 */

import { liveModelIds } from "../../modules/azure-catalog.js";

export interface AzureDeploymentOption {
  name: string;
  /** Where this name comes from. */
  source: string;
}

export function azureLiveDeployments(): AzureDeploymentOption[] {
  return liveModelIds().map((name) => ({ name, source: "Azure deployment listing (live deployments)" }));
}

export const DEFAULT_AZURE_LIVE_DEPLOYMENT = "gpt-live-1";

export function isKnownAzureDeployment(name: string): boolean {
  return liveModelIds().includes(name);
}
