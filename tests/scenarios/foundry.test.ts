import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createFoundryClient,
  createMockFoundryClient,
  loadFoundryConfig,
  makeFoundryConfig,
  normalizeFoundryUrl,
  requireDeployment,
} from "../../src/models/foundry.js";
import { newCallContext, runWithTrace, traceBus, type TraceEvent } from "../../src/trace/events.js";

const KEY = "SECRETKEYVALUE123";
const BASE = "https://example-test.openai.azure.com/openai/v1";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Runs `fn` inside a traced call and returns the events it emitted. */
async function traced<T>(fn: () => Promise<T>): Promise<{ value: T | undefined; error?: Error; events: TraceEvent[] }> {
  const ctx = newCallContext("lead_foundry_test", "inbound");
  const before = traceBus.history().length;
  let value: T | undefined;
  let error: Error | undefined;
  await runWithTrace(ctx, async () => {
    try {
      value = await fn();
    } catch (err) {
      error = err as Error;
    }
  });
  const events = traceBus.history().slice(before).filter((e) => e.recordId === ctx.recordId);
  return { value, error, events };
}

function clockFrom(...times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe("Foundry configuration", () => {
  const file = (text: string, mode = 0o600) => ({ mode: () => mode, read: () => text });

  it("reads the URL, the key and the optional deployment names from the development dotenv", () => {
    const cfg = loadFoundryConfig(
      { VOICE_HARNESS_DEV_ENV_FILE: "/tmp/dev.env" },
      file(`SUPABASE_URL=x\nexport AZURE_FOUNDRY_URL="${BASE}/"\nAZURE_FOUNDRY_KEY=${KEY}\nAZURE_REPLY_DEPLOYMENT=gpt-5.5\n`),
    );
    expect(cfg.baseUrl).toBe(BASE);
    expect(cfg.apiKey).toBe(KEY);
    expect(cfg.deployments).toMatchObject({ reply: "gpt-5.5" });
    expect(cfg.deployments.decision).toBeUndefined();
    expect(() => requireDeployment(cfg, "decision")).toThrow("foundry_deployment_not_configured");
    expect(requireDeployment(cfg, "reply")).toBe("gpt-5.5");
  });

  it("never shows the key when the config is printed or serialized", () => {
    const cfg = makeFoundryConfig(BASE, KEY);
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    expect(inspect(cfg)).not.toContain(KEY);
    expect(Object.keys(cfg)).not.toContain("apiKey");
  });

  it("fails with fixed codes that never carry a value", () => {
    const env = { VOICE_HARNESS_DEV_ENV_FILE: "/tmp/dev.env" };
    expect(() => loadFoundryConfig({}, file(""))).toThrow("foundry_env_file_not_configured");
    expect(() => loadFoundryConfig(env, file("", 0o644))).toThrow("foundry_env_file_permissions_too_open");
    expect(() => loadFoundryConfig(env, { mode: () => 0o600, read: () => { throw new Error(`/secret/path ${KEY}`); } })).toThrow(/^foundry_env_file_unreadable$/);
    expect(() => loadFoundryConfig(env, file(`AZURE_FOUNDRY_KEY=${KEY}`))).toThrow("foundry_missing_AZURE_FOUNDRY_URL");
    expect(() => loadFoundryConfig(env, file(`AZURE_FOUNDRY_URL=${BASE}`))).toThrow("foundry_missing_AZURE_FOUNDRY_KEY");
    expect(() => loadFoundryConfig(env, file(`AZURE_FOUNDRY_URL=https://evil.example.com/openai/v1\nAZURE_FOUNDRY_KEY=${KEY}`))).toThrow("foundry_url_not_azure");
  });

  it("accepts only https Azure hosts", () => {
    expect(normalizeFoundryUrl("https://x.services.ai.azure.com/openai/v1")).toBe("https://x.services.ai.azure.com/openai/v1");
    expect(() => normalizeFoundryUrl("http://x.openai.azure.com/openai/v1")).toThrow("foundry_url_invalid");
    expect(() => normalizeFoundryUrl("https://x.openai.azure.com.evil.com/openai/v1")).toThrow("foundry_url_not_azure");
    expect(() => normalizeFoundryUrl("not a url")).toThrow("foundry_url_invalid");
  });
});

describe("Foundry client", () => {
  const config = makeFoundryConfig(BASE, KEY);

  it("sends a strict structured-output completion to the deployment and parses the JSON", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({ choices: [{ finish_reason: "stop", message: { content: '{"answer":"allow"}' } }], usage: { prompt_tokens: 40, completion_tokens: 5 } }),
    );
    const client = createFoundryClient(config, { fetch, clock: clockFrom(1000, 1137) });
    const { value, events } = await traced(() =>
      client.complete({
        deployment: "gpt-5.5",
        messages: [{ role: "user", content: "PROMPTSENTINEL question" }],
        responseFormat: { type: "json_schema", name: "verdict", schema: { type: "object" } },
        maxTokens: 50,
      }),
    );
    expect(seen[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["api-key"]).toBe(KEY);
    expect(seen[0]!.body).toMatchObject({
      model: "gpt-5.5",
      max_completion_tokens: 50,
      response_format: { type: "json_schema", json_schema: { name: "verdict", strict: true } },
    });
    expect(value).toMatchObject({ json: { answer: "allow" }, latencyMs: 137, usage: { inputTokens: 40, outputTokens: 5 } });

    // One tool_call event: operation, deployment, success, duration. No prompt, no reply, no key.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_call");
    expect(events[0]!.data).toMatchObject({ tool: "foundry.complete", inputs: { deployment: "gpt-5.5" }, success: true });
    const dump = JSON.stringify(events);
    for (const secret of [KEY, "PROMPTSENTINEL", "allow"]) expect(dump).not.toContain(secret);
  });

  it("returns token alternatives when asked, for choice probabilities", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "allow" },
            logprobs: { content: [{ token: "allow", logprob: -0.1, top_logprobs: [{ token: "allow", logprob: -0.1 }, { token: "block", logprob: -2.4 }] }] },
          },
        ],
      }),
    );
    const out = await createFoundryClient(config, { fetch }).complete({ deployment: "gpt-5.4-mini", messages: [], topLogprobs: 5 });
    expect(seen[0]!.body).toMatchObject({ logprobs: true, top_logprobs: 5 });
    expect(out.logprobs?.[0]?.top.map((t) => t.token)).toEqual(["allow", "block"]);
  });

  it("maps every failure to a fixed code and traces it without the response text", async () => {
    const cases: Array<[Response | "throw" | "abort", string]> = [
      [json({ error: { message: `bad ${KEY}` } }, 401), "foundry_auth"],
      [json({}, 404), "foundry_deployment_not_found"],
      [json({}, 429), "foundry_rate_limited"],
      [json({}, 503), "foundry_unavailable"],
      [json({}, 418), "foundry_http_418"],
      [new Response("not json", { status: 200 }), "foundry_bad_response"],
      [json({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }), "foundry_content_filtered"],
      [json({ choices: [{ finish_reason: "length", message: { content: '{"a":' } }] }), "foundry_reply_truncated"],
      ["throw", "foundry_unreachable"],
    ];
    for (const [response, code] of cases) {
      const fetch = (async () => {
        if (response === "throw") throw new Error(`connect failed to ${BASE} with ${KEY}`);
        return response as Response;
      }) as typeof globalThis.fetch;
      const { error, events } = await traced(() => createFoundryClient(config, { fetch }).complete({ deployment: "d1", messages: [] }));
      expect(error?.message).toBe(code);
      expect(events[0]!.data).toMatchObject({ tool: "foundry.complete", success: false, reason: code });
      expect(JSON.stringify(events)).not.toContain(KEY);
    }
  });

  it("reports a timeout when the request is aborted", async () => {
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof globalThis.fetch;
    await expect(createFoundryClient(config, { fetch }).complete({ deployment: "d1", messages: [], timeoutMs: 5 })).rejects.toThrow("foundry_timeout");
  });

  it("rejects a reply that is not JSON when JSON was asked for", async () => {
    const { fetch } = fakeFetch(() => json({ choices: [{ finish_reason: "stop", message: { content: "sure thing" } }] }));
    await expect(
      createFoundryClient(config, { fetch }).complete({ deployment: "d1", messages: [], responseFormat: { type: "json_object" } }),
    ).rejects.toThrow("foundry_reply_not_json");
  });

  it("refuses a deployment name that could change the route", async () => {
    const { fetch, seen } = fakeFetch(() => json({}));
    await expect(createFoundryClient(config, { fetch }).complete({ deployment: "../admin", messages: [] })).rejects.toThrow("foundry_deployment_name_invalid");
    expect(seen).toHaveLength(0);
  });

  it("asks typed decision questions on the System One route and reads probabilities, including string values", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({
        model: "Microsoft-Decision-1",
        answers: {
          gate: { type: "choice", choice: "allow", probabilities: { allow: 0.91, block: "0.06", unclear: 0.03 }, confidence: 0.86 },
          urgent: { type: "noul", noul: 0.12 },
        },
        usage: { input_tokens: 210, output_tokens: 0 },
      }),
    );
    const client = createFoundryClient(config, { fetch, clock: clockFrom(0, 95) });
    const { value, events } = await traced(() =>
      client.decide({
        deployment: "microsoft-decision-1",
        state: "Caller: STATESENTINEL yes book it",
        questions: {
          gate: { type: "choice", instructions: "Go ahead?", criteria: { allow: "yes", block: "no", unclear: "cannot tell" } },
          urgent: { type: "noul", instructions: "Urgent?" },
        },
      }),
    );
    expect(seen[0]!.url).toBe("https://example-test.openai.azure.com/providers/microsoft/v1/systemone");
    expect(seen[0]!.body).toMatchObject({ model: "microsoft-decision-1", questions: { gate: { type: "choice" } } });
    expect(value).toEqual({
      answers: {
        gate: { type: "choice", choice: "allow", probabilities: { allow: 0.91, block: 0.06, unclear: 0.03 }, confidence: 0.86 },
        urgent: { type: "noul", probability: 0.12 },
      },
      latencyMs: 95,
      usage: { inputTokens: 210, outputTokens: 0 },
    });
    expect(events[0]!.data).toMatchObject({ tool: "foundry.decide", inputs: { deployment: "microsoft-decision-1" }, success: true });
    expect(JSON.stringify(events)).not.toContain("STATESENTINEL");
  });

  it("sends decisions to the configured decision URL when the model lives on another resource", async () => {
    const { fetch, seen } = fakeFetch(() => json({ answers: {} }));
    const cfg = makeFoundryConfig(BASE, KEY, {}, "https://example-foundry.services.ai.azure.com/providers/microsoft/v1/systemone");
    await createFoundryClient(cfg, { fetch }).decide({ deployment: "d1", state: "x", questions: {} });
    expect(seen[0]!.url).toBe("https://example-foundry.services.ai.azure.com/providers/microsoft/v1/systemone");
    expect(() => makeFoundryConfig(BASE, KEY, {}, "https://evil.example.com/x")).toThrow("foundry_url_not_azure");
  });

  it("rejects a decision answer it cannot read", async () => {
    const { fetch } = fakeFetch(() => json({ answers: { gate: { type: "choice" } } }));
    await expect(createFoundryClient(config, { fetch }).decide({ deployment: "d1", state: "x", questions: {} })).rejects.toThrow("foundry_bad_response");
  });

  it("lists the deployment names on the resource, from the data-plane deployment listing (not the model catalog at /models)", async () => {
    const { fetch, seen } = fakeFetch(() => json({ data: [{ id: "gpt-live-1" }, { id: "gpt-5.5" }, { nope: 1 }] }));
    expect(await createFoundryClient(config, { fetch }).listDeployments()).toEqual(["gpt-live-1", "gpt-5.5"]);
    expect(seen[0]).toMatchObject({ url: `${new URL(BASE).origin}/openai/deployments?api-version=2022-12-01`, method: "GET" });
  });

  it("transcribes with speaker-separated segments when asked to diarize", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({
        text: "hola sí",
        segments: [
          { speaker: "A", start: 0.0, end: 1.25, text: "hola" },
          { speaker: "B", start: 1.3, end: 1.9, text: "sí" },
        ],
      }),
    );
    const out = await createFoundryClient(config, { fetch, clock: clockFrom(0, 900) }).transcribe({
      deployment: "gpt-4o-transcribe-diarize",
      audio: new Uint8Array([1, 2, 3]),
      diarize: true,
      language: "es",
    });
    expect(seen[0]!.url).toBe(`${BASE}/audio/transcriptions`);
    const form = seen[0]!.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(form.get("response_format")).toBe("diarized_json");
    expect(form.get("language")).toBe("es");
    expect(out.segments).toEqual([
      { speaker: "A", startMs: 0, endMs: 1250, text: "hola" },
      { speaker: "B", startMs: 1300, endMs: 1900, text: "sí" },
    ]);
    expect(out.latencyMs).toBe(900);
  });

  it("describes the realtime connection for the server without exposing the key when serialized", () => {
    const conn = createFoundryClient(config).realtimeSession({ deployment: "gpt-live-1" });
    expect(conn.url).toBe("wss://example-test.openai.azure.com/openai/v1/realtime?model=gpt-live-1");
    expect(conn.headers()).toEqual({ "api-key": KEY });
    expect(JSON.stringify(conn)).not.toContain(KEY);
    expect(inspect(conn)).not.toContain(KEY);
  });
});

describe("mock Foundry client", () => {
  it("has the same interface, records calls and emits the same trace events", async () => {
    const mock = createMockFoundryClient({
      deployments: ["gpt-5.5"],
      complete: (req) => ({ json: { answer: req.deployment === "gpt-5.5" ? "allow" : "block" } }),
      latencyMs: 90,
    });
    const { value, events } = await traced(() =>
      mock.complete({ deployment: "gpt-5.5", messages: [{ role: "user", content: "x" }], responseFormat: { type: "json_object" } }),
    );
    expect(value).toMatchObject({ json: { answer: "allow" }, latencyMs: 90 });
    expect(events[0]!.data).toMatchObject({ tool: "foundry.complete", inputs: { deployment: "gpt-5.5" }, success: true });
    expect(await mock.listDeployments()).toEqual(["gpt-5.5"]);
    expect(mock.calls.map((c) => c.op)).toEqual(["complete", "list_deployments"]);
    const decided = await mock.decide({
      deployment: "md1",
      state: "x",
      questions: { gate: { type: "choice", instructions: "?", criteria: { allow: "a", block: "b" } } },
    });
    expect(decided.answers.gate).toEqual({ type: "choice", choice: "allow", probabilities: { allow: 1 } });
  });

  it("simulates a failure by throwing a fixed code, traced as a failure", async () => {
    const mock = createMockFoundryClient({ complete: () => { throw new Error("foundry_timeout"); } });
    const { error, events } = await traced(() => mock.complete({ deployment: "d1", messages: [] }));
    expect(error?.message).toBe("foundry_timeout");
    expect(events[0]!.data).toMatchObject({ success: false, reason: "foundry_timeout" });
  });
});
