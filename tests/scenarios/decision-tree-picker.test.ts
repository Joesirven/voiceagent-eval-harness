import { mkdtempSync } from "node:fs";
import { controlPageBundle } from "../helpers/control-page.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { startInteractiveCall, type InteractiveCall } from "../../src/decision/interactive.js";
import {
  FULL_TREE_FILE,
  STUB_TREE_FILE,
  listDecisionTrees,
  loadActiveTree,
  resetActiveTree,
  selectDecisionTree,
  selectDecisionTreeForTest,
  selectedDecisionTreeId,
} from "../../src/decision/tree-source.js";
import { resetJudges } from "../../src/judge/index.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "decision-tree-picker-test-")));
  traceBus.reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) =>
    String(input).startsWith(base) ? realFetch(input, init) : Promise.reject(new Error("no network in this test"))) as typeof fetch);
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});
const realFetch = globalThis.fetch;

const open: InteractiveCall[] = [];
afterEach(async () => {
  for (const call of open.splice(0)) if (call.status === "connected") await call.hangUp();
  vi.restoreAllMocks();
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
});

const post = (path: string, body: unknown = {}) =>
  realFetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
const getState = async () => (await realFetch(base + "/api/state")).json() as Promise<any>;

const startCall = async () => {
  const harness = new CallHarness({ now: () => new Date(IN_WINDOW) }, undefined, getModuleRegistry());
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness });
  open.push(call);
  return call;
};
const nodesEntered = (call: InteractiveCall) =>
  traceBus.history().filter((e) => e.callId === call.callId && e.type === "node_enter").map((e) => String(e.data.nodeId));

describe("decision tree picker", () => {
  it("boots on the full tree, and the live list holds only that one tree (113 nodes)", async () => {
    expect(selectedDecisionTreeId()).toBe("full");
    const state = await getState();
    expect(state.selectedDecisionTreeId).toBe("full");
    expect(state.decisionTrees.map((t: any) => t.id)).toEqual(["full"]);
    expect(state.decisionTrees[0].nodeCount).toBe(113);
    // The stub and the fixture stay available to tests and tools, not to the server.
    expect(listDecisionTrees().map((t) => t.id)).toEqual(["full", "stub", "fixture"]);
  });

  it("serves the full tree on /api/tree", async () => {
    const full = await (await realFetch(base + "/api/tree")).json() as any;

    expect(full.nodes.length).toBeGreaterThanOrEqual(113);
  });

  it("shows one read-only line on the Call tab, with no tree select", async () => {
    const html = await controlPageBundle(base, realFetch);
    expect(html).toContain("stackDecisionTree");
    expect(html).not.toContain("/api/decision-tree/select");
  });

  it("refuses the stub and the fixture through the route and through selectDecisionTree", async () => {
    for (const id of ["stub", "fixture", "nope"]) {
      const bad = await post("/api/decision-tree/select", { decisionTreeId: id });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe("unknown_decision_tree");
      expect(() => selectDecisionTree(id)).toThrow("unknown_decision_tree");
    }
    expect((await post("/api/decision-tree/select", { decisionTreeId: "full" })).status).toBe(200);
    expect((await getState()).selectedDecisionTreeId).toBe("full");
  });

  it("the test-only path still selects the stub and the fixture", () => {
    selectDecisionTreeForTest("stub");
    expect(selectedDecisionTreeId()).toBe("stub");
    selectDecisionTreeForTest("fixture");
    expect(selectedDecisionTreeId()).toBe("fixture");
  });

  it("applies a switch to the next call, not to a call in progress", async () => {
    selectDecisionTreeForTest("stub");
    const first = await startCall();
    selectDecisionTreeForTest("fixture");
    await first.say("hello");
    selectDecisionTreeForTest("stub");
    const stubNodes = Object.keys(loadActiveTree().nodes);
    selectDecisionTreeForTest("fixture");
    const firstNodes = nodesEntered(first);
    expect(firstNodes.length).toBeGreaterThan(0);
    for (const id of firstNodes) expect(stubNodes).toContain(id);

    await first.hangUp();
    const second = await startCall();
    await second.say("hello");
    const fixtureNodes = Object.keys(loadActiveTree().nodes);
    const secondNodes = nodesEntered(second);
    expect(secondNodes.length).toBeGreaterThan(0);
    for (const id of secondNodes) expect(fixtureNodes).toContain(id);
  });

  it("uses VOICE_HARNESS_DECISION_TREE as the boot choice and shows an unknown path as custom", () => {
    process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE;
    resetActiveTree();
    expect(selectedDecisionTreeId()).toBe("stub");
    expect(loadActiveTree().id).toBe("stub-tree");
    selectDecisionTree("full");
    expect(selectedDecisionTreeId()).toBe("full");

    process.env.VOICE_HARNESS_DECISION_TREE = FULL_TREE_FILE.replace("full-tree.json", "../decision-tree/full-tree.json");
    resetActiveTree();
    expect(selectedDecisionTreeId()).toBe("custom");
    expect(listDecisionTrees().map((t) => t.id)).toEqual(["full", "stub", "fixture", "custom"]);
    expect(loadActiveTree().nodes).toBeDefined();
  });
});
