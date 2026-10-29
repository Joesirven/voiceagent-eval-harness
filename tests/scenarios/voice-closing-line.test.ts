/**
 * The closing line (a goodbye, or a transfer offer) is spoken before a played
 * call's voice session closes. The decision tree emits its disposition during
 * the decision step for the caller's line, before the voice model has said the
 * closing line, so the call must stay open until that line has played (or a
 * cap passes), on both voice paths.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import type { LiveSocket } from "../../src/modules/azure-live-session.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { attachVoice, handle } from "../../src/server/dev-server.js";
import { resetAzureHealth } from "../../src/server/azure-startup-check.js";
import { getStartInteractiveCall, resetStartInteractiveCall, setPlayClock, setStartInteractiveCall } from "../../src/server/play-wiring.js";
import { setFakePaceMs } from "../../src/server/fake-interactive.js";
import { DeepgramVoiceRuntime } from "../../src/server/voice/deepgram-voice-runtime.js";
import {
  activeVoiceCallId,
  resetTalkOrchestrator,
  resetVoiceDeps,
  resetVoicePath,
  selectTalkOrchestrator,
  selectVoicePath,
  setVoiceDeps,
} from "../../src/server/voice/manager.js";
import { attachVoiceSockets, CLOSING_LINE_TAIL_MS, type VoiceCallHandle } from "../../src/server/voice/socket-route.js";
import { resetVoiceErrors } from "../../src/server/voice/voice-errors.js";
import { resetLeadStore } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import { clearedTestCall } from "../helpers/cleared-call.js";

// The stub tree ends a call when the caller says they are not interested. The dev server reads the tree when it loads.
vi.hoisted(() => {
  process.env.VOICE_HARNESS_DECISION_TREE = new URL("../../src/decision/stub-tree.json", import.meta.url).pathname;
});

const fakeSidecar = fileURLToPath(new URL("../helpers/fake-deepgram-sidecar.mjs", import.meta.url));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(15);
  }
}

/** A stand-in for the Azure socket: answers session.start and records what was sent. */
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
    if (!this.closed) this.onMsg(JSON.stringify(message));
  }
  steers(): string[] {
    return this.sent.filter((m) => m.type === "session.instructions.append").map((m) => String(m.content));
  }
}

let server: Server;
let base: string;
let port: number;
beforeAll(async () => {
  setFakePaceMs(0);
  server = createServer((req, res) => void handle(req, res));
  attachVoice(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));

let azure: FakeAzure;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetLeadStore();
  resetStartInteractiveCall();
  resetAzureHealth();
  resetVoiceErrors();
  resetVoiceDeps();
  resetTalkOrchestrator();
  resetVoicePath();
  setAiCallingEnabled("agency-demo", true);
  setPlayClock({ now: () => new Date("2026-10-15T14:00:00.000Z") });
  traceBus.reset();
  selectTalkOrchestrator("direct");
  azure = new FakeAzure();
  setVoiceDeps({
    socketFactory: async () => azure.socket,
    credentials: () => ({ liveUrl: "wss://example.invalid/openai/v1/live/sessions", apiKey: "k" }),
    log: () => undefined,
    turnGapMs: 30,
  });
});
afterEach(async () => {
  await fetch(`${base}/api/play/hangup-all`, { method: "POST", body: "{}" });
  resetVoiceDeps();
  resetTalkOrchestrator();
  resetVoicePath();
  vi.restoreAllMocks();
});

/** What the browser saw, in order, with the time each message arrived. */
type Seen = { at: number; msg: Record<string, any> };

async function startPlayedCall(): Promise<string> {
  const started = await fetch(`${base}/api/play/start`, { method: "POST", body: JSON.stringify({ leadId: "lead-1", direction: "inbound", voice: true }) });
  expect(started.status).toBe(200);
  return ((await started.json()) as { callId: string }).callId;
}

function connect(callId: string, seen: Seen[], query = "?input=text"): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/${callId}/socket${query}`, { headers: { Origin: base } });
    ws.on("message", (d) => seen.push({ at: Date.now(), msg: JSON.parse(d.toString()) }));
    ws.once("open", () => resolve(ws));
  });
}

const callEvents = (callId: string, type: string): TraceEvent[] => traceBus.history().filter((e) => e.callId === callId && e.type === type);
const openPlayCalls = async () => (await (await fetch(`${base}/api/play/open`)).json()) as Array<{ callId: string }>;
const ended = (seen: Seen[]) => seen.find((s) => s.msg.type === "status" && s.msg.state === "ended");

describe("the closing line is spoken before the call closes", () => {
  it("Azure path: a caller line that ends the call gets its goodbye played and recorded as spoken, then the session closes and the play call is finished", async () => {
    const callId = await startPlayedCall();
    const seen: Seen[] = [];
    const ws = await connect(callId, seen);
    await until(() => seen.some((s) => s.msg.type === "status" && s.msg.state === "ready"));
    ws.send(JSON.stringify({ type: "text", text: "no thanks, I am not interested" }));
    await until(() => callEvents(callId, "disposition").length > 0);
    // The voice model is told to say the decision step's closing line, and says it.
    const disposedAt = callEvents(callId, "disposition")[0]!.seq;
    const intended = callEvents(callId, "tool_call").filter((e) => e.seq > disposedAt && e.data.tool === "intended_agent_line");
    const closingText = String((intended.at(-1)?.data.result as { text?: unknown } | null)?.text ?? "");
    expect(closingText, "the end node has a closing line").not.toBe("");
    await until(() => azure.steers().some((c) => c.includes(closingText)), 3000);
    azure.say({ type: "session.output_audio.delta", delta: "R09PREJZRQ==" });
    azure.say({ type: "session.output_transcript.delta", delta: "Thanks for your time, goodbye." });
    await until(() => Boolean(ended(seen)), 12_000);
    const audioAt = seen.find((s) => s.msg.type === "audio" && s.msg.data === "R09PREJZRQ==")?.at;
    expect(audioAt, "the closing line's audio reached the browser").toBeDefined();
    expect(audioAt!).toBeLessThan(ended(seen)!.at);
    const goodbye = callEvents(callId, "transcript_final").find((e) => e.data.role === "agent" && e.data.text === "Thanks for your time, goodbye.");
    expect(goodbye?.data, "the closing line is recorded as spoken").toMatchObject({ spoken: true, source: "voice_module" });
    const close = callEvents(callId, "tool_call").find((e) => e.data.tool === "voice_session_close")!;
    expect(goodbye!.seq).toBeLessThan(close.seq);
    expect(close.data.inputs).toMatchObject({ reason: "play_call_ended" });
    // It closed after the playback tail, well before the cap.
    expect(ended(seen)!.at - Date.parse(goodbye!.at)).toBeGreaterThanOrEqual(CLOSING_LINE_TAIL_MS - 100);
    expect(ended(seen)!.at - Date.parse(goodbye!.at)).toBeLessThan(CLOSING_LINE_TAIL_MS + 1000);
    // The session closed by itself, then the play call was finished, its slot freed and its record holds the goodbye.
    await until(() => activeVoiceCallId() === undefined);
    await until(() => ws.readyState === ws.CLOSED);
    await until(async () => !(await openPlayCalls()).some((c) => c.callId === callId), 1000);
    const record = recordStore.read(callId)!;
    expect(record.transcript.find((t) => t.role === "agent" && t.text === "Thanks for your time, goodbye.")).toMatchObject({ spoken: true });
  }, 20_000);

  it("Deepgram path: the sidecar's closing line plays and is recorded as spoken before the session closes", async () => {
    setVoiceDeps({
      deepgramRuntime: () => new DeepgramVoiceRuntime(() => ({ command: process.execPath, args: [fakeSidecar], env: { PATH: process.env.PATH ?? "" } })),
    });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    const callId = await startPlayedCall();
    const seen: Seen[] = [];
    const ws = await connect(callId, seen);
    await until(() => seen.some((s) => s.msg.type === "status" && s.msg.state === "ready"));
    ws.send(JSON.stringify({ type: "text", text: "no thanks, I am not interested" }));
    await until(() => Boolean(ended(seen)), 12_000);
    expect(callEvents(callId, "disposition").length).toBeGreaterThan(0);
    // The fake sidecar speaks the guidance it was sent: its audio is the line's text.
    const steer = callEvents(callId, "tool_call").find((e) => e.data.tool === "steer_voice_model");
    expect(steer, "the closing line was sent to the sidecar").toBeDefined();
    const closing = String((steer!.data.inputs as { instruction: string }).instruction);
    const audioAt = seen.find((s) => s.msg.type === "audio" && Buffer.from(s.msg.data, "base64").toString() === closing)?.at;
    expect(audioAt, "the closing line's audio reached the browser").toBeDefined();
    expect(audioAt!).toBeLessThan(ended(seen)!.at);
    const line = callEvents(callId, "transcript_final").find((e) => e.data.role === "agent" && e.data.text === closing);
    expect(line?.data).toMatchObject({ spoken: true, source: "voice_module" });
    const close = callEvents(callId, "tool_call").find((e) => e.data.tool === "voice_session_close")!;
    expect(line!.seq).toBeLessThan(close.seq);
    expect(close.data.inputs).toMatchObject({ reason: "play_call_ended" });
    expect(ended(seen)!.at - Date.parse(line!.at)).toBeLessThan(CLOSING_LINE_TAIL_MS + 1000);
    await until(() => activeVoiceCallId() === undefined);
    await until(() => ws.readyState === ws.CLOSED);
    await until(async () => !(await openPlayCalls()).some((c) => c.callId === callId), 1000);
    expect(recordStore.read(callId)!.transcript.find((t) => t.role === "agent" && t.text === closing)).toMatchObject({ spoken: true });
  }, 20_000);

  it("a caller hangup while the closing line is awaited ends the call at once", async () => {
    const callId = await startPlayedCall();
    const seen: Seen[] = [];
    const ws = await connect(callId, seen);
    await until(() => seen.some((s) => s.msg.type === "status" && s.msg.state === "ready"));
    ws.send(JSON.stringify({ type: "text", text: "no thanks, I am not interested" }));
    await until(() => callEvents(callId, "disposition").length > 0);
    const hungUpAt = Date.now();
    ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => activeVoiceCallId() === undefined, 1000);
    expect(Date.now() - hungUpAt).toBeLessThan(1000);
    expect(callEvents(callId, "tool_call").find((e) => e.data.tool === "voice_session_close")?.data.inputs).toMatchObject({ reason: "caller_hangup" });
    await until(() => ws.readyState === ws.CLOSED, 1000);
    await tick(50);
    expect((await openPlayCalls()).map((c) => c.callId)).not.toContain(callId);
  });

  it("a failed disclosure check marks the dialog's opening line not said, and the session ending stops the dialog", async () => {
    const callId = await startPlayedCall();
    const seen: Seen[] = [];
    const ws = await connect(callId, seen);
    await until(() => seen.some((s) => s.msg.type === "status" && s.msg.state === "ready"));
    // What the voice session traces when the disclosure was cut off.
    traceBus.emit({ type: "tool_call", leadId: "lead-1", recordId: callId, channel: "call", direction: "inbound", callId, data: { tool: "disclosure_check", inputs: {}, result: null, success: false, durationMs: 0, reason: "disclosure_cut_off" } });
    await until(() => callEvents(callId, "tool_call").some((e) => e.data.tool === "agent_line_not_said"));
    expect(callEvents(callId, "tool_call").find((e) => e.data.tool === "agent_line_not_said")!.data.inputs).toEqual({ turnIndex: -1 });
    ws.send(JSON.stringify({ type: "hangup" }));
    await until(() => callEvents(callId, "tool_call").some((e) => e.data.tool === "dialog_stopped"));
    expect(callEvents(callId, "tool_call").find((e) => e.data.tool === "dialog_stopped")!.data.inputs).toMatchObject({ reason: "caller_hangup" });
  });

  it("a play call with no open voice session is still finished as soon as it reaches a disposition", async () => {
    const started = new Map<string, { say(text: string): Promise<unknown> }>();
    const inner = getStartInteractiveCall()!;
    setStartInteractiveCall(async (args) => {
      const call = await inner(args);
      if (call.status !== "blocked") started.set(call.callId, call);
      return call;
    });
    const callId = await startPlayedCall();
    expect((await openPlayCalls()).map((c) => c.callId)).toContain(callId);
    // No browser socket: the caller line goes to the gated call itself.
    await started.get(callId)!.say("no thanks, I am not interested");
    expect(callEvents(callId, "disposition").length).toBeGreaterThan(0);
    await until(async () => !(await openPlayCalls()).some((c) => c.callId === callId), 500);
  });
});

describe("the closing-line wait on the socket route alone", () => {
  let wsServer: Server;
  let wsPort: number;
  let handleFor: VoiceCallHandle;
  // Read on each socket upgrade, so a test can change the wait before it connects.
  const wait = { closingLineCapMs: 300, closingLineTailMs: 50 };
  // Hung up after each test, even one that failed, so the next can start a call for the same lead.
  let openCalls: Array<{ hangUp(): Promise<unknown> }> = [];
  beforeEach(async () => {
    wait.closingLineCapMs = 300;
    wait.closingLineTailMs = 50;
    wsServer = createServer();
    attachVoiceSockets(wsServer, (id) => (id === handleFor?.call.callId ? handleFor : undefined), wait);
    await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r));
    wsPort = (wsServer.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const call of openCalls) await call.hangUp().catch(() => undefined);
    openCalls = [];
    await new Promise<void>((r) => (wsServer.closeAllConnections(), wsServer.close(() => r())));
  });

  /** A cleared call whose caller line reaches a disposition at once, connected over the socket route. */
  async function disposingCall(seen: Seen[]) {
    const cleared = await clearedTestCall();
    openCalls.push(cleared);
    const emitDisposition = () =>
      traceBus.emit({ type: "disposition", leadId: "lead-1", recordId: cleared.callId, channel: "call", direction: "inbound", callId: cleared.callId, data: { value: "not_interested" } });
    handleFor = { call: cleared, leadId: "lead-1", direction: "inbound", say: async () => (emitDisposition(), undefined), disclosure: () => "Hi, I am an AI assistant." };
    const ws = await new Promise<WebSocket>((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${wsPort}/api/voice/${cleared.callId}/socket?input=text`, { headers: { Origin: `http://127.0.0.1:${wsPort}` } });
      s.on("message", (d) => seen.push({ at: Date.now(), msg: JSON.parse(d.toString()) }));
      s.once("open", () => resolve(s));
    });
    await until(() => seen.some((s) => s.msg.type === "status" && s.msg.state === "ready"));
    return { cleared, ws };
  }
  /** One second of mu-law silence, as the browser plays it (8000 one-byte samples). */
  const oneSecondOfAudio = Buffer.alloc(8000, 0xff).toString("base64");

  it("with no closing line at all, the session closes at the cap after the disposition", async () => {
    const seen: Seen[] = [];
    const { cleared, ws } = await disposingCall(seen);
    const saidAt = Date.now();
    ws.send(JSON.stringify({ type: "text", text: "bye" }));
    await until(() => Boolean(ended(seen)), 2000);
    expect(ended(seen)!.at - saidAt).toBeGreaterThanOrEqual(250);
    expect(ended(seen)!.msg.reason).toBe("play_call_ended");
    await cleared.hangUp().catch(() => undefined);
  });

  it("a closing line whose audio arrived faster than it plays stays open until the browser has played it", async () => {
    wait.closingLineCapMs = 3000;
    const seen: Seen[] = [];
    const { cleared, ws } = await disposingCall(seen);
    ws.send(JSON.stringify({ type: "text", text: "bye" }));
    await until(() => traceBus.history().some((e) => e.callId === cleared.callId && e.type === "disposition"));
    // Speech synthesis can send a whole line in a moment, then report it: the browser still has a second to play.
    const sentAt = Date.now();
    azure.say({ type: "session.output_audio.delta", delta: oneSecondOfAudio });
    azure.say({ type: "session.output_transcript.delta", delta: "Thanks for your time, goodbye." });
    await until(() => Boolean(ended(seen)), 4000);
    expect(seen.some((s) => s.msg.type === "audio" && s.msg.data === oneSecondOfAudio)).toBe(true);
    expect(ended(seen)!.at - sentAt, "the browser had time to play the line").toBeGreaterThanOrEqual(900);
    expect(ended(seen)!.at - sentAt, "and it closed well before the cap").toBeLessThan(2500);
    expect(ended(seen)!.msg.reason).toBe("play_call_ended");
    await cleared.hangUp().catch(() => undefined);
  });

  it("audio streamed after the closing line (the Azure path keeps sending silence) does not hold the call open", async () => {
    wait.closingLineCapMs = 3000;
    const seen: Seen[] = [];
    const { cleared, ws } = await disposingCall(seen);
    ws.send(JSON.stringify({ type: "text", text: "bye" }));
    await until(() => traceBus.history().some((e) => e.callId === cleared.callId && e.type === "disposition"));
    const sentAt = Date.now();
    azure.say({ type: "session.output_audio.delta", delta: oneSecondOfAudio });
    azure.say({ type: "session.output_transcript.delta", delta: "Thanks for your time, goodbye." });
    // More audio keeps arriving faster than it plays, so the queue in the browser never drains.
    const twoTenthsOfASecond = Buffer.alloc(1600, 0xff).toString("base64");
    const feed = setInterval(() => azure.say({ type: "session.output_audio.delta", delta: twoTenthsOfASecond }), 100);
    try {
      await until(() => Boolean(ended(seen)), 4000);
    } finally {
      clearInterval(feed);
    }
    expect(ended(seen)!.at - sentAt, "the browser had time to play the line").toBeGreaterThanOrEqual(900);
    expect(ended(seen)!.at - sentAt, "and the audio after it did not hold the call to the cap").toBeLessThan(1800);
    expect(ended(seen)!.msg.reason).toBe("play_call_ended");
  });

  it("the cap still holds while a closing line's audio is waiting to play", async () => {
    const seen: Seen[] = [];
    const { cleared, ws } = await disposingCall(seen);
    ws.send(JSON.stringify({ type: "text", text: "bye" }));
    await until(() => traceBus.history().some((e) => e.callId === cleared.callId && e.type === "disposition"));
    const disposedAt = Date.now();
    azure.say({ type: "session.output_audio.delta", delta: oneSecondOfAudio });
    azure.say({ type: "session.output_transcript.delta", delta: "Thanks for your time, goodbye." });
    await until(() => Boolean(ended(seen)), 2000);
    expect(ended(seen)!.at - disposedAt).toBeLessThan(800);
    expect(ended(seen)!.msg.reason).toBe("play_call_ended");
    await cleared.hangUp().catch(() => undefined);
  });
});
