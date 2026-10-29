import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig } from "../../src/config.js";
import { DecisionModuleRegistry, getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { asDecisionModule } from "../../src/decision-models/bridge.js";
import type { DecisionModel, DecisionModelCallOptions, DecisionModelOutcome, DecisionModelRequest } from "../../src/decision-models/types.js";
import { resetAzureHealth, type AzureStatus } from "../../src/server/azure-startup-check.js";
import { CALL_WARMUP_STEP_TIMEOUT_MS, warmUpCall, warmupDecisionRequest, warmupLogLine, type CallWarmupDeps, type CallWarmupResult } from "../../src/server/call-warmup.js";
import { handle } from "../../src/server/dev-server.js";
import { resetVoiceDeps, selectTalkOrchestrator } from "../../src/server/voice/manager.js";
import { VOICE_ERROR_CATALOG } from "../../src/server/voice/voice-errors.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { currentTrace, traceBus, type TraceContext } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const FIXED_REQUEST = {
  nodeId: "warmup",
  question: "Is the caller greeting the agent?",
  answers: ["yes", "unclear"],
  transcript: [{ role: "caller", text: "Hello.", turnIndex: 0 }],
};

/** A real-kind decision model that never touches the network: it answers with whatever the test scripts. */
function fakeModel(answer: (request: DecisionModelRequest, options?: DecisionModelCallOptions) => Promise<DecisionModelOutcome>, kind: "real" | "mock" = "real") {
  const decide = vi.fn(answer);
  const model: DecisionModel = { id: kind === "real" ? "fake-real" : "fake-mock", label: "Fake model", kind, decide };
  return { model, decide };
}

const answered = async (): Promise<DecisionModelOutcome> => ({ ok: true, answer: "yes", confidence: 0.9, reason: "the caller said hello", latencyMs: 5, modelId: "fake" });
const never = <T>() => new Promise<T>(() => {});

/** A registry with the given model registered (through the same bridge the live wiring uses) and selected. */
function registryWith(model: DecisionModel): DecisionModuleRegistry {
  const registry = new DecisionModuleRegistry();
  registry.register(asDecisionModule(model));
  registry.select(model.id);
  return registry;
}

/** Every dependency healthy; each test overrides the one it is about. */
function healthy(patch: Partial<CallWarmupDeps> = {}): CallWarmupDeps {
  return {
    resolveVoiceMode: () => "direct_azure_microphone",
    azureReady: async () => ({ ok: true }),
    getLead: async (id) => ({ id }),
    decisionRegistry: new DecisionModuleRegistry(),
    ...patch,
  };
}

const step = (result: CallWarmupResult, id: string) => result.steps.find((s) => s.id === id)!;

describe("warmUpCall", () => {
  it("answers every step in a fixed order with plain labels, and ok when all pass", async () => {
    const { model } = fakeModel(answered);
    const result = await warmUpCall({ leadId: "lead-1" }, healthy({ decisionRegistry: registryWith(model) }));
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.id, s.label])).toEqual([
      ["voice_path", "Voice path"],
      ["azure", "Azure"],
      ["lead", "Lead"],
      ["decision_model", "Decision model"],
    ]);
    expect(result.steps.every((s) => s.ok && !s.skipped && s.code === undefined && Number.isInteger(s.ms) && s.ms >= 0)).toBe(true);
    expect(step(result, "voice_path").detail).toBe("direct_azure_microphone");
    expect(step(result, "decision_model").detail).toBe("fake-real");
    expect(Number.isInteger(result.totalMs) && result.totalMs >= 0).toBe(true);
  });

  it("runs the steps in parallel: all four start before any of them finishes", async () => {
    const started: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { model } = fakeModel(async () => {
      started.push("decision_model");
      await gate;
      return answered();
    });
    const pending = warmUpCall(
      { leadId: "lead-1" },
      {
        resolveVoiceMode: async () => (started.push("voice_path"), await gate, "direct_azure_microphone"),
        azureReady: async () => (started.push("azure"), await gate, { ok: true }),
        getLead: async (id) => (started.push("lead"), await gate, { id }),
        decisionRegistry: registryWith(model),
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(started.sort()).toEqual(["azure", "decision_model", "lead", "voice_path"]);
    open();
    expect((await pending).ok).toBe(true);
  });

  describe("voice_path", () => {
    it("a catalog code from the voice manager is the code, and its catalog title is the detail", async () => {
      const result = await warmUpCall({}, healthy({ resolveVoiceMode: () => { throw new Error("azure_voice_live_needs_direct"); } }));
      expect(step(result, "voice_path")).toMatchObject({ ok: false, code: "azure_voice_live_needs_direct", detail: VOICE_ERROR_CATALOG.azure_voice_live_needs_direct.title });
      expect(result.ok).toBe(false);
    });

    it("anything that is not a catalog code becomes voice_start_failed, and its text is never passed on", async () => {
      const result = await warmUpCall({}, healthy({ resolveVoiceMode: () => { throw new Error("socket to https://example-host.invalid refused"); } }));
      expect(step(result, "voice_path")).toMatchObject({ ok: false, code: "voice_start_failed", detail: VOICE_ERROR_CATALOG.voice_start_failed.title });
      expect(JSON.stringify(result)).not.toContain("example-host");
      expect(result.ok).toBe(false);
    });

    it("times out on its own limit with code timeout", async () => {
      const result = await warmUpCall({}, healthy({ resolveVoiceMode: () => never<string>(), stepTimeoutMs: 30 }));
      expect(step(result, "voice_path")).toMatchObject({ ok: false, code: "timeout" });
      expect(step(result, "azure").ok).toBe(true);
      expect(result.ok).toBe(false);
    });
  });

  describe("azure", () => {
    it("a failure gives the status code, with its message as the detail", async () => {
      const status: AzureStatus = { ok: false, code: "foundry_auth", message: "Azure is not working: the Azure key does not work.", source: "runtime" };
      const result = await warmUpCall({}, healthy({ azureReady: async () => status }));
      expect(step(result, "azure")).toMatchObject({ ok: false, code: "foundry_auth", detail: status.message });
      expect(result.ok).toBe(false);
    });

    it("keeps a settings code that names the setting in capitals, on the step and in the log line", async () => {
      const status: AzureStatus = { ok: false, code: "foundry_missing_AZURE_FOUNDRY_KEY", message: "Azure is not working: AZURE_FOUNDRY_KEY is missing from the dotenv.", source: "startup" };
      const result = await warmUpCall({}, healthy({ azureReady: async () => status }));
      expect(step(result, "azure")).toMatchObject({ ok: false, code: "foundry_missing_AZURE_FOUNDRY_KEY" });
      expect(warmupLogLine(result)).toMatch(/ azure=foundry_missing_AZURE_FOUNDRY_KEY\/\d+ms /);
    });

    it("a status code that is not code-shaped becomes azure_unavailable", async () => {
      const result = await warmUpCall({}, healthy({ azureReady: async () => ({ ok: false, code: "https://example-host.invalid failed" }) }));
      expect(step(result, "azure")).toMatchObject({ ok: false, code: "azure_unavailable", detail: "Azure is not working." });
      expect(JSON.stringify(result)).not.toContain("example-host");
    });

    it("times out on its own limit with code timeout, and the other steps still answer", async () => {
      const result = await warmUpCall({ leadId: "lead-1" }, healthy({ azureReady: () => never<AzureStatus>(), stepTimeoutMs: 30 }));
      expect(step(result, "azure")).toMatchObject({ ok: false, code: "timeout" });
      expect(step(result, "azure").ms).toBeGreaterThanOrEqual(25);
      expect(step(result, "voice_path").ok).toBe(true);
      expect(step(result, "lead").ok).toBe(true);
      expect(result.ok).toBe(false);
    });
  });

  describe("lead", () => {
    it("is ok when the lead store has the lead", async () => {
      const getLead = vi.fn(async (id: string) => ({ id }));
      const result = await warmUpCall({ leadId: "lead-1" }, healthy({ getLead }));
      expect(getLead).toHaveBeenCalledWith("lead-1");
      expect(step(result, "lead")).toMatchObject({ ok: true });
      expect(step(result, "lead").detail).toBeUndefined();
    });

    it("is lead_not_found when the store has no such lead, and the call may not start", async () => {
      const result = await warmUpCall({ leadId: "lead-404" }, healthy({ getLead: async () => undefined }));
      expect(step(result, "lead")).toMatchObject({ ok: false, code: "lead_not_found", detail: VOICE_ERROR_CATALOG.lead_not_found.title });
      expect(result.ok).toBe(false);
    });

    it.each([undefined, null, ""])("is skipped (ok, 0 milliseconds) when the lead id is %j, and the call may still start", async (leadId) => {
      const getLead = vi.fn(async () => ({}));
      const result = await warmUpCall({ leadId }, healthy({ getLead }));
      expect(step(result, "lead")).toMatchObject({ ok: true, skipped: true, ms: 0 });
      expect(getLead).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it.each([42, "../etc", "a b", "x".repeat(61)])("is bad_lead_id for %j, without asking the store", async (leadId) => {
      const getLead = vi.fn(async () => ({}));
      const result = await warmUpCall({ leadId }, healthy({ getLead }));
      expect(step(result, "lead")).toMatchObject({ ok: false, code: "bad_lead_id" });
      expect(getLead).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });

    it("a store that throws keeps a code-shaped message, and anything else becomes lead_store_failed", async () => {
      const coded = await warmUpCall({ leadId: "lead-1" }, healthy({ getLead: async () => { throw new Error("crm_dev_credentials_missing"); } }));
      expect(step(coded, "lead")).toMatchObject({ ok: false, code: "crm_dev_credentials_missing" });
      const raw = await warmUpCall({ leadId: "lead-1" }, healthy({ getLead: () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432"); } }));
      expect(step(raw, "lead")).toMatchObject({ ok: false, code: "lead_store_failed" });
      expect(JSON.stringify(raw)).not.toContain("10.1.2.3");
      expect(raw.ok).toBe(false);
    });

    it("times out on its own limit with code timeout", async () => {
      const result = await warmUpCall({ leadId: "lead-1" }, healthy({ getLead: () => never(), stepTimeoutMs: 30 }));
      expect(step(result, "lead")).toMatchObject({ ok: false, code: "timeout" });
      expect(result.ok).toBe(false);
    });
  });

  describe("decision_model", () => {
    it("asks a real model once, with the fixed request and the step's limit, and keeps neither its answer nor its reason", async () => {
      const { model, decide } = fakeModel(answered);
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(model) }));
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide.mock.calls[0]![0]).toEqual(FIXED_REQUEST);
      expect(decide.mock.calls[0]![1]).toEqual({ timeoutMs: CALL_WARMUP_STEP_TIMEOUT_MS });
      expect(step(result, "decision_model")).toMatchObject({ ok: true, detail: "fake-real" });
      expect(JSON.stringify(result)).not.toContain("said hello");
    });

    it("hands out a fresh request each time, so a model cannot change the next one", () => {
      const first = warmupDecisionRequest();
      first.answers.push("no");
      expect(warmupDecisionRequest()).toEqual(FIXED_REQUEST);
    });

    it("skips the keyword module without asking anything, and the call may still start", async () => {
      const result = await warmUpCall({}, healthy({ decisionRegistry: new DecisionModuleRegistry() }));
      expect(step(result, "decision_model")).toMatchObject({ ok: true, skipped: true, ms: 0 });
      expect(result.ok).toBe(true);
    });

    it("skips a mock-kind model without calling it", async () => {
      const { model, decide } = fakeModel(answered, "mock");
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(model) }));
      expect(step(result, "decision_model")).toMatchObject({ ok: true, skipped: true });
      expect(decide).not.toHaveBeenCalled();
    });

    it("a model failure is a warning with its short code: the call may still start", async () => {
      const { model } = fakeModel(async () => ({ ok: false, reason: "error", code: "rate_limit", latencyMs: 3, modelId: "fake" }));
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(model) }));
      expect(step(result, "decision_model")).toMatchObject({ ok: false, code: "rate_limit" });
      expect(result.ok).toBe(true);
    });

    it("a failure with no code uses the reason; a code that is not code-shaped is never passed on", async () => {
      const noCode = fakeModel(async () => ({ ok: false, reason: "timeout", latencyMs: 8000, modelId: "fake" }));
      expect(step(await warmUpCall({}, healthy({ decisionRegistry: registryWith(noCode.model) })), "decision_model")).toMatchObject({ ok: false, code: "timeout" });
      const badCode = fakeModel(async () => ({ ok: false, reason: "error", code: "Upstream said: https://example-host.invalid", latencyMs: 3, modelId: "fake" }));
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(badCode.model) }));
      expect(step(result, "decision_model")).toMatchObject({ ok: false, code: "error" });
      expect(JSON.stringify(result)).not.toContain("example-host");
    });

    it("a model that throws is code error, and the call may still start", async () => {
      const { model } = fakeModel(async () => { throw new Error("boom"); });
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(model) }));
      expect(step(result, "decision_model")).toMatchObject({ ok: false, code: "error" });
      expect(result.ok).toBe(true);
    });

    it("times out on its own limit with code timeout, and the call may still start", async () => {
      const { model } = fakeModel(() => never());
      const result = await warmUpCall({}, healthy({ decisionRegistry: registryWith(model), stepTimeoutMs: 30 }));
      expect(step(result, "decision_model")).toMatchObject({ ok: false, code: "timeout" });
      expect(result.ok).toBe(true);
    });
  });

  describe("warmupLogLine", () => {
    it("names each step with its milliseconds, skipped, or its code, and never a detail", async () => {
      const result = await warmUpCall(
        { leadId: "lead-404" },
        healthy({ getLead: async () => undefined, azureReady: async () => ({ ok: false, code: "foundry_auth", message: "Azure is not working: the key." }) }),
      );
      const line = warmupLogLine(result);
      expect(line).toMatch(/^call warmup ok=no voice_path=\d+ms azure=foundry_auth\/\d+ms lead=lead_not_found\/\d+ms decision_model=skipped total=\d+ms$/);
      expect(line).not.toContain("Azure is not working");
      expect(line).not.toContain(VOICE_ERROR_CATALOG.lead_not_found.title);
      expect(line).not.toContain("direct_azure_microphone");
    });
  });
});

describe("POST /api/call/warmup", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    // Direct orchestrator on the default Azure gpt-live path: the mode does not depend on whether Pipecat is set up here.
    resetVoiceDeps();
    selectTalkOrchestrator("direct");
    resetHarnessConfig();
    resetLeadStore();
    seedLead(baseLead());
    // Azure counts as working, so the azure step never runs the network check.
    resetAzureHealth();
    resetDecisionRegistry();
  });
  afterEach(() => {
    resetDecisionRegistry();
    vi.restoreAllMocks();
  });

  const post = (body: unknown) =>
    fetch(base + "/api/call/warmup", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  const warmupLines = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("call warmup"));

  it("answers 200 with every step for a known lead, and writes one log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ leadId: "lead-1" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.steps).toEqual([
      { id: "voice_path", label: "Voice path", ok: true, ms: expect.any(Number), detail: "direct_azure_microphone" },
      { id: "azure", label: "Azure", ok: true, ms: expect.any(Number) },
      { id: "lead", label: "Lead", ok: true, ms: expect.any(Number) },
      { id: "decision_model", label: "Decision model", ok: true, skipped: true, ms: 0, detail: "Decision module jev-mock is not a real model." },
    ]);
    expect(typeof res.json.totalMs).toBe("number");
    const lines = warmupLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^call warmup ok=yes voice_path=\d+ms azure=\d+ms lead=\d+ms decision_model=skipped total=\d+ms$/);
  });

  it("an unknown lead is still 200, with ok false and lead_not_found", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({ leadId: "lead-404" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.steps[2]).toMatchObject({ id: "lead", ok: false, code: "lead_not_found" });
    expect(warmupLines(log)[0]).toMatch(/^call warmup ok=no .*lead=lead_not_found\/\d+ms/);
  });

  it("with no lead id the lead step is skipped and the call may start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.steps[2]).toMatchObject({ id: "lead", ok: true, skipped: true, ms: 0 });
  });

  it("warms the selected real model once, outside any traced run: no trace event and no question or answer in the log", async () => {
    const seen: Array<TraceContext | undefined> = [];
    const { model, decide } = fakeModel(async () => {
      seen.push(currentTrace());
      return answered();
    });
    getDecisionRegistry().register(asDecisionModule(model));
    getDecisionRegistry().select(model.id);
    const events: unknown[] = [];
    const unsubscribe = traceBus.subscribe((e) => events.push(e));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await post({ leadId: "lead-1" });
      expect(res.json.steps[3]).toMatchObject({ id: "decision_model", ok: true, detail: "fake-real" });
      expect(res.json.ok).toBe(true);
    } finally {
      unsubscribe();
    }
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toEqual(FIXED_REQUEST);
    expect(seen).toEqual([undefined]);
    expect(events).toEqual([]);
    const lines = warmupLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^call warmup ok=yes .*decision_model=\d+ms total=\d+ms$/);
    const everything = log.mock.calls.flat().map(String).join("\n");
    expect(everything).not.toContain(FIXED_REQUEST.question);
    expect(everything).not.toContain("Hello.");
    expect(everything).not.toContain("said hello");
  });

  it("a body that is not JSON is a 400, like the other routes", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });
});
