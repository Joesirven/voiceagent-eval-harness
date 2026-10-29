// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Drives the real microphone client with a fake audio context, microphone and socket, and checks what it tells
// the page about the call audio (the Call tab waveform reads it).
const sent: unknown[] = [];
let socket: any;
const ctx = {
  state: "running", sampleRate: 8000, currentTime: 0, destination: {},
  resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}),
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  createScriptProcessor: () => { processor = { connect() {}, disconnect() {}, onaudioprocess: null as null | ((e: unknown) => void) }; return processor; },
  createBuffer: () => ({ getChannelData: () => new Float32Array(4), duration: 0.01 }),
  createBufferSource: () => ({ connect() {}, start() {}, stop() {}, onended: null }),
};
let processor: any;

afterEach(() => { sent.length = 0; vi.restoreAllMocks(); });

describe("pause and resume on the microphone client", () => {
  it("stops sending caller audio and suspends playback while paused, restarts both on resume, and reports the call audio level", async () => {
    URL.createObjectURL = () => "blob:worklet";
    document.body.innerHTML = `<select id="lead"><option value="lead-1">Jane</option></select><input id="dir" value="inbound"><input id="gap" value="900">
      <button id="start"></button><button id="pause" disabled></button><button id="hang" disabled></button><span id="status"></span><span id="clock"></span>`;
    (globalThis as any).AudioContext = function () { return ctx; };
    (globalThis as any).WebSocket = class { readyState = 1; onmessage: any; constructor() { socket = this; } send(d: unknown) { sent.push(d); } close() {} };
    (navigator as any).mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes("leads") ? [] : { callId: "call_1" }) })));
    const { bindLeadVoice, getCallAudio, getCallAudioLevel, subscribeCallAudio } = await import("../../../src/server/voice/voice-client.js");
    const changes: unknown[] = [];
    subscribeCallAudio(() => changes.push(getCallAudio()));
    expect(getCallAudio()).toEqual({ live: false, paused: false });
    bindLeadVoice({ lead: "lead", dir: "dir", gap: "gap", startMic: "start", pause: "pause", hang: "hang", status: "status", clock: "clock" });

    (document.getElementById("start") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(socket).toBeDefined());
    await socket.onmessage({ data: JSON.stringify({ type: "status", state: "ready", sessionMode: "direct_azure_microphone" }) });
    await vi.waitFor(() => expect(processor?.onaudioprocess).toBeTruthy());
    const pause = document.getElementById("pause") as HTMLButtonElement;
    expect(pause.disabled).toBe(false);

    const frame = { inputBuffer: { getChannelData: () => new Float32Array(160).fill(0.01) } };
    processor.onaudioprocess(frame);
    expect(sent.filter((d) => d instanceof Uint8Array)).toHaveLength(1);
    // The page reads the level of the caller audio the call sent, from the same frames.
    expect(getCallAudio()).toEqual({ live: true, paused: false });
    expect(getCallAudioLevel()).toBeCloseTo(0.01, 5);

    // Agent audio counts while it plays: four loud mu-law bytes scheduled 150 milliseconds ahead, 10 milliseconds long.
    await socket.onmessage({ data: JSON.stringify({ type: "audio", data: btoa("\0\0\0\0") }) });
    ctx.currentTime = 0.155;
    expect(getCallAudioLevel()).toBeGreaterThan(0.9);
    ctx.currentTime = 0.2;
    expect(getCallAudioLevel()).toBeCloseTo(0.01, 5);

    pause.click();
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(1));
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("status")!.textContent).toContain("Paused");
    processor.onaudioprocess(frame);
    expect(sent.filter((d) => d instanceof Uint8Array)).toHaveLength(1);
    // Paused: the page is told, and the level is flat even if a frame still arrives.
    expect(getCallAudio()).toEqual({ live: true, paused: true });
    expect(getCallAudioLevel()).toBe(0);

    pause.click();
    await vi.waitFor(() => expect(ctx.resume).toHaveBeenCalled());
    expect(pause.getAttribute("aria-pressed")).toBe("false");
    processor.onaudioprocess(frame);
    expect(sent.filter((d) => d instanceof Uint8Array)).toHaveLength(2);
    expect(getCallAudio()).toEqual({ live: true, paused: false });
    expect(getCallAudioLevel()).toBeCloseTo(0.01, 5);

    // The call ends: no call audio to show.
    await socket.onmessage({ data: JSON.stringify({ type: "status", state: "ended", reason: "hangup" }) });
    expect(getCallAudio()).toEqual({ live: false, paused: false });
    expect(getCallAudioLevel()).toBe(0);
    expect(changes).toEqual([
      { live: true, paused: false }, { live: true, paused: true }, { live: true, paused: false }, { live: false, paused: false },
    ]);
  });

  it("publishes the caller microphone track, the agent tap track and the ready state, and clears them when the call ends", async () => {
    URL.createObjectURL = () => "blob:worklet";
    document.body.innerHTML = `<select id="lead"><option value="lead-1">Jane</option></select><input id="dir" value="inbound"><input id="gap" value="900">
      <button id="start"></button><button id="pause" disabled></button><button id="hang" disabled></button><span id="status"></span><span id="clock"></span><p id="hint"></p>`;
    const callerTrack = { kind: "audio", id: "caller", stop: vi.fn() };
    const agentTrack = { kind: "audio", id: "agent" };
    const tapped: unknown[] = [];
    const tapNode = { stream: { getAudioTracks: () => [agentTrack] } };
    const tapCtx = {
      ...ctx,
      currentTime: 0,
      createMediaStreamDestination: () => tapNode,
      createBufferSource: () => ({ connect: (to: unknown) => { tapped.push(to); }, start() {}, stop() {}, onended: null }),
    };
    (globalThis as any).AudioContext = function () { return tapCtx; };
    (globalThis as any).WebSocket = class { readyState = 1; onmessage: any; constructor() { socket = this; } send(d: unknown) { sent.push(d); } close() {} };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [callerTrack], getAudioTracks: () => [callerTrack] }));
    (navigator as any).mediaDevices = { getUserMedia };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes("leads") ? [] : { callId: "call_2" }) })));
    const { bindLeadVoice, getCallTracks, subscribeCallTracks } = await import("../../../src/server/voice/voice-client.js");
    const seen: unknown[] = [];
    subscribeCallTracks(() => seen.push(getCallTracks()));
    expect(getCallTracks()).toEqual({ ready: false, caller: null, agent: null });
    socket = undefined;
    bindLeadVoice({ lead: "lead", dir: "dir", gap: "gap", startMic: "start", pause: "pause", hang: "hang", status: "status", clock: "clock", micHint: "hint" });
    // The hint element is found through its id in the ids object.
    expect(document.getElementById("hint")!.textContent).toContain("Talk microphone");

    (document.getElementById("start") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(socket).toBeDefined());
    // Not ready yet: nothing is published.
    expect(getCallTracks()).toEqual({ ready: false, caller: null, agent: null });
    await socket.onmessage({ data: JSON.stringify({ type: "status", state: "ready", sessionMode: "direct_azure_microphone" }) });
    await vi.waitFor(() => expect(getCallTracks().caller).toBe(callerTrack));
    expect(getCallTracks()).toEqual({ ready: true, caller: callerTrack, agent: agentTrack });
    // Only the call's own microphone stream is used.
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Agent playback is also routed to the tap.
    await socket.onmessage({ data: JSON.stringify({ type: "audio", data: btoa("\0\0\0\0") }) });
    expect(tapped).toContain(tapNode);

    await socket.onmessage({ data: JSON.stringify({ type: "status", state: "ended", reason: "hangup" }) });
    expect(getCallTracks()).toEqual({ ready: false, caller: null, agent: null });
    expect(callerTrack.stop).toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ ready: false, caller: null, agent: null });
  });
});
