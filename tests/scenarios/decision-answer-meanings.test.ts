import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureCredentials } from "../../src/connectors/credentials.js";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { JevMockModule } from "../../src/decision/modules.js";
import { type DecisionTree } from "../../src/decision/tree.js";
import { loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import { asDecisionModule } from "../../src/decision-models/bridge.js";
import { createDecisionModelCatalog } from "../../src/decision-models/index.js";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../../src/decision-models/types.js";
import { createMockFoundryClient } from "../../src/models/foundry.js";
import { resetJudges } from "../../src/judge/index.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { applyDecisionModuleChoice, DECISION_MODULE_ENV, listDecisionModuleOptions, useDecisionModelCatalog } from "../../src/server/live-judge-wiring.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";

/** Echoes which meanings it saw: records every request, answers "unclear" (and "none" for the interrupt check). */
class MeaningEcho implements DecisionModel {
  readonly id = "meaning-echo";
  readonly label = "Meaning echo (test)";
  readonly kind = "mock" as const;
  readonly seen: DecisionModelRequest[] = [];
  async decide(request: DecisionModelRequest): Promise<DecisionModelOutcome> {
    this.seen.push(request);
    const answer = request.nodeId === "interrupts" ? "none" : "unclear";
    return { ok: true, answer, confidence: 0.9, reason: "echo", latencyMs: 1, modelId: this.id };
  }
}

const azure = (extra: Partial<AzureCredentials> = {}): AzureCredentials =>
  ({
    foundryUrl: "https://x.openai.azure.com/openai/v1",
    decisionUrl: "https://x.openai.azure.com/providers/microsoft/v1/systemone",
    apiKey: "k",
    ...extra,
  }) as AzureCredentials;

let tree: DecisionTree;
let server: Server;
let base: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  tree = loadActiveTree();
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "decision-answer-meanings-test-")));
  traceBus.reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) =>
    String(input).startsWith(base) ? realFetch(input, init) : Promise.reject(new Error("no network in this test"))) as typeof fetch);
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  delete process.env.VOICE_HARNESS_DECISION_MODULE;
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
  useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: null }));
});
afterEach(() => {
  vi.restoreAllMocks();
  useDecisionModelCatalog(undefined);
  resetDecisionRegistry();
});

const runCall = (lines: string[]) =>
  new CallHarness({ now: () => new Date(IN_WINDOW) }, undefined, getModuleRegistry(), { tree }).runInbound("lead-1", "+15550143", {
    idempotencyKey: `in-${Math.random()}`,
    agent: "decision_tree",
    callerUtterances: lines,
  });

const post = async (path: string, body: unknown) => {
  const res = await realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

describe("answer meanings reach the decision model", () => {
  it("sends each node answer's meaning, and the interrupt answers' meanings, to the model", async () => {
    const echo = new MeaningEcho();
    getDecisionRegistry().register(asDecisionModule(echo));
    getDecisionRegistry().select("meaning-echo");
    await runCall(["Hi there"]);

    const nodeAsk = echo.seen.find((r) => r.nodeId !== "interrupts")!;
    const node = tree.nodes[nodeAsk.nodeId]!;
    const expectedNode = Object.fromEntries(node.decision!.answers.filter((a) => a.meaning).map((a) => [a.answer, a.meaning]));
    expect(Object.keys(expectedNode).length).toBeGreaterThan(0);
    expect(nodeAsk.answerCriteria).toEqual(expectedNode);
    // The names stay the only valid outputs.
    expect(nodeAsk.answers).toEqual(node.decision!.answers.map((a) => a.answer));

    const interruptAsk = echo.seen.find((r) => r.nodeId === "interrupts")!;
    const expectedInterrupt = Object.fromEntries(tree.interrupts!.answers.filter((a) => a.meaning).map((a) => [a.answer, a.meaning]));
    expect(Object.keys(expectedInterrupt).length).toBeGreaterThan(0);
    expect(interruptAsk.answerCriteria).toEqual(expectedInterrupt);
  });

  it("keeps meaning text out of trace events and recorded runs", async () => {
    const echo = new MeaningEcho();
    getDecisionRegistry().register(asDecisionModule(echo));
    getDecisionRegistry().select("meaning-echo");
    const run = await runCall(["Hi there"]);
    const meanings = [...tree.interrupts!.answers, ...Object.values(tree.nodes).flatMap((n) => n.decision?.answers ?? [])]
      .map((a) => a.meaning)
      .filter((m): m is string => !!m);
    expect(meanings.length).toBeGreaterThan(0);
    const everything = JSON.stringify([traceBus.history(), recordStore.read(run.recordId!)]);
    for (const meaning of meanings) expect(everything).not.toContain(meaning);
  });

  it("is ignored by the keyword module: same answer with and without meanings", async () => {
    const keyword = new JevMockModule();
    const request = {
      nodeId: "n",
      question: "Does the caller want a quote?",
      answers: ["yes", "no", "unclear"],
      transcript: [{ role: "caller" as const, text: "yes please", turnIndex: 0 }],
      cues: { yes: ["yes"] },
    };
    const plain = await keyword.decide(request);
    const withMeanings = await keyword.decide({ ...request, answerCriteria: { yes: "wants a quote", no: "does not" } });
    expect(withMeanings).toEqual(plain);
  });

  it("reaches the Azure model as one line per answer in the system message", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { answer: "yes" } }) });
    const catalog = createDecisionModelCatalog({ credentials: {}, azure: azure({ fastDeployment: "fast-1" }), foundry });
    const model = catalog.get("azure-decision")!.model;
    await model.decide({
      nodeId: "n",
      question: "Does the caller want a quote?",
      answers: ["yes", "no", "unclear"],
      transcript: [{ role: "caller", text: "a short fake sentence", turnIndex: 0 }],
      answerCriteria: { yes: "MEANING-YES", no: "MEANING-NO" },
    });
    const system = JSON.stringify(foundry.calls[0]!.request);
    expect(system).toContain("- yes: MEANING-YES");
    expect(system).toContain("- no: MEANING-NO");
  });
});

describe("selecting the decision module", () => {
  it("never lists the mock modules, and lists azure-decision only when Azure is configured", () => {
    expect(listDecisionModuleOptions()).toEqual([]);
    useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: azure({ fastDeployment: "fast-1" }), foundry: createMockFoundryClient() }));
    const options = listDecisionModuleOptions();
    expect(options.map((o) => o.id)).toEqual(["azure-decision"]);
    expect(options[0]).toMatchObject({ kind: "model", selected: false, available: true });
  });

  it("the catalog default chat deployment applies only when the dotenv names none", () => {
    const withDefault = (a: AzureCredentials) => createDecisionModelCatalog({ credentials: {}, azure: a, defaultChatDeployment: "chat-default", foundry: createMockFoundryClient() });
    expect(withDefault(azure()).get("azure-decision")).toMatchObject({ fellBackToMock: false });
    expect(createDecisionModelCatalog({ credentials: {}, azure: azure() }).get("azure-decision")).toMatchObject({ fellBackToMock: true, reason: "no_credential" });
    expect(createDecisionModelCatalog({ credentials: {}, azure: null, defaultChatDeployment: "chat-default" }).get("azure-decision")).toMatchObject({ fellBackToMock: true });
  });

  it("by route: the state lists no mock, the mocks are refused, azure-decision is refused without a credential", async () => {
    const state = await (await realFetch(`${base}/api/state`)).json();
    expect(state.decisionModules).toEqual([]);
    for (const id of ["jev-mock", "openai-mock"]) {
      const mock = await post("/api/decision-module/select", { decisionModuleId: id });
      expect(mock.status).toBe(409);
      expect(mock.body.error).toBe("test_only_decision_module");
    }
    expect(getDecisionRegistry().selectedModuleId()).toBe("jev-mock");
    const refused = await post("/api/decision-module/select", { decisionModuleId: "azure-decision" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("no_credential");
    expect(getDecisionRegistry().selectedModuleId()).toBe("jev-mock");
    expect((await post("/api/decision-module/select", { decisionModuleId: "nope" })).body.error).toBe("unknown_decision_module");
  });

  it("by route and by environment variable: azure-decision is registered and selected with a credential", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { answer: "unclear" } }) });
    useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: azure({ fastDeployment: "fast-1" }), foundry }));
    const byRoute = await post("/api/decision-module/select", { decisionModuleId: "azure-decision" });
    expect(byRoute.status).toBe(200);
    expect(byRoute.body.decisionModules.find((d: any) => d.selected).id).toBe("azure-decision");

    resetDecisionRegistry();
    const byEnv = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "azure-decision" } });
    expect(byEnv).toMatchObject({ outcome: "registered_from_catalog", selected: "azure-decision" });
  });

  it("with the default module, no model is called and the catalog is not built", async () => {
    useDecisionModelCatalog(undefined);
    expect(getDecisionRegistry().selectedModuleId()).toBe("jev-mock");
    await runCall(["Hi there"]);
    expect(applyDecisionModuleChoice({ env: {} })).toMatchObject({ outcome: "default", selected: "jev-mock" });
  });

  it("an end-to-end call on azure-decision sends the tree's meanings to the deployment", async () => {
    const foundry = createMockFoundryClient({ complete: () => ({ json: { answer: "unclear" } }) });
    useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: azure({ fastDeployment: "fast-1" }), foundry }));
    expect(applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "azure-decision" } }).outcome).toBe("registered_from_catalog");
    await runCall(["Hi there"]);
    expect(foundry.calls.length).toBeGreaterThan(0);
    const sent = JSON.stringify(foundry.calls.map((c) => c.request));
    const someMeaning = tree.nodes[tree.starts!.inbound]!.decision!.answers.find((a) => a.meaning)!.meaning!;
    expect(sent).toContain(someMeaning);
    expect(JSON.stringify(traceBus.history())).not.toContain(someMeaning);
  });
});
