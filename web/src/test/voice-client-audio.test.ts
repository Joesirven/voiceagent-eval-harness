// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Checks the browser audio path of the microphone client: the low-pass filter and decimation, the 20 millisecond
// messages, the sustained loudness rule for cutting the agent off, and the lead before a line's first chunk.
const sent: unknown[] = [];
let socket: any;
let processor: any;
let scheduled: number[] = [];
let stopped = 0;
const ctx: any = {
  state: "running", sampleRate: 48000, currentTime: 0, destination: {},
  resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}),
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  createScriptProcessor: () => { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; },
  createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n), duration: n / 8000 }),
  createBufferSource: () => ({ connect() {}, start(t: number) { scheduled.push(t); }, stop() { stopped += 1; }, onended: null }),
};

const bytes = (list: unknown[]) => list.filter((d): d is Uint8Array => d instanceof Uint8Array);
const bargeIns = () => sent.filter((d) => typeof d === "string" && d.includes("barge_in"));
const block = (n: number, amp: number) => ({ inputBuffer: { getChannelData: () => new Float32Array(n).fill(amp) } });
const tone = (hz: number, rate: number, n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x: Float32Array, skip = 200) => Math.sqrt(x.slice(skip).reduce((a, v) => a + v * v, 0) / (x.length - skip));

/** Starts a call; `ready` adds fields to the server's ready frame (for example who owns barge-in). */
async function startCall(ready: Record<string, unknown> = {}) {
  URL.createObjectURL = () => "blob:worklet";
  document.body.innerHTML = `<select id="lead"><option value="lead-1">Jane</option></select><input id="dir" value="inbound"><input id="gap" value="900">
    <button id="start"></button><button id="pause" disabled></button><button id="hang" disabled></button><span id="status"></span><span id="clock"></span>`;
  (globalThis as any).AudioContext = function () { return ctx; };
  (globalThis as any).WebSocket = class { readyState = 1; onmessage: any; constructor() { socket = this; } send(d: unknown) { sent.push(d); } close() {} };
  (navigator as any).mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes("leads") ? [] : { callId: "call_1" }) })));
  const mod = await import("../../../src/server/voice/voice-client.js");
  socket = undefined;
  mod.bindLeadVoice({ lead: "lead", dir: "dir", gap: "gap", startMic: "start", pause: "pause", hang: "hang", status: "status", clock: "clock" });
  (document.getElementById("start") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(socket).toBeDefined());
  await socket.onmessage({ data: JSON.stringify({ type: "status", state: "ready", sessionMode: "direct_azure_microphone", ...ready }) });
  await vi.waitFor(() => expect(processor?.onaudioprocess).toBeTruthy());
  return mod;
}
const agentChunk = () => socket.onmessage({ data: JSON.stringify({ type: "audio", data: btoa("\0".repeat(8000)) }) });
const feed = (blocks: number, amp: number, size = 128) => { for (let i = 0; i < blocks; i++) processor.onaudioprocess(block(size, amp)); };

beforeEach(() => {
  URL.createObjectURL = () => "blob:worklet"; ctx.currentTime = 0; ctx.sampleRate = 48000; scheduled = []; stopped = 0; processor = undefined; });
afterEach(() => { sent.length = 0; vi.restoreAllMocks(); });

describe("downsampler", () => {
  const run = async (rate: number, size: number) => {
    URL.createObjectURL = () => "blob:worklet";
    const { createDownsampler } = await import("../../../src/server/voice/voice-client.js");
    const down = createDownsampler(rate, 8000);
    const input = tone(1000, rate, rate);
    let total = 0;
    for (let i = 0; i < input.length; i += size) total += down(input.subarray(i, Math.min(i + size, input.length))).length;
    return total;
  };
  it("turns 48,000 input samples into exactly 8,000 in blocks of 128, 2048 or one block", async () => {
    expect(await run(48000, 128)).toBe(8000);
    expect(await run(48000, 2048)).toBe(8000);
    expect(await run(48000, 48000)).toBe(8000);
  });
  it("turns 44,100 input samples into exactly 8,000 whatever the block size", async () => {
    expect(await run(44100, 128)).toBe(8000);
    expect(await run(44100, 2048)).toBe(8000);
    expect(await run(44100, 44100)).toBe(8000);
  });
  it("brings a 6 kilohertz tone at least 30 decibels below a 1 kilohertz tone of the same amplitude", async () => {
    const { createDownsampler } = await import("../../../src/server/voice/voice-client.js");
    const level = (hz: number) => rms(createDownsampler(48000, 8000)(tone(hz, 48000, 48000)));
    expect(20 * Math.log10(level(6000) / level(1000))).toBeLessThan(-30);
    expect(level(1000)).toBeGreaterThan(0.3);
  });
});

describe("microphone client audio path", () => {
  it("sends 160 mu-law bytes (20 milliseconds) per message and drops a partial message on pause", async () => {
    await startCall();
    feed(100, 0.01); // 12,800 input samples at 48 kilohertz is 2,133 output samples
    const messages = bytes(sent);
    expect(messages).toHaveLength(13);
    expect(messages.every((m) => m.length === 160)).toBe(true);
    // 2133 - 13 * 160 = 53 samples are pending; pausing drops them.
    const pause = document.getElementById("pause") as HTMLButtonElement;
    pause.click();
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalled());
    feed(10, 0.01);
    expect(bytes(sent)).toHaveLength(13);
    pause.click();
    await vi.waitFor(() => expect(ctx.resume).toHaveBeenCalled());
    // 960 input samples after resume are 160 output samples: exactly one message only if the stale 53 were dropped.
    feed(7, 0.01, 128); // 896 input samples, 149 output samples
    expect(bytes(sent)).toHaveLength(13);
    feed(1, 0.01, 128);
    expect(bytes(sent)).toHaveLength(14);
  });

  it("does not clear playback for one loud block, but does for 200 milliseconds of loud audio", async () => {
    await startCall();
    feed(1200, 0.01); // 3.2 seconds of quiet audio, past the start-up period
    await agentChunk();
    feed(1, 0.5);
    expect(stopped).toBe(0);
    expect(bargeIns()).toHaveLength(0);
    feed(2, 0.01); // a quiet block resets the count
    feed(74, 0.5); // 197 milliseconds: without the reset, 75 loud blocks would already have counted
    expect(bargeIns()).toHaveLength(0);
    feed(1, 0.5); // the 75th loud block since the quiet one reaches 200 milliseconds
    expect(bargeIns()).toHaveLength(1);
    expect(stopped).toBe(1);
  });

  it("does not clear playback when a quiet block interrupts a long run of loud audio", async () => {
    await startCall();
    feed(1200, 0.01);
    await agentChunk();
    feed(40, 0.5);
    feed(1, 0.01);
    feed(40, 0.5); // 80 loud blocks in total, but never 75 in a row
    expect(bargeIns()).toHaveLength(0);
    expect(stopped).toBe(0);
  });

  it("still honours the whole 1500 millisecond start-up period when paused partway through it", async () => {
    await startCall();
    await agentChunk();
    feed(375, 0.01); // 1 second of quiet audio
    const pause = document.getElementById("pause") as HTMLButtonElement;
    pause.click();
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalled());
    feed(300, 0.5); // paused: none of this is heard
    pause.click();
    await vi.waitFor(() => expect(ctx.resume).toHaveBeenCalled());
    feed(150, 0.5); // 1.4 seconds of unpaused audio so far
    expect(bargeIns()).toHaveLength(0);
    feed(150, 0.5); // the period ends 100 milliseconds in, leaving 300 loud milliseconds
    expect(bargeIns()).toHaveLength(1);
  });

  it("ignores loud audio for the first 1500 milliseconds after the microphone starts", async () => {
    await startCall();
    await agentChunk();
    feed(500, 0.5); // 1.33 seconds of loud audio
    expect(bargeIns()).toHaveLength(0);
    expect(stopped).toBe(0);
    feed(150, 0.5); // 2.0 seconds in: more than 200 milliseconds of loud audio after the first 1.5 seconds
    expect(bargeIns()).toHaveLength(1);
  });

  it("leaves barge-in to the server when the ready frame says the server owns it (Azure Voice Live)", async () => {
    await startCall({ sessionMode: "azure_voice_live_microphone", bargeInOwner: "server" });
    feed(1200, 0.01);
    await agentChunk();
    feed(80, 0.5); // more than 200 milliseconds of loud audio over the agent
    expect(bargeIns()).toHaveLength(0);
    expect(stopped).toBe(0);
  });

  it("keeps the loudness barge-in when the ready frame says the browser owns it", async () => {
    await startCall({ bargeInOwner: "browser" });
    feed(1200, 0.01);
    await agentChunk();
    feed(80, 0.5);
    expect(bargeIns()).toHaveLength(1);
    expect(stopped).toBe(1);
  });

  it("schedules a line's first chunk about 150 milliseconds ahead and the next chunk from the playhead", async () => {
    await startCall();
    ctx.currentTime = 2;
    await agentChunk(); // 8,000 bytes is one second
    await agentChunk();
    expect(scheduled[0]).toBeCloseTo(2.15, 5);
    expect(scheduled[1]).toBeCloseTo(3.15, 5);
  });
});
