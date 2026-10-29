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
import { startInteractiveCall } from "../../src/decision/interactive.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { createDecisionModelCatalog } from "../../src/decision-models/index.js";
import { createMockFoundryClient } from "../../src/models/foundry.js";
import { getActionJudge, resetJudges } from "../../src/judge/index.js";
import { handle } from "../../src/server/dev-server.js";
import { installLiveJudge, liveJudgeModel, LIVE_DECISION_TIMEOUT_MS, useDecisionModelCatalog } from "../../src/server/live-judge-wiring.js";
import { markAzureFailed, resetAzureHealth } from "../../src/server/azure-startup-check.js";
import { judgeLine, judgeRows } from "../../src/server/live-view-core.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const realFetch = globalThis.fetch;

const azure = (): AzureCredentials =>
  ({
    foundryUrl: "https://x.openai.azure.com/openai/v1",
    decisionUrl: "https://x.openai.azure.com/providers/microsoft/v1/systemone",
    apiKey: "k",
    fastDeployment: "fast-1",
  }) as AzureCredentials;

/** A stand-in catalog that reports Azure configured, answering through the mock Foundry client (no network). */
const configuredCatalog = (answer = "allow") => {
  const foundry = createMockFoundryClient({ complete: () => ({ json: { answer, confidence: 0.9 } }) });
  useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: azure(), foundry }));
  return foundry;
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "live-judge-wiring-test-")));
  traceBus.reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) =>
    String(input).startsWith(base) ? realFetch(input, init) : Promise.reject(new Error("no network in this test"))) as typeof fetch);
  // No credential: the catalog reports no Azure, so there is no judge model.
  useDecisionModelCatalog(createDecisionModelCatalog({ credentials: {}, azure: null }));
  process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE; // these paths use the stub tree's booking
  delete process.env.VOICE_HARNESS_DECISION_MODULE; // the opt-in must never come from the developer's shell in a test
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

// The action judge is global state: put the rule judge back after every test.
afterEach(() => {
  vi.restoreAllMocks();
  useDecisionModelCatalog(undefined);
  resetDecisionRegistry();
  resetJudges();
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
});

const getState = async () => (await realFetch(`${base}/api/state`)).json() as Promise<any>;

const play = async (lines: string[]) => {
  const harness = new CallHarness({ now: () => new Date(IN_WINDOW) }, undefined, getModuleRegistry());
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness });
  for (const line of lines) await call.say(line);
  const events: TraceEvent[] = traceBus.history().filter((e) => e.callId === call.callId);
  if (call.status === "connected") await call.hangUp();
  return events;
};

describe("with Azure configured", () => {
  it("makes azure-decision the selected decision module and the judge's model, and lists no mock and one tree", async () => {
    configuredCatalog();
    installLiveJudge();
    expect(getActionJudge().id).toBe("live-decision-model");
    expect(getDecisionRegistry().selectedModuleId()).toBe("azure-decision");
    expect(liveJudgeModel()?.id).toBe("azure-decision");
    expect(liveJudgeModel()?.kind).toBe("real");

    const state = await getState();
    expect(state.decisionModules.map((d: any) => d.id)).toEqual(["azure-decision"]);
    expect(state.decisionModules[0]).toMatchObject({ selected: true, available: true });
    expect(state.decisionModuleStatus).toEqual({ selected: "azure-decision", available: true });
    expect(state.decisionTrees).toHaveLength(1);
    expect(state.decisionTrees[0]).toMatchObject({ id: "full", nodeCount: 9 });
    expect(JSON.stringify([state.decisionModules, state.decisionModuleStatus])).not.toMatch(/mock/i);
  });

  it("gives the module a 6000 millisecond limit per decision", async () => {
    const foundry = configuredCatalog();
    installLiveJudge();
    expect(LIVE_DECISION_TIMEOUT_MS).toBe(6000);
    await getDecisionRegistry().get("azure-decision").decide({ nodeId: "n", question: "q", answers: ["yes", "no", "unclear"], transcript: [{ role: "caller", text: "yes", turnIndex: 0 }] });
    expect((foundry.calls.at(-1)!.request as { timeoutMs?: number }).timeoutMs).toBe(6000);
  });

  it("a booking is judged by the Azure model, and books", async () => {
    configuredCatalog();
    installLiveJudge();
    // Only the judge is under test: the tree's questions use the keyword rules a test registered explicitly.
    getDecisionRegistry().select("jev-mock");
    const events = await play(["Hi", "I want to book an appointment", "tomorrow at 3 pm", "yes"]);
    const verdict = events.find((e) => e.type === "judge_verdict" && e.data.action === "book")!;
    expect(verdict.data.allowed).toBe(true);
    const decision = events.find((e) => e.type === "decision" && e.data.kind === "live_judge" && e.data.action === "book")!;
    expect(decision.data).toMatchObject({ modelId: "azure-decision", modelKind: "real", answer: "allow", allowed: true });
    expect(getLead("lead-1")!.bookings).toHaveLength(1);
  });
});

describe("with no Azure credential", () => {
  it("installLiveJudge refuses: there is no keyword fallback on the live path", async () => {
    expect(() => installLiveJudge()).toThrow("azure_decision_model_unavailable");
    expect(getActionJudge().id).not.toBe("live-decision-model");
    expect(getDecisionRegistry().list().map((m) => m.id)).not.toContain("keyword-no-credential");
    expect(liveJudgeModel()).toBeNull();
  });
});

describe("when Azure stops working while the server runs", () => {
  afterEach(() => resetAzureHealth());

  it("the decision status and the module list say so", async () => {
    configuredCatalog();
    installLiveJudge();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    markAzureFailed("foundry_auth");
    const state = await getState();
    expect(state.decisionModuleStatus).toMatchObject({ selected: "azure-decision", available: false, reason: "azure_unavailable", azureCode: "foundry_auth" });
    expect(state.decisionModuleStatus.message).toContain("Azure is not working");
    expect(state.decisionModules[0].available).toBe(false);
  });
});

describe("the judge install", () => {
  it("resetJudges puts the rule judge back", () => {
    configuredCatalog();
    installLiveJudge();
    resetJudges();
    expect(getActionJudge().id).not.toBe("live-decision-model");
  });
});
