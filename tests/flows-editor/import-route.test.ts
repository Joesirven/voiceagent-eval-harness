import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFlowEditorRoute, safeProblems } from "../../src/server/flow-editor-routes.js";

const python = process.env.VOICE_HARNESS_PIPECAT_PYTHON ?? "/tmp/voice-harness-pipecat-venv/bin/python";
const repoRoot = resolve(__dirname, "..", "..");
const bridgeScript = join(repoRoot, "scripts", "flows-editor", "flow_bridge.py");
const pythonPresent = existsSync(python);
if (!pythonPresent) console.warn(`import-route tests skipped: Pipecat interpreter not found at ${python}`);

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
const brokenFlow = goodFlow.replace("transition_to: b", "transition_to: ghost");

let root: string;
let flowFile: string;
let server: Server;
let port: number;
let handlersFile: string | undefined;

function leftovers(): string[] {
  const dir = join(root, "artifacts", "flows-editor");
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "flow-import-"));
  flowFile = join(root, "runtime", "tree.flow.yaml");
  handlersFile = join(root, "no-such-handlers.py");
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    handleFlowEditorRoute(req.method ?? "GET", path, req, res, {
      root,
      env: { VOICE_HARNESS_PIPECAT_PYTHON: python, VOICE_HARNESS_FLOW_FILE: flowFile },
      bridgeScript,
      handlersFile,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function post(body: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  const all: Record<string, string> = {
    "content-type": "application/json",
    origin: `http://127.0.0.1:${port}`,
    ...headers,
  };
  for (const key of Object.keys(all)) if (all[key] === "") delete all[key];
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/flows/import", method: "POST", headers: { ...all, "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

describe.skipIf(!pythonPresent)("POST /api/flows/import", { timeout: 60_000 }, () => {
  it("writes the runtime file and reports ok, with handlersChecked false when no handlers file exists", async () => {
    const reply = await post(JSON.stringify({ flowName: "tree", yaml: goodFlow }));
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);
    expect(reply.body.handlersChecked).toBe(false);
    expect(reply.body.warnings).toEqual([]);
    expect(reply.body.path).toBe(flowFile);
    expect(readFileSync(flowFile, "utf8")).toBe(goodFlow);
    expect(leftovers()).toEqual([]);
  });

  it("passes --handlers when the handlers file exists", async () => {
    handlersFile = join(root, "flow_handlers.py");
    writeFileSync(handlersFile, "# no handlers\n");
    const reply = await post(JSON.stringify({ yaml: goodFlow }));
    expect(reply.status).toBe(200);
    expect(reply.body.handlersChecked).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("refuses with the bridge problem lines and leaves the runtime file byte-identical", async () => {
    mkdirSync(join(root, "runtime"), { recursive: true });
    const before = Buffer.from("# existing runtime flow\ninitial_node: keep\n");
    writeFileSync(flowFile, before);
    const reply = await post(JSON.stringify({ yaml: brokenFlow }));
    expect(reply.status).toBe(422);
    expect(reply.body.ok).toBe(false);
    const problems = reply.body.problems as string[];
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("ghost");
    expect(readFileSync(flowFile).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a wrong Origin with 403", async () => {
    for (const origin of ["http://evil.example", `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, `http://192.168.0.1:${port}`]) {
      const reply = await post(JSON.stringify({ yaml: goodFlow }), { origin });
      expect(reply.status).toBe(403);
    }
    expect(existsSync(flowFile)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("accepts the localhost origin on the same port", async () => {
    const reply = await post(JSON.stringify({ yaml: goodFlow }), { origin: `http://localhost:${port}` });
    expect(reply.status).toBe(200);
  });

  it("refuses a missing Origin with 403", async () => {
    const reply = await post(JSON.stringify({ yaml: goodFlow }), { origin: "" });
    expect(reply.status).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a content type other than JSON with 415", async () => {
    const reply = await post(JSON.stringify({ yaml: goodFlow }), { "content-type": "text/plain" });
    expect(reply.status).toBe(415);
    expect(existsSync(flowFile)).toBe(false);
  });

  it("refuses a body just over 2 megabytes with 413", async () => {
    const over = Buffer.alloc(2 * 1024 * 1024 + 1, "a");
    const reply = await post(over);
    expect(reply.status).toBe(413);
    expect(leftovers()).toEqual([]);
  });

  it("refuses invalid JSON with 400", async () => {
    const reply = await post("{not json");
    expect(reply.status).toBe(400);
    expect(leftovers()).toEqual([]);
  });

  it("refuses an empty or missing yaml with 400", async () => {
    expect((await post(JSON.stringify({ yaml: "" }))).status).toBe(400);
    expect((await post(JSON.stringify({ yaml: "   \n" }))).status).toBe(400);
    expect((await post(JSON.stringify({ yaml: 5 }))).status).toBe(400);
    expect((await post(JSON.stringify({ flowName: "x" }))).status).toBe(400);
    expect(leftovers()).toEqual([]);
  });
});

function seedRuntimeFile(): Buffer {
  mkdirSync(join(root, "runtime"), { recursive: true });
  const before = Buffer.from("# existing runtime flow\ninitial_node: keep\n");
  writeFileSync(flowFile, before);
  return before;
}

/** A POST with no content-length header: the body goes out in chunks. */
function postChunked(chunks: Buffer[], headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/flows/import",
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "transfer-encoding": "chunked", ...headers },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }));
      },
    );
    req.on("error", fail);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe.skipIf(!pythonPresent)("POST /api/flows/import refusals keep the runtime file", { timeout: 60_000 }, () => {
  it("answers 413 for a chunked body over the cap with no content-length, file untouched", async () => {
    const before = seedRuntimeFile();
    const piece = Buffer.alloc(256 * 1024, "a");
    const reply = await postChunked(Array.from({ length: 9 }, () => piece));
    expect(reply.status).toBe(413);
    expect(readFileSync(flowFile).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("accepts a chunked body under the cap", async () => {
    const body = Buffer.from(JSON.stringify({ yaml: goodFlow }));
    const reply = await postChunked([body.subarray(0, 10), body.subarray(10)]);
    expect(reply.status).toBe(200);
    expect(readFileSync(flowFile, "utf8")).toBe(goodFlow);
  });

  it("accepts a content type with a charset parameter and an uppercase media type", async () => {
    const first = await post(JSON.stringify({ yaml: goodFlow }), { "content-type": "application/json; charset=utf-8" });
    expect(first.status).toBe(200);
    const second = await post(JSON.stringify({ yaml: goodFlow }), { "content-type": "Application/JSON" });
    expect(second.status).toBe(200);
  });

  it("refuses the Origin values null, trailing dot, uppercase and other localhost forms, file untouched", async () => {
    const before = seedRuntimeFile();
    const origins = [
      "null",
      `http://127.0.0.1.:${port}`,
      `http://localhost.:${port}`,
      `HTTP://127.0.0.1:${port}`,
      `http://LOCALHOST:${port}`,
      `http://127.0.0.1:${port}/`,
      `http://[::1]:${port}`,
      `http://0.0.0.0:${port}`,
    ];
    for (const origin of origins) {
      const reply = await post(JSON.stringify({ yaml: goodFlow }), { origin });
      expect(reply.status, origin).toBe(403);
    }
    expect(readFileSync(flowFile).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("leaves a pre-existing runtime file byte-identical for 403, 413, 415 and 400", async () => {
    const before = seedRuntimeFile();
    expect((await post(JSON.stringify({ yaml: goodFlow }), { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(Buffer.alloc(2 * 1024 * 1024 + 1, "a"))).status).toBe(413);
    expect((await post(JSON.stringify({ yaml: goodFlow }), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ yaml: "" }))).status).toBe(400);
    expect(readFileSync(flowFile).equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("does not handle other methods on the import path", async () => {
    const before = seedRuntimeFile();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/flows/import`, { method });
      expect(res.status, method).toBe(404);
    }
    expect(readFileSync(flowFile).equals(before)).toBe(true);
  });

  it("settles two imports at once with a whole file from one of them and no leftovers", async () => {
    const other = goodFlow.replace("Say goodbye.", "Say farewell.");
    const [one, two] = await Promise.all([
      post(JSON.stringify({ yaml: goodFlow })),
      post(JSON.stringify({ yaml: other })),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect([goodFlow, other]).toContain(readFileSync(flowFile, "utf8"));
    expect(leftovers()).toEqual([]);
  });

  it("does not leak paths or traceback lines in refusal text", async () => {
    seedRuntimeFile();
    const reply = await post(JSON.stringify({ yaml: "initial_node: a\nnodes: [unclosed" }));
    expect(reply.status).toBe(422);
    const text = JSON.stringify(reply.body);
    expect(text).not.toContain(root);
    expect(text).not.toContain("Traceback");
  });
});

describe("safeProblems", () => {
  const known = { file: "/tmp/x/artifacts/flows-editor/import-ab/editor-saved.flow.yaml", dir: "/tmp/x/artifacts/flows-editor/import-ab", root: "/tmp/x" };

  it("drops traceback lines and names the temporary file in words", () => {
    const stderr = `cannot read ${known.file}: boom\nTraceback (most recent call last):\n  File "/usr/lib/python3/x.py", line 3, in <module>\nValueError: nope\n`;
    expect(safeProblems(stderr, known)).toEqual(["cannot read the submitted flow: boom"]);
  });

  it("replaces the destination and any other absolute path", () => {
    const stderr = "cannot write /Users/someone/project/runtime/tree.flow.yaml: Permission denied\nschema: bad /opt/a/b value\n";
    expect(safeProblems(stderr, known)).toEqual(["cannot write <path>: Permission denied", "schema: bad <path> value"]);
  });

  it("keeps ordinary problem text and falls back when nothing is left", () => {
    expect(safeProblems("node 'a' transition_to 'ghost' is not a node\n", known)).toEqual(["node 'a' transition_to 'ghost' is not a node"]);
    expect(safeProblems("Traceback (most recent call last):\n  File \"/a/b\"\n", known)).toEqual(["the flow could not be checked"]);
  });
});

describe("POST /api/flows/import without an interpreter", () => {
  it("answers 503 pipecat_python_not_configured", async () => {
    const own = createServer((req, res) => {
      handleFlowEditorRoute("POST", "/api/flows/import", req, res, { root, env: {} });
    });
    await new Promise<void>((done) => own.listen(0, "127.0.0.1", done));
    const ownPort = (own.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${ownPort}/api/flows/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${ownPort}` },
      body: JSON.stringify({ yaml: goodFlow }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "pipecat_python_not_configured" });
    await new Promise((done) => own.close(done));
  });
});
