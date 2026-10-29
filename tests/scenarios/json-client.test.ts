import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createAzureJsonClient,
  createGatewayJsonClient,
  createJsonModelClient,
  GATEWAY_CHAT_URL,
  JsonClientError,
  type JsonAsk,
} from "../../src/connectors/json-client.js";
import { createMockFoundryClient } from "../../src/models/foundry.js";

const KEY = "GATEWAYSECRET456";
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };
const ask = (model: string, extra: Partial<JsonAsk> = {}): JsonAsk => ({ model, system: "SYSTEMTEXT", user: "USERTEXT", schema: SCHEMA, ...extra });

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const reply = (choice: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ choices: [choice] }), { status, headers: { "content-type": "application/json" } });
const ok = (content: string) => reply({ finish_reason: "stop", message: { content } });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(JsonClientError);
    expect((err as Error).message).toBe((err as JsonClientError).code);
    return (err as JsonClientError).code;
  }
  return "no error";
}

describe("Azure JSON client", () => {
  it("asks Foundry for a strict json_schema reply on the named deployment", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { verdict: "pass" } }) });
    const out = await createAzureJsonClient(foundry).askJson<{ verdict: string }>(ask("judge-1", { maxTokens: 500, effort: "high" }));
    expect(out).toEqual({ verdict: "pass" });
    expect(foundry.calls).toHaveLength(1);
    expect(foundry.calls[0]).toMatchObject({ op: "complete", deployment: "judge-1" });
    expect(foundry.calls[0]!.request).toMatchObject({
      messages: [{ role: "system", content: "SYSTEMTEXT" }, { role: "user", content: "USERTEXT" }],
      responseFormat: { type: "json_schema", schema: SCHEMA },
      maxTokens: 500,
    });
  });

  it("maps Foundry codes to fixed codes and never repeats provider text", async () => {
    const failing = (message: string) =>
      createAzureJsonClient(createMockFoundryClient({ complete: () => { throw new Error(message); } })).askJson(ask("judge-1"));
    expect(await codeOf(failing("foundry_content_filtered"))).toBe("json_client_refused");
    expect(await codeOf(failing("foundry_reply_truncated"))).toBe("json_client_truncated");
    expect(await codeOf(failing("foundry_reply_not_json"))).toBe("json_client_not_json");
    expect(await codeOf(failing("foundry_auth"))).toBe("json_client_auth");
    expect(await codeOf(failing("foundry_rate_limited"))).toBe("json_client_rate_limited");
    expect(await codeOf(failing("foundry_timeout"))).toBe("json_client_timeout");
    expect(await codeOf(failing("foundry_unavailable"))).toBe("json_client_failed");
    expect(await codeOf(failing("raw text with USERTEXT inside"))).toBe("json_client_failed");
  });
});

describe("Gateway JSON client", () => {
  it("posts to the chat completions route with the key, the schema and the data-handling options", async () => {
    const { fetch: f, seen } = fakeFetch(() => ok('{"verdict":"pass"}'));
    const client = createGatewayJsonClient({ apiKey: KEY, fetch: f });
    const out = await client.askJson<{ verdict: string }>(ask("anthropic/claude-opus-5-5", { effort: "xhigh", maxTokens: 900, gatewayProvider: "anthropic" }));
    expect(out).toEqual({ verdict: "pass" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(GATEWAY_CHAT_URL);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({
      model: "anthropic/claude-opus-5-5",
      messages: [{ role: "system", content: "SYSTEMTEXT" }, { role: "user", content: "USERTEXT" }],
      response_format: { type: "json_schema", json_schema: { name: "reply", schema: SCHEMA, strict: true } },
      max_tokens: 900,
      reasoning: { effort: "xhigh" },
      providerOptions: { gateway: { zeroDataRetention: true, disallowPromptTraining: true, only: ["anthropic"] } },
    });
  });

  it("sends no provider restriction unless the ask names a slug, and can drop zero data retention for a model that has none", async () => {
    const { fetch: f, seen } = fakeFetch(() => ok("{}"));
    const client = createGatewayJsonClient({ apiKey: KEY, fetch: f });
    await client.askJson(ask("anthropic/claude-opus-5-5"));
    await client.askJson(ask("anthropic/claude-fable-5-1", { zeroDataRetention: false }));
    expect((seen[0]!.body.providerOptions as any).gateway).toEqual({ zeroDataRetention: true, disallowPromptTraining: true });
    expect((seen[1]!.body.providerOptions as any).gateway).toEqual({ zeroDataRetention: false, disallowPromptTraining: true });
  });

  it("cancels the response body on a non-ok reply", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    const { fetch: f } = fakeFetch(() => new Response(body, { status: 400 }));
    expect(await codeOf(createGatewayJsonClient({ apiKey: KEY, fetch: f }).askJson(ask("a/b")))).toBe("json_client_failed");
    expect(cancelled).toBe(true);
  });

  it("omits effort and max tokens when not asked", async () => {
    const { fetch: f, seen } = fakeFetch(() => ok("{}"));
    await createGatewayJsonClient({ apiKey: KEY, fetch: f }).askJson(ask("openai/gpt-x"));
    expect(seen[0]!.body).not.toHaveProperty("reasoning");
    expect(seen[0]!.body).not.toHaveProperty("max_tokens");
  });

  it("keeps the key out of the client when printed or serialized", () => {
    const client = createGatewayJsonClient({ apiKey: KEY, fetch: fakeFetch(() => ok("{}")).fetch });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(inspect(client)).not.toContain(KEY);
  });

  it("maps every failure to a fixed code", async () => {
    const run = (respond: () => Response | Promise<Response>) =>
      codeOf(createGatewayJsonClient({ apiKey: KEY, fetch: fakeFetch(respond).fetch }).askJson(ask("anthropic/m")));
    expect(await run(() => reply({ finish_reason: "content_filter", message: { content: null } }))).toBe("json_client_refused");
    expect(await run(() => reply({ finish_reason: "stop", message: { content: null, refusal: "I will not say USERTEXT" } }))).toBe("json_client_refused");
    expect(await run(() => reply({ finish_reason: "length", message: { content: '{"verd' } }))).toBe("json_client_truncated");
    expect(await run(() => ok("this is not json"))).toBe("json_client_not_json");
    expect(await run(() => reply({ finish_reason: "stop", message: {} }))).toBe("json_client_not_json");
    expect(await run(() => new Response("SECRET provider text", { status: 401 }))).toBe("json_client_auth");
    expect(await run(() => new Response("", { status: 403 }))).toBe("json_client_auth");
    expect(await run(() => new Response("", { status: 429 }))).toBe("json_client_rate_limited");
    expect(await run(() => new Response("", { status: 504 }))).toBe("json_client_timeout");
    expect(await run(() => new Response("", { status: 500 }))).toBe("json_client_failed");
    expect(await run(() => new Response("<html>", { status: 200 }))).toBe("json_client_failed");
    expect(await run(() => Response.json({ choices: [] }))).toBe("json_client_failed");
    expect(await run(() => { throw new Error(`connect ECONNREFUSED Bearer ${KEY}`); })).toBe("json_client_failed");
  });

  it("reports a timeout when the request is aborted", async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const code = await codeOf(createGatewayJsonClient({ apiKey: KEY, fetch: slow, timeoutMs: 5 }).askJson(ask("anthropic/m")));
    expect(code).toBe("json_client_timeout");
  });
});

describe("routing by model name", () => {
  it("sends a slash id to the Gateway and a bare name to Azure", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { verdict: "azure" } }) });
    const { fetch: f, seen } = fakeFetch(() => ok('{"verdict":"gateway"}'));
    const client = createJsonModelClient({ azure: foundry, gateway: { apiKey: KEY, fetch: f } });
    expect(await client.askJson(ask("anthropic/claude-opus-5-5"))).toEqual({ verdict: "gateway" });
    expect(await client.askJson(ask("judge-1"))).toEqual({ verdict: "azure" });
    expect(seen).toHaveLength(1);
    expect(foundry.calls).toHaveLength(1);
  });

  it("throws a fixed code, and makes no request, when the needed connector has no credential", async () => {
    const foundry = createMockFoundryClient();
    const { fetch: f, seen } = fakeFetch(() => ok("{}"));
    expect(await codeOf(createJsonModelClient({ azure: foundry }).askJson(ask("a/b")))).toBe("json_client_gateway_not_configured");
    expect(await codeOf(createJsonModelClient({ gateway: { apiKey: KEY, fetch: f } }).askJson(ask("judge-1")))).toBe("json_client_azure_not_configured");
    expect(await codeOf(createJsonModelClient({}).askJson(ask("judge-1")))).toBe("json_client_azure_not_configured");
    expect(seen).toHaveLength(0);
    expect(foundry.calls).toHaveLength(0);
  });
});

describe("buildJudgeJsonClient", () => {
  it("needs the Gateway key and names the variables, not values", async () => {
    const { buildJudgeJsonClient, GATEWAY_KEY_MISSING_MESSAGE } = await import("../../src/judging/offline/connector-client.js");
    const fs = (text: string) => ({ mode: () => 0o600, read: () => text });
    expect(() => buildJudgeJsonClient({ VOICE_HARNESS_DEV_ENV_FILE: "/x", DECISION_MODELS_ENV_FILE: "/none" }, { mode: () => { throw new Error("x"); }, read: () => "" })).toThrow("gateway_key_missing");
    expect(GATEWAY_KEY_MISSING_MESSAGE).toContain("AI_GATEWAY_API_KEY");
    expect(GATEWAY_KEY_MISSING_MESSAGE).toContain("VOICE_HARNESS_DEV_ENV_FILE");
    const { fetch: f, seen } = fakeFetch(() => ok('{"verdict":"x"}'));
    const client = buildJudgeJsonClient({ VOICE_HARNESS_DEV_ENV_FILE: "/x" }, fs(`AI_GATEWAY_API_KEY=${KEY}`), f);
    expect(await client.askJson(ask("anthropic/claude-opus-5-5"))).toEqual({ verdict: "x" });
    expect(seen).toHaveLength(1);
    expect(await codeOf(client.askJson(ask("azure-deployment")))).toBe("json_client_azure_not_configured");
  });
});
