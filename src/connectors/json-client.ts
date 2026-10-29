/**
 * One structured ask, answered as JSON, over either connector. The ask has the
 * same shape as `ClaudeJsonAsk` in src/judging/offline/claude.ts, so that file
 * can later re-export this interface.
 *
 *   - A bare deployment name (no "/") goes to Azure AI Foundry: one
 *     `FoundryClient.complete` call with a strict `json_schema` response format.
 *     Foundry's chat route has no effort setting here, so `effort` is not sent.
 *   - A model id containing "/" (for example "anthropic/claude-opus-5-5") goes to
 *     the Vercel AI Gateway chat completions route.
 *
 * Every failure is a `JsonClientError` with a fixed code; provider text, the
 * prompt and the key never appear in an error.
 *
 * Gateway documentation, checked 2026-10-19 at vercel.com/docs/ai-gateway
 * (pages last updated 2026-09-08 and 2026-10-02):
 *   Verified: POST https://ai-gateway.vercel.sh/v1/chat/completions with
 *   "Authorization: Bearer <AI_GATEWAY_API_KEY>"; request fields model, messages,
 *   max_tokens; response_format { type: "json_schema", json_schema: { name,
 *   schema, strict? } }; the reply in choices[0].message.content with
 *   finish_reason; `providerOptions.gateway` at the top level of the body with
 *   `only` (provider slugs); `reasoning: { effort }` accepting none, minimal,
 *   low, medium, high, xhigh, max (effort is relative to the model; the Gateway
 *   may map max to xhigh on cross-provider routes).
 *   Verified 2026-10-19 on the zero data retention and disallow prompt training
 *   pages: `providerOptions.gateway.zeroDataRetention: true` and
 *   `providerOptions.gateway.disallowPromptTraining: true` (the chat completions
 *   examples put both inside `gateway`). A request that no provider can satisfy
 *   fails with HTTP 400 `no_providers_available`. The zero data retention page
 *   states that `anthropic/claude-fable-5` supports it on no provider (30-day
 *   retention, no training), so an ask for that model must set
 *   `zeroDataRetention: false` or the Gateway refuses it.
 *   Provider slugs (anthropic, bedrock, vertex, azure, openai ...) are listed on
 *   the provider options page; the slug is not always the model id prefix, so
 *   `only` is sent only when the ask names `gatewayProvider`.
 *   Not verified: the finish_reason values the Gateway uses for a refusal or a
 *   cut-off reply (this client treats "content_filter" or a non-empty
 *   message.refusal as refused, and "length" as truncated, the OpenAI
 *   convention); the error body format (never read here); and the model ids.
 *   The docs' examples name "anthropic/claude-sonnet-5" and "claude-opus-5", and
 *   a changelog names "Claude Opus 5.5"; the caller passes whatever id the
 *   Gateway listing shows.
 *
 * No network call is made by tests: both clients take an injected fetch or an
 * injected Foundry client.
 */

import type { FoundryClient } from "../models/foundry.js";

export interface JsonAsk {
  /** An Azure deployment name, or a Gateway model id such as "anthropic/claude-opus-5-5". */
  model: string;
  system: string;
  user: string;
  /** A JSON Schema object; the reply is constrained to it. */
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Gateway only: the provider slug for `only`. Omitted (no restriction) when unknown. */
  gatewayProvider?: string;
  /** Gateway only: require zero data retention. Default true; false only for a model that has none (Fable). */
  zeroDataRetention?: boolean;
}

export interface JsonModelClient {
  askJson<T>(ask: JsonAsk): Promise<T>;
}

export type JsonClientErrorCode =
  | "json_client_refused"
  | "json_client_truncated"
  | "json_client_not_json"
  | "json_client_auth"
  | "json_client_rate_limited"
  | "json_client_timeout"
  /** Any other failure: unreachable, unavailable, bad request, unreadable reply. */
  | "json_client_failed"
  | "json_client_azure_not_configured"
  | "json_client_gateway_not_configured";

export class JsonClientError extends Error {
  readonly code: JsonClientErrorCode;

  constructor(code: JsonClientErrorCode) {
    super(code);
    this.name = "JsonClientError";
    this.code = code;
  }
}

const SCHEMA_NAME = "reply";

/* ------------------------------------------------------------------ Azure */

const FOUNDRY_TO_JSON_CODE: Record<string, JsonClientErrorCode> = {
  foundry_content_filtered: "json_client_refused",
  foundry_reply_truncated: "json_client_truncated",
  foundry_reply_not_json: "json_client_not_json",
  foundry_auth: "json_client_auth",
  foundry_rate_limited: "json_client_rate_limited",
  foundry_timeout: "json_client_timeout",
};

export function createAzureJsonClient(foundry: FoundryClient): JsonModelClient {
  return {
    async askJson<T>(ask: JsonAsk): Promise<T> {
      try {
        const completion = await foundry.complete({
          deployment: ask.model,
          messages: [
            { role: "system", content: ask.system },
            { role: "user", content: ask.user },
          ],
          responseFormat: { type: "json_schema", name: SCHEMA_NAME, schema: ask.schema },
          maxTokens: ask.maxTokens,
        });
        if (completion.json === undefined) throw new JsonClientError("json_client_not_json");
        return completion.json as T;
      } catch (err) {
        if (err instanceof JsonClientError) throw err;
        const message = err instanceof Error ? err.message : "";
        throw new JsonClientError(FOUNDRY_TO_JSON_CODE[message] ?? "json_client_failed");
      }
    },
  };
}

/* ---------------------------------------------------------------- Gateway */

export const GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;

export interface GatewayJsonOptions {
  /** The Vercel AI Gateway key. Held privately, never serialized. */
  apiKey: string;
  fetch?: typeof fetch;
  /** Milliseconds; default 120,000 because the offline judges think for a while. */
  timeoutMs?: number;
}

function statusToCode(status: number): JsonClientErrorCode {
  if (status === 401 || status === 403) return "json_client_auth";
  if (status === 429) return "json_client_rate_limited";
  if (status === 408 || status === 504) return "json_client_timeout";
  return "json_client_failed";
}

export function createGatewayJsonClient(options: GatewayJsonOptions): JsonModelClient {
  const { apiKey } = options;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
  // The key lives in this closure only, so it cannot be enumerated off the client.
  return {
    async askJson<T>(ask: JsonAsk): Promise<T> {
      const gatewayOptions: Record<string, unknown> = {
        zeroDataRetention: ask.zeroDataRetention !== false,
        disallowPromptTraining: true,
      };
      if (ask.gatewayProvider) gatewayOptions.only = [ask.gatewayProvider];
      const body: Record<string, unknown> = {
        model: ask.model,
        messages: [
          { role: "system", content: ask.system },
          { role: "user", content: ask.user },
        ],
        stream: false,
        response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema: ask.schema, strict: true } },
        providerOptions: { gateway: gatewayOptions },
      };
      if (ask.maxTokens !== undefined) body.max_tokens = ask.maxTokens;
      if (ask.effort) body.reasoning = { effort: ask.effort };

      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await doFetch(GATEWAY_CHAT_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        // Never forward the underlying error: it can carry the URL or headers.
        throw new JsonClientError(signal.aborted ? "json_client_timeout" : "json_client_failed");
      }
      if (!response.ok) {
        // Release the connection without reading provider text.
        await response.body?.cancel().catch(() => undefined);
        throw new JsonClientError(statusToCode(response.status));
      }

      let reply: unknown;
      try {
        reply = await response.json();
      } catch {
        throw new JsonClientError(signal.aborted ? "json_client_timeout" : "json_client_failed");
      }
      const choice = (reply as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }> } | null)
        ?.choices?.[0];
      if (!choice) throw new JsonClientError("json_client_failed");
      if (choice.finish_reason === "content_filter" || (typeof choice.message?.refusal === "string" && choice.message.refusal)) {
        throw new JsonClientError("json_client_refused");
      }
      if (choice.finish_reason === "length") throw new JsonClientError("json_client_truncated");
      const text = choice.message?.content;
      if (typeof text !== "string") throw new JsonClientError("json_client_not_json");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new JsonClientError("json_client_not_json");
      }
    },
  };
}

/* ---------------------------------------------------------------- routing */

export interface JsonModelClientOptions {
  /** The Azure Foundry client; absent when there is no Azure credential. */
  azure?: FoundryClient;
  /** The Gateway key and fetch; absent when there is no Gateway credential. */
  gateway?: GatewayJsonOptions;
}

/** True for a Gateway model id ("provider/model"); a bare name is an Azure deployment. */
export function isGatewayModel(model: string): boolean {
  return model.includes("/");
}

/**
 * Chooses the connector by model name. When the needed connector has no
 * credential, the ask throws `json_client_azure_not_configured` or
 * `json_client_gateway_not_configured` before any request is made.
 */
export function createJsonModelClient(options: JsonModelClientOptions): JsonModelClient {
  const azure = options.azure ? createAzureJsonClient(options.azure) : undefined;
  const gateway = options.gateway ? createGatewayJsonClient(options.gateway) : undefined;
  return {
    askJson<T>(ask: JsonAsk): Promise<T> {
      if (isGatewayModel(ask.model)) {
        return gateway ? gateway.askJson<T>(ask) : Promise.reject(new JsonClientError("json_client_gateway_not_configured"));
      }
      return azure ? azure.askJson<T>(ask) : Promise.reject(new JsonClientError("json_client_azure_not_configured"));
    },
  };
}
