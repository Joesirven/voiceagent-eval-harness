import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  azureReadyForNewCall,
  azureStartupGate,
  azureStatus,
  checkAzure,
  resetAzureHealth,
  watchAzureFailures,
} from "../../src/server/azure-startup-check.js";
import { handle } from "../../src/server/dev-server.js";
import { traceBus } from "../../src/trace/index.js";

const ENV = { VOICE_HARNESS_DEV_ENV_FILE: "/fake/env" };
const SECRET_KEY = "super-secret-key-value";
const fsWith = (text: string) => ({ mode: () => 0o600, read: () => text });
const goodFs = fsWith(`AZURE_FOUNDRY_URL=https://secret-host.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=${SECRET_KEY}\n`);
const listing = (status: number) => vi.fn(async (_url: string, _init?: unknown) => new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status }));

afterEach(() => resetAzureHealth());

describe("the startup check", () => {
  it("working settings: the gate lets the server start and prints nothing", async () => {
    const log = vi.fn();
    const fetchMock = listing(200);
    expect(await azureStartupGate({ env: ENV, fs: goodFs, fetch: fetchMock as any, log })).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one free listing, no model call
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/openai\/deployments\?api-version=/);
  });

  it("missing settings: refuses and names the missing setting, never a value", async () => {
    const lines: string[] = [];
    const noKey = fsWith("AZURE_FOUNDRY_URL=https://secret-host.openai.azure.com/openai/v1\n");
    expect(await azureStartupGate({ env: ENV, fs: noKey, fetch: listing(200) as any, log: (l) => lines.push(l) })).toBe(false);
    expect(lines.join("\n")).toContain("AZURE_FOUNDRY_KEY is missing");
    expect(lines.join("\n")).not.toContain("secret-host");
    const none: string[] = [];
    expect(await azureStartupGate({ env: {}, fs: goodFs, fetch: listing(200) as any, log: (l) => none.push(l) })).toBe(false);
    expect(none.join("\n")).toContain("VOICE_HARNESS_DEV_ENV_FILE is not set");
  });

  it("a failed check: refuses with the failing check named, without the key or the host", async () => {
    const lines: string[] = [];
    expect(await azureStartupGate({ env: ENV, fs: goodFs, fetch: listing(401) as any, log: (l) => lines.push(l) })).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("WARNING");
    expect(out).toContain("authentication failed");
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain("secret-host");
    const unreachable = vi.fn(async () => { throw new Error("connect ECONNREFUSED secret-host"); });
    const status = await checkAzure({ env: ENV, fs: goodFs, fetch: unreachable as any });
    expect(status).toMatchObject({ ok: false, code: "foundry_unreachable" });
    expect(JSON.stringify(status)).not.toContain("secret-host");
  });

  it("the real dev server process exits nonzero before listening when settings are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-startup-"));
    const empty = join(dir, "env");
    writeFileSync(empty, "SOMETHING_ELSE=1\n", { mode: 0o600 });
    const result = spawnSync("node_modules/.bin/tsx", ["src/server/dev-server.ts"], {
      env: { PATH: process.env.PATH, PORT: "0", VOICE_HARNESS_DEV_ENV_FILE: empty },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WARNING Azure is not working");
    expect(result.stderr).toContain("Refusing to start");
    expect(result.stdout).not.toContain("Control page:");
  }, 70_000);
});

describe("runtime authentication failure", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const failedCall = (reason: string) => traceBus.emit({ type: "tool_call", leadId: "lead-1", recordId: "r1", channel: "call", callId: "c1", data: { tool: "foundry.decide", inputs: {}, result: null, success: false, reason, durationMs: 1 } });

  it("marks Azure as not working, ends calls in progress once, shows in /api/state, and refuses new calls until it works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    traceBus.reset();
    const ended = vi.fn();
    const stop = watchAzureFailures(ended);
    expect(azureStatus().ok).toBe(true);

    failedCall("foundry_timeout"); // a slow moment is not an authentication failure
    expect(azureStatus().ok).toBe(true);
    failedCall("foundry_auth");
    failedCall("foundry_deployment_not_found");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_auth", source: "runtime" });

    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.azureStatus).toMatchObject({ ok: false, code: "foundry_auth" });
    expect(state.decisionModuleStatus).toMatchObject({ available: false, reason: "azure_unavailable", azureCode: "foundry_auth" });

    const refused = await fetch(`${base}/api/play/start`, { method: "POST", body: JSON.stringify({ leadId: "lead-1", direction: "inbound" }) });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "azure_unavailable", code: "foundry_auth" });

    const later = Date.now() + 60_000; // the refused start above already used a recheck
    // Still failing: the recheck keeps the block. Passing: it lifts.
    expect((await azureReadyForNewCall({ env: ENV, fs: goodFs, fetch: listing(401) as any, now: () => later })).ok).toBe(false);
    expect((await azureReadyForNewCall({ env: ENV, fs: goodFs, fetch: listing(200) as any, now: () => later + 100 })).ok).toBe(false); // within the recheck interval
    expect((await azureReadyForNewCall({ env: ENV, fs: goodFs, fetch: listing(200) as any, now: () => later + 20_000 })).ok).toBe(true);
    expect(azureStatus().ok).toBe(true);
    stop();
  });
});
