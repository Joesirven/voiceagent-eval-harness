import { beforeEach, describe, expect, it } from "vitest";
import { clearDeepgramCatalogCache, DEFAULT_STT_MODEL, DEFAULT_VOICE, loadDeepgramCatalog } from "../../src/modules/deepgram-catalog.js";

const stt = (name: string, extra: object = {}) => ({ canonical_name: name, architecture: "base", languages: ["en"], streaming: true, multilingual: false, ...extra });
const tts = (name: string, architecture = "aura-2") => ({ canonical_name: name, architecture, languages: ["en"] });
const models = {
  stt: [
    stt("enhanced-general"),
    stt("nova-3-general"),
    stt("nova-3-general"),
    stt("nova-2-batch-only", { streaming: false }),
    stt("nova-2-french", { languages: ["fr"] }),
    stt("general-dQw4w9WgXcQ"),
    stt("nova-3-medical", { languages: ["fr"], multilingual: true }),
  ],
  tts: [tts("aura-2-zeus-en"), tts("aura-2-thalia-en"), tts("aura-2-agathe-fr"), tts("aura-asteria-en", "aura-1")],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(opts: { status?: number; body?: unknown; hang?: boolean } = {}) {
  const calls: { url: string; auth: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization) });
    if (opts.hang) return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    if (opts.status && opts.status !== 200) return json({ err_code: "x" }, opts.status);
    if (url.endsWith("/projects")) return json({ projects: [{ project_id: "proj-1" }] });
    return json(opts.body ?? models);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const deps = (f: typeof fetch) => ({ fetch: f, apiKey: () => "test-key-not-real", baseUrl: "https://dg.test/v1" });

beforeEach(() => clearDeepgramCatalogCache());

describe("loadDeepgramCatalog", () => {
  it("lists streaming English speech to text models and Aura-2 English voices, defaults first", async () => {
    const f = fakeFetch();
    const c = await loadDeepgramCatalog(deps(f.fn));
    expect(c.status).toMatchObject({ provider: "deepgram", ok: true });
    expect(c.status.detail).toBeUndefined();
    expect(c.models.filter((m) => m.role === "speech_to_text").map((m) => m.id)).toEqual([DEFAULT_STT_MODEL, "enhanced-general", "nova-3-medical"]);
    const speech = c.models.find((m) => m.role === "text_to_speech")!;
    expect(speech).toMatchObject({ id: "aura-2", provider: "deepgram" });
    expect(speech.voices).toEqual([DEFAULT_VOICE, "aura-2-zeus-en"]);
    expect(f.calls.map((x) => x.url)).toEqual(["https://dg.test/v1/projects", "https://dg.test/v1/projects/proj-1/models"]);
    expect(f.calls[0]!.auth).toBe("Token test-key-not-real");
  });

  it("caches a success so a second call asks Deepgram nothing", async () => {
    const f = fakeFetch();
    await loadDeepgramCatalog(deps(f.fn));
    await loadDeepgramCatalog(deps(f.fn));
    expect(f.calls).toHaveLength(2);
  });

  it("reports a refused key plainly, with no models, no throw and no key in the reason", async () => {
    const c = await loadDeepgramCatalog(deps(fakeFetch({ status: 401 }).fn));
    expect(c).toMatchObject({ status: { provider: "deepgram", ok: false, detail: "Deepgram refused the configured key" }, models: [] });
    expect(JSON.stringify(c)).not.toContain("test-key-not-real");
  });

  it("reports a timeout plainly and does not cache the failure", async () => {
    const slow = await loadDeepgramCatalog({ ...deps(fakeFetch({ hang: true }).fn), timeoutMs: 20 });
    expect(slow).toMatchObject({ status: { ok: false, detail: "Deepgram did not answer in time" }, models: [] });
    const f = fakeFetch();
    expect((await loadDeepgramCatalog(deps(f.fn))).status.ok).toBe(true);
  });

  it("reports a missing key and an unexpected answer", async () => {
    const none = await loadDeepgramCatalog({ ...deps(fakeFetch().fn), apiKey: () => { throw new Error("secret detail"); } });
    expect(none.status).toMatchObject({ ok: false, detail: "No Deepgram key is configured" });
    const odd = await loadDeepgramCatalog(deps(fakeFetch({ body: { nope: 1 } }).fn));
    expect(odd).toMatchObject({ status: { ok: false, detail: "Deepgram sent an unexpected answer" }, models: [] });
  });
});
