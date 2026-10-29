import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFlowProxyMiddleware, flowProxyPlugin, MAX_PROXY_BODY_BYTES } from "../../console-standard/web/flow-proxy-plugin.js";
import { handleFlowEditorRoute } from "../../src/server/flow-editor-routes.js";

interface Seen { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
interface Reply { status: number; body: string; json: any }

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
const close = (server: Server | undefined) => new Promise((done) => { if (!server) return done(undefined); server.closeAllConnections?.(); server.close(done); });

/** A page server made of only the proxy middleware; every other path answers like Vite would for an unknown path. */
function pageServer(pagePort: number, harnessPort: number): Server {
  const middleware = createFlowProxyMiddleware({ pagePort, harnessPort });
  return createServer((req, res) => middleware(req, res, () => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>vite fallthrough</html>"); }));
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> {
  return new Promise((done, fail) => {
    let answered = false;
    const req = request({ host: "127.0.0.1", port, method, path, headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
        answered = true;
        done({ status: res.statusCode ?? 0, body: text, json });
      });
    });
    // A server that refuses early may close while the body is still being written; that is fine once it has answered.
    req.on("error", (e) => { if (!answered) fail(e); });
    req.end(body);
  });
}

describe("flowProxyPlugin middleware", () => {
  let harness: Server;
  let harnessPort: number;
  let page: Server;
  let pagePort: number;
  let seen: Seen[] = [];
  let harnessStatus = 200;

  beforeAll(async () => {
    harness = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(harnessStatus, { "content-type": "application/json", "set-cookie": "leak=1" });
        res.end(JSON.stringify({ from: "harness", url: req.url }));
      });
    });
    harnessPort = await listen(harness);
    page = createServer();
    pagePort = await listen(page);
    await close(page);
    page = pageServer(pagePort, harnessPort);
    await new Promise<void>((done) => page.listen(pagePort, "127.0.0.1", done));
  });
  afterAll(async () => { await close(page); await close(harness); });
  afterEach(() => { seen = []; harnessStatus = 200; });

  const okPost = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", origin: `http://127.0.0.1:${pagePort}`, ...extra });

  it("is a Vite plugin for both servers", () => {
    const plugin = flowProxyPlugin({ pagePort: 1 });
    expect(plugin.name).toBe("crm-flow-proxy");
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });

  it("forwards the two GET routes and streams back the status and body", async () => {
    for (const path of ["/api/flow-tools/catalog", "/api/flows/current"]) {
      const reply = await call(pagePort, "GET", path);
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ from: "harness", url: path });
      expect(reply.body).not.toMatch(/vite/);
    }
    expect(seen.map((s) => s.url)).toEqual(["/api/flow-tools/catalog", "/api/flows/current"]);
  });

  it("passes the harness status through (404, 422)", async () => {
    harnessStatus = 404;
    expect((await call(pagePort, "GET", "/api/flows/current")).status).toBe(404);
    harnessStatus = 422;
    expect((await call(pagePort, "POST", "/api/flows/import", okPost(), JSON.stringify({ yaml: "a: b" }))).status).toBe(422);
  });

  it("forwards a POST import with Host and Origin rewritten for the harness", async () => {
    const reply = await call(pagePort, "POST", "/api/flows/import", okPost({ cookie: "a=b", "x-extra": "1" }), JSON.stringify({ yaml: "a: b" }));
    expect(reply.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.host).toBe(`127.0.0.1:${harnessPort}`);
    expect(seen[0].headers.origin).toBe(`http://127.0.0.1:${harnessPort}`);
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers["x-extra"]).toBeUndefined();
    expect(JSON.parse(seen[0].body)).toEqual({ yaml: "a: b" });
    expect(reply.body).toBeTruthy();
  });

  it("accepts the localhost origin form of the page, with a charset on the content type", async () => {
    const reply = await call(pagePort, "POST", "/api/flows/import", okPost({ origin: `http://localhost:${pagePort}`, "content-type": "application/json; charset=utf-8" }), "{}");
    expect(reply.status).toBe(200);
  });

  it("does not expose any other path, under /api/ or elsewhere", async () => {
    for (const path of ["/api/other", "/api/flows", "/api/flows/", "/api/flows/current/", "/api/flows/current/x", "/api/flows/%63urrent", "/api/Flows/current", "//api/flows/current", "/api/flow-tools", "/api/flow-tools/catalog/..", "/api/flows/import/x", "/"]) {
      const reply = await call(pagePort, "GET", path);
      expect(reply.body, path).toContain("vite fallthrough");
    }
    expect(seen).toEqual([]);
  });

  it("allows only the listed method for each path", async () => {
    for (const [method, path] of [["POST", "/api/flows/current"], ["POST", "/api/flow-tools/catalog"], ["GET", "/api/flows/import"], ["PUT", "/api/flows/import"], ["DELETE", "/api/flows/current"], ["HEAD", "/api/flows/current"], ["OPTIONS", "/api/flows/import"]] as const) {
      const reply = await call(pagePort, method, path, okPost(), method === "GET" || method === "HEAD" ? undefined : "{}");
      expect(reply.status, `${method} ${path}`).toBe(405);
    }
    expect(seen).toEqual([]);
  });

  it("a query string neither widens the allowlist nor reaches the harness", async () => {
    const ok = await call(pagePort, "GET", "/api/flows/current?evil=/etc/passwd&x=%0d%0a");
    expect(ok.status).toBe(200);
    expect(seen[0].url).toBe("/api/flows/current");
    seen = [];
    const other = await call(pagePort, "GET", "/api/other?path=/api/flows/current");
    expect(other.body).toContain("vite fallthrough");
    const hash = await call(pagePort, "GET", "/api/flows/current/?/api/flows/current");
    expect(hash.body).toContain("vite fallthrough");
    expect(seen).toEqual([]);
  });

  it("refuses a missing or wrong Origin with 403 and never reaches the harness", async () => {
    const bad = [undefined, "http://evil.example", `http://127.0.0.1:${pagePort + 1}`, `https://127.0.0.1:${pagePort}`, `http://127.0.0.1:${harnessPort}`, "null", `http://127.0.0.1:${pagePort}.evil.example`];
    for (const origin of bad) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin !== undefined) headers.origin = origin;
      const reply = await call(pagePort, "POST", "/api/flows/import", headers, "{}");
      expect(reply.status, String(origin)).toBe(403);
      expect(reply.json).toEqual({ error: "origin_not_allowed" });
    }
    expect(seen).toEqual([]);
  });

  it("refuses a wrong or missing content type with 415", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", ""]) {
      const headers: Record<string, string | undefined> = okPost({ "content-type": type });
      if (type === "") delete headers["content-type"];
      expect((await call(pagePort, "POST", "/api/flows/import", headers as Record<string, string>, "{}")).status, type).toBe(415);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a body over 2 megabytes with 413, declared or streamed, and accepts one at the cap", async () => {
    const big = Buffer.alloc(MAX_PROXY_BODY_BYTES + 1, 97);
    const declared = await call(pagePort, "POST", "/api/flows/import", okPost(), big);
    expect(declared.status).toBe(413);
    // Streamed without a content-length: the cap is counted as the body arrives.
    const streamed = await new Promise<number>((done, fail) => {
      const req = request({ host: "127.0.0.1", port: pagePort, method: "POST", path: "/api/flows/import", headers: { ...okPost(), "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => done(res.statusCode ?? 0)); });
      req.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? done(413) : fail(e)));
      for (let i = 0; i < 3; i++) req.write(Buffer.alloc(MAX_PROXY_BODY_BYTES / 2, 98));
      req.end();
    });
    expect(streamed).toBe(413);
    expect(seen).toEqual([]);
    const atCap = await call(pagePort, "POST", "/api/flows/import", okPost(), Buffer.alloc(MAX_PROXY_BODY_BYTES, 99));
    expect(atCap.status).toBe(200);
    expect(seen[0].body.length).toBe(MAX_PROXY_BODY_BYTES);
  });

  it("answers 502 harness_unreachable when the harness is down", async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await close(dead);
    const lonely = pageServer(pagePort, deadPort);
    const port = await listen(lonely);
    try {
      const get = await call(port, "GET", "/api/flows/current");
      expect(get.status).toBe(502);
      expect(get.json).toEqual({ error: "harness_unreachable" });
      const post = await call(port, "POST", "/api/flows/import", okPost(), "{}");
      expect(post.status).toBe(502);
      expect(post.json).toEqual({ error: "harness_unreachable" });
    } finally { await close(lonely); }
  });

  it("refuses a connection that is not loopback", () => {
    const middleware = createFlowProxyMiddleware({ pagePort: 1, harnessPort: 2 });
    let status = 0; let fell = false;
    const req = { url: "/api/flows/current", method: "GET", headers: {}, socket: { remoteAddress: "192.168.1.5" } } as never;
    const res = { headersSent: false, writeHead: (s: number) => { status = s; }, end: () => {} } as never;
    middleware(req, res, () => { fell = true; });
    expect(status).toBe(403);
    expect(fell).toBe(false);
  });
});

describe("flow panel proxy in front of the real route handlers", () => {
  const python = process.env.VOICE_HARNESS_PIPECAT_PYTHON ?? "/tmp/voice-harness-pipecat-venv/bin/python";
  const pythonPresent = existsSync(python);
  const repoRoot = resolve(__dirname, "..", "..");
  const goodFlow = `initial_node: a
nodes:
  a:
    task_messages:
      - role: developer
        content: Say hello.
    functions:
      - name: go
        transition_only: true
        description: Go.
        transition_to: b
  b:
    task_messages:
      - role: developer
        content: Say goodbye.
`;
  let root: string; let flowFile: string; let harness: Server; let page: Server; let pagePort: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-proxy-e2e-"));
    mkdirSync(join(root, "src", "flow-tools"), { recursive: true });
    writeFileSync(join(root, "src", "flow-tools", "catalog.json"), readFileSync(join(repoRoot, "tests", "flows-editor", "fixtures", "catalog.synthetic.json")));
    flowFile = join(root, "runtime", "tree.flow.yaml");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(flowFile, goodFlow);
    harness = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      handleFlowEditorRoute(req.method ?? "GET", path, req, res, {
        root,
        env: { VOICE_HARNESS_PIPECAT_PYTHON: python, VOICE_HARNESS_FLOW_FILE: flowFile },
        bridgeScript: join(repoRoot, "scripts", "flows-editor", "flow_bridge.py"),
        handlersFile: join(root, "no-such-handlers.py"),
      }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    const harnessPort = await listen(harness);
    const probe = createServer();
    pagePort = await listen(probe);
    await close(probe);
    page = pageServer(pagePort, harnessPort);
    await new Promise<void>((done) => page.listen(pagePort, "127.0.0.1", done));
  });
  afterAll(async () => { await close(page); await close(harness); if (root) rmSync(root, { recursive: true, force: true }); });

  const headers = () => ({ "content-type": "application/json", origin: `http://127.0.0.1:${pagePort}` });

  it("serves the catalog and the runtime flow through the page server", async () => {
    const catalog = await call(pagePort, "GET", "/api/flow-tools/catalog");
    expect(catalog.status).toBe(200);
    expect(Array.isArray(catalog.json.tools)).toBe(true);
    const current = await call(pagePort, "GET", "/api/flows/current");
    expect(current.status).toBe(200);
    expect(current.json).toMatchObject({ flowName: "tree", yaml: goodFlow, path: flowFile });
  });

  it.skipIf(!pythonPresent)("imports through the proxy, then refuses a bad flow without touching the runtime file", { timeout: 60_000 }, async () => {
    const saved = goodFlow.replace("Say goodbye.", "Say farewell.");
    const ok = await call(pagePort, "POST", "/api/flows/import", headers(), JSON.stringify({ flowName: "tree", yaml: saved }));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, path: flowFile });
    expect(readFileSync(flowFile, "utf8")).toBe(saved);
    const bad = await call(pagePort, "POST", "/api/flows/import", headers(), JSON.stringify({ yaml: goodFlow.replace("transition_to: b", "transition_to: ghost") }));
    expect(bad.status).toBe(422);
    expect(bad.json.problems.join("\n")).toMatch(/ghost/);
    expect(readFileSync(flowFile, "utf8")).toBe(saved);
  });

  it("the real route refuses a direct call that skips the proxy rewrite (the harness checks its own Host port)", async () => {
    // Proof the rewrite matters: the page origin does not match the harness Host, so a direct post to the harness would be refused.
    const direct = await call(Number((harness.address() as AddressInfo).port), "POST", "/api/flows/import", headers(), JSON.stringify({ yaml: goodFlow }));
    expect(direct.status).toBe(403);
  });
});
