// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives startBoundCall on the real microphone client with fake audio contexts, a fake /api/play/start and a fake
// socket, and checks the ringback: what it plays, when the call starts behind it, and every way it stops.
type VoiceClient = typeof import("../../../src/server/voice/voice-client.js");

// Each audio context is a new fake; the first one in a ringing test is the ring's. The event log keeps the order of
// what the contexts did across all of them ("<context number> <event>").
let contexts: any[] = [];
let events: string[] = [];
let sockets: any[] = [];
let startReply: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { callId: "call_1" } };
let fetchMock: ReturnType<typeof vi.fn>;
let mod: VoiceClient;

function makeContext() {
  const id = contexts.length;
  const log = (what: string) => events.push(`${id} ${what}`);
  const ctx: any = {
    state: "suspended", sampleRate: 8000, currentTime: 0, destination: {},
    oscillators: [] as any[], gainCalls: [] as [string, number, number][],
    resume: vi.fn(async () => { ctx.state = "running"; }),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => { log("close"); ctx.state = "closed"; }),
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: (v: number, t: number) => ctx.gainCalls.push(["set", v, t]),
        linearRampToValueAtTime: (v: number, t: number) => ctx.gainCalls.push(["ramp", v, t]),
      },
      connect() {},
    }),
    createOscillator: () => {
      const oscillator = { frequency: { value: 0 }, connect() {}, start: vi.fn(() => log("oscillator start")), stop: vi.fn(() => log("oscillator stop")) };
      ctx.oscillators.push(oscillator);
      return oscillator;
    },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
    createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n), duration: n / 8000 }),
    createBufferSource: () => ({ connect() {}, start: () => log("chunk start"), stop() {}, onended: null }),
  };
  contexts.push(ctx);
  return ctx;
}

const startFetches = () => fetchMock.mock.calls.filter(([url]) => url === "/api/play/start").length;
const status = () => document.getElementById("status")!.textContent;
const socket = () => sockets.at(-1);
/** Lets the fake fetch and the other promises in begin settle, without moving the fake clock. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
}
const ready = () => socket().onmessage({ data: JSON.stringify({ type: "status", state: "ready", sessionMode: "direct_azure_microphone" }) });
const agentChunk = () => socket().onmessage({ data: JSON.stringify({ type: "audio", data: btoa("\0".repeat(160)) }) });

function bind() {
  mod.bindLeadVoice({ lead: "lead", dir: "dir", gap: "gap", startMic: "start", pause: "pause", hang: "hang", status: "status", clock: "clock" });
}

/** Starts a ringing call and lets the default 1500 millisecond lead pass, so begin has opened the socket. */
async function ringThroughLead() {
  mod.startBoundCall({ ring: true });
  await vi.advanceTimersByTimeAsync(1500);
  await until(() => sockets.length === 1);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  contexts = []; events = []; sockets = [];
  startReply = { ok: true, status: 200, body: { callId: "call_1" } };
  URL.createObjectURL = () => "blob:worklet";
  document.body.innerHTML = `<select id="lead"><option value="lead-1">Jane</option></select><input id="dir" value="inbound"><input id="gap" value="900">
    <button id="start"></button><button id="pause" disabled></button><button id="hang" disabled></button><span id="status"></span><span id="clock"></span>`;
  (globalThis as any).AudioContext = function () { return makeContext(); };
  (globalThis as any).WebSocket = class {
    readyState = 1; onmessage: any; onclose: any; onerror: any; sent: unknown[] = [];
    constructor() { sockets.push(this); }
    send(d: unknown) { this.sent.push(d); }
    close() { events.push("socket close"); }
  };
  (navigator as any).mediaDevices = { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) };
  fetchMock = vi.fn(async (url: string) => (url.includes("leads")
    ? { ok: true, status: 200, json: async () => [] }
    : { ok: startReply.ok, status: startReply.status, json: async () => startReply.body }));
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  mod = await import("../../../src/server/voice/voice-client.js");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("startBoundCall with a ring", () => {
  it("plays the North American ringback at once through its own audio context and shows Ringing", () => {
    bind();
    expect(mod.isRinging()).toBe(false);
    mod.startBoundCall({ ring: true });
    expect(mod.isRinging()).toBe(true);
    expect(contexts).toHaveLength(1);
    const ring = contexts[0];
    expect(ring.resume).toHaveBeenCalled();
    expect(ring.oscillators.map((o: any) => o.frequency.value)).toEqual([440, 480]);
    expect(ring.oscillators.every((o: any) => o.start.mock.calls.length === 1)).toBe(true);
    expect(status()).toBe("Ringing");
    // Two seconds on and four off at a modest level: on at 0, 6, 12 seconds..., off again two seconds after each.
    const ramps = ring.gainCalls.filter(([kind]: [string]) => kind === "ramp");
    const ons = ramps.filter(([, v]: [string, number]) => v > 0);
    const offs = ramps.filter(([, v]: [string, number]) => v === 0);
    expect(ons.map(([, , t]: [string, number, number]) => Math.round(t))).toEqual([0, 6, 12, 18, 24]);
    expect(offs.map(([, , t]: [string, number, number]) => t)).toEqual([2, 8, 14, 20, 26]);
    expect(ons.every(([, v]: [string, number]) => v <= 0.25)).toBe(true);
    expect(startFetches()).toBe(0);
  });

  it("starts the call only once the 1500 millisecond lead has passed, with the ring still playing", async () => {
    bind();
    mod.startBoundCall({ ring: true });
    await vi.advanceTimersByTimeAsync(1499);
    expect(startFetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(startFetches()).toBe(1);
    await until(() => sockets.length === 1);
    expect(mod.isRinging()).toBe(true);
    expect(contexts[0].close).not.toHaveBeenCalled();
    // The existing statuses replace Ringing as the call proceeds.
    expect(status()).toBe("Starting");
    await ready();
    expect(status()).toContain("Live microphone");
    expect(mod.isRinging()).toBe(true);
  });

  it("honours a shorter ringLeadMs", async () => {
    bind();
    mod.startBoundCall({ ring: true, ringLeadMs: 400 });
    await vi.advanceTimersByTimeAsync(399);
    expect(startFetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(startFetches()).toBe(1);
  });

  it("stops the ring at the first agent audio, before that chunk plays", async () => {
    bind();
    await ringThroughLead();
    await ready();
    await agentChunk();
    expect(mod.isRinging()).toBe(false);
    const firstChunk = events.indexOf("1 chunk start");
    expect(firstChunk).toBeGreaterThan(-1);
    expect(events.indexOf("0 oscillator stop")).toBeGreaterThan(-1);
    expect(events.indexOf("0 oscillator stop")).toBeLessThan(firstChunk);
    expect(events.indexOf("0 close")).toBeLessThan(firstChunk);
    // Later chunks play normally and the ring is not stopped again.
    await agentChunk();
    expect(events.filter((e) => e === "1 chunk start")).toHaveLength(2);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("stops the ring when /api/play/start refuses the call", async () => {
    bind();
    startReply = { ok: false, status: 409, body: { blocked: true, reason: "lead is on the do not call list" } };
    mod.startBoundCall({ ring: true });
    await vi.advanceTimersByTimeAsync(1500);
    await until(() => !mod.isRinging());
    expect(status()).toBe("Call not started: lead is on the do not call list");
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
  });

  it("stops the ring when the socket closes", async () => {
    bind();
    await ringThroughLead();
    socket().onclose({ wasClean: false, code: 1006, reason: "" });
    expect(mod.isRinging()).toBe(false);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(status()).toBe("WebSocket closed (code 1006)");
  });

  it("stops the ring on a socket error", async () => {
    bind();
    await ringThroughLead();
    socket().onerror();
    expect(mod.isRinging()).toBe(false);
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it("stops the ring when the call ends", async () => {
    bind();
    await ringThroughLead();
    await ready();
    await socket().onmessage({ data: JSON.stringify({ type: "status", state: "ended", reason: "hangup" }) });
    expect(mod.isRinging()).toBe(false);
  });

  it("stops the ring at once on hang up, and sends the hang up", async () => {
    bind();
    await ringThroughLead();
    await ready();
    (document.getElementById("hang") as HTMLButtonElement).click();
    expect(mod.isRinging()).toBe(false);
    expect(contexts[0].oscillators.every((o: any) => o.stop.mock.calls.length === 1)).toBe(true);
    expect(socket().sent).toContain(JSON.stringify({ type: "hangup" }));
  });

  it("stops the ring at the 30 second cap while the call waits for the agent", async () => {
    bind();
    await ringThroughLead();
    await ready();
    await vi.advanceTimersByTimeAsync(28_499);
    expect(mod.isRinging()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mod.isRinging()).toBe(false);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    // Only the ring stopped; the call is still live.
    expect(events).not.toContain("socket close");
  });

  it("is harmless to stop twice", async () => {
    bind();
    await ringThroughLead();
    await ready();
    (document.getElementById("hang") as HTMLButtonElement).click();
    await socket().onmessage({ data: JSON.stringify({ type: "status", state: "ended", reason: "hangup" }) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[0].oscillators.every((o: any) => o.stop.mock.calls.length === 1)).toBe(true);
  });

  it("a second startBoundCall during the lead stops the first ring and starts one call, a lead after the second", async () => {
    bind();
    mod.startBoundCall({ ring: true });
    await vi.advanceTimersByTimeAsync(1000);
    mod.startBoundCall({ ring: true });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].oscillators).toHaveLength(2);
    expect(mod.isRinging()).toBe(true);
    await vi.advanceTimersByTimeAsync(1499);
    expect(startFetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(startFetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(startFetches()).toBe(1);
  });

  it("a second startBoundCall while the call is starting stops the ring and starts nothing else", async () => {
    bind();
    await ringThroughLead();
    const before = contexts.length;
    mod.startBoundCall({ ring: true });
    expect(mod.isRinging()).toBe(false);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(5000);
    expect(startFetches()).toBe(1);
  });

  it("starts the call even when the ringback cannot be built", async () => {
    bind();
    (globalThis as any).AudioContext = function () {
      const ctx = makeContext();
      if (contexts.length === 1) ctx.createOscillator = () => { throw new Error("no oscillators here"); };
      return ctx;
    };
    mod.startBoundCall({ ring: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(startFetches()).toBe(1);
    await until(() => sockets.length === 1);
  });
});

describe("startBoundCall without a ring", () => {
  it("starts the call at once, as clicking startMic would, with no ringback", async () => {
    bind();
    mod.startBoundCall();
    expect(startFetches()).toBe(1);
    expect(mod.isRinging()).toBe(false);
    await until(() => sockets.length === 1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].oscillators).toHaveLength(0);
    expect(status()).toBe("Starting");
  });

  it("treats ring: false the same", () => {
    bind();
    mod.startBoundCall({ ring: false });
    expect(startFetches()).toBe(1);
    expect(contexts).toHaveLength(0);
    expect(mod.isRinging()).toBe(false);
  });

  it("does nothing when no controls are bound", async () => {
    mod.startBoundCall({ ring: true });
    mod.startBoundCall();
    await vi.advanceTimersByTimeAsync(5000);
    expect(contexts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.isRinging()).toBe(false);
  });

  it("does nothing while a call is live", async () => {
    bind();
    mod.startBoundCall();
    await until(() => sockets.length === 1);
    await ready();
    mod.startBoundCall({ ring: true });
    mod.startBoundCall();
    await vi.advanceTimersByTimeAsync(5000);
    expect(startFetches()).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(mod.isRinging()).toBe(false);
    expect(status()).toContain("Live microphone");
  });
});

describe("the startMic button", () => {
  it("starts a call at once with no ring, as before", async () => {
    bind();
    (document.getElementById("start") as HTMLButtonElement).click();
    expect(startFetches()).toBe(1);
    expect(mod.isRinging()).toBe(false);
    await until(() => sockets.length === 1);
    await ready();
    await agentChunk();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].oscillators).toHaveLength(0);
    expect(events).toEqual(["0 chunk start"]);
    expect(status()).toContain("Live microphone");
  });

  it("clicked during a ring's lead, it starts the only call and the lead does not start a second one", async () => {
    bind();
    mod.startBoundCall({ ring: true });
    await vi.advanceTimersByTimeAsync(500);
    (document.getElementById("start") as HTMLButtonElement).click();
    expect(startFetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(startFetches()).toBe(1);
    await until(() => sockets.length === 1);
    await ready();
    expect(mod.isRinging()).toBe(true);
    await agentChunk();
    expect(mod.isRinging()).toBe(false);
  });
});
