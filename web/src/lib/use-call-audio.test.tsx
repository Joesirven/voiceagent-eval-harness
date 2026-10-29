// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The published tracks, driven by hand.
const store = vi.hoisted(() => {
  let state = { ready: false, caller: null as unknown, agent: null as unknown };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: typeof state) { state = next; for (const l of listeners) l(); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    count: () => listeners.size,
  };
});
vi.mock("../../../src/server/voice/voice-client.js", () => ({ getCallTracks: store.get, subscribeCallTracks: store.subscribe }));

import { useCallAudio } from "./use-call-audio";

afterEach(cleanup);

describe("useCallAudio", () => {
  it("follows the published tracks and unsubscribes on unmount", () => {
    const { result, unmount } = renderHook(() => useCallAudio());
    expect(result.current).toEqual({ ready: false, caller: null, agent: null });
    const caller = { kind: "audio", id: "caller" };
    const agent = { kind: "audio", id: "agent" };
    act(() => store.set({ ready: true, caller, agent }));
    expect(result.current.ready).toBe(true);
    expect(result.current.caller).toBe(caller);
    expect(result.current.agent).toBe(agent);
    act(() => store.set({ ready: false, caller: null, agent: null }));
    expect(result.current.caller).toBeNull();
    unmount();
    expect(store.count()).toBe(0);
  });
});
