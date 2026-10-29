// @vitest-environment jsdom
// Runs the flows editor page against the real route handlers on a real local server.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { URL as NodeUrl } from "node:url";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "../test/setup";
import { EDITOR_ORIGIN, FlowEditorView } from "./FlowEditorView";

// Only the interpreter lookup is replaced. The web transform of the test runner rewrites the
// file-relative URL inside the real lookup into a page URL, which cannot load here. The lookup
// below keeps its rule (an absolute path that exists); every route handler stays real.
vi.mock("../../../src/orchestration-modules/pipecat-config", async () => {
  const { existsSync } = await import("node:fs");
  const { isAbsolute } = await import("node:path");
  return {
    resolvePipecatPython: (env: NodeJS.ProcessEnv = process.env) => {
      const path = env.VOICE_HARNESS_PIPECAT_PYTHON?.trim();
      return path && isAbsolute(path) && existsSync(path) ? path : undefined;
    },
    pipecatVoiceSidecarPath: () => "",
  };
});

const python = process.env.VOICE_HARNESS_PIPECAT_PYTHON ?? "/tmp/voice-harness-pipecat-venv/bin/python";
const pythonPresent = existsSync(python);
if (!pythonPresent) console.warn(`flow editor route contract tests skipped: Pipecat interpreter not found at ${python}`);

const repoRoot = resolve(__dirname, "..", "..", "..");
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
let origin: string;
const realFetch = globalThis.fetch;

describe.skipIf(!pythonPresent)("flow editor page against the real routes", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-contract-"));
    mkdirSync(join(root, "src", "flow-tools"), { recursive: true });
    writeFileSync(join(root, "src", "flow-tools", "catalog.json"), readFileSync(join(repoRoot, "tests", "flows-editor", "fixtures", "catalog.synthetic.json")));
    flowFile = join(root, "runtime", "tree.flow.yaml");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(flowFile, goodFlow);
    const { handleFlowEditorRoute } = await import("../../../src/server/flow-editor-routes");
    server = createServer((req, res) => {
      const path = new NodeUrl(req.url ?? "/", "http://x").pathname;
      handleFlowEditorRoute(req.method ?? "GET", path, req, res, {
        root,
        env: { VOICE_HARNESS_PIPECAT_PYTHON: python, VOICE_HARNESS_FLOW_FILE: flowFile },
        bridgeScript: join(repoRoot, "scripts", "flows-editor", "flow_bridge.py"),
        handlersFile: join(root, "no-such-handlers.py"),
      }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server?.close(done));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** jsdom fetch has no page origin: send relative URLs to the server and add the Origin header the import route needs. */
  function routeFetchToServer() {
    vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) =>
      realFetch(new NodeUrl(input, origin).href, { ...init, headers: { origin, ...(init.headers as Record<string, string> | undefined) } }));
  }

  function mount() {
    routeFetchToServer();
    render(<FlowEditorView />);
    const frame = screen.getByTitle("Pipecat flows editor") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    return { frame, post };
  }
  function send(frame: HTMLIFrameElement, data: unknown) {
    act(() => { window.dispatchEvent(new MessageEvent("message", { data, origin: EDITOR_ORIGIN, source: frame.contentWindow })); });
  }

  it("shows the catalog tool names and sends the runtime flow when there is no draft", async () => {
    const { frame, post } = mount();
    send(frame, { type: "voice-agent-editor-ready", hasDraft: false });
    expect(await screen.findByText("fixture_tool_0")).toBeTruthy();
    expect(screen.getByText("fixture_tool_1")).toBeTruthy();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const message = post.mock.calls[0][0] as any;
    expect(message.type).toBe("voice-agent-load");
    expect(message.catalog.tools.length).toBeGreaterThan(1);
    expect(message.flowName).toBe("tree");
    expect(message.yaml).toBe(goodFlow);
    expect(post.mock.calls[0][1]).toBe(EDITOR_ORIGIN);
  });

  it("shows the success result with the path the real route returns for a valid saved flow", async () => {
    const { frame } = mount();
    send(frame, { type: "voice-agent-flow-saved", flowName: "tree", yaml: goodFlow });
    expect(await screen.findByText(/Imported/, {}, { timeout: 20000 })).toBeTruthy();
    const status = screen.getByRole("region", { name: "Last import" });
    expect(status.textContent).toMatch(/Imported to .*flow/);
    expect(status.textContent).not.toMatch(/refused|failed/);
  }, 30000);

  it("shows the real bridge problem line for a saved flow with a missing node target", async () => {
    const { frame } = mount();
    send(frame, { type: "voice-agent-flow-saved", flowName: "tree", yaml: brokenFlow });
    expect(await screen.findByText(/Import refused/, {}, { timeout: 20000 })).toBeTruthy();
    const list = screen.getByRole("region", { name: "Last import" }).querySelectorAll("li");
    expect(list.length).toBeGreaterThan(0);
    expect(Array.from(list).map((li) => li.textContent).join("\n")).toMatch(/ghost/);
  }, 30000);
});
