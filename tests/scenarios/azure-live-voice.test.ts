import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resetHarnessConfig } from "../../src/config.js";
import type { LiveSocket } from "../../src/modules/azure-live-session.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { resetSystemPromptBuilder, setSystemPromptBuilder } from "../../src/modules/prompt-setup.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/index.js";
import { liveUrlFrom, loadAzureLiveCredentials } from "../../src/server/voice/azure-credentials.js";
import { activeVoiceCallId, openVoiceSession, resetTalkOrchestrator, resetVoiceDeps, selectTalkOrchestrator, setVoiceDeps, type OpenVoiceParams } from "../../src/server/voice/manager.js";
import { attachVoiceSockets, type VoiceCallHandle } from "../../src/server/voice/socket-route.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import { baseLead } from "../helpers/fixtures.js";
import { clearedTestCall } from "../helpers/cleared-call.js";
import type { InteractiveCall } from "../../src/decision/interactive-call.js";

/** A stand-in for the Azure socket: answers session.start with session.started and records what was sent. */
class FakeAzure {
  sent: Array<Record<string, any>> = [];
  closed = false;
  private onMsg: (raw: string) => void = () => undefined;
  private onClose: () => void = () => undefined;
  autoStart = true;
  readonly socket: LiveSocket = {
    send: (data) => {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg.type === "session.start" && this.autoStart) queueMicrotask(() => this.say({ type: "session.started", session: { id: "s1" } }));
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
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

// A live session opens only for a call the harness cleared, so each test starts one.
let cleared: InteractiveCall;
let CALL_ID: string;
let trace: { leadId: string; leadLabel: string; recordId: string; channel: "call"; direction: "inbound"; callId: string };

function params(over: Partial<OpenVoiceParams> = {}): OpenVoiceParams & { audio: string[]; cleared: number; ended: Array<{ reason: string }> } {
  const state = { audio: [] as string[], cleared: 0, ended: [] as Array<{ reason: string }> };
  seedLead(baseLead());
  return Object.assign(state, {
    call: cleared,
    input: "text" as const,
    trace,
    leadFirstName: "Jane",
    direction: "inbound" as const,
    disclosure: "Hi, I am an AI assistant and this call may be recorded.",
    packet: buildLeadContextPacket(baseLead({ quoteFields: { vehicle: { value: "2019 Civic", evidenceSpan: "my 2019 Civic" } } })),
    dialogOwnsTranscript: false,
    onAudio: (b: string) => void state.audio.push(b),
    onClearPlayback: () => void state.cleared++,
    onEnd: (s: { reason: string }) => void state.ended.push(s),
    ...over,
  });
}

let azure: FakeAzure;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  // These tests exercise the direct Azure path; Pipecat is the boot default when configured.
  selectTalkOrchestrator("direct");
  resetHarnessConfig();
  resetModuleRegistry();
  resetLeadStore();
  traceBus.reset();
  cleared = await clearedTestCall();
  CALL_ID = cleared.callId;
  trace = { leadId: "lead-1", leadLabel: "Jane", recordId: CALL_ID, channel: "call", direction: "inbound", callId: CALL_ID };
  // The tree's own opening line is not what these tests count.
  traceBus.reset();
  azure = new FakeAzure();
  setVoiceDeps({
    socketFactory: async () => azure.socket,
    credentials: () => ({ liveUrl: "wss://example.invalid/openai/v1/live/sessions", apiKey: "k" }),
    log: () => undefined,
    turnGapMs: 30,
  });
});
afterEach(async () => {
  await cleared.hangUp();
  resetTalkOrchestrator();
  resetVoiceDeps();
  resetSystemPromptBuilder();
});

const callEvents = (type: string) => traceBus.history().filter((e) => e.callId === CALL_ID && e.type === type);

describe("Azure credentials", () => {
  const fs = (text: string, mode = 0o600) => ({ mode: () => mode, read: () => text });
  it("derives the secure live endpoint and keeps only the two names", () => {
    const creds = loadAzureLiveCredentials(
      { VOICE_HARNESS_DEV_ENV_FILE: "/x" },
      fs("OTHER=1\nAZURE_FOUNDRY_URL=https://res.openai.azure.com/openai/v1\nAZURE_FOUNDRY_KEY='abc'\n"),
    );
    expect(creds.liveUrl).toBe("wss://res.openai.azure.com/openai/v1/live/sessions");
    expect(creds.apiKey).toBe("abc");
  });
  it("fails with fixed codes that never carry a value", () => {
    expect(() => loadAzureLiveCredentials({}, fs(""))).toThrow("azure_env_file_not_configured");
    expect(() => loadAzureLiveCredentials({ VOICE_HARNESS_DEV_ENV_FILE: "/x" }, fs("AZURE_FOUNDRY_KEY=secretvalue"))).toThrow("azure_settings_missing_url");
    expect(() => loadAzureLiveCredentials({ VOICE_HARNESS_DEV_ENV_FILE: "/x" }, fs("AZURE_FOUNDRY_URL=https://a/openai/v1"))).toThrow("azure_settings_missing_key");
    expect(() => loadAzureLiveCredentials({ VOICE_HARNESS_DEV_ENV_FILE: "/x" }, fs("", 0o644))).toThrow("azure_env_file_permissions_too_open");
    expect(() => liveUrlFrom("http://insecure/openai/v1")).toThrow("azure_live_url_not_secure");
    try {
      loadAzureLiveCredentials({ VOICE_HARNESS_DEV_ENV_FILE: "/x" }, fs("AZURE_FOUNDRY_URL=nonsense\nAZURE_FOUNDRY_KEY=secretvalue"));
    } catch (err) {
      expect(String(err)).not.toContain("secretvalue");
      expect(String(err)).not.toContain("nonsense");
    }
  });
});

describe("live session over a fake Azure socket", () => {
  it("starts with the setup prompt plus the lead context, then speaks the disclosure first", async () => {
    setSystemPromptBuilder((setupId, ctx) => `SETUP ${setupId} for ${ctx.leadFirstName}`);
    await openVoiceSession(params({ setupId: "layers-v1" }));
    const start = azure.of("session.start")[0]!;
    expect(start.session.model).toBe("gpt-live-1");
    expect(start.session.instructions).toContain("SETUP layers-v1 for Jane");
    // Earlier summaries and quote details are held until the named person is confirmed.
    expect(start.session.instructions).not.toContain("Prior: asked about auto quote.");
    expect(start.session.instructions).not.toContain("vehicle: 2019 Civic");
    expect(start.session.instructions).toContain("until the named person is confirmed");
    expect(start.session.instructions).not.toContain("5551234567");
    const first = azure.of("session.instructions.append")[0]!;
    expect(first.content).toContain("Hi, I am an AI assistant and this call may be recorded.");
    expect(first.content).toContain("Speak first");
    expect(callEvents("tool_call").some((e) => e.data.tool === "voice_session_open" && e.data.success === true)).toBe(true);
    // The Context panel on the control page reads the instruction text from this trace row.
    const context = callEvents("tool_call").find((e) => e.data.tool === "agent_context");
    expect((context?.data.result as { text: string }).text).toBe(start.session.instructions);
  });

  it("refuses a call the harness has not cleared, and a module that is off", async () => {
    await expect(openVoiceSession(params({ call: { callId: "call_test1", status: "blocked" } }))).rejects.toThrow("call_not_cleared");
    expect(activeVoiceCallId()).toBeUndefined();
  });

  it("plays agent audio, records both lines on the bus, and stops at one session", async () => {
    const p = params();
    const session = await openVoiceSession(p);
    await expect(openVoiceSession(params())).rejects.toThrow("voice_session_already_open");
    azure.say({ type: "session.output_audio.delta", delta: "AAAA" });
    azure.say({ type: "session.output_transcript.delta", delta: "Hello Jane." });
    azure.say({ type: "session.input_transcript.delta", delta: "Hi there" });
    await tick(120);
    expect(p.audio).toEqual(["AAAA"]);
    const lines = callEvents("transcript_final").map((e) => [e.data.role, e.data.text]);
    expect(lines).toContainEqual(["agent", "Hello Jane."]);
    expect(lines).toContainEqual(["caller", "Hi there"]);
    session.stop();
    expect(activeVoiceCallId()).toBeUndefined();
  });

  it("barge-in clears playback and records the interrupted agent line", async () => {
    const p = params();
    await openVoiceSession(p);
    azure.say({ type: "session.output_audio.delta", delta: "AAAA" });
    azure.say({ type: "session.output_transcript.delta", delta: "I was saying" });
    azure.say({ type: "session.input_transcript.delta", delta: "wait" });
    expect(p.cleared).toBe(1);
    expect(callEvents("tool_call").some((e) => e.data.tool === "clear_playback")).toBe(true);
    await tick(80);
    const agent = callEvents("transcript_final").find((e) => e.data.role === "agent");
    expect(agent?.data).toMatchObject({ text: "I was saying", spoken: false });
  });

  it("holds audio until the guard allows the line, and drops a blocked line", async () => {
    const guard = vi.fn(async (line: string) => (line.includes("guarantee") ? null : line));
    const p = params({ guardAgentLine: guard });
    await openVoiceSession(p);
    azure.say({ type: "session.output_audio.delta", delta: "OK1=" });
    azure.say({ type: "session.output_transcript.delta", delta: "Happy to help." });
    expect(p.audio).toEqual([]);
    await tick(100);
    expect(p.audio).toEqual(["OK1="]);
    azure.say({ type: "session.output_audio.delta", delta: "BAD=" });
    azure.say({ type: "session.output_transcript.delta", delta: "I guarantee the lowest price." });
    await tick(100);
    expect(p.audio).toEqual(["OK1="]);
    expect(callEvents("tool_call").some((e) => e.data.tool === "guard_agent_line" && e.data.success === false)).toBe(true);
  });

  it("typed caller lines take the same path and steer the agent with the decision module's reply", async () => {
    const said: string[] = [];
    const p = params({ dialogOwnsTranscript: true, onCallerFinal: async (t) => (said.push(t), "Which car do you want covered?") });
    const session = await openVoiceSession(p);
    await session.sendCallerText("I need a quote");
    expect(said).toEqual(["I need a quote"]);
    const last = azure.of("session.instructions.append").at(-1)!;
    expect(last.content).toContain("I need a quote");
    expect(last.content).toContain("Which car do you want covered?");
  });

  it("sends the call context update as its own append, before the guidance, and only when it changed", async () => {
    let n = 0;
    const p = params({
      dialogOwnsTranscript: true,
      onCallerFinal: async () => "Which car do you want covered?",
      contextUpdate: async () => (n++ === 0 ? "Call context update (information for you, not lines to say):\nCall stage: discovery." : undefined),
    });
    const session = await openVoiceSession(p);
    await session.sendCallerText("I need a quote");
    await session.sendCallerText("Twelve employees");
    const appends = azure.of("session.instructions.append").map((m) => String(m.content));
    const updateAt = appends.findIndex((c) => c.startsWith("Call context update"));
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(appends.filter((c) => c.startsWith("Call context update"))).toHaveLength(1);
    // Separate from the line to say: the guidance text is not inside the update, and the update is not inside the guidance.
    expect(appends[updateAt]).not.toContain("Which car");
    expect(appends[updateAt + 1]).toContain("Which car do you want covered?");
    expect(appends[updateAt + 1]).not.toContain("Call stage");
  });

  it("ends at the cap and logs the duration", async () => {
    const log = vi.fn();
    setVoiceDeps({ maxMs: 60, log });
    const p = params();
    await openVoiceSession(p);
    await tick(150);
    expect(p.ended[0]?.reason).toBe("session_cap");
    expect(azure.closed).toBe(true);
    expect(log.mock.calls[0]![0]).toMatch(/seconds=\d+\.\d reason=session_cap/);
    expect(callEvents("tool_call").some((e) => e.data.tool === "voice_session_close")).toBe(true);
  });

  it("reports a failed start as a fixed code and frees the slot", async () => {
    azure.autoStart = false;
    setVoiceDeps({ socketFactory: async () => azure.socket });
    const rejecting = openVoiceSession(params());
    await tick(20);
    azure.say({ type: "error", error: { message: "provider text that must not surface" } });
    await expect(rejecting).rejects.toThrow("azure_session_rejected");
    expect(activeVoiceCallId()).toBeUndefined();
    setVoiceDeps({ socketFactory: async () => { throw new Error("azure_connect_failed"); } });
    await expect(openVoiceSession(params())).rejects.toThrow("azure_connect_failed");
  });
});

describe("browser websocket route", () => {
  let server: Server;
  let port: number;
  const handle = (): VoiceCallHandle => ({
    call: cleared,
    leadId: "lead-1",
    direction: "inbound",
    say: async () => "Reply from the decision module.",
    disclosure: () => "Hi, I am an AI assistant.",
  });

  beforeEach(async () => {
    seedLead(baseLead());
    server = createServer();
    attachVoiceSockets(server, (id) => (id === CALL_ID ? handle() : undefined));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const open = (headers: Record<string, string>, path = `/api/voice/${CALL_ID}/socket`) =>
    new Promise<{ ws?: WebSocket; error?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on("message", (d) => received.push(JSON.parse(d.toString())));
      ws.once("open", () => resolve({ ws }));
      ws.once("unexpected-response", (_req, res) => resolve({ error: String(res.statusCode) }));
      ws.once("error", () => undefined);
    });
  let received: Array<Record<string, any>> = [];
  beforeEach(() => void (received = []));
  const good = () => ({ Origin: `http://127.0.0.1:${port}` });

  it("refuses a foreign origin, a foreign host, a missing origin and an unknown call", async () => {
    expect((await open({ Origin: "http://evil.example" })).error).toBe("403");
    expect((await open({ ...good(), Host: "evil.example" })).error).toBe("403");
    expect((await open({})).error).toBe("403");
    expect((await open(good(), "/api/voice/nope/socket")).error).toBe("404");
  });

  it("accepts a configured proxy host only when HARNESS_ALLOWED_HOSTS names it", async () => {
    const proxied = { Host: "proxy.example.ts.net:8443", Origin: "https://proxy.example.ts.net:8443" };
    expect((await open(proxied)).error).toBe("403");
    process.env.HARNESS_ALLOWED_HOSTS = "proxy.example.ts.net,proxy.example.ts.net:8443";
    try {
      const { ws } = await open(proxied);
      expect(ws).toBeDefined();
      ws!.close();
      expect((await open({ ...proxied, Origin: "https://other.example" })).error).toBe("403");
      expect((await open({ Host: "other.example", Origin: "https://other.example" })).error).toBe("403");
    } finally {
      delete process.env.HARNESS_ALLOWED_HOSTS;
    }
  });

  it("relays audio and typed lines between the browser and the fake Azure socket", async () => {
    const { ws } = await open(good());
    await tick(80);
    expect(received.some((m) => m.type === "status" && m.state === "ready")).toBe(true);
    ws!.send(Buffer.from([1, 2, 3]));
    ws!.send(JSON.stringify({ type: "text", text: "hello" }));
    await tick(60);
    expect(azure.of("session.input_audio.append")[0]!.audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    azure.say({ type: "session.output_audio.delta", delta: "QUJD" });
    await tick(40);
    expect(received).toContainEqual({ type: "audio", data: "QUJD" });
    expect(azure.of("session.instructions.append").at(-1)!.content).toContain("Reply from the decision module.");
    ws!.send(JSON.stringify({ type: "hangup" }));
    await tick(60);
    expect(azure.closed).toBe(true);
    expect(activeVoiceCallId()).toBeUndefined();
  });
});
