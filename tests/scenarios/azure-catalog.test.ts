import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { azureCatalogSnapshot, liveModelIds, loadAzureCatalog, resetAzureCatalog, roleOfModel, setAzureCatalogDeps } from "../../src/modules/azure-catalog.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { resetTalkOrchestrator, resetVoiceDeps, selectTalkOrchestrator, setVoiceDeps } from "../../src/server/voice/manager.js";
import { chosenPathModel, deepgramReplyDeployment, storePathModel } from "../../src/server/voice/path-model-choices.js";
import type { ProviderCatalog, VoiceOptions } from "../../src/server/voice/voice-options.js";

// No test here reaches Deepgram: its catalog answers with a fixed list.
vi.mock("../../src/modules/deepgram-catalog.js", () => ({
  loadDeepgramCatalog: async (): Promise<ProviderCatalog> => ({
    status: { provider: "deepgram", ok: true, checkedAt: "2026-10-20T00:00:00.000Z" },
    models: [
      { id: "nova-3-general", label: "nova-3-general", role: "speech_to_text", provider: "deepgram" },
      { id: "aura-2", label: "Aura-2", role: "text_to_speech", provider: "deepgram", voices: ["aura-2-thalia-en", "aura-2-orion-en"] },
    ],
  }),
}));

const KEY = "test-key-that-must-not-surface";
const HOST = "example-catalog-test.openai.azure.com";

/** A settings file like the real one, with a fake resource and key. */
function settingsFile(extra = ""): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "azure-catalog-"));
  const file = join(dir, "dev.env");
  writeFileSync(file, `AZURE_FOUNDRY_URL=https://${HOST}/openai/v1\nAZURE_FOUNDRY_KEY=${KEY}\n${extra}`, { mode: 0o600 });
  return { VOICE_HARNESS_DEV_ENV_FILE: file };
}

/** What the data-plane deployment listing answers: deployment name in id, base model in model. */
const REAL_NAMES = [
  "gpt-5.6-luna", "gpt-live-1", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-4o-transcribe", "gpt-realtime-2.1", "gpt-realtime-2.1-mini",
  "gpt-realtime-translate", "gpt-live-transcribe", "gpt-transcribe", "gpt-4o-transcribe-diarize", "gpt-4o-mini-transcribe",
  "gpt-4o-mini-tts", "gpt-audio-1.5", "gpt-audio-mini",
];
/** The resource's real deployment listing (2026-10-20, 15 deployments, names only), plus two cases it lacks. */
const LISTING = {
  data: [
    ...REAL_NAMES.map((id) => ({ id, model: id, status: "succeeded", object: "deployment" })),
    { id: "dall-e-3", model: "dall-e-3", status: "succeeded", object: "deployment" },
    { id: "gpt-live-1-new", model: "gpt-live-1", status: "creating", object: "deployment" },
  ],
  object: "list",
};

type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (call: Call) => Promise<Response> | Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  resetAzureCatalog();
  resetModuleRegistry();
});
afterEach(() => {
  resetAzureCatalog();
  vi.unstubAllEnvs();
});

describe("Azure catalog", () => {
  it("lists the resource's own deployments, by role, and leaves out what the live protocol cannot use", async () => {
    const f = fakeFetch(() => json(LISTING));
    setAzureCatalogDeps({ env: settingsFile(), fetch: f.fetch });
    const catalog = await loadAzureCatalog();

    expect(catalog.status).toMatchObject({ provider: "azure", ok: true });
    const byRole = (role: string) => catalog.models.filter((m) => m.role === role).map((m) => m.id);
    // Translation, gpt-audio, images and a deployment still being created stay out of every call slot.
    // gpt-realtime-2.1 answered session.start with server_error / output_creation_failed and the mini with nothing (probe, 2026-10-20).
    expect(byRole("speech_to_speech")).toEqual(["gpt-live-1"]);
    expect(byRole("reply")).toEqual(["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(byRole("speech_to_text")).toEqual(["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize", "gpt-live-transcribe", "gpt-transcribe"]);
    expect(byRole("text_to_speech")).toEqual(["gpt-4o-mini-tts"]);
    expect(catalog.models).toHaveLength(10);
    expect(catalog.models.find((m) => m.id === "gpt-live-1")!.voices).toContain("verse");

    // The deployment listing, not GET /models (Azure's whole model catalog, which lists models this resource does not have).
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe("/openai/deployments");
    expect(url.searchParams.get("api-version")).toBeTruthy();
    expect((f.calls[0]!.init!.headers as Record<string, string>)["api-key"]).toBe(KEY);
    expect(f.calls[0]!.init!.redirect).toBe("error");

    // Cached: a second read does not list again, and the synchronous readers see it.
    await loadAzureCatalog();
    expect(f.calls).toHaveLength(1);
    expect(azureCatalogSnapshot()).toBe(catalog);
    expect(liveModelIds()).toEqual(["gpt-live-1"]);
    expect(JSON.stringify(catalog)).not.toContain(KEY);
    expect(JSON.stringify(catalog)).not.toContain(HOST);
  });

  it.each([
    [401, "refused the key"],
    [404, "no deployment listing"],
    [429, "rate limiting"],
    [503, "server error"],
  ])("a listing answered %i is ok false with a plain reason, and falls back to the live deployments in the settings", async (status, words) => {
    const f = fakeFetch(() => json({ error: { message: `provider text from ${HOST}` } }, status));
    setAzureCatalogDeps({ env: settingsFile("AZURE_REALTIME_DEPLOYMENT=gpt-live-1\n"), fetch: f.fetch });
    const catalog = await loadAzureCatalog();
    expect(catalog.status.ok).toBe(false);
    expect(catalog.status.detail).toContain(words);
    expect(catalog.models.map((m) => [m.id, m.role])).toEqual([["gpt-live-1", "speech_to_speech"]]);
    const shown = JSON.stringify(catalog);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(HOST);
    expect(shown).not.toContain("provider text");
  });

  it("never throws: an unreachable endpoint, a hung listing, a body that is not a listing and missing settings all give ok false", async () => {
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => Promise.reject(new Error(`connect ECONNREFUSED ${HOST}`))).fetch });
    expect((await loadAzureCatalog()).status.detail).toContain("could not be reached");

    setAzureCatalogDeps({
      timeoutMs: 20,
      fetch: fakeFetch(({ init }) => new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))).fetch,
    });
    expect((await loadAzureCatalog()).status.detail).toContain("timed out");

    setAzureCatalogDeps({ timeoutMs: undefined, fetch: fakeFetch(() => json({ nothing: true })).fetch });
    expect((await loadAzureCatalog()).status.detail).toContain("not a deployment listing");

    // A 200 whose body is not JSON was answered: it is not a listing, not "could not be reached".
    setAzureCatalogDeps({ fetch: fakeFetch(() => new Response("<html>gateway</html>", { status: 200 })).fetch });
    expect((await loadAzureCatalog()).status.detail).toContain("not a deployment listing");

    let fetched = 0;
    setAzureCatalogDeps({ env: { VOICE_HARNESS_DEV_ENV_FILE: "" }, fetch: fakeFetch(() => (fetched++, json(LISTING))).fetch });
    const catalog = await loadAzureCatalog();
    expect(catalog.status.detail).toContain("settings are missing");
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-live-1"]);
    expect(fetched).toBe(0);
  });

  it("a listing with no live deployment it recognises is not ok and keeps the settings names, so calls are not all refused", async () => {
    const listing = { data: [{ id: "my-live", model: "voice-live-next", status: "succeeded" }, { id: "gpt-5.6-luna", model: "gpt-5.6-luna", status: "succeeded" }] };
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(listing)).fetch });
    const catalog = await loadAzureCatalog();
    expect(catalog.status.ok).toBe(false);
    expect(catalog.status.detail).toContain("no live deployment");
    expect(liveModelIds()).toEqual(["gpt-live-1"]);
    expect(catalog.models.find((m) => m.role === "reply")!.id).toBe("gpt-5.6-luna");
  });

  it("a failed refresh keeps the last good models and reports the failure", async () => {
    let now = 1_000_000;
    let fail = false;
    setAzureCatalogDeps({
      env: settingsFile(),
      now: () => now,
      fetch: fakeFetch(() => (fail ? json({}, 503) : json({ data: [{ id: "gpt-live-1-eu", model: "gpt-live-1", status: "succeeded" }] }))).fetch,
    });
    expect((await loadAzureCatalog()).status.ok).toBe(true);
    fail = true;
    now += 10 * 60_000; // past the cache time
    const refreshed = await loadAzureCatalog();
    expect(refreshed.status.ok).toBe(false);
    expect(liveModelIds()).toEqual(["gpt-live-1-eu"]);
    now += 60_000; // past the failed-listing cache time: a second failure in a row keeps them too
    expect((await loadAzureCatalog()).status.ok).toBe(false);
    expect(liveModelIds()).toEqual(["gpt-live-1-eu"]);
  });

  it("the model menu and saving a model follow the catalog", async () => {
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    await loadAzureCatalog();
    const live = getModuleRegistry().get("azure-gpt-live");
    expect(live.info().modelChoices).toEqual(["gpt-live-1"]);
    expect(getModuleRegistry().get("openai-realtime").info().modelChoices).toEqual(["gpt-live-1"]);
    expect(getModuleRegistry().get("openai-realtime").getConfig().model).toBe("gpt-live-1"); // its default is in its own menu
    expect(() => live.updateConfig({ model: "gpt-realtime" })).toThrow("azure_model_not_deployed"); // an unavailable model: not deployed
    expect(() => live.updateConfig({ model: "gpt-realtime-2.1" })).toThrow("azure_model_not_deployed"); // deployed, but not on the live protocol
    expect(() => live.updateConfig({ model: "gpt-realtime-translate" })).toThrow("azure_model_not_deployed");
    expect(live.updateConfig({ model: "gpt-live-1" }).model).toBe("gpt-live-1");
  });

  it("classifies base models by role", () => {
    expect(roleOfModel("gpt-live-1")).toBe("speech_to_speech");
    expect(roleOfModel("gpt-live-transcribe")).toBe("speech_to_text");
    expect(roleOfModel("gpt-realtime-2.1")).toBeUndefined();
    expect(roleOfModel("gpt-realtime-2.1-mini")).toBeUndefined();
    expect(roleOfModel("gpt-realtime")).toBeUndefined();
    expect(roleOfModel("gpt-realtime-translate")).toBeUndefined();
    expect(roleOfModel("gpt-4o-realtime-preview")).toBeUndefined();
    expect(roleOfModel("gpt-audio-mini")).toBeUndefined();
    expect(roleOfModel("gpt-4o-transcribe-diarize")).toBe("speech_to_text");
    expect(roleOfModel("gpt-audio-1.5")).toBeUndefined();
    expect(roleOfModel("text-embedding-3-large")).toBeUndefined();
    expect(roleOfModel("gpt-4o-mini-tts")).toBe("text_to_speech");
    expect(roleOfModel("whisper")).toBe("speech_to_text");
    expect(roleOfModel("gpt-5.6-luna")).toBe("reply");
  });
});

describe("GET /api/voice/options", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    resetTalkOrchestrator();
    resetVoiceDeps();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("offers each available orchestrator with its voice paths, and only deployed models in each slot", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath); // any existing absolute path makes Pipecat available
    selectTalkOrchestrator("direct");
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    const res = await fetch(base + "/api/voice/options");
    expect(res.status).toBe(200);
    const options = (await res.json()) as VoiceOptions;

    expect(options.sources.find((s) => s.provider === "azure")).toMatchObject({ ok: true });
    expect(options.orchestrators.map((o) => o.id)).toEqual(["direct", "pipecat"]);
    for (const o of options.orchestrators) {
      const live = o.voicePaths.find((p) => p.id === "azure_gpt_live")!;
      expect(live.slots).toEqual([expect.objectContaining({ role: "speech_to_speech", defaultId: "gpt-live-1" })]);
      expect(live.slots[0]!.models.map((m) => m.id)).toEqual(["gpt-live-1"]);
    }
    expect(JSON.stringify(options)).not.toMatch(/gpt-realtime|gpt-audio|dall-e/);
    expect(JSON.stringify(options)).not.toContain(KEY);
  });

  const choose = async (body: unknown) => {
    const res = await fetch(base + "/api/voice/path-models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const liveSlot = (options: VoiceOptions) => options.orchestrators[0]!.voicePaths.find((p) => p.id === "azure_gpt_live")!.slots[0]!;

  it("POST /api/voice/path-models stores a live model and voice on the module the live session reads, and reports it as selected", async () => {
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    const ok = await choose({ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-live-1", voice: "marin" });
    expect(ok.status).toBe(200);
    expect(liveSlot(ok.json)).toMatchObject({ selectedId: "gpt-live-1", selectedVoice: "marin" });
    expect(getModuleRegistry().get("azure-gpt-live").getConfig()).toMatchObject({ model: "gpt-live-1", voice: "marin" });
    expect(liveSlot((await (await fetch(base + "/api/voice/options")).json()) as VoiceOptions).selectedVoice).toBe("marin");

    // A custom voice id follows the same rule as the module route, and is reported as selected.
    const custom = await choose({ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-live-1", voice: "voice_abc" });
    expect(custom.status).toBe(200);
    expect(liveSlot(custom.json).selectedVoice).toBe("voice_abc");
  });

  it.each([
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-realtime" }, "azure_model_not_deployed"],
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-realtime-translate" }, "azure_model_not_deployed"],
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-realtime-2.1" }, "azure_model_not_deployed"],
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-5.6-luna" }, "azure_model_not_deployed"],
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-live-1", voice: "nope" }, "voice_not_offered"],
    [{ voicePathId: "azure_gpt_live", role: "reply", modelId: "gpt-5.6-luna" }, "unknown_model_role"],
    [{ voicePathId: "nope", role: "speech_to_speech", modelId: "gpt-live-1" }, "unknown_voice_path"],
    [{ voicePathId: "azure_gpt_live", role: "singing", modelId: "gpt-live-1" }, "unknown_model_role"],
    [{ voicePathId: "azure_gpt_live", role: "speech_to_speech" }, "bad_path_model_choice"],
  ])("POST /api/voice/path-models refuses %j with %s and changes nothing", async (body, code) => {
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    const res = await choose(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(code);
    expect(getModuleRegistry().get("azure-gpt-live").getConfig()).toMatchObject({ model: "gpt-live-1", voice: "verse" });
  });

  it("a Deepgram path slot choice is stored and reported, for the Deepgram path to use", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath);
    setVoiceDeps({ deepgramRuntime: () => ({}) as never });
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    const res = await choose({ voicePathId: "deepgram", role: "reply", modelId: "gpt-5.6-terra" });
    expect(res.status).toBe(200);
    const deepgram = (res.json as VoiceOptions).orchestrators.find((o) => o.id === "pipecat")!.voicePaths.find((p) => p.id === "deepgram")!;
    expect(deepgram.slots.find((s) => s.role === "reply")).toMatchObject({ selectedId: "gpt-5.6-terra" });
    expect(chosenPathModel("deepgram", "reply")).toEqual({ modelId: "gpt-5.6-terra" });
    expect((await choose({ voicePathId: "deepgram", role: "reply", modelId: "gpt-live-1" })).json.error).toBe("azure_model_not_deployed");

    // Deepgram speech is one option, aura-2, whose voices are the voice ids; the chosen one comes back as selectedVoice.
    const voice = await choose({ voicePathId: "deepgram", role: "text_to_speech", modelId: "aura-2", voice: "aura-2-orion-en" });
    expect(voice.status).toBe(200);
    const tts = (voice.json as VoiceOptions).orchestrators.find((o) => o.id === "pipecat")!.voicePaths.find((p) => p.id === "deepgram")!.slots.find((s) => s.role === "text_to_speech");
    expect(tts).toMatchObject({ selectedId: "aura-2", selectedVoice: "aura-2-orion-en" });
    expect((await choose({ voicePathId: "deepgram", role: "text_to_speech", modelId: "aura-2", voice: "aura-2-nobody-en" })).json.error).toBe("voice_not_offered");
    expect((await choose({ voicePathId: "deepgram", role: "speech_to_text", modelId: "nova-3-general" })).status).toBe(200);
    expect((await choose({ voicePathId: "deepgram", role: "speech_to_text", modelId: "nova-9" })).json.error).toBe("deepgram_model_not_offered");
    expect(chosenPathModel("deepgram", "speech_to_text")).toEqual({ modelId: "nova-3-general" });
  });

  it("the Deepgram reply default is one value for the options and the sidecar, and a stored reply the listing dropped is not used", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath);
    setVoiceDeps({ deepgramRuntime: () => ({}) as never });
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    await loadAzureCatalog();
    // No AZURE_REPLY_DEPLOYMENT in the settings: the first listed reply deployment, never the sidecar's own built-in default.
    expect(deepgramReplyDeployment(undefined)).toBe("gpt-5.4-mini");
    const options = (await (await fetch(base + "/api/voice/options")).json()) as VoiceOptions;
    const reply = options.orchestrators.find((o) => o.id === "pipecat")!.voicePaths.find((p) => p.id === "deepgram")!.slots.find((s) => s.role === "reply")!;
    expect(reply.defaultId).toBe("gpt-5.4-mini");
    expect(deepgramReplyDeployment("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    storePathModel("deepgram", "reply", { modelId: "gpt-5.6-terra" });
    expect(deepgramReplyDeployment("gpt-5.6-luna")).toBe("gpt-5.6-terra");
    storePathModel("deepgram", "reply", { modelId: "gpt-deleted" });
    expect(deepgramReplyDeployment("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("leaves out an orchestrator that cannot run", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", "");
    setAzureCatalogDeps({ env: settingsFile(), fetch: fakeFetch(() => json(LISTING)).fetch });
    const options = (await (await fetch(base + "/api/voice/options")).json()) as VoiceOptions;
    expect(options.orchestrators.map((o) => o.id)).toEqual(["direct"]);
  });
});
