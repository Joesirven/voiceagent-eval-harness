/**
 * The interface mock at /mock: served behind the same loopback guard as the
 * control page, built from fake data only, and rendered with textContent only.
 */
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle } from "../../src/server/dev-server.js";

let server: Server;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const status = (path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

const mockFiles = ["index.html", "mock.css", "mock.js", "mock-data.js"];

describe("interface mock", () => {
  it("serves the page and its three assets, and nothing else under /mock", async () => {
    const page = await fetch(base() + "/mock");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Test mode");
    for (const path of ["/mock/mock.css", "/mock/mock.js", "/mock/mock-data.js"]) expect((await fetch(base() + path)).status, path).toBe(200);
    expect((await fetch(base() + "/mock/../dev-server.ts")).status).not.toBe(200);
    expect((await fetch(base() + "/mock/index.html")).status).toBe(404);
  });

  it("refuses a non-loopback host or a foreign origin", async () => {
    expect(await status("/mock", { host: `evil.example:${port}` })).toBe(403);
    expect(await status("/mock/mock.js", { host: `127.0.0.1:${port}`, origin: "http://evil.example" })).toBe(403);
  });

  it("accepts localhost as well as 127.0.0.1, for Host and Origin", async () => {
    expect(await status("/mock", { host: `localhost:${port}` })).toBe(200);
    expect(await status("/mock", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    expect(await status("/mock", { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` })).toBe(200);
  });

  it("accepts the hosts named in HARNESS_ALLOWED_HOSTS, and only those, on top of loopback", async () => {
    const before = process.env.HARNESS_ALLOWED_HOSTS;
    try {
      delete process.env.HARNESS_ALLOWED_HOSTS;
      expect(await status("/mock", { host: "test-host.example.ts.net" })).toBe(403);
      process.env.HARNESS_ALLOWED_HOSTS = "test-host.example.ts.net, test-host.example.ts.net:8443";
      expect(await status("/mock", { host: "test-host.example.ts.net" })).toBe(200);
      expect(await status("/mock", { host: "test-host.example.ts.net:8443" })).toBe(200);
      expect(await status("/mock", { host: "test-host.example.ts.net", origin: "https://test-host.example.ts.net" })).toBe(200);
      expect(await status("/mock", { host: "test-host.example.ts.net", origin: "https://evil.example" })).toBe(403);
      expect(await status("/mock", { host: "other.example.ts.net" })).toBe(403);
      expect(await status("/mock", { host: `127.0.0.1:${port}` })).toBe(200);
    } finally {
      if (before === undefined) delete process.env.HARNESS_ALLOWED_HOSTS; else process.env.HARNESS_ALLOWED_HOSTS = before;
    }
  });

  it("uses textContent only and reaches no network", () => {
    for (const file of mockFiles) {
      const text = readFileSync(new URL(`../../src/server/ui-mock/${file}`, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(text, file).not.toMatch(/fetch\(|EventSource|XMLHttpRequest|WebSocket|https?:\/\//);
    }
  });

  it("scripts a call that ends with an outcome and a post-call score, in time order", async () => {
    const data = await import("../../src/server/ui-mock/mock-data.js");
    const types = data.script.map((e: { type: string }) => e.type);
    expect(types.at(-2)).toBe("call_outcome");
    expect(types.at(-1)).toBe("judge_score");
    for (let i = 1; i < data.script.length; i += 1) expect(data.script[i].ms).toBeGreaterThanOrEqual(data.script[i - 1].ms);
    expect(data.script.some((e: any) => e.type === "judge_verdict" && e.data.allowed === false)).toBe(true);
    expect(data.script.some((e: any) => e.type === "compliance_check" && e.data.skipped)).toBe(true);
    for (const e of data.script.filter((e: any) => e.type === "node_enter")) expect(data.tree.nodes.map((n: any) => n.id)).toContain(e.data.nodeId);
  });
});
