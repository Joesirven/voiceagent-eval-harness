// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup";

// The real wave and radial visualizers, with only the browser audio and drawing pieces faked, mounted with no
// Pipecat client provider and a plain media track from the call.
const created: string[] = [];
const track = { id: "fake-track", kind: "audio" } as unknown as MediaStreamTrack;
const tracks = vi.hoisted(() => ({ value: { ready: true, caller: null as unknown, agent: null as unknown } }));
vi.mock("@/lib/use-call-audio", () => ({ useCallAudio: () => tracks.value }));

import { MediaPane } from "./MediaPane";

beforeEach(() => {
  created.length = 0;
  tracks.value = { ready: true, caller: track, agent: track };
  class FakeAudioContext {
    sampleRate = 48000;
    constructor() { created.push("context"); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { context: this, fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 512, getByteFrequencyData() {}, getByteTimeDomainData() {} }; }
    close() { created.push("closed"); return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // A drawing context that accepts every call; the test is about wiring, not pixels.
  const noop = () => drawing;
  const drawing: any = new Proxy({} as Record<string | symbol, unknown>, {
    get: (store, key) => (key === "measureText" ? () => ({ width: 0 }) : key in store ? store[key] : typeof key === "symbol" ? undefined : noop),
    set: (store, key, value) => { store[key] = value; return true; },
  });
  HTMLCanvasElement.prototype.getContext = ((kind: string) => (kind === "2d" ? drawing : null)) as never;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("media pane with the real visualizers", () => {
  it("mounts the wave and the radial ring on a plain track without a client provider, and releases the audio contexts when it unmounts", () => {
    const { unmount, container } = render(<MediaPane sorted={[]} inCall controls={null} />);
    expect(screen.getByTestId("agentVisualizer").querySelector("canvas, div")).toBeTruthy();
    expect(screen.getByTestId("callerVisualizer").querySelector("canvas")).toBeTruthy();
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Caller");
    expect(created.filter((c) => c === "context").length).toBeGreaterThan(0);
    unmount();
    expect(created.filter((c) => c === "closed").length).toBe(created.filter((c) => c === "context").length);
  });
});
