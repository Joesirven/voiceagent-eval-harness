import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import type { InteractiveCall } from "../../src/decision/interactive-call.js";
import type { LiveSocket } from "../../src/modules/azure-live-session.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { azureCatalogSnapshot, loadAzureCatalog, resetAzureCatalog, setAzureCatalogDeps } from "../../src/modules/azure-catalog.js";
import { handle } from "../../src/server/dev-server.js";
import { azureStatus, resetAzureHealth, watchAzureFailures } from "../../src/server/azure-startup-check.js";
import { DeepgramVoiceRuntime } from "../../src/server/voice/deepgram-voice-runtime.js";
import {
  activeVoiceCallId,
  closeActiveVoiceSession,
  openVoiceSession,
  resetTalkOrchestrator,
  resetVoiceDeps,
  selectTalkOrchestrator,
  selectVoicePath,
  setVoiceDeps,
  VoiceStartError,
  type OpenVoiceParams,
} from "../../src/server/voice/manager.js";
import type { PipecatVoiceRuntime, VoiceRuntimeHandlers } from "../../src/server/voice/pipecat-voice-runtime.js";
import { attachVoiceSockets, type VoiceCallHandle } from "../../src/server/voice/socket-route.js";
import { recentVoiceErrors, resetVoiceErrors } from "../../src/server/voice/voice-errors.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";
import { clearedTestCall } from "../helpers/cleared-call.js";
import { baseLead } from "../helpers/fixtures.js";

const fakeSidecar = fileURLToPath(new URL("../helpers/fake-deepgram-sidecar.mjs", import.meta.url));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(15);
  }
}

class FakeAzure {
  sent: Array<Record<string, any>> = [];
  closed = false;
  private onMsg: (raw: string) => void = () => undefined;
  private onClose: () => void = () => undefined;
  readonly socket: LiveSocket = {
    send: (data) => {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg.type === "session.start") queueMicrotask(() => this.say({ type: "session.started", session: { id: "s1" } }));
    },
    close: () => {
      this.closed = true;
      this.onClose();
    },
    onMessage: (cb) => void (this.onMsg = cb),
    onClose: (cb) => void (this.onClose = cb),
  };
  say(message: Record<string, unknown>): void {
    this.onMsg(JSON.stringify(message));
  }
}

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let cleared: InteractiveCall;
let callId: string;
let azure: FakeAzure;
let events: TraceEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", ""); // a refused start re-checks Azure with the real settings; none, so the block stays
  resetTalkOrchestrator();
  resetVoiceDeps();
  resetVoiceErrors();
  resetAzureHealth();
  resetHarnessConfig();
  resetModuleRegistry();
  resetAzureCatalog();
  resetLeadStore();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
  traceBus.reset();
  selectTalkOrchestrator("direct");
  cleared = await clearedTestCall();
  callId = cleared.callId;
  azure = new FakeAzure();
  events = [];
  unsubscribe = traceBus.subscribe((e) => {
    if (e.callId === callId && e.type === "voice_error") events.push(e);
  });
  setVoiceDeps({
    socketFactory: async () => azure.socket,
    credentials: () => ({ liveUrl: "wss://example.invalid/openai/v1/live/sessions", apiKey: "k" }),
    log: () => undefined,
    retryDelayMs: 0,
  });
});
afterEach(async () => {
  unsubscribe();
  await cleared?.hangUp().catch(() => undefined);
  resetVoiceDeps();
  resetAzureHealth();
  resetVoiceErrors();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function params(over: Partial<OpenVoiceParams> = {}): OpenVoiceParams & { ended: string[]; errors: string[] } {
  const state = { ended: [] as string[], errors: [] as string[] };
  return Object.assign(state, {
    call: cleared,
    input: "text" as const,
    trace: { leadId: "lead-1", leadLabel: "Jane", recordId: callId, channel: "call" as const, direction: "inbound" as const, callId },
    leadFirstName: "Jane",
    direction: "inbound" as const,
    disclosure: "Hi, I am an AI assistant.",
    packet: buildLeadContextPacket(baseLead()),
    dialogOwnsTranscript: false,
    onAudio: () => {},
    onClearPlayback: () => {},
    onProviderError: (code: string) => void state.errors.push(code),
    onEnd: (s: { reason: string }) => void state.ended.push(s.reason),
    ...over,
  });
}

const codes = () => recentVoiceErrors().map((r) => r.code);

/** A new call start is refused with 503 azure_unavailable while Azure is marked as not working. */
async function expectNewCallsBlocked(azureCode: string): Promise<void> {
  await tick(0); // the block is applied right after the caller has told the page
  expect(azureStatus()).toMatchObject({ ok: false, code: azureCode });
  const state = (await (await fetch(`${base}/api/state`)).json()) as any;
  expect(state.azureStatus).toMatchObject({ ok: false, code: azureCode });
  expect(state.voiceErrors.at(-1)).toMatchObject({ blocksNewCalls: true });
  const refused = await fetch(`${base}/api/play/start`, { method: "POST", body: JSON.stringify({ leadId: "lead-1", direction: "inbound" }) });
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: "azure_unavailable", code: azureCode });
}

describe("direct Azure path", () => {
  it("an authentication failure notifies with the fix, blocks the next start with 503, and is not retried", async () => {
    const factory = vi.fn(async () => {
      throw new Error("azure_auth_failed");
    });
    setVoiceDeps({ socketFactory: factory });
    const p = params();
    const err = await openVoiceSession(p).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceStartError);
    expect(err.message).toBe("azure_auth_failed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(activeVoiceCallId()).toBeUndefined();
    expect(p.ended).toEqual(["start_failed"]); // the failed call ends cleanly
    const record = err.record;
    expect(record).toMatchObject({ code: "azure_auth_failed", severity: "error", canContinue: false, blocksNewCalls: true, path: "azure_gpt_live", callId });
    expect(record.fix).toContain("AZURE_FOUNDRY_KEY");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ code: "azure_auth_failed", title: record.title, fix: record.fix, severity: "error" });
    await expectNewCallsBlocked("foundry_auth");
  });

  it("an in-session authentication error event also blocks, and carries the code to the page", async () => {
    const p = params();
    await openVoiceSession(p);
    azure.say({ type: "error", error: { code: "invalid_api_key", message: "provider text that must not surface" } });
    expect(p.errors).toEqual(["azure_auth_failed"]);
    expect(JSON.stringify(recentVoiceErrors())).not.toContain("provider text");
    expect(p.ended).toEqual(["azure_error"]);
    await expectNewCallsBlocked("foundry_auth");
  });

  /** Azure answers the session start with this error event instead of session.started. */
  function refuseSessionStart(error: Record<string, unknown>): void {
    const original = azure.socket.send;
    azure.socket.send = (data) => {
      if (JSON.parse(data).type === "session.start") return void queueMicrotask(() => azure.say({ type: "error", event_id: "e1", error }));
      original(data);
    };
  }

  function usePath(orchestrator: "direct" | "pipecat"): void {
    selectTalkOrchestrator(orchestrator);
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath); // the helper is faked; Azure refuses before it would start
    setVoiceDeps({ pipecatRuntime: () => ({}) as PipecatVoiceRuntime });
  }

  it.each([["direct", "text"], ["pipecat", "audio"]] as const)(
    "Azure's reply to a model it has not deployed (as the real service sent it) is a fixable model error on the %s path, with Azure's type and code, and does not block new calls",
    async (orchestrator, input) => {
      usePath(orchestrator);
      const lines: string[] = [];
      setVoiceDeps({ log: (l) => void lines.push(l) });
      refuseSessionStart({ type: "invalid_request_error", code: "model_not_deployed", message: "Model deployment 'gpt-realtime' was not found at wss://secret.example.invalid", param: "model" });
      const err = await openVoiceSession(params({ input })).catch((e) => e);
      const path = orchestrator === "pipecat" ? "pipecat" : "azure_gpt_live";
      expect(lines).toContain(`voice error call=${callId} code=azure_model_not_deployed path=${path} model=gpt-live-1 azure=invalid_request_error / model_not_deployed`);
      expect(lines.join("\n")).not.toMatch(/secret\.example|was not found/);
      expect(err).toBeInstanceOf(VoiceStartError);
      expect(err.message).toBe("azure_model_not_deployed");
      expect(err.record).toMatchObject({ code: "azure_model_not_deployed", blocksNewCalls: false, canContinue: false });
      expect(err.record.detail).toContain("Azure said: invalid_request_error / model_not_deployed.");
      expect(err.record.fix).toContain("Model menu in Settings");
      expect(err.record.detail).toContain("Model: gpt-live-1; live deployments allowed: gpt-live-1.");
      expect(JSON.stringify(recentVoiceErrors())).not.toMatch(/secret\.example|was not found/);
      expect(azureStatus().ok).toBe(true);
    },
  );

  it("any other refusal of the session start stays azure_session_rejected and carries Azure's own type and code", async () => {
    refuseSessionStart({ type: "invalid_request_error", code: "unsupported_audio_format", message: "provider text that must not surface" });
    const err = await openVoiceSession(params()).catch((e) => e);
    expect(err.record).toMatchObject({ code: "azure_session_rejected", blocksNewCalls: false });
    expect(err.record.detail).toContain("Azure said: invalid_request_error / unsupported_audio_format.");
    expect(JSON.stringify(recentVoiceErrors())).not.toContain("provider text");
  });

  it("Azure failing to create the session (server_error / output_creation_failed, as gpt-realtime-2.1 answered) is a refusal with Azure's type and code, not retried", async () => {
    let opened = 0;
    const lines: string[] = [];
    setVoiceDeps({ socketFactory: async () => (opened++, azure.socket), log: (l) => void lines.push(l) });
    refuseSessionStart({ type: "server_error", code: "output_creation_failed", message: "provider text that must not surface" });
    const err = await openVoiceSession(params()).catch((e) => e);
    expect(err.record).toMatchObject({ code: "azure_session_rejected", blocksNewCalls: false });
    expect(err.record.detail).toContain("Azure said: server_error / output_creation_failed.");
    expect(opened).toBe(1);
    expect(lines.some((l) => l.includes("code=azure_session_rejected") && l.includes("azure=server_error / output_creation_failed"))).toBe(true);
  });

  it("with the settings naming another live deployment, a fresh server starts on it and saving the voice with the model unchanged works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-name-"));
    const file = join(dir, "dev.env");
    writeFileSync(file, "AZURE_REALTIME_DEPLOYMENT=gpt-live-1-eu\n", { mode: 0o600 });
    vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", file);
    resetModuleRegistry();
    resetAzureCatalog();
    const module = getModuleRegistry().get("azure-gpt-live");
    expect(module.getConfig().model).toBe("gpt-live-1-eu");
    expect(module.info()).toMatchObject({ modelAllowed: true, modelChoices: ["gpt-live-1-eu"] });
    expect(module.updateConfig({ voice: "marin", model: "gpt-live-1-eu", latency: { firstResponseMs: 400 } }).voice).toBe("marin");
    const session = await openVoiceSession(params());
    expect(azure.sent.find((m) => m.type === "session.start")!.session.model).toBe("gpt-live-1-eu");
    session.stop();
  });

  it.each([["direct", "text"], ["pipecat", "audio"]] as const)(
    "a model the Azure catalog does not list is refused on the %s path before Azure is opened, with a fixable error",
    async (orchestrator, input) => {
      usePath(orchestrator);
      const dir = mkdtempSync(join(tmpdir(), "catalog-"));
      const file = join(dir, "dev.env");
      writeFileSync(file, "AZURE_FOUNDRY_URL=https://example-test.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=k\n", { mode: 0o600 });
      const listing = (names: string[]) => (async () =>
        new Response(JSON.stringify({ data: names.map((id) => ({ id, model: "gpt-live-1", status: "succeeded" })) }), { status: 200 })) as unknown as typeof fetch;
      setAzureCatalogDeps({ env: { VOICE_HARNESS_DEV_ENV_FILE: file }, fetch: listing(["gpt-live-1", "gpt-live-1-eu"]) });
      await loadAzureCatalog();
      const module = getModuleRegistry().get("azure-gpt-live")!;
      module.updateConfig({ model: "gpt-live-1-eu" });
      // The deployment is removed after it was chosen (or the server kept an old choice, as on a test call).
      setAzureCatalogDeps({ fetch: listing(["gpt-live-1"]) });
      await loadAzureCatalog();
      expect(azureCatalogSnapshot()!.status.ok).toBe(true);
      let opened = 0;
      const lines: string[] = [];
      setVoiceDeps({ socketFactory: async () => (opened++, azure.socket), log: (l) => void lines.push(l) });
      const err = await openVoiceSession(params({ input })).catch((e) => e);
      expect(err).toBeInstanceOf(VoiceStartError);
      expect(err.record).toMatchObject({ code: "azure_model_not_deployed", blocksNewCalls: false, callId });
      expect(err.record.fix).toContain("Model menu in Settings");
      // The refused model and the allowed list are named, in the record and in one server log line.
      expect(err.record.detail).toContain("Model: gpt-live-1-eu; live deployments allowed: gpt-live-1.");
      expect(lines.filter((l) => l.startsWith("voice error "))).toEqual([
        `voice error call=${callId} code=azure_model_not_deployed path=${orchestrator === "pipecat" ? "pipecat" : "azure_gpt_live"} model=gpt-live-1-eu azure=none`,
      ]);
      expect(getModuleRegistry().get("azure-gpt-live").info()).toMatchObject({ modelAllowed: false });
      expect((getModuleRegistry().get("azure-gpt-live").info() as { modelNotAllowedReason?: string }).modelNotAllowedReason).toContain("gpt-live-1-eu");
      expect(opened).toBe(0);
      expect(activeVoiceCallId()).toBeUndefined();
    },
  );

  it("an Azure error during the call carries Azure's own type and code into the record and the log line", async () => {
    const lines: string[] = [];
    setVoiceDeps({ log: (l) => void lines.push(l) });
    const p = params();
    await openVoiceSession(p);
    azure.say({ type: "error", error: { type: "server_error", code: "internal_failure", message: "provider text that must not surface" } });
    const record = recentVoiceErrors().at(-1)!;
    expect(record.code).toBe("azure_error");
    expect(record.detail).toContain("Azure said: server_error / internal_failure.");
    expect(lines.some((l) => l.includes("code=azure_error") && l.includes("azure=server_error / internal_failure"))).toBe(true);
    expect(JSON.stringify(recentVoiceErrors()) + lines.join("\n")).not.toContain("provider text");
  });

  it("a retried start and Azure closing during the call each write a voice error log line", async () => {
    const lines: string[] = [];
    let attempts = 0;
    setVoiceDeps({
      log: (l) => void lines.push(l),
      socketFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("azure_connect_failed");
        return azure.socket;
      },
    });
    const session = await openVoiceSession(params());
    expect(lines).toContain(`voice error call=${callId} code=azure_connect_failed path=azure_gpt_live model=gpt-live-1 azure=none retrying=yes`);
    azure.socket.close(); // Azure drops the connection in the middle of the call
    expect(lines).toContain(`voice error call=${callId} code=azure_closed path=azure_gpt_live model=gpt-live-1 azure=none`);
    session.stop();
  });

  it("a missing deployment blocks too", async () => {
    setVoiceDeps({ socketFactory: async () => { throw new Error("azure_deployment_not_found"); } });
    await expect(openVoiceSession(params())).rejects.toThrow("azure_deployment_not_found");
    await expectNewCallsBlocked("foundry_deployment_not_found");
  });

  it("settings problems block, with a fix that names the setting", async () => {
    setVoiceDeps({ credentials: () => { throw new Error("azure_settings_missing_key"); } });
    const err = await openVoiceSession(params()).catch((e) => e);
    expect(err.record.fix).toContain("AZURE_FOUNDRY_KEY");
    await tick(0);
    expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_missing_AZURE_FOUNDRY_KEY" });
  });

  it("a connection failure is retried once; when the retry works the call goes on and the first failure was a warning", async () => {
    let n = 0;
    setVoiceDeps({ socketFactory: async () => { if (++n === 1) throw new Error("azure_connect_failed"); return azure.socket; } });
    const p = params();
    const session = await openVoiceSession(p);
    expect(n).toBe(2);
    expect(activeVoiceCallId()).toBe(callId);
    expect(p.ended).toEqual([]); // the failed first attempt did not end the call
    expect(recentVoiceErrors()).toHaveLength(1);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "azure_connect_failed", severity: "warning", canContinue: true, blocksNewCalls: false });
    await tick(0);
    expect(recentVoiceErrors()[0]!.detail).toContain("trying once more");
    expect(azureStatus().ok).toBe(true);
    session.stop();
  });

  it("when the retry fails too, the call ends once with an error notification, and new calls are blocked until Azure can be reached", async () => {
    const factory = vi.fn(async () => {
      throw new Error("azure_connect_failed");
    });
    setVoiceDeps({ socketFactory: factory });
    const p = params();
    const err = await openVoiceSession(p).catch((e) => e);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(err.message).toBe("azure_connect_failed");
    expect(recentVoiceErrors().map((r) => [r.code, r.severity, r.blocksNewCalls])).toEqual([["azure_connect_failed", "warning", false], ["azure_connect_failed", "error", true]]);
    expect(p.ended).toEqual(["start_failed"]);
    expect(activeVoiceCallId()).toBeUndefined();
    await expectNewCallsBlocked("foundry_unreachable");
  });

  it("the socket closing in the middle of a call is reported once and does not block", async () => {
    const p = params();
    await openVoiceSession(p);
    azure.socket.close();
    expect(p.ended).toEqual(["azure_closed"]);
    expect(codes()).toEqual(["azure_closed"]);
    expect(azureStatus().ok).toBe(true);
  });

  it("the caller leaving during the start is not an error", async () => {
    const left = new AbortController();
    setVoiceDeps({ socketFactory: () => new Promise(() => undefined) });
    const pending = openVoiceSession(params({ signal: left.signal })).catch((e) => e);
    await tick(10);
    left.abort();
    expect((await pending).message).toBe("voice_session_ended");
    expect(recentVoiceErrors()).toEqual([]);
  });
});

describe("Pipecat path", () => {
  /** A stand-in for the Pipecat helper process. */
  function fakeRuntimes(plan: Array<"ok" | "pipecat_failed" | "pipecat_unavailable">) {
    const made: Array<{ handlers?: VoiceRuntimeHandlers; stopped: boolean }> = [];
    const factory = () => {
      const state: { handlers?: VoiceRuntimeHandlers; stopped: boolean } = { stopped: false };
      made.push(state);
      const outcome = plan[made.length - 1] ?? "ok";
      return {
        start: async (h: VoiceRuntimeHandlers) => {
          state.handlers = h;
          if (outcome !== "ok") throw new Error(outcome);
        },
        stop: async () => void (state.stopped = true),
        cancel: async () => void (state.stopped = true),
        sendCallerAudio: () => undefined,
        relayModelAudio: () => undefined,
        bargeIn: () => undefined,
        get isStopped() {
          return state.stopped;
        },
        toModelFrames: 0,
      } as unknown as PipecatVoiceRuntime;
    };
    return { made, factory };
  }

  beforeEach(() => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath); // any existing absolute path: the helper itself is faked
    selectTalkOrchestrator("pipecat");
  });

  it("an Azure authentication failure blocks the next start with 503 and notifies on the Pipecat path", async () => {
    setVoiceDeps({ socketFactory: async () => { throw new Error("azure_auth_failed"); }, pipecatRuntime: fakeRuntimes([]).factory });
    const err = await openVoiceSession(params({ input: "audio" })).catch((e) => e);
    expect(err.record).toMatchObject({ code: "azure_auth_failed", path: "pipecat", blocksNewCalls: true });
    expect(events).toHaveLength(1);
    await expectNewCallsBlocked("foundry_auth");
  });

  it("a helper that fails to start is retried once and the call goes live; Azure is reconnected cleanly", async () => {
    const { made, factory } = fakeRuntimes(["pipecat_failed", "ok"]);
    setVoiceDeps({ pipecatRuntime: factory });
    const p = params({ input: "audio" });
    const session = await openVoiceSession(p);
    expect(made).toHaveLength(2);
    expect(p.ended).toEqual([]);
    expect(recentVoiceErrors()).toHaveLength(1);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "pipecat_failed", severity: "warning", path: "pipecat" });
    expect(azureStatus().ok).toBe(true);
    session.stop();
  });

  it("a helper that keeps failing ends the call with an error notification and does not block new calls", async () => {
    const { factory } = fakeRuntimes(["pipecat_failed", "pipecat_failed"]);
    setVoiceDeps({ pipecatRuntime: factory });
    const p = params({ input: "audio" });
    const err = await openVoiceSession(p).catch((e) => e);
    expect(err.message).toBe("pipecat_failed");
    expect(recentVoiceErrors().map((r) => r.severity)).toEqual(["warning", "error"]);
    expect(err.record.fix).toContain("Direct Azure");
    expect(azure.closed).toBe(true); // Azure was not left open
    expect(activeVoiceCallId()).toBeUndefined();
    expect(azureStatus().ok).toBe(true);
  });

  it("a helper that crashes in the middle of a call is restarted once; a second crash ends the call with a notification", async () => {
    const { made, factory } = fakeRuntimes([]);
    setVoiceDeps({ pipecatRuntime: factory });
    const p = params({ input: "audio" });
    await openVoiceSession(p);
    made[0]!.handlers!.onFailure("pipecat_closed");
    await until(() => made.length === 2);
    await tick(20);
    expect(p.ended).toEqual([]);
    expect(recentVoiceErrors()).toHaveLength(1);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "pipecat_closed", severity: "warning", canContinue: true });
    made[1]!.handlers!.onFailure("pipecat_closed");
    await until(() => p.ended.length === 1);
    expect(p.ended).toEqual(["pipecat_failed"]);
    expect(recentVoiceErrors().map((r) => [r.code, r.severity])).toEqual([["pipecat_closed", "warning"], ["pipecat_closed", "error"]]);
    expect(p.errors).toEqual(["pipecat_closed"]);
    expect(azureStatus().ok).toBe(true);
  });

  it("an interpreter that is not configured is a clear, non-blocking error", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", "");
    const err = await openVoiceSession(params({ input: "audio" })).catch((e) => e);
    expect(err.record).toMatchObject({ code: "pipecat_interpreter_not_configured", blocksNewCalls: false });
    expect(err.record.fix).toContain("VOICE_HARNESS_PIPECAT_PYTHON");
    expect(azureStatus().ok).toBe(true);
  });
});

describe("Deepgram path", () => {
  const counterDir = mkdtempSync(join(tmpdir(), "dg-errors-"));
  let counterN = 0;
  /** A runtime factory bound to the fake sidecar; each call is a fresh process. */
  function deepgramRuntime(mode: string, errorCode?: string) {
    const counter = join(counterDir, `first-${(counterN += 1)}`);
    return () =>
      new DeepgramVoiceRuntime(() => ({
        command: process.execPath,
        args: [fakeSidecar],
        env: { PATH: process.env.PATH ?? "", FAKE_MODE: mode, FAKE_COUNTER: counter, ...(errorCode ? { FAKE_ERROR_CODE: errorCode } : {}) },
      }));
  }
  const audio = Buffer.from([1]).toString("base64");

  it("an Azure authentication failure from the sidecar blocks the next start with 503 and notifies", async () => {
    setVoiceDeps({ deepgramRuntime: deepgramRuntime("error_on_audio", "azure_auth_failed") });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    const p = params({ input: "audio" });
    const session = await openVoiceSession(p);
    session.sendAudio(audio);
    await until(() => p.ended.length === 1);
    expect(p.errors).toEqual(["azure_auth_failed"]);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "azure_auth_failed", path: "deepgram", blocksNewCalls: true, callId });
    expect(events).toHaveLength(1);
    await expectNewCallsBlocked("foundry_auth");
  });

  it("a rejected Deepgram key notifies with the fix and does not block", async () => {
    setVoiceDeps({ deepgramRuntime: deepgramRuntime("error_on_audio", "deepgram_key_rejected") });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    const p = params({ input: "audio" });
    const session = await openVoiceSession(p);
    session.sendAudio(audio);
    await until(() => p.ended.length === 1);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "deepgram_key_rejected", severity: "error", blocksNewCalls: false });
    expect(recentVoiceErrors()[0]!.fix).toContain("DEEPGRAM_API_KEY");
    expect(azureStatus().ok).toBe(true);
    const next = await fetch(`${base}/api/play/start`, { method: "POST", body: JSON.stringify({ leadId: "lead-1", direction: "inbound" }) });
    expect(next.status).not.toBe(503);
  });

  it("a helper that dies on its first start is restarted once and the call goes live", async () => {
    setVoiceDeps({ deepgramRuntime: deepgramRuntime("die_first_start") });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    const p = params({ input: "audio" });
    const session = await openVoiceSession(p);
    expect(p.ended).toEqual([]);
    expect(recentVoiceErrors().map((r) => [r.code, r.severity])).toEqual([["deepgram_closed", "warning"]]);
    session.stop();
  });

  it("a helper that never starts ends the call with an error notification after one retry, without blocking", async () => {
    setVoiceDeps({ deepgramRuntime: deepgramRuntime("die_before_ready") });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    const p = params({ input: "audio" });
    const err = await openVoiceSession(p).catch((e) => e);
    expect(err.message).toBe("deepgram_closed");
    expect(recentVoiceErrors().map((r) => r.severity)).toEqual(["warning", "error"]);
    expect(p.ended).toEqual(["start_failed"]);
    expect(azureStatus().ok).toBe(true);
  });
});

describe("outside a call and on the page", () => {
  it("a failed selection is in /api/state without any call", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", "");
    expect(() => selectVoicePath("vapi" as never)).toThrow("unknown_voice_path");
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.voiceErrors).toHaveLength(1);
    expect(state.voiceErrors[0]).toMatchObject({ code: "unknown_voice_path", severity: "warning", canContinue: true });
    expect(state.voiceErrors[0].callId).toBeUndefined();
    expect(state.azureStatus.ok).toBe(true);
  });

  describe("browser socket", () => {
    let wsServer: Server;
    let port: number;
    let received: Array<Record<string, any>>;
    const lookup = (): VoiceCallHandle => ({ call: cleared, leadId: "lead-1", direction: "inbound", say: async () => "ok", disclosure: () => "Hi, I am an AI assistant." });
    beforeEach(async () => {
      received = [];
      wsServer = createServer();
      attachVoiceSockets(wsServer, (id) => (id === callId ? lookup() : undefined), { microphoneWaitMs: 60 });
      await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r));
      port = (wsServer.address() as AddressInfo).port;
    });
    afterEach(() => new Promise<void>((r) => (wsServer.closeAllConnections(), wsServer.close(() => r()))));
    const connect = (query = "") =>
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/${callId}/socket${query}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
        ws.on("message", (d) => received.push(JSON.parse(d.toString())));
        ws.once("open", () => resolve(ws));
      });

    it("a failed start sends the full error frame, with code, title and fix", async () => {
      setVoiceDeps({ socketFactory: async () => { throw new Error("azure_auth_failed"); } });
      const ws = await connect("?input=text");
      await until(() => received.some((m) => m.type === "error")).catch((e) => { console.warn(JSON.stringify(received), JSON.stringify(recentVoiceErrors())); throw e; });
      expect(received.find((m) => m.type === "error")).toMatchObject({
        type: "error",
        code: "azure_auth_failed",
        title: "Azure refused the key",
        severity: "error",
        canContinue: false,
        blocksNewCalls: true,
        callId,
      });
      expect(received.find((m) => m.type === "error")!.fix).toContain("AZURE_FOUNDRY_KEY");
      ws.close();
    });

    it("a provider error during the call sends the frame; a microphone call without audio gets a warning and keeps going", async () => {
      const ws = await connect();
      await until(() => received.some((m) => m.type === "status" && m.state === "ready"));
      await until(() => received.some((m) => m.code === "microphone_audio_missing"));
      expect(received.find((m) => m.code === "microphone_audio_missing")).toMatchObject({ severity: "warning", canContinue: true });
      expect(activeVoiceCallId()).toBe(callId); // the call was not ended
      azure.say({ type: "error", error: { code: "rate_limit_exceeded" } });
      await until(() => received.some((m) => m.code === "azure_rate_limited"));
      expect(azureStatus().ok).toBe(true);
      ws.close();
    });

    it("with the server's Azure block on (as the dev server runs it), the page still gets the error frame before the call ends", async () => {
      const stopWatching = watchAzureFailures(() => closeActiveVoiceSession("azure_unavailable"));
      try {
        const ws = await connect("?input=text");
        await until(() => received.some((m) => m.type === "status" && m.state === "ready"));
        azure.say({ type: "error", error: { code: "invalid_api_key", message: "provider text that must not surface" } });
        await until(() => received.some((m) => m.type === "status" && m.state === "ended"));
        const kinds = received.map((m) => (m.type === "error" ? m.code : m.type === "status" ? `status:${m.state}` : m.type));
        expect(kinds).toEqual(["status:ready", "azure_auth_failed", "status:ended"]);
        expect(received.find((m) => m.type === "error")).toMatchObject({ blocksNewCalls: true, severity: "error", callId });
        expect(JSON.stringify(received)).not.toContain("provider text");
        expect(azureStatus()).toMatchObject({ ok: false, code: "foundry_auth" });
        ws.close();
      } finally {
        stopWatching();
      }
    });

    it("typed audio frames keep the missing-microphone warning away", async () => {
      const ws = await connect();
      await until(() => received.some((m) => m.type === "status" && m.state === "ready"));
      ws.send(Buffer.from([1, 2, 3]));
      await tick(150);
      expect(received.some((m) => m.code === "microphone_audio_missing")).toBe(false);
      ws.close();
    });
  });
});
