import { useEffect, useMemo, useState } from "react";
import * as core from "../../../src/server/live-view-core.js";
import type { SortedEvent, TreeJson } from "../../../src/server/live-view-core.js";
import { act, api } from "@/lib/api";
import { liveView, useLiveVersion } from "@/lib/live";

export interface ReplayData { events: any[]; judge?: Record<string, any> | null }

/** The text of the last "agent_context" trace row in view, or null when there is none. */
export function extractContext(sorted: SortedEvent[]): string | null {
  const row = [...sorted].reverse().find((e) => e.type === "tool_call" && e.data.tool === "agent_context");
  const text = (row?.data.result as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : null;
}

/** All state behind the call views: pinned call, tree, replay, and everything derived from the trace. */
export function useCallView() {
  const version = useLiveVersion();
  const [pinned, setPinned] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeJson | null>(null);
  const [data, setData] = useState<ReplayData | null>(null);
  const [step, setStep] = useState(0);
  const [records, setRecords] = useState<any[] | null>(null);
  const [recordId, setRecordId] = useState<string>("");

  useEffect(() => { void act(async () => setTree(await api("/api/tree"))); }, []);

  const sorted = useMemo<SortedEvent[]>(() => {
    if (data) return core.eventsFor(data.events.slice(0, step), null);
    return core.eventsFor(liveView.events.values(), pinned || core.latestCallId(liveView));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, data, step, pinned]);
  const groups = useMemo(() => core.align(sorted), [sorted]);
  const sum = useMemo(() => core.summarize(sorted, data?.judge), [sorted, data]);
  const judged = useMemo(() => core.judgeRows(sorted), [sorted]);
  const visited = useMemo(() => new Set(sorted.filter((e) => e.type === "node_enter").map((e) => e.data.nodeId as string)), [sorted]);
  const stage = useMemo(() => (tree ? core.buildStage(tree, sorted, sum) : null), [tree, sorted, sum]);
  // The agent's context is a trace row of its own: the last one in view wins.
  const context = useMemo(() => extractContext(sorted), [sorted]);
  const taken = stage?.branches.find((b) => b.taken)?.answer ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const callIds = useMemo(() => core.callIdsOf(liveView), [version]);

  /** Loads a record; with all set, the whole call shows at once (the left pane), else stepping starts at the first row (Watch and replay). */
  const load = async (id: string, opts: { all?: boolean } = {}) => {
    setRecordId(id);
    const json = await api<ReplayData>(`/api/records/${encodeURIComponent(id)}`);
    setData(json);
    setStep(opts.all ? json.events.length : 0);
  };
  /** Replays a call from trace rows already in hand (a call the history endpoint knows but that has no record on this machine). */
  const loadEvents = (id: string, events: any[], judge?: Record<string, any> | null, opts: { all?: boolean } = {}) => { setRecordId(id); setData({ events, judge: judge ?? null }); setStep(opts.all ? events.length : 0); };
  const start = () => act(async () => {
    const list = (await api<any[]>("/api/records")).filter((r) => r.kind === "call");
    setRecords(list);
    if (list.length) await load(list[0].recordId);
  });
  const stop = () => { setData(null); setRecords(null); };

  const replay = {
    data, step, records, recordId,
    load, loadEvents, start, stop,
    stepBack: () => setStep((s) => Math.max(0, s - 1)),
    stepNext: () => setStep((s) => Math.min(data?.events.length ?? 0, s + 1)),
    stepAll: () => setStep(data?.events.length ?? 0),
  };

  return { sorted, groups, sum, judged, visited, stage, taken, tree, context, pinned, setPinned, replay, callIds };
}

export type CallViewModel = ReturnType<typeof useCallView>;
