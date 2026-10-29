import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import type { InteractiveCall } from "../../src/decision/interactive-call.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import type { LiveSocket, LiveSocketFactory } from "../../src/modules/azure-live-session.js";
import { liveModelIds, loadAzureCatalog, resetAzureCatalog, setAzureCatalogDeps } from "../../src/modules/azure-catalog.js";
import { VOICE_LIVE_MODEL, VOICE_LIVE_TOOLS_NOTE, VOICE_LIVE_VOICE } from "../../src/modules/azure-voice-live-session.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { azureStatus, resetAzureHealth } from "../../src/server/azure-startup-check.js";
import { handle } from "../../src/server/dev-server.js";
import type { AzureVoiceLiveCredentials } from "../../src/server/voice/azure-voice-live-credentials.js";
import { resetDecisionRouterChoices } from "../../src/server/voice/decision-router.js";
import { flowFunctionTools } from "../../src/server/voice/flow-tool-runner.js";
import { thinkerTools } from "../../src/server/voice/live-thinker.js";
import {
  activeVoiceCallId,
  closeActiveVoiceSession,
  listVoicePaths,
  openVoiceSession,
  realVoiceLiveSocketFactory,
  resetTalkOrchestrator,
  resetVoiceDeps,
  resolveVoiceSessionMode,
  RETRYABLE_START_CODES,
  selectTalkOrchestrator,
  selectVoicePath,
  selectedVoicePath,
  setVoiceDeps,
  voiceErrorPathFor,
  voiceLiveHandshakeCode,
  VoiceStartError,
  voiceLiveChoice,
  type OpenVoiceParams,
} from "../../src/server/voice/manager.js";
import { PipecatVoiceRuntime } from "../../src/server/voice/pipecat-voice-runtime.js";
import { attachVoiceSockets } from "../../src/server/voice/socket-route.js";
import { isVoiceErrorCode, recentVoiceErrors, reportVoiceError, resetVoiceErrors } from "../../src/server/voice/voice-errors.js";
import type { ProviderCatalog, VoiceOptions, VoicePathOption } from "../../src/server/voice/voice-options.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/index.js";
import { clearedTestCall } from "../helpers/cleared-call.js";
import { baseLead } from "../helpers/fixtures.js";

// No test here reaches Deepgram: its catalog answers with a fixed list (the Azure listing is refused by the test setup).
vi.mock("../../src/modules/deepgram-catalog.js", () => ({
  loadDeepgramCatalog: async (): Promise<ProviderCatalog> => ({
    status: { provider: "deepgram", ok: true, checkedAt: "2026-10-20T00:00:00.000Z" },
    models: [
      { id: "nova-3-general", label: "nova-3-general", role: "speech_to_text", provider: "deepgram" },
      { id: "aura-2", label: "Aura-2", role: "text_to_speech", provider: "deepgram", voices: ["aura-2-thalia-en"] },
    ],
  }),
}));

const KEY = "voice-live-test-key";
const RESOURCE = "https://example-voice-live-test.services.ai.azure.com";
const SOCKET_BASE = "wss://example-voice-live-test.services.ai.azure.com/voice-live/realtime?api-version=2026-04-10&model=";
const DISCLOSURE = "Hi, I am an AI assistant.";
const VOICE_LIVE_RESTART = "Restart the call. If it repeats, check the Azure Voice Live resource and the network, or set Voice path to Azure gpt-live.";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(15);
  }
}

/** A stand-in for the Voice Live websocket, answering in the order the real service did on 2026-10-20. */
class FakeVoiceLive {
  sent: Array<Record<string, any>> = [];
  closed = false;
  private onMsg: (raw: string) => void = () => undefined;
  private onCloseCb: () => void = () => undefined;
  /** The first event after connect: session.created, or an error event (a refused model or key arrives before session.created). */
  constructor(private readonly first: Record<string, unknown> = { type: "session.created", session: { id: "sess_1" } }) {}
  readonly socket: LiveSocket = {
    send: (data) => {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      // session.updated echoes the whole session, with the model and the input sample rate added.
      if (msg.type === "session.update") {
        queueMicrotask(() => this.say({ type: "session.updated", session: { ...msg.session, model: "gpt-realtime", input_audio_sampling_rate: 8000 } }));
      }
    },
    close: () => {
      if (this.closed) return;
      this.closed = true;
      this.onCloseCb();
    },
    onMessage: (cb) => {
      this.onMsg = cb;
      queueMicrotask(() => this.say(this.first));
    },
    onClose: (cb) => void (this.onCloseCb = cb),
  };
  say(message: Record<string, unknown>): void {
    this.onMsg(JSON.stringify(message));
  }
  sessionUpdate(): Record<string, any> | undefined {
    return this.sent.find((m) => m.type === "session.update")?.session;
  }
}

/** Every test starts with sockets that refuse, so a missing fake can never reach a real host. */
const refuseNetwork: LiveSocketFactory = async () => {
  throw new Error("network_disabled_in_tests");
};

const fakeCredentials = (): AzureVoiceLiveCredentials => ({ resourceUrl: RESOURCE, apiKey: KEY });

type Connection = { url: string; apiKey: string; fake?: FakeVoiceLive };

/**
 * Makes Azure Voice Live available with fake settings and one fake socket per
 * connection. Each step of the plan is one connection: "ok", the error event
 * Voice Live answers with instead of session.created, or a factory failure.
 */
function useVoiceLive(plan: Array<"ok" | Record<string, unknown> | Error> = []): Connection[] {
  const opened: Connection[] = [];
  setVoiceDeps({
    voiceLiveCredentials: fakeCredentials,
    voiceLiveSocketFactory: async (url, apiKey) => {
      const step = plan[opened.length] ?? "ok";
      const connection: Connection = { url, apiKey };
      opened.push(connection);
      if (step instanceof Error) throw step;
      connection.fake = new FakeVoiceLive(step === "ok" ? undefined : step);
      return connection.fake.socket;
    },
  });
  return opened;
}

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const getJson = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

let calls: InteractiveCall[] = [];
let lines: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Neither setting is read from the machine: each test opts in.
  vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", "");
  vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", "");
  resetTalkOrchestrator();
  resetVoiceDeps();
  resetVoiceErrors();
  resetAzureHealth();
  resetAzureCatalog();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRouterChoices();
  resetLeadStore();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
  traceBus.reset();
  lines = [];
  setVoiceDeps({ socketFactory: refuseNetwork, voiceLiveSocketFactory: refuseNetwork, log: (l) => void lines.push(l), retryDelayMs: 0 });
  selectTalkOrchestrator("direct");
});
afterEach(async () => {
  closeActiveVoiceSession("test");
  for (const call of calls.splice(0)) await call.hangUp().catch(() => undefined);
  resetVoiceDeps();
  resetTalkOrchestrator();
  resetAzureHealth();
  resetAzureCatalog();
  resetVoiceErrors();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function cleared(): Promise<InteractiveCall> {
  const call = await clearedTestCall();
  calls.push(call);
  return call;
}

function params(call: InteractiveCall, over: Partial<OpenVoiceParams> = {}): OpenVoiceParams & { ended: string[]; errors: string[] } {
  const state = { ended: [] as string[], errors: [] as string[] };
  return Object.assign(state, {
    call,
    input: "text" as const,
    trace: { leadId: "lead-1", leadLabel: "Jane", recordId: call.callId, channel: "call" as const, direction: "inbound" as const, callId: call.callId },
    leadFirstName: "Jane",
    direction: "inbound" as const,
    disclosure: DISCLOSURE,
    packet: buildLeadContextPacket(baseLead()),
    dialogOwnsTranscript: false,
    onAudio: () => {},
    onClearPlayback: () => {},
    onProviderError: (code: string) => void state.errors.push(code),
    onEnd: (s: { reason: string }) => void state.ended.push(s.reason),
    ...over,
  });
}

/** A real settings file under the temporary directory, with the mode set after writing (a strict umask would hide 0644). */
function settingsFile(text: string, mode = 0o600): string {
  const file = join(mkdtempSync(join(tmpdir(), "voice-live-path-")), "dev.env");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

const voiceLiveInfo = () => listVoicePaths().find((p) => p.id === "azure_voice_live")!;
const pathsOf = (options: VoiceOptions, orchestrator: string) => options.orchestrators.find((o) => o.id === orchestrator)?.voicePaths ?? [];
const voiceLiveOption = (options: VoiceOptions): VoicePathOption | undefined => pathsOf(options, "direct").find((p) => p.id === "azure_voice_live");

describe("the voice path list", () => {
  it("lists Azure gpt-live, Azure Voice Live and Deepgram in that order, with Azure Voice Live unavailable by a fixed code while it has no settings", async () => {
    expect(listVoicePaths().map((p) => p.id)).toEqual(["azure_gpt_live", "azure_voice_live", "deepgram"]);
    expect(voiceLiveInfo()).toMatchObject({ available: false, unavailableReason: "azure_voice_live_env_file_not_configured" });
    const res = await fetch(base + "/api/state");
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    expect(state.voicePaths.map((p: { id: string }) => p.id)).toEqual(["azure_gpt_live", "azure_voice_live", "deepgram"]);
    expect(state.voicePaths[1]).toMatchObject({ id: "azure_voice_live", available: false, unavailableReason: "azure_voice_live_env_file_not_configured" });
    // Listing the paths reports nothing and blocks nothing.
    expect(state.voiceErrors).toEqual([]);
    expect(state.azureStatus.ok).toBe(true);
  });

  it.each([
    ["a settings file without the Voice Live names", "AZURE_FOUNDRY_URL=https://x.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=k\n", 0o600, "azure_voice_live_missing_url"],
    ["a settings file without the Voice Live key", `AZURE_VOICE_LIVE_URL=${RESOURCE}\n`, 0o600, "azure_voice_live_missing_key"],
    ["a settings file other users can read", `AZURE_VOICE_LIVE_URL=${RESOURCE}\nAZURE_VOICE_LIVE_KEY=${KEY}\n`, 0o644, "azure_voice_live_env_file_permissions_too_open"],
    ["the OpenAI address of the resource", `AZURE_VOICE_LIVE_URL=https://x.openai.azure.com\nAZURE_VOICE_LIVE_KEY=${KEY}\n`, 0o600, "azure_voice_live_url_invalid"],
  ])("with %s, the path is unavailable with its code, and neither the list nor /api/state throws", async (_what, text, mode, code) => {
    vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", settingsFile(text, mode));
    expect(voiceLiveInfo()).toEqual({ id: "azure_voice_live", label: expect.any(String), available: false, unavailableReason: code });
    const state = await getJson("/api/state");
    expect(state.voicePaths.find((p: { id: string }) => p.id === "azure_voice_live")).toMatchObject({ available: false, unavailableReason: code });
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it("a settings file that is named but missing makes the path unavailable as unreadable", () => {
    vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", join(mkdtempSync(join(tmpdir(), "voice-live-path-")), "absent.env"));
    expect(voiceLiveInfo()).toMatchObject({ available: false, unavailableReason: "azure_voice_live_env_file_unreadable" });
  });

  it("is available with a complete settings file, or with injected settings, and then has no reason", async () => {
    vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", settingsFile(`AZURE_VOICE_LIVE_URL=${RESOURCE}\nAZURE_VOICE_LIVE_KEY=${KEY}\n`));
    expect(voiceLiveInfo()).toEqual({ id: "azure_voice_live", label: expect.any(String), available: true });
    const state = await getJson("/api/state");
    expect(state.voicePaths[1]).toMatchObject({ id: "azure_voice_live", available: true });
    expect(state.voicePaths[1].unavailableReason).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(KEY);
    vi.stubEnv("VOICE_HARNESS_DEV_ENV_FILE", "");
    useVoiceLive();
    expect(voiceLiveInfo()).toEqual({ id: "azure_voice_live", label: expect.any(String), available: true });
  });
});

describe("choosing the Azure Voice Live path", () => {
  it("refuses while its settings are missing, records the code on the Azure Voice Live path, and does not block Azure", async () => {
    expect(() => selectVoicePath("azure_voice_live")).toThrow("azure_voice_live_env_file_not_configured");
    expect(recentVoiceErrors().at(-1)).toMatchObject({ code: "azure_voice_live_env_file_not_configured", path: "azure_voice_live", blocksNewCalls: false });
    expect(selectedVoicePath()).toBe("azure_gpt_live");
    const res = await post("/api/voice/path", { voicePathId: "azure_voice_live" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("azure_voice_live_env_file_not_configured");
    expect(selectedVoicePath()).toBe("azure_gpt_live");
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });

  it("refuses under the Pipecat orchestrator with azure_voice_live_needs_direct, and the session mode check agrees", () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath); // any existing absolute path: nothing is started
    expect(PipecatVoiceRuntime.available()).toBe(true);
    useVoiceLive();
    selectTalkOrchestrator("pipecat");
    expect(() => selectVoicePath("azure_voice_live")).toThrow("azure_voice_live_needs_direct");
    expect(recentVoiceErrors().at(-1)).toMatchObject({ code: "azure_voice_live_needs_direct", path: "azure_voice_live", blocksNewCalls: false });
    expect(selectedVoicePath()).toBe("azure_gpt_live");
    // Chosen under Direct, then the orchestrator falls back to its default, which is Pipecat once it is configured.
    selectTalkOrchestrator("direct");
    selectVoicePath("azure_voice_live");
    resetTalkOrchestrator();
    expect(() => resolveVoiceSessionMode("text")).toThrow("azure_voice_live_needs_direct");
    expect(() => resolveVoiceSessionMode("audio")).toThrow("azure_voice_live_needs_direct");
  });

  it("works under Direct, and choosing Pipecat afterwards puts the path back to Azure gpt-live", async () => {
    useVoiceLive();
    selectVoicePath("azure_voice_live");
    expect(selectedVoicePath()).toBe("azure_voice_live");
    expect(resolveVoiceSessionMode("text")).toBe("azure_voice_live_text");
    expect(resolveVoiceSessionMode("audio")).toBe("azure_voice_live_microphone");
    expect(recentVoiceErrors()).toEqual([]);
    selectTalkOrchestrator("pipecat");
    expect(selectedVoicePath()).toBe("azure_gpt_live");
    // The same through the dev server.
    selectTalkOrchestrator("direct");
    expect((await post("/api/voice/path", { voicePathId: "azure_voice_live" })).json.selectedVoicePathId).toBe("azure_voice_live");
    const back = await post("/api/orchestration/select", { orchestratorId: "pipecat" });
    expect(back.json).toMatchObject({ selectedOrchestratorId: "pipecat", selectedVoicePathId: "azure_gpt_live" });
  });

  it("POST /api/voice/path refuses an unknown id and changes nothing", async () => {
    useVoiceLive();
    for (const voicePathId of ["azure_voice_live_2", "voice_live", ["azure_voice_live"], 7]) {
      const res = await post("/api/voice/path", { voicePathId });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("unknown_voice_path");
    }
    expect(selectedVoicePath()).toBe("azure_gpt_live");
  });
});

describe("GET /api/voice/options and POST /api/voice/path-models", () => {
  it("lists Azure Voice Live under Direct only, with the model menu (no transcription menu for a speech to speech model) and the decision model router", async () => {
    vi.stubEnv("VOICE_HARNESS_PIPECAT_PYTHON", process.execPath); // both orchestrators listed
    useVoiceLive();
    const options = (await getJson("/api/voice/options")) as VoiceOptions;
    expect(options.orchestrators.map((o) => o.id)).toEqual(["direct", "pipecat"]);
    expect(pathsOf(options, "pipecat").map((p) => p.id)).toContain("azure_gpt_live");
    expect(pathsOf(options, "pipecat").map((p) => p.id)).not.toContain("azure_voice_live");
    expect(pathsOf(options, "direct").map((p) => p.id)).toEqual(["azure_gpt_live", "azure_voice_live"]);
    const path = voiceLiveOption(options)!;
    expect(path.label).toBe(voiceLiveInfo().label);
    expect(path.slots.map((s) => s.role)).toEqual(["speech_to_speech"]);
    expect(path.slots[0]!.models.map((m) => m.id)).toEqual(["gpt-realtime", "gpt-realtime-2.1", "gpt-6-luna", "gpt-5.4", "gpt-5.1", "gpt-4.1"]);
    expect(path.slots[0]!.defaultId).toBe("gpt-realtime");
    expect(path.slots[0]!.models.every((m) => m.voices === undefined && /one probe sample/.test(m.label))).toBe(true);
    expect(path.decisionRouters!.options.map((o) => o.id)).toEqual(["decision_model"]);
    expect(path.decisionRouters).toMatchObject({ defaultId: "decision_model", selectedId: "decision_model" });
  });

  it("leaves Azure Voice Live out while its settings are missing, and refuses a model for it as an unknown path", async () => {
    const options = (await getJson("/api/voice/options")) as VoiceOptions;
    expect(pathsOf(options, "direct").map((p) => p.id)).toEqual(["azure_gpt_live"]);
    const res = await post("/api/voice/path-models", { voicePathId: "azure_voice_live", role: "speech_to_speech", modelId: "gpt-realtime" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("unknown_voice_path");
  });

  it("stores a text model, which brings the transcription menu, and the next call uses both; the Azure gpt-live module never changes", async () => {
    useVoiceLive();
    const before = getModuleRegistry().get("azure-gpt-live").getConfig();
    const res = await post("/api/voice/path-models", { voicePathId: "azure_voice_live", role: "speech_to_speech", modelId: "gpt-6-luna" });
    expect(res.status).toBe(200);
    const path = voiceLiveOption(res.json)!;
    expect(path.slots[0]!.selectedId).toBe("gpt-6-luna");
    expect(path.slots.map((s) => s.role)).toEqual(["speech_to_speech", "speech_to_text"]);
    expect(path.slots[1]!.models.map((m) => m.id)).toEqual(["azure-speech", "mai-transcribe-2"]);
    expect(path.slots[1]!.defaultId).toBe("azure-speech");
    expect(voiceLiveChoice()).toEqual({ model: "gpt-6-luna", kind: "text", transcription: "azure-speech" });
    const stt = await post("/api/voice/path-models", { voicePathId: "azure_voice_live", role: "speech_to_text", modelId: "mai-transcribe-2" });
    expect(stt.status).toBe(200);
    expect(voiceLiveChoice()).toEqual({ model: "gpt-6-luna", kind: "text", transcription: "mai-transcribe-2" });
    expect(getModuleRegistry().get("azure-gpt-live").getConfig()).toEqual(before);
    // Back to a speech to speech model: the transcription menu goes away and the stored choice is not used.
    await post("/api/voice/path-models", { voicePathId: "azure_voice_live", role: "speech_to_speech", modelId: "gpt-realtime-2.1" });
    expect(voiceLiveChoice()).toEqual({ model: "gpt-realtime-2.1", kind: "speech_to_speech" });
    expect(voiceLiveOption(await getJson("/api/voice/options") as VoiceOptions)!.slots.map((s) => s.role)).toEqual(["speech_to_speech"]);
  });

  it.each([
    ["a model that was not in the full probe", { role: "speech_to_speech", modelId: "gpt-5-nano" }, "azure_voice_live_model_not_offered"],
    ["the Azure gpt-live deployment", { role: "speech_to_speech", modelId: "gpt-live-1" }, "azure_voice_live_model_not_offered"],
    ["a transcription for a speech to speech model", { role: "speech_to_text", modelId: "azure-speech" }, "unknown_model_role"],
  ])("refuses %s with its fixed code and changes nothing", async (_what, choice, code) => {
    useVoiceLive();
    const res = await post("/api/voice/path-models", { voicePathId: "azure_voice_live", ...choice });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(code);
    expect(voiceLiveChoice()).toEqual({ model: "gpt-realtime", kind: "speech_to_speech" });
  });

  it("with the lead context gate off, the instructions Voice Live gets carry the lead's facts and what the call needs from the first word", async () => {
    vi.stubEnv("VOICE_HARNESS_LEAD_CONTEXT_GATE", "off");
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    await openVoiceSession(params(call));
    const instructions = opened[0]!.fake!.sessionUpdate()!.instructions as string;
    expect(instructions).toContain("Lead context (read only):");
    expect(instructions).toMatch(/What this call needs from them: .+, then their yes to receiving the quote by text\./);
    expect(instructions).toContain("Who is calling (the person may not be who the record names; confirm before relying on any of it):");
    expect(instructions).not.toContain("The person on the call is not yet confirmed to be this person.");
  });

  it("with the gate on (the library default), the instructions carry only the name on file until the person is confirmed", async () => {
    vi.stubEnv("VOICE_HARNESS_LEAD_CONTEXT_GATE", "");
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    await openVoiceSession(params(call));
    const instructions = opened[0]!.fake!.sessionUpdate()!.instructions as string;
    expect(instructions).toContain("Lead context (read only):");
    expect(instructions).toContain("The person on the call is not yet confirmed to be this person.");
    expect(instructions).not.toContain("What this call needs from them:");
  });

  it("a call on a text model opens that model's Voice Live address with the text settings and the interim response", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    await post("/api/voice/path-models", { voicePathId: "azure_voice_live", role: "speech_to_speech", modelId: "gpt-5.1" });
    const call = await cleared();
    await openVoiceSession(params(call));
    expect(opened[0]!.url).toBe(`${SOCKET_BASE}gpt-5.1`);
    const update = opened[0]!.fake!.sessionUpdate()!;
    expect(update.turn_detection).toMatchObject({ type: "azure_semantic_vad_multilingual", languages: ["en", "es"], create_response: false });
    expect(update.input_audio_transcription).toEqual({ model: "azure-speech" });
    expect(update.interim_response).toMatchObject({ type: "llm_interim_response", latency_threshold_ms: 180 });
    expect(lines).toContain(`voice live call=${call.callId} model=gpt-5.1 kind=text transcription=azure-speech voice=${VOICE_LIVE_VOICE} tools=${flowFunctionTools().length}`);
  });
});

describe("a call on Azure Voice Live", () => {
  it.each([
    ["text", "azure_voice_live_text"],
    ["audio", "azure_voice_live_microphone"],
  ] as const)("with %s input starts as %s on the fixed model's Voice Live address, with the dispatched flow tools on the speaking model", async (input, mode) => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const session = await openVoiceSession(params(call, { input }));
    expect(session.sessionMode).toBe(mode);
    expect(activeVoiceCallId()).toBe(call.callId);
    expect(opened).toHaveLength(1);
    expect(VOICE_LIVE_MODEL).toBe("gpt-realtime");
    expect(opened[0]!.url).toBe(`${SOCKET_BASE}gpt-realtime`);
    expect(opened[0]!.apiKey).toBe(KEY);
    const fake = opened[0]!.fake!;
    const update = fake.sessionUpdate()!;
    expect(update.voice).toEqual({ name: VOICE_LIVE_VOICE, type: "azure-standard" });
    expect(update).toMatchObject({ input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw" });
    expect(update.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high", create_response: false, interrupt_response: false });
    expect(update.input_audio_transcription).toEqual({ model: "gpt-4o-transcribe" });
    expect(update.input_audio_noise_reduction).toEqual({ type: "azure_deep_noise_suppression" });
    // The tools are the shared flow tool list, the same one the gpt-live thinker hands Azure.
    expect(update.tools.length).toBeGreaterThan(0);
    expect(update.tools).toEqual(flowFunctionTools());
    expect(update.tools.map((t: { name: string }) => t.name)).toEqual(thinkerTools().map((t) => t.name));
    expect(update.tool_choice).toBe("auto");
    // The harness asks for the opening line itself: a system item, then one response.create.
    expect(fake.sent.map((m) => m.type)).toEqual(["session.update", "conversation.item.create", "response.create"]);
    expect(fake.sent[1]!.item).toMatchObject({ type: "message", role: "system" });
    expect(fake.sent[1]!.item.content[0].text).toContain(DISCLOSURE);
    // The Context panel shows the note the speaking model was given.
    const context = traceBus.history().find((e) => e.callId === call.callId && e.type === "tool_call" && e.data.tool === "agent_context");
    const text = (context?.data.result as { text?: string } | undefined)?.text ?? "";
    expect(text.endsWith(VOICE_LIVE_TOOLS_NOTE)).toBe(true);
    expect(update.instructions).toBe(text);
    expect(recentVoiceErrors()).toEqual([]);
    expect(lines).toContain(`voice live call=${call.callId} model=gpt-realtime kind=speech_to_speech voice=${VOICE_LIVE_VOICE} tools=${flowFunctionTools().length}`);
  });

  it("never runs the Azure gpt-live model check: a listing without the gpt-live model refuses Direct Azure but not Azure Voice Live", async () => {
    const file = settingsFile("AZURE_FOUNDRY_URL=https://example-test.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY=k\n");
    const listing = (async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-live-1-eu", model: "gpt-live-1", status: "succeeded" }] }), { status: 200 })) as unknown as typeof fetch;
    setAzureCatalogDeps({ env: { VOICE_HARNESS_DEV_ENV_FILE: file }, fetch: listing });
    await loadAzureCatalog();
    expect(liveModelIds()).not.toContain(getModuleRegistry().get("azure-gpt-live").getConfig().model);
    const opened = useVoiceLive();
    const call = await cleared();
    // The control: on Azure gpt-live the same listing refuses the start before any socket opens.
    const refused = await openVoiceSession(params(call)).catch((e) => e);
    expect(refused.message).toBe("azure_model_not_deployed");
    selectVoicePath("azure_voice_live");
    const session = await openVoiceSession(params(call));
    expect(session.sessionMode).toBe("azure_voice_live_text");
    expect(opened).toHaveLength(1);
    expect(recentVoiceErrors().map((r) => r.code)).toEqual(["azure_model_not_deployed"]);
  });

  it("settings that go missing after the path was chosen refuse the start with the settings code, without the Azure block", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    setVoiceDeps({ voiceLiveCredentials: undefined });
    const call = await cleared();
    const err = await openVoiceSession(params(call)).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceStartError);
    expect(err.record).toMatchObject({ code: "azure_voice_live_env_file_not_configured", path: "azure_voice_live", blocksNewCalls: false, callId: call.callId });
    expect(opened).toHaveLength(0);
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });

  it("a refused request during the call (no active response to cancel) is a warning, and the call goes on", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    await openVoiceSession(p);
    opened[0]!.fake!.say({ type: "error", event_id: "evt_1", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "provider text that must not surface" } });
    expect(p.errors).toEqual([]);
    expect(p.ended).toEqual([]);
    expect(recentVoiceErrors()).toEqual([]);
    expect(activeVoiceCallId()).toBe(call.callId);
    const warning = traceBus.history().find((e) => e.callId === call.callId && e.type === "tool_call" && e.data.tool === "voice_provider_warning");
    expect(warning?.data.reason).toBe("response_cancel_not_active");
  });
});

describe("Azure Voice Live failures never set the Azure block", () => {
  it("voiceLiveHandshakeCode maps 401 and 403 to auth failed, 429 to rate limited, 400 to session rejected, anything else to connect failed", () => {
    expect([401, 403, 429, 400, 404, 500, 503, undefined].map(voiceLiveHandshakeCode)).toEqual([
      "azure_voice_live_auth_failed",
      "azure_voice_live_auth_failed",
      "azure_voice_live_rate_limited",
      "azure_voice_live_session_rejected",
      "azure_voice_live_connect_failed",
      "azure_voice_live_connect_failed",
      "azure_voice_live_connect_failed",
      "azure_voice_live_connect_failed",
    ]);
  });

  it("the real Voice Live socket factory turns a refused handshake into those codes (a loopback server answering instead of upgrading)", async () => {
    const refusing = createServer();
    refusing.on("upgrade", (req, socket) => {
      const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status"));
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", r));
    const port = (refusing.address() as AddressInfo).port;
    try {
      const codeFor = (status: number) =>
        realVoiceLiveSocketFactory(`ws://127.0.0.1:${port}/voice-live/realtime?status=${status}`, KEY).then(
          () => "opened",
          (err: Error) => err.message,
        );
      expect(await codeFor(401)).toBe("azure_voice_live_auth_failed");
      expect(await codeFor(403)).toBe("azure_voice_live_auth_failed");
      expect(await codeFor(429)).toBe("azure_voice_live_rate_limited");
      expect(await codeFor(400)).toBe("azure_voice_live_session_rejected");
      expect(await codeFor(503)).toBe("azure_voice_live_connect_failed");
    } finally {
      refusing.closeAllConnections();
      await new Promise<void>((r) => refusing.close(() => r()));
    }
  });

  it("a refused key at the handshake reports azure_voice_live_auth_failed, is not retried, and new calls are not blocked", async () => {
    const opened = useVoiceLive([new Error(voiceLiveHandshakeCode(401))]);
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    const err = await openVoiceSession(p).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceStartError);
    expect(err.message).toBe("azure_voice_live_auth_failed");
    expect(opened).toHaveLength(1);
    expect(err.record).toMatchObject({
      code: "azure_voice_live_auth_failed",
      path: "azure_voice_live",
      severity: "error",
      canContinue: false,
      blocksNewCalls: false,
      callId: call.callId,
    });
    expect(err.record.fix).toContain("AZURE_VOICE_LIVE_KEY");
    expect(p.ended).toEqual(["start_failed"]);
    expect(activeVoiceCallId()).toBeUndefined();
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
    const state = await getJson("/api/state");
    expect(state.azureStatus.ok).toBe(true);
    expect(state.voiceErrors.at(-1)).toMatchObject({ code: "azure_voice_live_auth_failed", blocksNewCalls: false });
  });

  it("an authentication error event instead of session.created reports azure_voice_live_auth_failed with Voice Live's own type and code", async () => {
    const opened = useVoiceLive([{ type: "error", event_id: "evt_1", error: { type: "invalid_request_error", code: "invalid_api_key", message: "provider text that must not surface" } }]);
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const err = await openVoiceSession(params(call)).catch((e) => e);
    expect(err.record).toMatchObject({ code: "azure_voice_live_auth_failed", path: "azure_voice_live", blocksNewCalls: false });
    expect(err.record.detail).toContain("Azure said: invalid_request_error / invalid_api_key.");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.fake!.sessionUpdate()).toBeUndefined();
    expect(JSON.stringify(recentVoiceErrors())).not.toContain("provider text");
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });

  it("an authentication error during the call ends it with azure_voice_live_auth_failed, without the Azure block", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    await openVoiceSession(p);
    opened[0]!.fake!.say({ type: "error", error: { type: "authentication_error", code: "unauthorized", message: "provider text that must not surface" } });
    expect(p.errors).toEqual(["azure_voice_live_auth_failed"]);
    expect(p.ended).toEqual(["voice_live_error"]);
    expect(recentVoiceErrors()).toHaveLength(1);
    expect(recentVoiceErrors()[0]).toMatchObject({ code: "azure_voice_live_auth_failed", path: "azure_voice_live", blocksNewCalls: false, callId: call.callId });
    expect(JSON.stringify(recentVoiceErrors()) + lines.join("\n")).not.toContain("provider text");
    expect(activeVoiceCallId()).toBeUndefined();
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });

  it.each(["invalid_model", "model_retired"])(
    "a model Voice Live refuses at connect (%s) is azure_voice_live_session_rejected with Voice Live's type and code, and is not retried",
    async (code) => {
      const opened = useVoiceLive([{ type: "error", event_id: "evt_1", error: { type: "invalid_request_error", code, message: "Model is not supported in this region" } }]);
      selectVoicePath("azure_voice_live");
      const call = await cleared();
      const err = await openVoiceSession(params(call)).catch((e) => e);
      expect(err).toBeInstanceOf(VoiceStartError);
      expect(err.message).toBe("azure_voice_live_session_rejected");
      expect(opened).toHaveLength(1);
      expect(err.record).toMatchObject({ code: "azure_voice_live_session_rejected", path: "azure_voice_live", blocksNewCalls: false });
      expect(err.record.detail).toContain(`Azure said: invalid_request_error / ${code}.`);
      expect(err.record.fix).toContain("Azure's own reply is in the detail");
      expect(recentVoiceErrors()).toHaveLength(1);
      expect(lines).toContain(`voice error call=${call.callId} code=azure_voice_live_session_rejected path=azure_voice_live model=gpt-realtime azure=invalid_request_error / ${code}`);
      expect(lines.join("\n")).not.toContain("not supported in this region");
      await tick(0);
      expect(azureStatus()).toEqual({ ok: true });
    },
  );
});

describe("retrying a start, and a call that drops", () => {
  it("only passing failures are retried", () => {
    for (const code of ["azure_voice_live_connect_failed", "azure_voice_live_start_timeout", "azure_voice_live_closed_before_start"]) {
      expect(RETRYABLE_START_CODES.has(code), code).toBe(true);
    }
    for (const code of [
      "azure_voice_live_auth_failed",
      "azure_voice_live_rate_limited",
      "azure_voice_live_session_rejected",
      "azure_voice_live_needs_direct",
      "azure_voice_live_model_not_offered",
      "azure_voice_live_env_file_not_configured",
      "azure_voice_live_missing_key",
      "azure_voice_live_url_invalid",
    ]) {
      expect(RETRYABLE_START_CODES.has(code), code).toBe(false);
    }
  });

  it("a connection failure is tried once more with a fresh session; the first failure is a retrying warning and the call goes on", async () => {
    const opened = useVoiceLive([new Error("azure_voice_live_connect_failed"), "ok"]);
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    const session = await openVoiceSession(p);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.fake!.sessionUpdate()).toBeDefined();
    expect(p.ended).toEqual([]);
    expect(activeVoiceCallId()).toBe(call.callId);
    expect(recentVoiceErrors()).toHaveLength(1);
    expect(recentVoiceErrors()[0]).toMatchObject({
      code: "azure_voice_live_connect_failed",
      severity: "warning",
      canContinue: true,
      blocksNewCalls: false,
      path: "azure_voice_live",
    });
    expect(recentVoiceErrors()[0]!.detail).toContain("trying once more");
    expect(lines).toContain(`voice error call=${call.callId} code=azure_voice_live_connect_failed path=azure_voice_live model=gpt-realtime azure=none retrying=yes`);
    session.stop();
  });

  it("when the retry fails too, the call ends once with an error, and new calls are not blocked", async () => {
    const opened = useVoiceLive([new Error("azure_voice_live_connect_failed"), new Error("azure_voice_live_connect_failed")]);
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    const err = await openVoiceSession(p).catch((e) => e);
    expect(err.message).toBe("azure_voice_live_connect_failed");
    expect(opened).toHaveLength(2);
    expect(recentVoiceErrors().map((r) => [r.code, r.severity, r.blocksNewCalls])).toEqual([
      ["azure_voice_live_connect_failed", "warning", false],
      ["azure_voice_live_connect_failed", "error", false],
    ]);
    expect(p.ended).toEqual(["start_failed"]);
    expect(activeVoiceCallId()).toBeUndefined();
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });

  it("Voice Live closing the connection in the middle of the call is reported once as azure_voice_live_closed", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    await openVoiceSession(p);
    opened[0]!.fake!.socket.close();
    expect(p.ended).toEqual(["voice_live_closed"]);
    expect(recentVoiceErrors().map((r) => r.code)).toEqual(["azure_voice_live_closed"]);
    expect(recentVoiceErrors()[0]).toMatchObject({ path: "azure_voice_live", blocksNewCalls: false, callId: call.callId });
    expect(lines.filter((l) => l.includes("code=azure_voice_live_closed"))).toEqual([
      `voice error call=${call.callId} code=azure_voice_live_closed path=azure_voice_live model=gpt-realtime azure=none`,
    ]);
    expect(activeVoiceCallId()).toBeUndefined();
    // Nothing more is reported for the same call afterwards.
    closeActiveVoiceSession("test");
    opened[0]!.fake!.say({ type: "error", error: { type: "server_error", code: "internal_failure" } });
    expect(recentVoiceErrors()).toHaveLength(1);
    await tick(0);
    expect(azureStatus()).toEqual({ ok: true });
  });
});

describe("the error path and the restart fix", () => {
  it("voiceErrorPathFor names Azure Voice Live while it is the chosen path, for microphone and typed calls alike", () => {
    expect(voiceErrorPathFor("text")).toBe("azure_gpt_live");
    useVoiceLive();
    selectVoicePath("azure_voice_live");
    expect(voiceErrorPathFor("text")).toBe("azure_voice_live");
    expect(voiceErrorPathFor("audio")).toBe("azure_voice_live");
  });

  it("a Restart the call fix gets the Azure Voice Live sentence on this path, and only there", () => {
    expect(reportVoiceError("azure_voice_live_error").fix).toBe(VOICE_LIVE_RESTART);
    expect(reportVoiceError("voice_start_failed", { path: "azure_voice_live" }).fix).toBe(VOICE_LIVE_RESTART);
    expect(reportVoiceError("voice_start_failed", { path: "azure_gpt_live" }).fix).not.toBe(VOICE_LIVE_RESTART);
  });

  it("a start that times out twice ends with the Azure Voice Live restart fix", async () => {
    const opened = useVoiceLive([new Error("azure_voice_live_start_timeout"), new Error("azure_voice_live_start_timeout")]);
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const p = params(call);
    const err = await openVoiceSession(p).catch((e) => e);
    expect(opened).toHaveLength(2);
    expect(err.record).toMatchObject({ code: "azure_voice_live_start_timeout", path: "azure_voice_live", severity: "error", blocksNewCalls: false });
    expect(err.record.fix).toBe(VOICE_LIVE_RESTART);
    expect(recentVoiceErrors().map((r) => r.severity)).toEqual(["warning", "error"]);
    expect(p.ended).toEqual(["start_timeout"]);
  });
});

describe("the browser socket", () => {
  it("the ready frame says the server owns barge-in, and a stray browser barge-in is ignored", async () => {
    const opened = useVoiceLive();
    selectVoicePath("azure_voice_live");
    const call = await cleared();
    const wsServer = createServer();
    attachVoiceSockets(wsServer, (id) =>
      id === call.callId ? { call, leadId: "lead-1", direction: "inbound", say: async () => undefined, disclosure: () => DISCLOSURE } : undefined,
    );
    await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r));
    const port = (wsServer.address() as AddressInfo).port;
    const received: Array<Record<string, any>> = [];
    let ws: WebSocket | undefined;
    try {
      ws = await new Promise<WebSocket>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/voice/${call.callId}/socket?input=text`, { headers: { Origin: `http://127.0.0.1:${port}` } });
        socket.on("message", (d) => received.push(JSON.parse(d.toString())));
        socket.once("open", () => resolve(socket));
      });
      await until(() => received.some((m) => m.type === "status" && m.state === "ready"));
      expect(received.find((m) => m.type === "status" && m.state === "ready")).toMatchObject({
        sessionMode: "azure_voice_live_text",
        orchestration: "direct",
        bargeInOwner: "server",
      });
      ws.send(JSON.stringify({ type: "barge_in" }));
      await until(() => traceBus.history().some((e) => e.callId === call.callId && e.type === "tool_call" && e.data.tool === "barge_in_ignored"));
      const ignored = traceBus.history().find((e) => e.callId === call.callId && e.type === "tool_call" && e.data.tool === "barge_in_ignored");
      expect(ignored?.data.reason).toBe("server_owns_barge_in");
      expect(opened[0]!.fake!.sent.some((m) => m.type === "response.cancel")).toBe(false);
      ws.close();
      await until(() => activeVoiceCallId() === undefined);
    } finally {
      // An upgraded socket is not an HTTP connection the server can close for us.
      ws?.terminate();
      wsServer.closeAllConnections();
      await new Promise<void>((r) => wsServer.close(() => r()));
    }
  });
});
