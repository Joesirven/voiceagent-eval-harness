// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup";

// The call audio as the microphone client reports it, driven by hand here.
const call = vi.hoisted(() => {
  let state = { live: false, paused: false };
  const listeners = new Set<() => void>();
  return {
    level: vi.fn(() => 0.2),
    get: () => state,
    set(next: { live: boolean; paused: boolean }) { state = next; for (const l of listeners) l(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});
vi.mock("../../../src/server/voice/voice-client.js", () => ({ getCallAudio: call.get, subscribeCallAudio: call.subscribe, getCallAudioLevel: call.level, startBoundCall: vi.fn(), isRinging: () => false }));
// three.js needs WebGL; the orb has its own state tests.
vi.mock("@/components/ui/orb", () => ({ Orb: () => null }));

import { CallOrb } from "./CallOrb";

// jsdom has no canvas: a stand-in records the height of every bar drawn in the latest frame.
let bars: number[] = [];
const canvas2d = {
  scale() {}, beginPath() {}, fill() {}, fillRect() {},
  clearRect() { bars = []; },
  roundRect(_x: number, _y: number, _w: number, h: number) { bars.push(h); },
  createLinearGradient: () => ({ addColorStop() {} }),
  fillStyle: "", globalAlpha: 1, globalCompositeOperation: "",
};
// Animation frames run only when the test asks, 50 milliseconds apart.
const pending = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let clock = 0;
const runFrames = (count: number) => {
  for (let i = 0; i < count; i++) {
    clock += 50;
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback(clock);
  }
};
const getUserMedia = vi.fn();

beforeEach(() => {
  call.set({ live: false, paused: false });
  call.level.mockClear();
  call.level.mockReturnValue(0.2);
  getUserMedia.mockClear();
  bars = [];
  pending.clear();
  (navigator as any).mediaDevices = { getUserMedia };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvas2d as any);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 96, height: 28, top: 0, left: 0, right: 96, bottom: 28, x: 0, y: 0, toJSON() {} } as DOMRect);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pending.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { pending.delete(id); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const waveform = (container: HTMLElement) => container.querySelector('#callOrb [role="img"]');

describe("call waveform on the Call tab", () => {
  it("shows nothing when no call is live", () => {
    const { container, rerender } = render(<CallOrb sorted={[]} inCall={false} />);
    expect(waveform(container)).toBeNull();
    rerender(<CallOrb sorted={[]} inCall />);
    expect(waveform(container)).toBeNull();
    act(() => call.set({ live: true, paused: false }));
    expect(waveform(container)).not.toBeNull();
    act(() => call.set({ live: false, paused: false }));
    expect(waveform(container)).toBeNull();
  });

  it("draws the level the call audio hook reports and never opens a microphone of its own", () => {
    call.set({ live: true, paused: false });
    const { container } = render(<CallOrb sorted={[]} inCall />);
    act(() => runFrames(5));
    expect(call.level).toHaveBeenCalled();
    expect(waveform(container)!.getAttribute("aria-label")).toBe("Live audio waveform");
    // A level of 0.2 scaled by 4 is 0.8 of the bar room (80 percent of 28 pixels), well above the 4 pixel floor.
    expect(bars.length).toBeGreaterThan(0);
    expect(Math.max(...bars)).toBeCloseTo(0.8 * 28 * 0.8, 5);

    call.level.mockReturnValue(0);
    act(() => runFrames(1));
    expect(bars).toContain(4);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("goes flat while the call is paused and stops reading the level", () => {
    call.set({ live: true, paused: false });
    const { container } = render(<CallOrb sorted={[]} inCall />);
    act(() => runFrames(5));
    expect(Math.max(...bars)).toBeGreaterThan(4);

    act(() => call.set({ live: true, paused: true }));
    const reads = call.level.mock.calls.length;
    act(() => runFrames(60));
    expect(call.level).toHaveBeenCalledTimes(reads);
    expect(bars).toEqual([]);
    expect(waveform(container)!.getAttribute("aria-label")).toBe("Audio waveform idle");

    act(() => call.set({ live: true, paused: false }));
    act(() => runFrames(5));
    expect(call.level.mock.calls.length).toBeGreaterThan(reads);
    expect(Math.max(...bars)).toBeGreaterThan(4);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
