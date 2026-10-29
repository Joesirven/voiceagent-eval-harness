import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAzureCatalog, setAzureCatalogDeps } from "../../src/modules/azure-catalog.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import {
  chosenDecisionRouter,
  resetDecisionRouterChoices,
  storeDecisionRouter,
  WIRED_DECISION_ROUTERS,
} from "../../src/server/voice/decision-router.js";
import { DeepgramLiveSession } from "../../src/server/voice/deepgram-voice-session.js";
import { DeepgramVoiceRuntime } from "../../src/server/voice/deepgram-voice-runtime.js";
import { resetTalkOrchestrator, resetVoiceDeps, setVoiceDeps } from "../../src/server/voice/manager.js";
import { recentVoiceErrors, resetVoiceErrors, VOICE_ERROR_CATALOG } from "../../src/server/voice/voice-errors.js";
import type { ProviderCatalog, VoiceOptions, VoicePathOption } from "../../src/server/voice/voice-options.js";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";

// No test here reaches Deepgram or Azure: both catalogs answer with fixed lists.
vi.mock("../../src/modules/deepgram-catalog.js", () => ({
  loadDeepgramCatalog: async (): Promise<ProviderCatalog> => ({
    status: { provider: "deepgram", ok: true, checkedAt: "2026-10-20T00:00:00.000Z" },
    models: [
      { id: "nova-3-general", label: "nova-3-general", role: "speech_to_text", provider: "deepgram" },
      { id: "aura-2", label: "Aura-2", role: "text_to_speech", provider: "deepgram", voices: ["aura-2-thalia-en"] },
    ],
  }),
}));

const LISTING = {
  data: ["gpt-live-1", "gpt-5.4-mini"].map((id) => ({ id, model: id, status: "succeeded", object: "deployment" })),
  object: "list",
};

function useFakeAzure(): void {
  const dir = mkdtempSync(join(tmpdir(), "decision-router-"));
  const file = join(dir, "dev.env");
  writeFileSync(file, "AZURE_FOUNDRY_URL=https://decision-router-test.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=test-key\n", { mode: 0o600 });
  const fetchListing = (async () =>
    new Response(JSON.stringify(LISTING), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  setAzureCatalogDeps({ env: { VOICE_HARNESS_DEV_ENV_FILE: file }, fetch: fetchListing });
}

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  resetAzureCatalog();
  resetModuleRegistry();
  resetTalkOrchestrator();
  resetVoiceDeps();
  resetDecisionRouterChoices();
  resetVoiceErrors();
  // Any existing absolute path makes Pipecat available; a runtime factory makes the Deepgram path available.
  vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath);
  setVoiceDeps({ deepgramRuntime: () => ({}) as never });
  useFakeAzure();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  // Restored here, not in the test body, so a failed assertion cannot leave a router wired for later tests.
  WIRED_DECISION_ROUTERS.clear();
  WIRED_DECISION_ROUTERS.add("decision_model");
  resetDecisionRouterChoices();
  resetAzureCatalog();
  resetVoiceDeps();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const getOptions = async () => (await (await fetch(base + "/api/voice/options")).json()) as VoiceOptions;
const choose = async (body: unknown) => {
  const res = await fetch(base + "/api/voice/decision-router", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as VoiceOptions & { error?: string } };
};
const pathsNamed = (options: VoiceOptions, id: string): VoicePathOption[] =>
  options.orchestrators.flatMap((o) => o.voicePaths).filter((p) => p.id === id);
const deepgramPath = (options: VoiceOptions) => options.orchestrators.find((o) => o.id === "pipecat")!.voicePaths.find((p) => p.id === "deepgram")!;

describe("decision router setting", () => {
  it("GET /api/voice/options lists the routers on both voice paths with their availability", async () => {
    const options = await getOptions();
    const lives = pathsNamed(options, "azure_gpt_live");
    expect(lives).toHaveLength(2); // under Direct Azure and under Pipecat
    for (const live of lives) {
      expect(live.decisionRouters).toEqual({
        options: [{ id: "decision_model", label: "Decision model", available: true }],
        defaultId: "decision_model",
        selectedId: "decision_model",
      });
    }
    const deepgram = deepgramPath(options);
    expect(deepgram.decisionRouters!.defaultId).toBe("decision_model");
    expect(deepgram.decisionRouters!.selectedId).toBe("decision_model");
    expect(deepgram.decisionRouters!.options.map((o) => [o.id, o.available])).toEqual([
      ["decision_model", true],
      ["pipecat_flows", false],
      ["pipecat_classifier", false],
    ]);
    for (const o of deepgram.decisionRouters!.options.filter((r) => !r.available)) expect(o.detail).toMatch(/not wired into the Deepgram sidecar yet/);
  });

  it("POST decision_model on Deepgram succeeds and is the selected router", async () => {
    const res = await choose({ voicePathId: "deepgram", decisionRouterId: "decision_model", source: "test" });
    expect(res.status).toBe(200);
    expect(deepgramPath(res.json).decisionRouters!.selectedId).toBe("decision_model");
    expect(chosenDecisionRouter("deepgram")).toBe("decision_model");
    expect(console.log).toHaveBeenCalledWith("decision router changed path=deepgram old=decision_model new=decision_model source=test");
  });

  it("refuses Pipecat Flows on Azure gpt-live with decision_router_not_supported and the unchanged options", async () => {
    const res = await choose({ voicePathId: "azure_gpt_live", decisionRouterId: "pipecat_flows" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("decision_router_not_supported");
    expect(pathsNamed(res.json, "azure_gpt_live")[0]!.decisionRouters!.selectedId).toBe("decision_model");
    expect(chosenDecisionRouter("azure_gpt_live")).toBe("decision_model");
    expect(recentVoiceErrors().map((e) => e.code)).toEqual(["decision_router_not_supported"]);
  });

  it.each([
    [{ voicePathId: "deepgram", decisionRouterId: "coin_toss" }],
    [{ voicePathId: "vapi", decisionRouterId: "decision_model" }],
    [{ voicePathId: "deepgram" }],
    [{}],
  ])("refuses %j with decision_router_unknown", async (body) => {
    const res = await choose(body);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("decision_router_unknown");
    expect(res.json.orchestrators.length).toBeGreaterThan(0);
  });

  it("refuses Pipecat Flows on Deepgram while it is not wired, and accepts it once the switch is flipped", async () => {
    const refused = await choose({ voicePathId: "deepgram", decisionRouterId: "pipecat_flows" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("decision_router_unavailable");
    expect(deepgramPath(refused.json).decisionRouters!.selectedId).toBe("decision_model");

    WIRED_DECISION_ROUTERS.add("pipecat_flows");
    const ok = await choose({ voicePathId: "deepgram", decisionRouterId: "pipecat_flows" });
    expect(ok.status).toBe(200);
    const routers = deepgramPath(ok.json).decisionRouters!;
    expect(routers.selectedId).toBe("pipecat_flows");
    expect(routers.options.find((o) => o.id === "pipecat_flows")).toEqual({ id: "pipecat_flows", label: "Pipecat Flows", available: true });
    expect(chosenDecisionRouter("deepgram")).toBe("pipecat_flows");
    // Still not offered on the speech to speech path.
    expect((await choose({ voicePathId: "azure_gpt_live", decisionRouterId: "pipecat_flows" })).json.error).toBe("decision_router_not_supported");

    // Unwired again: the stored choice falls back to the decision model, in the options and for the session alike.
    WIRED_DECISION_ROUTERS.delete("pipecat_flows");
    expect(chosenDecisionRouter("deepgram")).toBe("decision_model");
    expect(deepgramPath(await getOptions()).decisionRouters!.selectedId).toBe("decision_model");
  });

  it("the voice error catalog has the three decision router codes", () => {
    for (const code of ["decision_router_not_supported", "decision_router_unknown", "decision_router_unavailable"] as const) {
      const e = VOICE_ERROR_CATALOG[code];
      expect(e.title.length).toBeGreaterThan(5);
      expect(e.what.length).toBeGreaterThan(15);
      expect(e.fix).toMatch(/[.]$/);
    }
  });
});

describe("the Deepgram session records which router ran", () => {
  const fakeSidecar = fileURLToPath(new URL("../helpers/fake-deepgram-sidecar.mjs", import.meta.url));

  async function openEvent(callId: string): Promise<TraceEvent> {
    const events: TraceEvent[] = [];
    const unsubscribe = traceBus.subscribe((e) => {
      if (e.callId === callId) events.push(e);
    });
    const logFile = join(mkdtempSync(join(tmpdir(), "dg-router-")), "received.jsonl");
    const session = new DeepgramLiveSession({
      trace: { leadId: "lead-1", recordId: callId, channel: "call", direction: "inbound", callId },
      instructions: "Be brief.",
      disclosure: "Hi, I am an AI assistant.",
      maxMs: 60_000,
      startTimeoutMs: 1500,
      dialogOwnsTranscript: false,
      onAudio: () => undefined,
      onClearPlayback: () => undefined,
      onEnd: () => undefined,
      runtime: new DeepgramVoiceRuntime(() => ({
        command: process.execPath,
        args: [fakeSidecar],
        env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_MODE: "" },
      })),
    });
    try {
      await session.start();
    } finally {
      session.stop();
      unsubscribe();
    }
    return events.find((e) => e.type === "tool_call" && e.data.tool === "voice_session_open")!;
  }

  it("voice_session_open carries the chosen decision router", async () => {
    expect((await openEvent("call_dg_router_1")).data).toMatchObject({ success: true, inputs: { provider: "deepgram", decisionRouter: "decision_model" } });
    WIRED_DECISION_ROUTERS.add("pipecat_flows");
    storeDecisionRouter("deepgram", "pipecat_flows");
    expect((await openEvent("call_dg_router_2")).data).toMatchObject({ inputs: { decisionRouter: "pipecat_flows" } });
  });
});
