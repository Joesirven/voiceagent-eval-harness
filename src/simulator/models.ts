/**
 * The simulator's model route: Azure AI Foundry only . No
 * Vercel AI Gateway, no direct vendor client. A Gateway-style id ("provider/model")
 * is refused before anything is sent.
 *
 * Deployments per role, as confirmed by research note on 2026-10-20:
 *   - lead (the model-played lead), extractor and judge: gpt-5.6-terra, a
 *     different deployment from the agent's, so a grader never grades its own
 *     model's words. It had not answered a real call when this was written.
 *   - decision: gpt-5.6-luna (has answered real calls).
 *   - agent: the chosen setup's dialogue model (gpt-live-1 on the speech path).
 *
 * The Foundry JSON route sends no temperature or seed, so those are recorded as
 * null in the run's model settings rather than invented.
 */

import { azureCredentialsStatus, loadAzureCredentials, type ConnectorEnv, type ConnectorFs } from "../connectors/credentials.js";
import { createAzureJsonClient, JsonClientError, type JsonAsk, type JsonModelClient } from "../connectors/json-client.js";
import { createFoundryClient, foundryConfigFromCredentials } from "../models/foundry.js";

export type ModelRole = "agent" | "lead" | "decision" | "judge" | "extractor";

export const DEFAULT_DEPLOYMENTS: Readonly<Record<Exclude<ModelRole, "agent">, string>> = {
  lead: "gpt-5.6-terra",
  extractor: "gpt-5.6-terra",
  judge: "gpt-5.6-terra",
  decision: "gpt-5.6-luna",
};

/** One role's settings, in the shape of sim_run.model_settings. */
export interface RoleSettings {
  deployment: string;
  temperature: number | null;
  max_output_tokens: number | null;
  seed: string | null;
}

export type ModelSettings = Partial<Record<ModelRole, RoleSettings>>;

export function roleSettings(deployment: string, maxOutputTokens: number | null = null): RoleSettings {
  return { deployment, temperature: null, max_output_tokens: maxOutputTokens, seed: null };
}

/** An Azure deployment name: no "/", the shape Foundry accepts. */
export function assertAzureDeployment(model: string): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error("simulator_model_not_azure");
}

export interface RetryOptions {
  /** Attempts in all, the first included. Default 4. */
  attempts?: number;
  /** Wait before the second attempt; doubles each time. Default 2 seconds. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set(["json_client_rate_limited", "json_client_timeout"]);

/** Retries a rate-limited or timed-out ask with doubling waits; every other failure is thrown at once. */
export function withRetry(client: JsonModelClient, options: RetryOptions = {}): JsonModelClient & { retries: () => number } {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let retries = 0;
  return {
    retries: () => retries,
    async askJson<T>(ask: JsonAsk): Promise<T> {
      for (let i = 1; ; i += 1) {
        try {
          return await client.askJson<T>(ask);
        } catch (err) {
          const code = err instanceof JsonClientError ? err.code : "";
          if (!RETRYABLE.has(code) || i >= attempts) throw err;
          retries += 1;
          await sleep(base * 2 ** (i - 1));
        }
      }
    },
  };
}

/** The Azure-only JSON client. Throws `azure_credentials_missing:<code>` (a fixed code, never a value) when Foundry is not configured. */
export function buildAzureJsonClient(env?: ConnectorEnv, fs?: ConnectorFs, fetchImpl?: typeof fetch): JsonModelClient {
  const status = azureCredentialsStatus(env, fs);
  if (!status.available) throw new Error(`azure_credentials_missing:${status.code}`);
  const foundry = createFoundryClient(foundryConfigFromCredentials(loadAzureCredentials(env, fs)), { fetch: fetchImpl });
  const azure = createAzureJsonClient(foundry);
  return {
    askJson<T>(ask: JsonAsk): Promise<T> {
      assertAzureDeployment(ask.model);
      return azure.askJson<T>(ask);
    },
  };
}
