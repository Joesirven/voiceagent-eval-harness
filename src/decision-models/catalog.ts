/**
 * Every decision model adapter in one list. `get` returns the real model when
 * its credential is present and the mock otherwise, and says which one it
 * handed out, so a run on mocks is never mistaken for a run on Jev.
 *
 * Without `credentials` the catalog reads them through the one credential
 * loader (../connectors/credentials.ts), which may throw its permission error;
 * tests always pass credentials in. Azure credentials are read the same way,
 * and a missing or unusable Azure setup just leaves "azure-decision" on its mock.
 */

import { loadAzureCredentials, type AzureCredentials, type ConnectorFs } from "../connectors/credentials.js";
import { createFoundryClient, foundryConfigFromCredentials, type FoundryClient } from "../models/foundry.js";
import type { Clock } from "../types/clock.js";
import { AzureDecisionModel } from "./azure.js";
import { OpenAiDecisionModel } from "./openai-decisions.js";
import { loadDecisionCredentials, type DecisionCredentials } from "./credentials.js";
import { GatewayDecisionModel, JEV_GATEWAY_MODEL, OTHER_GATEWAY_MODELS, gatewayAdapterId } from "./gateway.js";
import type { FetchLike } from "./http.js";
import {
  createAzureDecisionMock,
  createGatewayMock,
  createJevDirectMock,
  createJevMock,
  createKevMock,
  createOpenAiDecisionsMock,
} from "./mocks.js";
import { createJevDirect, createKev, isAllowedBaseUrl } from "./system-one.js";
import type { DecisionModel } from "./types.js";

export const defaultDecisionModelId = "jev";

export interface DecisionModelCatalogOptions {
  credentials?: DecisionCredentials;
  /**
   * Azure credentials for "azure-decision". `null` means none. When omitted, they
   * are loaded from the dev env file, unless `credentials` was passed (then none,
   * so a test that passes credentials never reads a file).
   */
  azure?: AzureCredentials | null;
  /** A Foundry client to use instead of one built from the Azure credentials. */
  foundry?: FoundryClient;
  /** The chat deployment to use when the dotenv names no decision or fast deployment. The dotenv wins. */
  defaultChatDeployment?: string;
  fetch?: FetchLike;
  clock?: Clock;
  /** Environment and file system used to read credentials when none are passed; for tests. */
  env?: Record<string, string | undefined>;
  fs?: ConnectorFs;
}

export interface CatalogEntry {
  id: string;
  label: string;
  /** What `get` hands out right now: "real" with a credential, "mock" without. */
  kind: "real" | "mock";
  configured: boolean;
}

export interface CatalogLookup {
  model: DecisionModel;
  /** True when the real adapter was asked for and its credential is missing. */
  fellBackToMock: boolean;
  /** Why the mock was used, as a short code. */
  reason?: "no_credential" | "base_url_refused";
}

export interface DecisionModelCatalog {
  list(): CatalogEntry[];
  /** Undefined for an id nothing answers to. A "<id>-mock" id always returns the mock. */
  get(id: string): CatalogLookup | undefined;
  readonly defaultId: string;
}

interface Adapter {
  id: string;
  mock: () => DecisionModel;
  real: () => DecisionModel;
  /** Null when usable, otherwise why not. */
  unusable: () => CatalogLookup["reason"] | null;
}

function tryLoadAzure(env?: Record<string, string | undefined>, fs?: ConnectorFs): AzureCredentials | null {
  try {
    return loadAzureCredentials(env, fs);
  } catch {
    return null;
  }
}

export function createDecisionModelCatalog(options: DecisionModelCatalogOptions = {}): DecisionModelCatalog {
  const credentials = options.credentials ?? loadDecisionCredentials(options.env, options.fs);
  const { fetch: fetchImpl, clock } = options;
  const gatewayKey = credentials.AI_GATEWAY_API_KEY;
  const azure = options.azure !== undefined ? options.azure : options.credentials ? null : tryLoadAzure(options.env, options.fs);
  const azureDeployments = {
    decision: azure?.decisionDeployment,
    fast: azure?.fastDeployment ?? (azure && !azure.decisionDeployment ? options.defaultChatDeployment : undefined),
  };

  const gateway = (modelId: string): Adapter => ({
    id: gatewayAdapterId(modelId),
    mock: () => createGatewayMock(modelId),
    real: () => new GatewayDecisionModel(modelId, gatewayKey, fetchImpl, clock),
    unusable: () => (gatewayKey ? null : "no_credential"),
  });

  const adapters: Adapter[] = [
    gateway(JEV_GATEWAY_MODEL),
    {
      id: "jev-direct",
      mock: createJevDirectMock,
      real: () => createJevDirect(credentials.TYPESAFE_API_KEY, fetchImpl, clock),
      unusable: () => (credentials.TYPESAFE_API_KEY ? null : "no_credential"),
    },
    {
      id: "openai-decisions",
      mock: createOpenAiDecisionsMock,
      real: () => new OpenAiDecisionModel(credentials.OPENAI_API_KEY, fetchImpl, clock),
      unusable: () => (credentials.OPENAI_API_KEY ? null : "no_credential"),
    },
    {
      id: "kev",
      mock: createKevMock,
      real: () => createKev(credentials.KEV_BASE_URL, credentials.KEV_API_KEY, fetchImpl, clock),
      unusable: () =>
        !credentials.KEV_BASE_URL ? "no_credential" : isAllowedBaseUrl(credentials.KEV_BASE_URL) ? null : "base_url_refused",
    },
    {
      id: "azure-decision",
      mock: createAzureDecisionMock,
      real: () =>
        new AzureDecisionModel(
          options.foundry ?? (azure ? createFoundryClient(foundryConfigFromCredentials(azure), { fetch: fetchImpl }) : undefined),
          azureDeployments,
          clock,
        ),
      unusable: () => ((azure || options.foundry) && (azureDeployments.decision || azureDeployments.fast) ? null : "no_credential"),
    },
    ...OTHER_GATEWAY_MODELS.map(gateway),
  ];

  const find = (id: string): Adapter | undefined => {
    const known = adapters.find((a) => a.id === id);
    if (known) return known;
    // Any other "<provider>/<model>" under the Gateway prefix works without a code change.
    return id.startsWith("gateway:") && id.slice("gateway:".length).includes("/") ? gateway(id.slice("gateway:".length)) : undefined;
  };

  return {
    defaultId: defaultDecisionModelId,
    list() {
      return adapters.map((adapter) => {
        const configured = adapter.unusable() === null;
        const model = configured ? adapter.real() : adapter.mock();
        return { id: adapter.id, label: model.label, kind: model.kind, configured };
      });
    },
    get(id) {
      if (id.endsWith("-mock")) {
        const adapter = find(id.slice(0, -"-mock".length));
        return adapter ? { model: adapter.mock(), fellBackToMock: false } : undefined;
      }
      const adapter = find(id);
      if (!adapter) return undefined;
      const why = adapter.unusable();
      return why === null
        ? { model: adapter.real(), fellBackToMock: false }
        : { model: adapter.mock(), fellBackToMock: true, reason: why };
    },
  };
}

