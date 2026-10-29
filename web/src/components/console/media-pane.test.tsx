// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test/setup";

const tracks = vi.hoisted(() => ({ value: { ready: false, caller: null as unknown, agent: null as unknown } }));
vi.mock("@/lib/use-call-audio", () => ({ useCallAudio: () => tracks.value }));
// The visualizers draw with WebGL and analysers; here they only report what they were given.
vi.mock("@/components/pipecat/audio-visualizer-wave", () => ({
  AudioVisualizerWaveView: (p: any) => <div data-testid="wave" data-track={p.track?.id ?? "none"} data-connecting={String(!!p.isConnecting)} data-thinking={String(!!p.isThinking)} />,
}));
vi.mock("@/components/pipecat/audio-visualizer-radial", () => ({
  AudioVisualizerRadialView: (p: any) => <div data-testid="radial" data-track={p.track?.id ?? "none"} data-connecting={String(!!p.isConnecting)} />,
}));

import { MediaPane } from "./MediaPane";

afterEach(() => { cleanup(); vi.useRealTimers(); tracks.value = { ready: false, caller: null, agent: null }; });

const decisionNow = (): any => [{ type: "decision", at: new Date().toISOString(), data: {} }];

describe("MediaPane", () => {
  it("shows a calm idle note and the controls, without visualizers, when there is no call", () => {
    render(<MediaPane sorted={[]} inCall={false} controls={<button>Start call</button>} />);
    expect(screen.getByRole("button", { name: "Start call" })).toBeTruthy();
    expect(screen.getByTestId("mediaIdle").textContent).toMatch(/No call is running/);
    expect(screen.queryByTestId("wave")).toBeNull();
    expect(screen.queryByTestId("radial")).toBeNull();
  });

  it("shows connecting until the call is ready, then gives each visualizer its own track", () => {
    const { rerender } = render(<MediaPane sorted={[]} inCall controls={null} />);
    expect(screen.queryByTestId("mediaIdle")).toBeNull();
    expect(screen.getByTestId("wave").dataset.connecting).toBe("true");
    expect(screen.getByTestId("radial").dataset.connecting).toBe("true");
    tracks.value = { ready: true, caller: { id: "caller" }, agent: { id: "agent" } };
    rerender(<MediaPane sorted={[]} inCall controls={null} />);
    expect(screen.getByTestId("wave").dataset.connecting).toBe("false");
    expect(screen.getByTestId("wave").dataset.track).toBe("agent");
    expect(screen.getByTestId("radial").dataset.track).toBe("caller");
  });

  it("keeps the caller connecting after the call is ready until the microphone track exists", () => {
    tracks.value = { ready: true, caller: null, agent: { id: "agent" } };
    const { rerender } = render(<MediaPane sorted={[]} inCall controls={null} />);
    expect(screen.getByTestId("wave").dataset.connecting).toBe("false");
    expect(screen.getByTestId("radial").dataset.connecting).toBe("true");
    tracks.value = { ready: true, caller: { id: "caller" }, agent: { id: "agent" } };
    rerender(<MediaPane sorted={[]} inCall controls={null} />);
    expect(screen.getByTestId("radial").dataset.connecting).toBe("false");
  });

  it("shows thinking on the agent wave for the real hold time of four seconds after a decision", () => {
    vi.useFakeTimers();
    tracks.value = { ready: true, caller: { id: "caller" }, agent: { id: "agent" } };
    render(<MediaPane sorted={decisionNow()} inCall controls={null} />);
    expect(screen.getByTestId("wave").dataset.thinking).toBe("true");
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.getByTestId("wave").dataset.thinking).toBe("true");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId("wave").dataset.thinking).toBe("false");
  });
});
