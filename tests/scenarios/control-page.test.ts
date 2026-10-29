import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { resetTalkOrchestrator } from "../../src/server/voice/manager.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  resetHarnessConfig();
  setAiCallingEnabled("agency-demo", true);
  resetModuleRegistry();
  resetTalkOrchestrator();
});

const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    json: (await r.json()) as any,
  }));

describe("control page server", () => {
  it("serves the static page and state", async () => {
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    // The page is the built front end: its script and style files come from /assets/.
    const script = /src="(\/assets\/[\w.-]+\.js)"/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const bundle = await fetch(base + script!);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect(await bundle.text()).toContain("/api/state");
    expect((await fetch(base + "/assets/nope.js")).status).toBe(404);
    const voiceClient = await fetch(base + "/voice-client.js");
    const js = await voiceClient.text();
    expect(js).toContain("AudioWorklet");
    expect(js).not.toMatch(/catch\s*\{\s*say\("No microphone"\)/);
    const state = await (await fetch(base + "/api/state")).json();
    // Where run records go, by name only.
    expect(state.runStore).toMatchObject({ kind: "local", table: "voice_harness.harness_run" });
    expect(typeof state.runStore.writeBack).toBe("boolean");
    expect(JSON.stringify(state.runStore)).not.toMatch(/pooler|supabase\.co|password|PGPASSWORD/i);
    expect(state.modules).toHaveLength(8);
    expect(state.selectedModuleId).toBe("azure-gpt-live");
    expect(state.modules[0].modelChoices.length).toBeGreaterThan(0);
    expect(state.orchestrators).toHaveLength(2);
    const pipecatAvailable = state.orchestrators.find((o: any) => o.id === "pipecat").available;
    expect(state.selectedOrchestratorId).toBe(pipecatAvailable ? "pipecat" : "direct");
    expect(state.scenarios.length).toBeGreaterThanOrEqual(7);
  });

  it("shows and switches the stale-output drop after a barge-in", async () => {
    const { resetStaleOutputDrop } = await import("../../src/server/voice/manager.js");
    try {
      const state = await (await fetch(base + "/api/state")).json();
      expect(state.selectedStaleOutputDropId).toBe("one_gap");
      expect(state.staleOutputDrops.map((d: { id: string }) => d.id)).toEqual(["off", "one_gap", "two_gaps"]);
      const switched = await post("/api/voice/stale-output-drop", { staleOutputDropId: "off" });
      expect(switched.json.selectedStaleOutputDropId).toBe("off");
      const bad = await post("/api/voice/stale-output-drop", { staleOutputDropId: "forever" });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect((await (await fetch(base + "/api/state")).json()).selectedStaleOutputDropId).toBe("off");
    } finally {
      resetStaleOutputDrop();
    }
  });

  it("serves the deterministic scenarios page and links it from the control page", async () => {
    const page = await fetch(base + "/simulator");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Deterministic scenarios");
    expect(html).toContain("/api/scenarios/");
    const home = await (await fetch(base + "/")).text();
    const script = /src="(\/assets\/[\w.-]+\.js)"/.exec(home)![1]!;
    expect(await (await fetch(base + script)).text()).toContain("/simulator");
  });

  it("selects orchestrator and module model from the stack controls API", async () => {
    const orch = await post("/api/orchestration/select", { orchestratorId: "direct" });
    expect(orch.status).toBe(200);
    expect(orch.json.selectedOrchestratorId).toBe("direct");
    // The menu lists only live deployments (here no Azure settings, so the fallback gpt-live-1):
    // Azure refuses a session start naming any other model, so the server refuses it on save.
    const state = await (await fetch(base + "/api/state")).json();
    const live = state.modules.find((m: any) => m.id === "azure-gpt-live");
    expect(live.modelChoices).toEqual(["gpt-live-1"]);
    const refused = await post("/api/modules/azure-gpt-live", { model: "gpt-realtime" });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("azure_model_not_deployed");
    const model = await post("/api/modules/azure-gpt-live", { model: "gpt-live-1" });
    expect(model.json.modules.find((m: any) => m.id === "azure-gpt-live").config.model).toBe("gpt-live-1");

    // Every setting that changes is one log line with the old value, the new value and who asked.
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await post("/api/modules/azure-gpt-live", { model: "gpt-live-1", voice: "marin", source: "settings-sheet" });
    await post("/api/modules/azure-gpt-live", { voice: "coral" });
    const changes = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("module setting changed"));
    expect(changes).toEqual([
      "module setting changed module=azure-gpt-live field=voice old=verse new=marin source=settings-sheet",
      "module setting changed module=azure-gpt-live field=voice old=marin new=coral source=unknown",
    ]);
    logged.mockRestore();
    expect((await post("/api/orchestration/select", { orchestratorId: "nope" })).status).toBe(400);
  });

  it("edits azure gpt-live, flips the flag, and runs every scenario with a log", async () => {
    const edited = await post("/api/modules/azure-gpt-live", { voice: "marin" });
    expect(edited.json.modules.find((m: any) => m.id === "azure-gpt-live").config.voice).toBe("marin");
    expect((await post("/api/modules/azure-gpt-live", { voice: "" })).status).toBe(400);
    const nonsense = await post("/api/modules/azure-gpt-live", { voice: "nonsense" });
    expect(nonsense.status).toBe(400);
    expect(nonsense.json.error).toBe("voice_not_offered");
    expect((await post("/api/modules/azure-gpt-live", { voice: "voice_abc" })).json.modules.find((m: any) => m.id === "azure-gpt-live").config.voice).toBe("voice_abc");

    const ran = await post("/api/scenarios/recognized-inbound/run");
    expect(ran.json.summary).toContain("azure-gpt-live");
    expect(ran.json.logs.length).toBeGreaterThan(0);

    const off = await post("/api/flag", { agencyId: "agency-demo", enabled: false });
    expect(off.json.agencies[0].aiCallingEnabled).toBe(false);
    const fallback = await post("/api/scenarios/flag-off/run");
    expect(fallback.json.summary).toContain("normal_answering");
    expect(fallback.json.logs.some((l: any) => l.reason === "ai_calling_disabled_normal_answering")).toBe(true);

    await post("/api/flag", { agencyId: "agency-demo", enabled: true });
    const state = await (await fetch(base + "/api/state")).json();
    for (const s of state.scenarios) {
      const r = await post(`/api/scenarios/${s.id}/run`);
      expect(r.status, s.id).toBe(200);
      expect(r.json.logs.length, s.id).toBeGreaterThan(0);
    }
  });

  it("rejects requests whose Host or Origin is not loopback on this port", async () => {
    const port = (server.address() as AddressInfo).port;
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/state", headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await send({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await send({ host: `evil.example:${port}` })).toBe(403);
    expect(await send({ host: `127.0.0.1:${port}`, origin: "http://evil.example" })).toBe(403);
    expect(await send({ host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` })).toBe(200);
  });

});
