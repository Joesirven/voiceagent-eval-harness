import { describe, expect, it } from "vitest";
import type { AzureCredentials } from "../../src/connectors/credentials.js";
import {
  AzureDecisionModel,
  createAzureDecisionMock,
  createDecisionModelCatalog,
  defaultDecisionModelId,
  type DecisionModelFailure,
  type DecisionModelRequest,
} from "../../src/decision-models/index.js";
import { asDecisionModule, buildState } from "../../src/decision-models/index.js";
import { TreeDialog } from "../../src/decision/engine.js";
import { DecisionModuleRegistry } from "../../src/decision/registry.js";
import { FULL_TREE_FILE, loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import { createMockFoundryClient } from "../../src/models/foundry.js";

const CALLER_WORDS = "Yes please book it, my number is 305-555-0142";

function request(overrides: Partial<DecisionModelRequest> = {}): DecisionModelRequest {
  return {
    nodeId: "greeting",
    question: "Did the caller agree to book?",
    answers: ["allow", "block", "unclear"],
    transcript: [
      { role: "agent", text: "Is two o'clock tomorrow good?", turnIndex: 0, spoken: true },
      { role: "caller", text: CALLER_WORDS, turnIndex: 1 },
    ],
    ...overrides,
  };
}

const failure = (outcome: unknown): DecisionModelFailure => {
  expect((outcome as { ok: boolean }).ok).toBe(false);
  return outcome as DecisionModelFailure;
};

describe("azure-decision on the decision deployment", () => {
  it("asks the typed question through FoundryClient.decide and reads the probabilities", async () => {
    const foundry = createMockFoundryClient({
      decide: () => ({ answer: { type: "choice", choice: "allow", probabilities: { allow: 0.9, block: 0.06, unclear: 0.04 } } }),
    });
    const model = new AzureDecisionModel(foundry, { decision: "decision-1", fast: "fast-1" });
    const outcome = await model.decide(request({ answerCriteria: { allow: "a plain yes" } }));
    expect(outcome).toMatchObject({ ok: true, answer: "allow", confidence: 0.9, modelId: "decision-1" });
    expect(foundry.calls.map((c) => c.op)).toEqual(["decide"]);
    const sent = foundry.calls[0]!.request as { state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> };
    expect(sent.state).toContain("[phone]");
    expect(sent.state).not.toContain("305-555-0142");
    expect(sent.questions.answer).toMatchObject({ type: "choice", criteria: { allow: "a plain yes" } });
  });

  it("answers invalid_answer when the choice is outside the closed list or not a choice", async () => {
    const outside = new AzureDecisionModel(
      createMockFoundryClient({ decide: () => ({ answer: { type: "choice", choice: "maybe" } }) }),
      { decision: "decision-1" },
    );
    expect(failure(await outside.decide(request()))).toMatchObject({ reason: "invalid_answer", code: "invalid_answer" });
    const wrongType = new AzureDecisionModel(
      createMockFoundryClient({ decide: () => ({ answer: { type: "noul", probability: 0.5 } }) }),
      { decision: "decision-1" },
    );
    expect(failure(await wrongType.decide(request()))).toMatchObject({ reason: "invalid_answer" });
  });
});

describe("azure-decision on the fast chat deployment", () => {
  it("falls back to a json_schema choice constrained to the request's answers", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { answer: "block", confidence: 0.92 } }) });
    const model = new AzureDecisionModel(foundry, { fast: "fast-1" });
    const outcome = await model.decide(request({ answers: ["allow", "block"] }), { timeoutMs: 1234 });
    expect(outcome).toMatchObject({ ok: true, answer: "block", confidence: 0.92, modelId: "fast-1" });
    expect(foundry.calls.map((c) => c.op)).toEqual(["complete"]);
    const sent = foundry.calls[0]!.request as {
      deployment: string;
      timeoutMs: number;
      messages: Array<{ role: string; content: string }>;
      responseFormat: { type: string; schema: { properties: { answer: { enum: string[] } }; required: string[] } };
    };
    expect(sent).toMatchObject({ deployment: "fast-1", timeoutMs: 1234 });
    expect(sent.responseFormat.type).toBe("json_schema");
    expect(sent.responseFormat.schema.properties.answer.enum).toEqual(["allow", "block"]);
    expect(sent.responseFormat.schema.required).toEqual(["answer", "confidence"]);
    expect(sent.messages[1]!.content).not.toContain("305-555-0142");
  });

  it("falls back to 0.5 when the model states no usable confidence", async () => {
    for (const confidence of [undefined, 1.7, "high"]) {
      const model = new AzureDecisionModel(createMockFoundryClient({ complete: () => ({ json: { answer: "block", confidence } }) }), { fast: "fast-1" });
      expect(await model.decide(request({ answers: ["allow", "block"] }))).toMatchObject({ ok: true, answer: "block", confidence: 0.5 });
    }
  });

  it("rejects an answer outside the list", async () => {
    const model = new AzureDecisionModel(createMockFoundryClient({ complete: () => ({ json: { answer: "unclear" } }) }), { fast: "fast-1" });
    expect(failure(await model.decide(request({ answers: ["allow", "block"] })))).toMatchObject({ reason: "invalid_answer" });
  });
});

describe("azure-decision failures never throw and never carry text", () => {
  const throwing = (message: string, deployments = { decision: "decision-1" }) =>
    new AzureDecisionModel(createMockFoundryClient({ decide: () => { throw new Error(message); } }), deployments);

  it("maps Foundry codes to the failure reasons with short codes", async () => {
    const cases: Array<[string, DecisionModelFailure["reason"], string]> = [
      ["foundry_timeout", "timeout", "timeout"],
      ["foundry_too_large", "too_large", "too_large"],
      ["foundry_deployment_not_configured", "off", "no_credential"],
      ["foundry_bad_response", "invalid_answer", "invalid_answer"],
      ["foundry_content_filtered", "error", "content_filtered"],
      ["foundry_reply_truncated", "error", "reply_truncated"],
      ["foundry_auth", "error", "auth"],
      ["foundry_rate_limited", "error", "rate_limit"],
      ["foundry_deployment_not_found", "error", "model"],
      ["foundry_unavailable", "error", "unavailable"],
      ["foundry_unreachable", "error", "unreachable"],
      ["anything else, including " + CALLER_WORDS, "error", "error"],
    ];
    for (const [message, reason, code] of cases) {
      const out = failure(await throwing(message).decide(request()));
      expect(out).toMatchObject({ reason, code, modelId: "decision-1" });
      expect(JSON.stringify(out)).not.toContain(CALLER_WORDS);
    }
  });

  it("maps the chat route's reply failures the same way", async () => {
    const chat = new AzureDecisionModel(
      createMockFoundryClient({ complete: () => { throw new Error("foundry_reply_not_json"); } }),
      { fast: "fast-1" },
    );
    expect(failure(await chat.decide(request()))).toMatchObject({ reason: "invalid_answer" });
  });

  it("is off with no_credential when neither deployment or no client is available", async () => {
    const foundry = createMockFoundryClient();
    expect(failure(await new AzureDecisionModel(foundry, {}).decide(request()))).toMatchObject({ reason: "off", code: "no_credential" });
    expect(failure(await new AzureDecisionModel(undefined, { decision: "d" }).decide(request()))).toMatchObject({ reason: "off" });
    expect(foundry.calls).toHaveLength(0);
  });
});

describe("azure-decision in the catalog", () => {
  const azure = (extra: Partial<AzureCredentials>): AzureCredentials =>
    ({
      foundryUrl: "https://x.openai.azure.com/openai/v1",
      decisionUrl: "https://x.openai.azure.com/providers/microsoft/v1/systemone",
      apiKey: "k",
      ...extra,
    }) as AzureCredentials;

  it("keeps jev as the default and lists azure-decision", () => {
    const catalog = createDecisionModelCatalog({ credentials: {} });
    expect(defaultDecisionModelId).toBe("jev");
    expect(catalog.defaultId).toBe("jev");
    expect(catalog.list().find((e) => e.id === "azure-decision")).toMatchObject({ kind: "mock", configured: false });
  });

  it("falls back to the mock with no_credential when Azure is absent or names no deployment", () => {
    for (const options of [{ credentials: {} }, { credentials: {}, azure: azure({}) }]) {
      const lookup = createDecisionModelCatalog(options).get("azure-decision")!;
      expect(lookup).toMatchObject({ fellBackToMock: true, reason: "no_credential" });
      expect(lookup.model.kind).toBe("mock");
    }
  });

  it("hands out the real model on either deployment, using the injected Foundry client", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { answer: "allow" } }) });
    const catalog = createDecisionModelCatalog({ credentials: {}, azure: azure({ fastDeployment: "fast-1" }), foundry });
    const lookup = catalog.get("azure-decision")!;
    expect(lookup).toMatchObject({ fellBackToMock: false });
    expect(lookup.model.kind).toBe("real");
    expect(catalog.list().find((e) => e.id === "azure-decision")).toMatchObject({ kind: "real", configured: true });
    expect(await lookup.model.decide(request())).toMatchObject({ ok: true, answer: "allow" });
    expect(foundry.calls[0]).toMatchObject({ op: "complete", deployment: "fast-1" });
  });

  it("builds a real Foundry client from the credentials with the injected fetch", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ answers: { answer: { type: "choice", choice: "allow", probabilities: { allow: 0.8 } } } }), { status: 200 });
    }) as typeof fetch;
    const catalog = createDecisionModelCatalog({ credentials: {}, azure: azure({ decisionDeployment: "decision-1" }), fetch: fetchImpl });
    const out = await catalog.get("azure-decision")!.model.decide(request());
    expect(out).toMatchObject({ ok: true, answer: "allow", confidence: 0.8 });
    expect(seen).toEqual(["https://x.openai.azure.com/providers/microsoft/v1/systemone"]);
  });

  it("always returns the mock for azure-decision-mock, which answers from keywords and never touches Foundry", async () => {
    const catalog = createDecisionModelCatalog({ credentials: {} });
    const lookup = catalog.get("azure-decision-mock")!;
    expect(lookup).toMatchObject({ fellBackToMock: false });
    expect(lookup.model).toMatchObject({ id: "azure-decision-mock", kind: "mock" });
    const yes = request({ answers: ["yes", "no", "unclear"], transcript: [{ role: "caller", text: "Yes", turnIndex: 0 }] });
    expect(await createAzureDecisionMock().decide(yes)).toMatchObject({ ok: true, answer: "yes", modelId: "azure-decision" });
  });
});

describe("lead facts in the decision state", () => {
  it("adds one line saying what the record holds, and nothing when the request has no lead facts", () => {
    const withLead = buildState(request({ context: { missedCalls: 2, lead: { name: "Maria Lopez", business: "Riverside Plumbing" } } }));
    expect(withLead.split("\n")[1]).toBe("On record (the caller's words still decide): name Maria Lopez; business Riverside Plumbing.");
    const noBusiness = buildState(request({ context: { missedCalls: 0, lead: { name: "Maria Lopez" } } }));
    expect(noBusiness).toContain("business not on record");
    expect(buildState(request())).not.toContain("On record");
  });
});

describe("both Azure routes see what the engine sends", () => {
  const LEAD = { name: "Maria Lopez", business: "Riverside Plumbing" };
  const isInterrupt = (state: string) => state.startsWith("Node: interrupts");

  async function callWith(deployments: { decision?: string; fast?: string }) {
    const foundry = createMockFoundryClient({
      decide: (req) => {
        const choice = isInterrupt((req as { state: string }).state) ? "none" : "unclear";
        return { answer: { type: "choice", choice, probabilities: { [choice]: 0.9 } } };
      },
      complete: (req) => {
        const state = String(req.messages.at(-1)!.content);
        return { json: { answer: isInterrupt(state) ? "none" : "unclear", confidence: 0.9 } };
      },
    });
    process.env.VOICE_HARNESS_DECISION_TREE = FULL_TREE_FILE;
    resetActiveTree();
    const decisions = new DecisionModuleRegistry();
    const module = asDecisionModule(new AzureDecisionModel(foundry, deployments));
    decisions.register(module);
    decisions.select(module.id);
    const yes = async () => true;
    const dialog = new TreeDialog({
      tree: loadActiveTree(),
      decisions,
      gate: { judge: { id: "allow", judge: async () => ({ allowed: true, reason: "test", scores: [] }) }, leadId: "lead-1", callId: "call-1" },
      actions: { transfer: yes, saveQuoteField: yes, saveDetails: yes, book: yes, sendText: yes, endWithDisposition: yes },
      recorder: { record: () => {} },
      direction: "inbound",
      firstName: "Pat",
      timeZone: "UTC",
      clock: { now: () => new Date("2026-10-15T14:00:00.000Z") },
      lead: LEAD,
    });
    await dialog.open();
    await dialog.step("Hi, I have a missed call from this number.");
    await dialog.step("Is this about my renewal?");
    delete process.env.VOICE_HARNESS_DECISION_TREE;
    resetActiveTree();
    return foundry.calls.map((c) => {
      const req = c.request as { state?: string; messages?: Array<{ content: unknown }> };
      return req.state ?? String(req.messages!.at(-1)!.content);
    });
  }

  for (const [route, deployments] of [["typed decide", { decision: "decision-1" }], ["chat complete", { fast: "fast-1" }]] as const) {
    it(`${route}: the interrupt check gets only the latest caller line and the agent line before it, with the lead facts`, async () => {
      const states = await callWith(deployments);
      const interrupts = states.filter(isInterrupt);
      expect(interrupts).toHaveLength(2);
      const last = interrupts.at(-1)!.split("\n");
      expect(last[1]).toMatch(/^On record .*Maria Lopez.*Riverside Plumbing/);
      expect(last.slice(2)).toEqual(["Agent: May I continue with a few renewal questions?", "Caller: Is this about my renewal?"]);
      // A node question keeps the whole conversation, the disclosure included.
      const node = states.filter((s) => !isInterrupt(s)).at(-1)!;
      expect(node).toContain("This call is handled by an AI assistant");
      expect(node).toContain("Caller: Hi, I have a missed call from this number.");
      expect(node).toMatch(/On record .*Riverside Plumbing/);
    });
  }
});
