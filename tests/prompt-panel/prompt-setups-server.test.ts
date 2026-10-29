import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, getPromptSetupRegistry, renderSetupSections, resetPromptSetupRegistry, type PromptSetup } from "../../src/behaviour/prompt/index.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { OUTBOUND_SCRIPTED_OPENING } from "../../src/orchestration/call-loop.js";
import { handlePromptRoute, isAllowedOrigin, isLoopbackAddress } from "../../src/server/prompt-routes.js";
import { loadCustomSetups, saveCustomSetups } from "../../src/setups/prompt-setup-store.js";

let dir: string;
let file: string;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handlePromptRoute(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("other");
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prompt-setups-"));
  file = join(dir, "setups.json");
  process.env.VOICE_HARNESS_PROMPT_SETUPS_FILE = file;
  resetPromptSetupRegistry();
});
afterEach(() => {
  delete process.env.VOICE_HARNESS_PROMPT_SETUPS_FILE;
  resetPromptSetupRegistry();
  rmSync(dir, { recursive: true, force: true });
});

interface Reply { status: number; body: any; text: string }
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        ok({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}

const draft = (over: Record<string, unknown> = {}) => ({
  label: "Mine",
  description: "A test",
  layers: ["identity", "rules", "flow", "facts"],
  personalityId: "none",
  overrides: {},
  ...over,
});

describe("prompt setup store", () => {
  it("round trips custom setups and leaves no temporary file", () => {
    const registry = getPromptSetupRegistry();
    registry.register({ id: "kept", label: "Kept", description: "d", layers: ["rules"], personalityId: "none", overrides: { rules: "## Rules\nBe brief." } });
    saveCustomSetups(registry, file);
    expect(readdirSync(dir)).toEqual(["setups.json"]);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.setups.map((s: PromptSetup) => s.id)).toEqual(["kept"]);
    resetPromptSetupRegistry();
    const fresh = getPromptSetupRegistry();
    expect(loadCustomSetups(fresh, file).loaded).toEqual(["kept"]);
    expect(fresh.get("kept")?.overrides?.rules).toBe("## Rules\nBe brief.");
    expect(fresh.get("kept")?.layers).toContain("disclosure");
  });

  it("never overwrites a shipped setup from the file", () => {
    writeFileSync(file, JSON.stringify({ setups: [{ id: "playbook-full", label: "x", description: "d", layers: ["rules"], personalityId: "none" }] }));
    const registry = getPromptSetupRegistry();
    const result = loadCustomSetups(registry, file);
    expect(result.loaded).toEqual([]);
    expect(registry.get("playbook-full")?.label).not.toBe("x");
  });
});

describe("overrides in the builder", () => {
  const ctx = { direction: "inbound" as const, agencyName: "Acme Agency" };
  it("replaces the section text, fills slots, keeps id and title", () => {
    const setup: PromptSetup = { id: "o", label: "o", description: "d", layers: ["disclosure", "rules"], personalityId: "none", overrides: { rules: "## Rules\nWork for [agency name] only." } };
    const sections = renderSetupSections(setup, { direction: "inbound" });
    const rules = sections.find((s) => s.id === "rules")!;
    expect(rules.text).toBe("## Rules\nWork for [agency name] only.");
    expect(rules.overridden).toBe(true);
    expect(rules.defaultText).not.toBe(rules.text);
    expect(buildSystemPrompt(setup, ctx).text).toContain("Work for Acme Agency only.");
  });
  it("shipped output is unchanged and the opening script survives", () => {
    const built = buildSystemPrompt("playbook-full", { direction: "inbound" }).text;
    expect(built).toContain("This call is handled by an AI assistant.");
    expect(renderSetupSections("playbook-full", { direction: "inbound" }).every((s) => !s.overridden)).toBe(true);
  });
  it("refuses a setup with a disclosure override", () => {
    const setup = { id: "o", label: "o", description: "d", layers: ["disclosure"], personalityId: "none", overrides: { disclosure: "gone" } } as PromptSetup;
    expect(() => buildSystemPrompt(setup, { direction: "inbound" })).toThrow("disclosure_locked");
  });
});

describe("routes", () => {
  it("lists setups, layers, personalities and the locked disclosure", async () => {
    const r = await call("GET", "/api/prompt-setups");
    expect(r.status).toBe(200);
    expect(r.body.selectedId).toBe("playbook-full");
    expect(r.body.setups.find((s: any) => s.id === "playbook-full")).toMatchObject({ shipped: true, overrides: {} });
    expect(r.body.layers.find((l: any) => l.id === "disclosure").editable).toBe(false);
    expect(r.body.disclosure.locked).toBe(true);
    expect(r.body.disclosure.text).toContain("This call is handled by an AI assistant.");
    expect(r.body.personalities.length).toBeGreaterThan(0);
  });

  it("serves sections with slots left as templates and the floor and disclosure locked", async () => {
    const r = await call("GET", "/api/prompt-setups/playbook-full/sections?direction=outbound");
    expect(r.status).toBe(200);
    expect(r.body.sections[0]).toMatchObject({ id: "floor", editable: false });
    expect(r.body.sections.find((s: any) => s.id === "disclosure").editable).toBe(false);
    expect(r.body.sections.find((s: any) => s.id === "rules").editable).toBe(true);
    expect(r.body.sections.some((s: any) => /\[[a-zA-Z -]+\]/.test(s.text))).toBe(true);
  });

  it("saves, lists, builds instructions from, selects and deletes a custom setup", async () => {
    const put = await call("PUT", "/api/prompt-setups/my-setup", draft({ overrides: { rules: "## Rules\nCustom rule for [agency name]." } }));
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ id: "my-setup", shipped: false });
    expect(put.body.layers).toContain("disclosure");
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["setups.json"]);

    const sections = await call("GET", "/api/prompt-setups/my-setup/sections?direction=inbound");
    expect(sections.body.sections.find((s: any) => s.id === "rules")).toMatchObject({ overridden: true, text: "## Rules\nCustom rule for [agency name]." });

    const ins = await call("GET", "/api/agent-instructions?setup=my-setup&lead=lead-1&direction=inbound");
    expect(ins.status).toBe(200);
    expect(ins.body).toMatchObject({ setupId: "my-setup", direction: "inbound", leadId: "lead-1" });
    expect(ins.body.text).toContain("Custom rule for");
    expect(ins.body.text).toContain(inboundOpeningScript());
    expect(ins.body.text).toContain("Lead context (read only):");
    expect(ins.body.approxTokens).toBe(Math.ceil(ins.body.text.length / 4));

    const plain = await call("GET", "/api/agent-instructions?setup=my-setup", undefined, { accept: "text/plain" });
    expect(plain.text).toBe(ins.body.text);

    const sel = await call("POST", "/api/prompt-setups/my-setup/select");
    expect(sel.body).toEqual({ selectedId: "my-setup" });
    const def = await call("GET", "/api/agent-instructions?setup=default");
    expect(def.body.setupId).toBe("my-setup");

    const del = await call("DELETE", "/api/prompt-setups/my-setup");
    expect(del.status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).setups).toEqual([]);
    expect((await call("GET", "/api/prompt-setups/my-setup/sections")).status).toBe(404);
  });

  it("outbound instructions carry the outbound opening", async () => {
    const ins = await call("GET", "/api/agent-instructions?setup=playbook-full&direction=outbound");
    expect(ins.status).toBe(200);
    expect(ins.body.text).toContain("This is an outbound call");
    expect(OUTBOUND_SCRIPTED_OPENING.length).toBeGreaterThan(0);
  });

  it("refuses shipped ids, locked disclosure, bad ids and bad layers", async () => {
    expect((await call("PUT", "/api/prompt-setups/playbook-full", draft())).body).toEqual({ error: "setup_is_shipped" });
    expect((await call("PUT", "/api/prompt-setups/playbook-full", draft())).status).toBe(409);
    expect((await call("DELETE", "/api/prompt-setups/playbook-full")).status).toBe(409);
    const locked = await call("PUT", "/api/prompt-setups/x-one", draft({ overrides: { disclosure: "nope" } }));
    expect(locked.status).toBe(400);
    expect(locked.body.error).toBe("disclosure_locked");
    expect((await call("PUT", "/api/prompt-setups/Bad_Id", draft())).status).toBe(400);
    expect((await call("PUT", "/api/prompt-setups/x-one", draft({ overrides: { nonsense: "a" } }))).body.error).toBe("setup_invalid");
    expect((await call("PUT", "/api/prompt-setups/x-one", draft({ overrides: { rules: "a".repeat(20001) } }))).status).toBe(400);
    expect((await call("PUT", "/api/prompt-setups/x-one", draft({ layers: ["rules", "nope"] }))).status).toBe(400);
    expect(existsSync(file)).toBe(false);
  });

  it("forces the disclosure layer in when the draft leaves it out", async () => {
    const put = await call("PUT", "/api/prompt-setups/lean-one", draft({ layers: ["rules"] }));
    expect(put.body.layers).toEqual(["rules", "disclosure"]);
    expect(put.body.layers).toContain("disclosure");
    const ins = await call("GET", "/api/agent-instructions?setup=lean-one");
    expect(ins.body.text).toContain(inboundOpeningScript());
  });

  it("previews a draft without saving it", async () => {
    const r = await call("POST", "/api/prompt-setups/preview", { setup: draft({ overrides: { rules: "## Rules\nPreview only." } }), lead: "lead-1", direction: "inbound" });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain("Preview only.");
    expect(r.body.text).toContain(inboundOpeningScript());
    expect(r.body.approxTokens).toBe(Math.ceil(r.body.text.length / 4));
    expect(existsSync(file)).toBe(false);
    expect(getPromptSetupRegistry().list().every((s) => s.shipped)).toBe(true);
    const bad = await call("POST", "/api/prompt-setups/preview", { setup: draft({ overrides: { disclosure: "x" } }) });
    expect(bad.body.error).toBe("disclosure_locked");
  });

  it("returns 404 for unknown setup and lead", async () => {
    expect((await call("GET", "/api/agent-instructions?setup=nope")).body).toEqual({ error: "setup_unknown" });
    expect((await call("GET", "/api/agent-instructions?setup=default&lead=lead-999")).body).toEqual({ error: "lead_not_found" });
    expect((await call("POST", "/api/prompt-setups/nope/select")).status).toBe(404);
    expect((await call("DELETE", "/api/prompt-setups/nope")).status).toBe(404);
    expect((await call("GET", "/api/agent-instructions?direction=sideways")).status).toBe(400);
  });

  it("requires a json content type on writes", async () => {
    const r = await call("PUT", "/api/prompt-setups/x-two", undefined, { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });

  it("checks the Origin header and leaves other paths alone", async () => {
    expect((await call("GET", "/api/prompt-setups", undefined, { origin: "http://evil.example" })).body).toEqual({ error: "origin_not_allowed" });
    expect((await call("GET", "/api/prompt-setups", undefined, { origin: "http://127.0.0.1:9999" })).status).toBe(403);
    const ok = await call("GET", "/api/prompt-setups", undefined, { origin: "http://localhost:4372" });
    expect(ok.status).toBe(200);
    expect((await call("GET", "/api/prompt-setups", undefined, { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await call("OPTIONS", "/api/prompt-setups/x", undefined, { origin: "http://127.0.0.1:4371" })).status).toBe(204);
    expect((await call("GET", "/api/something-else")).text).toBe("other");
  });

  it("rejects a non-loopback peer", async () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isAllowedOrigin("http://localhost:4379", 1)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4380", 1)).toBe(false);
    const sent: { status?: number; body?: string } = {};
    const fake: any = { url: "/api/prompt-setups", method: "GET", headers: {}, socket: { remoteAddress: "192.168.1.9", localPort: 1 } };
    const res: any = { writeHead: (s: number) => (sent.status = s), end: (b: string) => (sent.body = b), setHeader() {} };
    expect(await handlePromptRoute(fake, res)).toBe(true);
    expect(sent.status).toBe(403);
  });
});
