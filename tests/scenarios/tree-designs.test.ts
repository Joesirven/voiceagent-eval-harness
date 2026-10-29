/**
 * The decision tree designs at /tree-designs are still served (the built page,
 * or the "not built" page when designs/dist is missing), behind the same
 * loopback guard as the control page. The animated tree lab that used to live
 * at /tree-lab was removed, so that path now falls through to the plain 404.
 */
import { existsSync, readdirSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle } from "../../src/server/dev-server.js";

let server: Server;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const designsIndex = fileURLToPath(new URL("../../designs/dist/index.html", import.meta.url));
const designsAssets = fileURLToPath(new URL("../../designs/dist/assets/", import.meta.url));

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("tree designs route", () => {
  it("serves the designs page, or says it is not built", async () => {
    const built = existsSync(designsIndex);
    for (const path of ["/tree-designs", "/tree-designs/"]) {
      const page = await fetch(base() + path);
      expect(page.status).toBe(built ? 200 : 503);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      if (!built) {
        expect(html).toContain("Decision tree designs");
        expect(html).toContain("pnpm build:designs");
      }
    }
    if (built) {
      const html = await (await fetch(base() + "/tree-designs")).text();
      const bundle = html.match(/src="\/tree-designs\/assets\/([^"]+\.js)"/)?.[1];
      expect(bundle, "the page names its bundle").toBeTruthy();
      expect(readdirSync(designsAssets)).toContain(bundle);
      const js = await fetch(`${base()}/tree-designs/assets/${bundle}`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect((await fetch(base() + "/tree-designs/assets/missing.js")).status).toBe(404);
    }
  });

  it("refuses a foreign Host header", async () => {
    // fetch will not send a foreign Host header; node's request will.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/tree-designs", method: "GET", headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(foreign).toBe(403);
  });
});

describe("removed tree lab route", () => {
  it("no longer serves /tree-lab or its assets", async () => {
    for (const path of ["/tree-lab", "/tree-lab/", "/tree-lab/assets/index.js"]) {
      const res = await fetch(base() + path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});
