import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFlowEditorRoute } from "../../src/server/flow-editor-routes.js";

let root: string;
let server: Server;
let base: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "flow-routes-"));
  env = {};
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    handleFlowEditorRoute(req.method ?? "GET", path, req, res, { root, env }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/flow-tools/catalog", () => {
  it("returns 404 catalog_not_found when the catalog is absent", async () => {
    const res = await fetch(`${base}/api/flow-tools/catalog`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "catalog_not_found" });
  });

  it("returns the catalog JSON as is", async () => {
    mkdirSync(join(root, "src", "flow-tools"), { recursive: true });
    const catalog = { version: 1, tools: [{ name: "look_up_hours", risk: "read_only" }] };
    writeFileSync(join(root, "src", "flow-tools", "catalog.json"), JSON.stringify(catalog));
    const res = await fetch(`${base}/api/flow-tools/catalog`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(catalog);
  });
});

describe("GET /api/flow-tools/catalog with the synthetic fixture", () => {
  const fixture = join(import.meta.dirname, "fixtures", "catalog.synthetic.json");

  it("serves the real format unchanged, every status, templates object and credential", async () => {
    mkdirSync(join(root, "src", "flow-tools"), { recursive: true });
    const text = readFileSync(fixture, "utf8");
    writeFileSync(join(root, "src", "flow-tools", "catalog.json"), text);
    const res = await fetch(`${base}/api/flow-tools/catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      templates: Record<string, string>;
      tools: Array<{ status: string; credential?: string }>;
    };
    expect(body).toEqual(JSON.parse(text));
    expect(Array.isArray(body.templates)).toBe(false);
    expect(typeof body.templates).toBe("object");
    expect(new Set(body.tools.map((tool) => tool.status))).toEqual(
      new Set([
        "runs_in_harness_memory",
        "queued_after_call",
        "reads_development_project",
        "needs_seat_session",
        "needs_admin_machine_credential",
        "blocked_on_dana",
        "not_yet_built",
      ]),
    );
    expect(body.tools.every((tool) => typeof tool.credential === "string")).toBe(true);
  });

  it("tolerates a tool without a credential field", async () => {
    mkdirSync(join(root, "src", "flow-tools"), { recursive: true });
    const catalog = { version: 1, templates: {}, tools: [{ name: "a_tool", status: "queued_after_call" }] };
    writeFileSync(join(root, "src", "flow-tools", "catalog.json"), JSON.stringify(catalog));
    const res = await fetch(`${base}/api/flow-tools/catalog`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(catalog);
  });
});

describe("GET /api/flows/current", () => {
  it("returns 404 runtime_flow_not_found when the file is absent", async () => {
    env.VOICE_HARNESS_FLOW_FILE = join(root, "missing.flow.yaml");
    const res = await fetch(`${base}/api/flows/current`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "runtime_flow_not_found" });
  });

  it("returns the runtime file named by VOICE_HARNESS_FLOW_FILE", async () => {
    const file = join(root, "my-tree.flow.yaml");
    writeFileSync(file, "initial_node: a\n");
    env.VOICE_HARNESS_FLOW_FILE = file;
    const res = await fetch(`${base}/api/flows/current`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.path).toBe(file);
    expect(body.flowName).toBe("my-tree");
    expect(body.yaml).toBe("initial_node: a\n");
    expect(Number.isNaN(Date.parse(body.modifiedAt))).toBe(false);
  });

  it("falls back to the default runtime file under the root", async () => {
    mkdirSync(join(root, "src", "decision-tree"), { recursive: true });
    writeFileSync(join(root, "src", "decision-tree", "full-tree.flow.yaml"), "x: 1\n");
    const res = await fetch(`${base}/api/flows/current`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, string>).flowName).toBe("full-tree");
  });
});
