import { describe, expect, it } from "vitest";
import type { AzureCredentials } from "../../src/connectors/credentials.js";
import {
  GatewayDecisionModel,
  OpenAiDecisionModel,
  asDecisionModule,
  createDecisionModelCatalog,
  createGatewayMock,
  createJevDirect,
  createJevDirectMock,
  createJevMock,
  createKev,
  createKevMock,
  createOpenAiDecisionsMock,
  buildQuestion,
  buildState,
  defaultDecisionModelId,
  type DecisionModel,
  type DecisionModelRequest,
  type FetchLike,
} from "../../src/decision-models/index.js";

/** A clock that moves 25 milliseconds every time it is read, so latency is exact and nothing waits. */
function steppingClock() {
  let t = Date.parse("2026-10-19T12:00:00.000Z");
  return {
    now: () => {
      const d = new Date(t);
      t += 25;
      return d;
    },
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  body: any;
  signal: AbortSignal | undefined;
}

function fakeFetch(respond: (sent: Sent) => Response | Promise<Response>) {
  const calls: Sent[] = [];
  const impl: FetchLike = async (input, init) => {
    const bodyText = String(init?.body ?? "");
    const sent: Sent = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      bodyText,
      body: JSON.parse(bodyText),
      signal: init?.signal ?? undefined,
    };
    calls.push(sent);
    return respond(sent);
  };
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function request(overrides: Partial<DecisionModelRequest> = {}): DecisionModelRequest {
  return {
    nodeId: "greeting",
    question: "Did the caller agree to book?",
    answers: ["allow", "block", "unclear"],
    transcript: [
      { role: "agent", text: "Is two o'clock tomorrow good?", turnIndex: 0, spoken: true },
      { role: "caller", text: "Yes, book it. Email me at pat.smith@example.com or call 305-555-0142.", turnIndex: 1 },
    ],
    ...overrides,
  };
}

const gatewayReply = {
  answers: {
    answer: { type: "choice", choice: "allow", probabilities: { allow: 0.91, block: 0.05, unclear: 0.04 } },
  },
};

const systemOneReply = {
  model: "jev-latest",
  answers: {
    answer: {
      type: "choice",
      choice: "allow",
      probabilities: { allow: 0.8, block: 0.1, unclear: 0.1 },
      confidence: 0.7,
    },
  },
};

describe("state and question", () => {
  it("sends only spoken turns as labelled lines and redacts personal details", () => {
    const state = buildState(
      request({
        transcript: [
          { role: "system", text: "internal note", turnIndex: 0 },
          { role: "agent", text: "I was saying something long", turnIndex: 1, spoken: false },
          { role: "agent", text: "Hello there", turnIndex: 2, spoken: true },
          { role: "caller", text: "Call me on 305-555-0142 or pat@example.com", turnIndex: 3 },
        ],
      }),
    );
    expect(state).toBe("Node: greeting\nAgent: Hello there\nCaller: Call me on [phone] or [email]");
  });

  it("builds instructions with the caller-only rule and a criterion for every answer", () => {
    const q = buildQuestion(request({ answerCriteria: { allow: "the caller said a plain yes" } }));
    expect(q.instructions).toBe("Did the caller agree to book? Only the caller's words count as the caller's answer.");
    expect(q.criteria.allow).toBe("the caller said a plain yes");
    expect(q.criteria.block).toBe(`the caller's words mean "block"`);
    expect(q.criteria.unclear).toBe("the caller's words do not settle the question");
  });

  it("prefers explicit instructions over the question and adds an unclear criterion when the list lacks one", () => {
    const q = buildQuestion(request({ instructions: "Judge the booking.", answers: ["allow", "block"] }));
    expect(q.instructions.startsWith("Judge the booking. ")).toBe(true);
    expect(Object.keys(q.criteria)).toEqual(["allow", "block", "unclear"]);
  });
});

describe("gateway adapter", () => {
  it("pins the wire format and zero data retention options", async () => {
    const { impl, calls } = fakeFetch(() => json(gatewayReply));
    const model = new GatewayDecisionModel("typesafe-ai/jev", "gw-key", impl, steppingClock());
    const outcome = await model.decide(request(), { timeoutMs: 500 });

    expect(model.id).toBe("jev");
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    expect(sent.headers).toEqual({
      authorization: "Bearer gw-key",
      "content-type": "application/json",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
      "ai-gateway-auth-method": "api-key",
      "ai-gateway-protocol-version": "0.0.1",
    });
    expect(sent.body.providerOptions).toEqual({
      gateway: { zeroDataRetention: true, disallowPromptTraining: true, only: ["typesafe-ai"] },
    });
    expect(sent.body.state).toContain("Caller: Yes, book it.");
    expect(sent.body.questions.answer.type).toBe("choice");
    expect(sent.body.questions.answer.criteria.unclear).toBeTruthy();
    expect(sent.signal).toBeInstanceOf(AbortSignal);

    expect(outcome).toMatchObject({
      ok: true,
      answer: "allow",
      confidence: 0.91,
      latencyMs: 25,
      modelId: "typesafe-ai/jev",
      probabilities: { allow: 0.91, block: 0.05, unclear: 0.04 },
    });
  });

  it("keeps an e-mail address and a phone number out of the sent body", async () => {
    const { impl, calls } = fakeFetch(() => json(gatewayReply));
    await new GatewayDecisionModel("typesafe-ai/jev", "gw-key", impl).decide(request());
    const body = calls[0]!.bodyText;
    expect(body).not.toContain("pat.smith@example.com");
    expect(body).not.toContain("305-555-0142");
    expect(body).toContain("[email]");
    expect(body).toContain("[phone]");
  });

  it("names other Gateway models gateway:<model> and sends their provider slug", async () => {
    const { impl, calls } = fakeFetch(() => json(gatewayReply));
    const model = new GatewayDecisionModel("perplexity/pplx-decider-flash-v1.2", "gw-key", impl);
    expect(model.id).toBe("gateway:perplexity/pplx-decider-flash-v1.2");
    await model.decide(request());
    expect(calls[0]!.headers["ai-model-id"]).toBe("perplexity/pplx-decider-flash-v1.2");
    expect(calls[0]!.body.providerOptions.gateway.only).toEqual(["perplexity"]);
    expect(calls[0]!.body.providerOptions.gateway.zeroDataRetention).toBe(true);
  });

  it("uses 0.5 when neither a distribution nor a confidence is sent", async () => {
    const { impl } = fakeFetch(() => json({ answers: { answer: { type: "choice", choice: "block" } } }));
    const outcome = await new GatewayDecisionModel("typesafe-ai/jev", "k", impl).decide(request());
    expect(outcome).toMatchObject({ ok: true, answer: "block", confidence: 0.5 });
  });

  it("rejects an answer outside the closed list", async () => {
    const { impl } = fakeFetch(() => json({ answers: { answer: { type: "choice", choice: "maybe" } } }));
    const outcome = await new GatewayDecisionModel("typesafe-ai/jev", "k", impl).decide(request());
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_answer" });
  });
});

describe("system one adapters", () => {
  it("pins the TypeSafe direct wire format and takes the probability, not the margin confidence", async () => {
    const { impl, calls } = fakeFetch(() => json(systemOneReply));
    const model = createJevDirect("ts-key", impl, steppingClock());
    const outcome = await model.decide(request());
    const sent = calls[0]!;
    expect(model.id).toBe("jev-direct");
    expect(sent.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent.headers).toEqual({ "content-type": "application/json", authorization: "Bearer ts-key" });
    expect(sent.body.model).toBe("jev-latest");
    expect(sent.body.state).toContain("Caller:");
    expect(sent.body.questions.answer.criteria.allow).toBeTruthy();
    expect(sent.bodyText).not.toContain("pat.smith@example.com");
    expect(outcome).toMatchObject({ ok: true, answer: "allow", confidence: 0.8, latencyMs: 25, modelId: "jev-latest" });
  });

  it("falls back to the provider confidence only when no distribution is sent", async () => {
    const { impl } = fakeFetch(() => json({ answers: { answer: { type: "choice", choice: "allow", confidence: 0.66 } } }));
    const outcome = await createJevDirect("k", impl).decide(request());
    expect(outcome).toMatchObject({ ok: true, confidence: 0.66 });
  });

  it("sends Kev requests to its own base without a bearer when no key is set", async () => {
    const { impl, calls } = fakeFetch(() => json({ ...systemOneReply, latency_ms: 12 }));
    const model = createKev("https://kev.example.test/", undefined, impl);
    const outcome = await model.decide(request());
    expect(model.id).toBe("kev");
    expect(calls[0]!.url).toBe("https://kev.example.test/v1/systemone");
    expect(calls[0]!.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]!.body.model).toBe("kev-latest");
    expect(outcome).toMatchObject({ ok: true, answer: "allow", confidence: 0.8 });
  });

  it("sends the Kev bearer when a key is set and allows localhost over http", async () => {
    const { impl, calls } = fakeFetch(() => json(systemOneReply));
    await createKev("http://localhost:8080", "kev-key", impl).decide(request());
    await createKev("http://127.0.0.1:9000", undefined, impl).decide(request());
    expect(calls[0]!.headers.authorization).toBe("Bearer kev-key");
    expect(calls[0]!.url).toBe("http://localhost:8080/v1/systemone");
    expect(calls).toHaveLength(2);
  });

  it("refuses a Kev base URL that is plain http to another host, without a request", async () => {
    const { impl, calls } = fakeFetch(() => json(systemOneReply));
    const outcome = await createKev("http://kev.example.test", "kev-key", impl).decide(request());
    expect(outcome).toMatchObject({ ok: false, reason: "off", code: "base_url_refused" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an answer outside the closed list", async () => {
    const { impl } = fakeFetch(() => json({ answers: { answer: { type: "choice", choice: "refund" } } }));
    expect(await createKev("https://kev.example.test", undefined, impl).decide(request())).toMatchObject({
      ok: false,
      reason: "invalid_answer",
    });
  });
});

describe("openai decisions adapter", () => {
  const reply = {
    answers: [
      {
        type: "choice",
        name: "answer",
        choice: "block",
        confidence: 0.4,
        probabilities: [
          { value: "allow", probability: 0.1 },
          { value: "block", probability: 0.85 },
          { value: "unclear", probability: 0.05 },
        ],
      },
    ],
  };

  it("pins the wire format and turns the probabilities list into a map", async () => {
    const { impl, calls } = fakeFetch(() => json(reply));
    const model = new OpenAiDecisionModel("oa-key", impl, steppingClock());
    const outcome = await model.decide(request({ answerCriteria: { allow: "plain yes" } }));
    const sent = calls[0]!;
    expect(model.id).toBe("openai-decisions");
    expect(sent.url).toBe("https://api.openai.com/v1/decisions");
    expect(sent.headers).toEqual({ authorization: "Bearer oa-key", "content-type": "application/json" });
    expect(sent.body.model).toBe("gpt-6-luna");
    expect(typeof sent.body.input).toBe("string");
    expect(sent.body.input).toContain("Caller:");
    expect(sent.body.questions).toHaveLength(1);
    expect(sent.body.questions[0]).toMatchObject({ type: "choice", name: "answer" });
    expect(sent.body.questions[0].choices).toContainEqual({ value: "allow", description: "plain yes" });
    expect(sent.body.questions[0].choices.map((c: { value: string }) => c.value)).toEqual(["allow", "block", "unclear"]);
    expect(sent.bodyText).not.toContain("305-555-0142");
    expect(outcome).toMatchObject({
      ok: true,
      answer: "block",
      confidence: 0.85,
      probabilities: { allow: 0.1, block: 0.85, unclear: 0.05 },
      latencyMs: 25,
    });
  });

  it("reports a refusal as an invalid answer with code refused", async () => {
    const { impl } = fakeFetch(() => json({ answers: [{ type: "refusal", name: "answer" }] }));
    expect(await new OpenAiDecisionModel("k", impl).decide(request())).toMatchObject({
      ok: false,
      reason: "invalid_answer",
      code: "refused",
    });
  });

  it("rejects an answer outside the closed list", async () => {
    const { impl } = fakeFetch(() => json({ answers: [{ type: "choice", name: "answer", choice: "other" }] }));
    expect(await new OpenAiDecisionModel("k", impl).decide(request())).toMatchObject({
      ok: false,
      reason: "invalid_answer",
    });
  });
});

describe("failures", () => {
  const adapters: Array<[string, (f: FetchLike) => DecisionModel]> = [
    ["gateway", (f) => new GatewayDecisionModel("typesafe-ai/jev", "k", f, steppingClock())],
    ["system one", (f) => createJevDirect("k", f, steppingClock())],
    ["openai decisions", (f) => new OpenAiDecisionModel("k", f, steppingClock())],
  ];

  const statusCases: Array<[number, string, string]> = [
    [401, "error", "auth"],
    [403, "error", "auth"],
    [404, "error", "model"],
    [413, "too_large", "too_large"],
    [429, "error", "rate_limit"],
    [529, "error", "overloaded"],
    [500, "error", "http_500"],
    [418, "error", "http_418"],
  ];

  for (const [name, make] of adapters) {
    it.each(statusCases)(`${name}: status %i is reason %s with code %s`, async (status, reason, code) => {
      const { impl } = fakeFetch(() => new Response("provider says: pat.smith@example.com is wrong", { status }));
      const outcome = await make(impl).decide(request());
      expect(outcome).toMatchObject({ ok: false, reason, code, latencyMs: 25 });
      expect(JSON.stringify(outcome)).not.toContain("pat.smith");
    });
  }

  it("treats a 422 as too_large only when the provider says the input is too big", async () => {
    const big = fakeFetch(() => new Response("input exceeds the context length", { status: 422 }));
    expect(await createJevDirect("k", big.impl).decide(request())).toMatchObject({ ok: false, reason: "too_large" });
    const other = fakeFetch(() => new Response("questions is required", { status: 422 }));
    expect(await createJevDirect("k", other.impl).decide(request())).toMatchObject({
      ok: false,
      reason: "error",
      code: "http_422",
    });
  });

  it("reports a network failure as unreachable and drops the error text", async () => {
    const impl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED while sending pat.smith@example.com");
    };
    const outcome = await new GatewayDecisionModel("typesafe-ai/jev", "k", impl, steppingClock()).decide(request());
    expect(outcome).toMatchObject({ ok: false, reason: "error", code: "unreachable" });
    expect(JSON.stringify(outcome)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(outcome)).not.toContain("pat.smith");
  });

  it("times out through an aborting fetch", async () => {
    const impl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const outcome = await new GatewayDecisionModel("typesafe-ai/jev", "k", impl, steppingClock()).decide(request(), {
      timeoutMs: 1,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "timeout", code: "timeout" });
  });

  it("maps a fetch that rejects with a timeout error to the timeout reason", async () => {
    const impl: FetchLike = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    expect(await createJevDirect("k", impl).decide(request())).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports a 200 that is not JSON as an invalid answer", async () => {
    const { impl } = fakeFetch(() => new Response("<html>gateway page</html>", { status: 200 }));
    expect(await new GatewayDecisionModel("typesafe-ai/jev", "k", impl).decide(request())).toMatchObject({
      ok: false,
      reason: "invalid_answer",
      code: "not_json",
    });
  });

  it("never throws, whatever the provider sends", async () => {
    for (const body of [null, 7, "text", [], {}, { answers: null }, { answers: { answer: null } }, { answers: [null] }]) {
      for (const [, make] of adapters) {
        const { impl } = fakeFetch(() => json(body));
        const outcome = await make(impl).decide(request());
        expect(outcome.ok).toBe(false);
      }
    }
  });
});

describe("missing credential", () => {
  it("answers off without any request", async () => {
    const { impl, calls } = fakeFetch(() => json(gatewayReply));
    const models: DecisionModel[] = [
      new GatewayDecisionModel("typesafe-ai/jev", undefined, impl),
      createJevDirect(undefined, impl),
      new OpenAiDecisionModel(undefined, impl),
      createKev(undefined, undefined, impl),
    ];
    for (const model of models) {
      expect(await model.decide(request())).toMatchObject({ ok: false, reason: "off", code: "no_credential" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("mocks", () => {
  const mocks: Array<[DecisionModel, string, number]> = [
    [createJevMock(), "jev-mock", 100],
    [createJevDirectMock(), "jev-direct-mock", 90],
    [createOpenAiDecisionsMock(), "openai-decisions-mock", 180],
    [createKevMock(), "kev-mock", 60],
    [createGatewayMock("liquid/d1"), "gateway:liquid/d1-mock", 150],
  ];

  it.each(mocks)("%# %s is deterministic, never real and reports its simulated latency", async (model, id, latency) => {
    expect(model.id).toBe(id);
    expect(model.kind).toBe("mock");
    const req = request({ answers: ["yes", "no", "unclear"], transcript: [{ role: "caller", text: "Yes, go ahead", turnIndex: 0 }] });
    const first = await model.decide(req);
    const second = await model.decide(req);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, answer: "yes", latencyMs: latency });
    if (first.ok) {
      expect(first.confidence).toBeGreaterThan(0.5);
      expect(Object.values(first.probabilities ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 1);
    }
  });

  it("answers unclear at low confidence when no cue matches, and uses request cues", async () => {
    const model = createJevMock();
    const none = await model.decide(request({ transcript: [{ role: "caller", text: "purple elephants", turnIndex: 0 }] }));
    expect(none).toMatchObject({ ok: true, answer: "unclear", confidence: 0.2 });
    const cued = await model.decide(
      request({
        answers: ["allow", "block", "unclear"],
        cues: { allow: ["purple elephants"] },
        transcript: [{ role: "caller", text: "purple elephants", turnIndex: 0 }],
      }),
    );
    expect(cued).toMatchObject({ ok: true, answer: "allow" });
  });

  it("calibrates each mock differently", async () => {
    const req = request({ answers: ["yes", "no", "unclear"], transcript: [{ role: "caller", text: "Yes", turnIndex: 0 }] });
    const confidences = await Promise.all(mocks.map(async ([m]) => ((await m.decide(req)) as { confidence: number }).confidence));
    expect(new Set(confidences).size).toBe(confidences.length);
  });
});

describe("catalog", () => {
  it("lists every adapter and defaults to jev", () => {
    const catalog = createDecisionModelCatalog({ credentials: {} });
    expect(catalog.defaultId).toBe("jev");
    expect(defaultDecisionModelId).toBe("jev");
    expect(catalog.list().map((e) => e.id)).toEqual([
      "jev",
      "jev-direct",
      "openai-decisions",
      "kev",
      "azure-decision",
      "gateway:perplexity/pplx-decider-flash-v1.2",
      "gateway:perplexity/pplx-decider-v1.2",
      "gateway:liquid/d1",
      "gateway:liquid/d1-ultra",
      "gateway:microsoft/microsoft-decision-1",
    ]);
  });

  it("falls back to the mock when the credential is missing and says so", () => {
    const catalog = createDecisionModelCatalog({ credentials: {} });
    for (const entry of catalog.list()) {
      expect(entry).toMatchObject({ kind: "mock", configured: false });
      const lookup = catalog.get(entry.id)!;
      expect(lookup.fellBackToMock).toBe(true);
      expect(lookup.model.kind).toBe("mock");
      expect(lookup.model.id).toBe(`${entry.id}-mock`);
      expect(lookup.reason).toBe("no_credential");
    }
  });

  it("returns the real model when its credential exists", () => {
    const catalog = createDecisionModelCatalog({
      credentials: { AI_GATEWAY_API_KEY: "g", OPENAI_API_KEY: "o", TYPESAFE_API_KEY: "t", KEV_BASE_URL: "https://kev.example.test" },
      azure: {
        foundryUrl: "https://x.openai.azure.com/openai/v1",
        decisionUrl: "https://x.openai.azure.com/providers/microsoft/v1/systemone",
        apiKey: "k",
        decisionDeployment: "decision-1",
      } as AzureCredentials,
    });
    for (const entry of catalog.list()) expect(entry).toMatchObject({ kind: "real", configured: true });
    expect(catalog.get("jev")).toMatchObject({ fellBackToMock: false });
    expect(catalog.get("jev")!.model.id).toBe("jev");
    expect(catalog.get("openai-decisions")!.model.kind).toBe("real");
    expect(catalog.get("gateway:liquid/d1")!.model.id).toBe("gateway:liquid/d1");
  });

  it("treats a refused Kev base URL as unconfigured", () => {
    const catalog = createDecisionModelCatalog({ credentials: { KEV_BASE_URL: "http://kev.example.test" } });
    expect(catalog.get("kev")).toMatchObject({ fellBackToMock: true, reason: "base_url_refused" });
  });

  it("returns a mock directly by its mock id and nothing for an unknown id", () => {
    const catalog = createDecisionModelCatalog({ credentials: { AI_GATEWAY_API_KEY: "g" } });
    expect(catalog.get("jev-mock")).toMatchObject({ fellBackToMock: false });
    expect(catalog.get("jev-mock")!.model.kind).toBe("mock");
    expect(catalog.get("nonsense")).toBeUndefined();
  });

  it("hands the injected fetch to the real models", async () => {
    const { impl, calls } = fakeFetch(() => json(gatewayReply));
    const catalog = createDecisionModelCatalog({ credentials: { AI_GATEWAY_API_KEY: "g" }, fetch: impl });
    await catalog.get("jev")!.model.decide(request());
    expect(calls).toHaveLength(1);
  });
});

describe("bridge to the tree engine's module", () => {
  const stubModel = (outcome: Awaited<ReturnType<DecisionModel["decide"]>>): DecisionModel => ({
    id: "jev",
    label: "Jev",
    kind: "real",
    decide: async () => outcome,
  });

  it("turns an answer into a result with a template reason", async () => {
    const module = asDecisionModule(
      stubModel({ ok: true, answer: "allow", confidence: 0.91, reason: "the caller said pat.smith@example.com", latencyMs: 112, modelId: "m" }),
    );
    expect(module.getConfig()).toEqual({ enabled: true, latencyMs: 0 });
    const result = await module.decide(request());
    expect(result).toEqual({ answer: "allow", confidence: 0.91, reason: "jev answered allow at 0.91 in 112 milliseconds" });
    expect(module.getConfig()).toEqual({ enabled: true, latencyMs: 112 });
    expect(module.id).toBe("jev");
    expect(module.label).toBe("Jev");
  });

  it("turns each failure into unclear at zero confidence with a code-only reason", async () => {
    const timeout = asDecisionModule(stubModel({ ok: false, reason: "timeout", latencyMs: 3000, modelId: "m", code: "timeout" }));
    expect(await timeout.decide(request())).toEqual({ answer: "unclear", confidence: 0, reason: "jev unavailable: timeout" });
    expect(timeout.getConfig().latencyMs).toBe(3000);

    const limited = asDecisionModule(stubModel({ ok: false, reason: "error", latencyMs: 40, modelId: "m", code: "rate_limit" }));
    expect((await limited.decide(request())).reason).toBe("jev unavailable: error (rate_limit)");

    const off = asDecisionModule(stubModel({ ok: false, reason: "off", latencyMs: 0, modelId: "m" }));
    expect(await off.decide(request())).toMatchObject({ answer: "unclear", confidence: 0, reason: "jev unavailable: off" });
  });

  it("never lets provider text into the reason, even through a bad code", async () => {
    const hostile = asDecisionModule(
      stubModel({ ok: false, reason: "error", latencyMs: 1, modelId: "m", code: "caller said pat.smith@example.com" }),
    );
    const result = await hostile.decide(request());
    expect(result.reason).toBe("jev unavailable: error");
    expect(result.reason).not.toContain("pat");
  });

  it("treats a confidence outside 0 to 1, or not a number, as unavailable instead of clamping it", async () => {
    for (const confidence of [2, -0.5, Number.NaN, Infinity]) {
      const bad = asDecisionModule(stubModel({ ok: true, answer: "allow", confidence, reason: "x", latencyMs: 5, modelId: "m" }));
      expect(await bad.decide(request())).toEqual({ answer: "unclear", confidence: 0, reason: "jev unavailable: invalid_confidence" });
    }
  });

  it("treats an answer outside the request's list, or a throwing model, as unavailable", async () => {
    const stray = asDecisionModule(stubModel({ ok: true, answer: "refund", confidence: 0.99, reason: "x", latencyMs: 5, modelId: "m" }));
    expect(await stray.decide(request())).toEqual({ answer: "unclear", confidence: 0, reason: "jev unavailable: invalid_answer" });
    const throwing = asDecisionModule({ id: "jev", label: "Jev", kind: "real", decide: async () => { throw new Error("boom with caller words"); } });
    expect(await throwing.decide(request())).toEqual({ answer: "unclear", confidence: 0, reason: "jev unavailable: error" });
  });

  it("works over a real adapter with an injected fetch, and over a mock", async () => {
    const { impl } = fakeFetch(() => json(gatewayReply));
    const real = asDecisionModule(new GatewayDecisionModel("typesafe-ai/jev", "k", impl, steppingClock()));
    expect(await real.decide(request())).toEqual({
      answer: "allow",
      confidence: 0.91,
      reason: "jev answered allow at 0.91 in 25 milliseconds",
    });
    const mock = asDecisionModule(createJevMock());
    const result = await mock.decide(request({ answers: ["yes", "no", "unclear"], transcript: [{ role: "caller", text: "yes", turnIndex: 0 }] }));
    expect(result.answer).toBe("yes");
    expect(result.reason).toBe(`jev-mock answered yes at ${result.confidence.toFixed(2)} in 100 milliseconds`);
    expect(mock.getConfig().latencyMs).toBe(100);
  });
});
