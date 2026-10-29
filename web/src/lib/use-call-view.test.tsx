// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/setup";

const tree = { start: "a", nodes: [{ id: "a", label: "A", edges: [] }], dispositions: [] };
const storedEvents = [1, 2, 3].map((n) => ({ seq: 900 + n, recordSeq: n, recordId: "stored-1", callId: "stored-call", leadId: "lead-2", channel: "call", type: "transcript_final", at: "2026-10-19T10:00:00.000Z", atMs: n * 100, data: { role: "caller", text: `line ${n}`, turnIndex: n } }));
const fetchMock = vi.fn(async (path: string) => {
  const json = path === "/api/tree" ? tree
    : path === "/api/records" ? [{ recordId: "stored-1", kind: "call", leadId: "lead-2", direction: "inbound", openedAt: "2026-10-19T10:00:00.000Z" }, { recordId: "other", kind: "scenario" }]
    : path === "/api/records/stored-1" ? { events: storedEvents, judge: null }
    : {};
  return { ok: true, json: async () => json };
});
vi.stubGlobal("fetch", fetchMock);

import { extractContext, useCallView } from "./use-call-view";
import { ingestFrame } from "@/lib/live";

afterEach(cleanup);

const contextRow = (seq: number, text: unknown, atMs: number) =>
  ({ seq, recordSeq: seq, recordId: "r", callId: "hook-call", leadId: "lead-1", channel: "call", type: "tool_call", at: "2026-10-19T10:00:00.000Z", atMs, data: { tool: "agent_context", inputs: {}, result: { text }, success: true } }) as any;

describe("extracting the agent context", () => {
  it("takes the text of the last agent_context row and ignores other rows", () => {
    const sorted = [contextRow(1, "first", 0), contextRow(2, "second", 10), { ...contextRow(3, "not it", 20), data: { tool: "other", result: { text: "not it" } } }] as any;
    expect(extractContext(sorted)).toBe("second");
  });
  it("is null when there is no context row or its text is not a string", () => {
    expect(extractContext([])).toBeNull();
    expect(extractContext([contextRow(1, 42, 0)] as any)).toBeNull();
  });
});

describe("useCallView", () => {
  it("loads the tree and follows live events, including the agent context", async () => {
    const { result } = renderHook(() => useCallView());
    await waitFor(() => expect(result.current.tree).not.toBeNull());
    act(() => ingestFrame(JSON.stringify({ event: contextRow(10, "STANDING RULES", 0) })));
    expect(result.current.context).toBe("STANDING RULES");
    expect(result.current.callIds).toContain("hook-call");
  });

  it("starts a replay of the newest stored call, steps through it, and stops", async () => {
    const { result } = renderHook(() => useCallView());
    await act(async () => { await result.current.replay.start(); });
    expect(result.current.replay.records).toHaveLength(1);
    expect(result.current.replay.recordId).toBe("stored-1");
    expect(result.current.replay.data?.events).toHaveLength(3);
    expect(result.current.sorted).toHaveLength(0);

    act(() => result.current.replay.stepNext());
    act(() => result.current.replay.stepNext());
    expect(result.current.replay.step).toBe(2);
    expect(result.current.sorted).toHaveLength(2);
    act(() => result.current.replay.stepBack());
    expect(result.current.sorted).toHaveLength(1);
    act(() => result.current.replay.stepAll());
    expect(result.current.sorted).toHaveLength(3);
    act(() => result.current.replay.stepNext());
    expect(result.current.replay.step).toBe(3);

    act(() => result.current.replay.stop());
    expect(result.current.replay.data).toBeNull();
    expect(result.current.replay.records).toBeNull();
    expect(result.current.sorted.every((e) => e.callId !== "stored-call")).toBe(true);
  });

  it("pins a call to watch", async () => {
    const { result } = renderHook(() => useCallView());
    act(() => ingestFrame(JSON.stringify({ event: contextRow(20, "PINNED CONTEXT", 0) })));
    act(() => result.current.setPinned("hook-call"));
    expect(result.current.pinned).toBe("hook-call");
    expect(result.current.context).toBe("PINNED CONTEXT");
  });
});
