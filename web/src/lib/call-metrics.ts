/**
 * Running metrics and the call's objectives, read from the trace alone so
 * they work live and in replay.
 *
 * - Reply timings come from the `reply_timing` row the direct Azure path
 *   writes once per caller line, and `voice_live_reply_timing` on the Voice
 *   Live path (same fields). On the Deepgram path the sidecar reports per-stage
 *   times (`voice_metrics`); the caller-to-first-audio figure is then a sum of
 *   stage times and is marked estimated.
 * - Tool call times are the durations of the flow tools the thinker dispatched.
 * - Interim responses: short agent lines spoken while a flow tool was still
 *   running. No path marks them explicitly yet; an `interim_response` row is
 *   read as one when a path adds it.
 * - The objectives are the latest `objective_check` row for the call, written in
 *   the background by the objectives judge.
 */

import type { FlowStep } from "../../../src/decision-tree/types.js";
import { FLOW_STEP_ORDER, inferFlowStep, type ObjectiveStatus } from "../../../src/judging/objective-definitions.js";
import { buildTranscript } from "../../../src/server/live-view-core.js";
import type { SortedEvent } from "../../../src/server/live-view-core.js";

export { FLOW_STEP_LABELS, FLOW_STEP_ORDER, CALL_OBJECTIVES } from "../../../src/judging/objective-definitions.js";

const REPLY_TIMING = /reply_timing$/;
/** Tool rows that are a flow tool the agent waited on. */
const FLOW_TOOL_ROWS = new Set(["voice_live_tool_call", "thinker_tool_call", "flow_tool_call"]);
/** Agent lines recorded this long after a tool finished still count as said while it ran (the line closes one turn gap after its last word). */
const INTERIM_TAIL_MS = 2000;
const INTERIM_MAX_CHARS = 90;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inputs(e: SortedEvent): Record<string, unknown> {
  const i = e.data?.inputs;
  return i && typeof i === "object" ? (i as Record<string, unknown>) : {};
}

/** Epoch milliseconds for a chart point; the record clock when the event's time does not parse. */
export function epochOf(e: SortedEvent): number {
  const at = Date.parse(e.at);
  return Number.isFinite(at) ? at : e.ms;
}

export interface ReplyTiming {
  ms: number;
  at: number;
  source: string;
  /** Caller stopped speaking to the agent's first audio. */
  latencyMs: number | null;
  /** The speaking model's own time: its response request (or the steer carrying the guidance) to its first audio. */
  modelMs: number | null;
  /** The decision step that chose what to say. */
  decisionMs: number | null;
  /** True when the latency is a sum of stage times rather than one measured gap. */
  estimated: boolean;
}

export function replyTimings(sorted: SortedEvent[]): ReplyTiming[] {
  const out: ReplyTiming[] = [];
  const deepgramTurns = new Map<number, { ms: number; at: number; stt: number | null; reply: number | null; tts: number | null }>();
  for (const e of sorted) {
    if (e.type !== "tool_call") continue;
    const tool = String(e.data?.tool ?? "");
    if (REPLY_TIMING.test(tool) && e.data?.success !== false) {
      const i = inputs(e);
      out.push({
        ms: e.ms,
        at: epochOf(e),
        source: typeof i.source === "string" ? i.source : tool.replace(/_?reply_timing$/, "") || "voice",
        latencyMs: num(i.callerFinalToFirstAudioMs) ?? num(e.data?.durationMs),
        modelMs: num(i.createToFirstAudioMs),
        decisionMs: num(i.decisionMs),
        estimated: false,
      });
    } else if (tool === "voice_metrics") {
      const i = inputs(e);
      const turn = num(i.turn);
      const ms = num(i.milliseconds);
      if (turn === null || ms === null || i.kind !== "time_to_first_byte") continue;
      const row = deepgramTurns.get(turn) ?? { ms: e.ms, at: epochOf(e), stt: null, reply: null, tts: null };
      if (i.stage === "speech_to_text") row.stt = ms;
      else if (i.stage === "reply") row.reply = ms;
      else if (i.stage === "text_to_speech") row.tts = ms;
      row.ms = Math.max(row.ms, e.ms);
      row.at = Math.max(row.at, epochOf(e));
      deepgramTurns.set(turn, row);
    }
  }
  for (const row of deepgramTurns.values()) {
    if (row.reply === null) continue;
    out.push({ ms: row.ms, at: row.at, source: "deepgram", latencyMs: (row.stt ?? 0) + row.reply + (row.tts ?? 0), modelMs: row.reply, decisionMs: null, estimated: true });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export interface ToolTiming {
  ms: number;
  at: number;
  name: string;
  durationMs: number;
  ok: boolean;
  reason: string | null;
  /** "pipecat" for the local engine's flow tools, which the interim heuristic treats without a tail. */
  engine: "pipecat" | null;
}

export function toolTimings(sorted: SortedEvent[]): ToolTiming[] {
  const out: ToolTiming[] = [];
  for (const e of sorted) {
    if (e.type !== "tool_call") continue;
    const tool = String(e.data?.tool ?? "");
    if (!FLOW_TOOL_ROWS.has(tool)) continue;
    const durationMs = num(e.data?.durationMs);
    if (durationMs === null) continue;
    const i = inputs(e);
    out.push({ ms: e.ms, at: epochOf(e), name: typeof i.name === "string" ? i.name : tool, durationMs, ok: e.data?.success !== false, reason: typeof e.data?.reason === "string" ? e.data.reason : null, engine: i.engine === "pipecat" ? "pipecat" : null });
  }
  return out;
}

export interface InterimResponse {
  ms: number;
  text: string;
  /** The tool that was running, when known. */
  tool: string | null;
  explicit: boolean;
}

export function interimResponses(sorted: SortedEvent[]): InterimResponse[] {
  const out: InterimResponse[] = [];
  const seen = new Set<string>();
  for (const e of sorted) {
    if (e.type !== "tool_call" || e.data?.tool !== "interim_response") continue;
    const i = inputs(e);
    const text = typeof i.text === "string" ? i.text : "";
    out.push({ ms: e.ms, text, tool: typeof i.tool === "string" ? i.tool : null, explicit: true });
    seen.add(`${e.ms}:${text}`);
  }
  // A filler is said while a tool runs: a row with no measured duration (a tool start) opens no window. The tail after a tool
  // allows for a late transcript of the filler; the Pipecat engine's tools get none, since its ordinary reply follows a save within that tail.
  const windows = toolTimings(sorted).filter((t) => t.durationMs > 0).map((t) => ({ start: t.ms - t.durationMs, end: t.ms + (t.engine === "pipecat" ? 0 : INTERIM_TAIL_MS), name: t.name }));
  if (windows.length) {
    for (const line of buildTranscript(sorted)) {
      if (line.role !== "agent" || !line.final || line.text.length > INTERIM_MAX_CHARS) continue;
      const w = windows.find((x) => line.ms >= x.start && line.ms <= x.end);
      if (!w || seen.has(`${line.ms}:${line.text}`)) continue;
      out.push({ ms: line.ms, text: line.text, tool: w.name, explicit: false });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export interface Stats {
  latest: number | null;
  median: number | null;
  max: number | null;
  count: number;
}

export function stats(values: Array<number | null>): Stats {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return { latest: null, median: null, max: null, count: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { latest: nums[nums.length - 1], median, max: sorted[sorted.length - 1], count: nums.length };
}

export interface CallStage {
  step: FlowStep | null;
  /** The label of the newest node entered, for a step the tree does not name. */
  nodeLabel: string | null;
  ended: boolean;
  disposition: string | null;
  /** True when no tree node arrived after the voice session opened, so the step is the first objective not yet done. */
  fromObjectives: boolean;
}

/** The step of the first objective not yet done in the newest objective check; the last objective's step when all are done. */
export function stepFromObjectives(sorted: SortedEvent[]): FlowStep | null {
  const state = objectiveState(sorted);
  if (!state || state.objectives.length === 0) return null;
  const open = state.objectives.find((o) => o.status !== "done");
  return (open ?? state.objectives[state.objectives.length - 1]!).step;
}

export function callStage(sorted: SortedEvent[]): CallStage {
  let step: FlowStep | null = null;
  let nodeLabel: string | null = null;
  let ended = false;
  let disposition: string | null = null;
  let nodeAfterOpen = false;
  let opened = false;
  for (const e of sorted) {
    if (e.type === "node_enter") {
      const found = (e.flowStep as FlowStep | undefined) ?? inferFlowStep(typeof e.data?.nodeId === "string" ? e.data.nodeId : null);
      if (found) step = found;
      nodeLabel = typeof e.data?.label === "string" ? e.data.label : nodeLabel;
      if (opened) nodeAfterOpen = true;
    } else if (e.type === "tool_call" && e.data?.tool === "voice_session_open") opened = true;
    else if (e.type === "disposition") disposition = typeof e.data?.value === "string" ? e.data.value : disposition;
    else if (e.type === "call_outcome") ended = true;
  }
  // With the decision tree off (Voice Live runs the call itself) the tree stops after its first node: the objectives say where the call is.
  if (opened && !nodeAfterOpen) {
    const fallback = stepFromObjectives(sorted);
    if (fallback) return { step: fallback, nodeLabel: null, ended, disposition, fromObjectives: true };
  }
  return { step, nodeLabel, ended, disposition, fromObjectives: false };
}

/** Index of a step in the drawn order; -1 when unknown. */
export function stepIndex(step: FlowStep | null): number {
  return step ? FLOW_STEP_ORDER.indexOf(step) : -1;
}

export interface ObjectiveRow {
  id: string;
  label: string;
  step: FlowStep;
  status: ObjectiveStatus;
  confidence: number | null;
}

export interface ObjectiveState {
  ms: number;
  objectives: ObjectiveRow[];
  modelId: string | null;
  asked: number;
  ok: boolean;
  reason: string | null;
  trigger: string | null;
}

/** The latest objective check for the call, or null before the judge has written one. */
export function objectiveState(sorted: SortedEvent[]): ObjectiveState | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    if (e.type !== "tool_call" || e.data?.tool !== "objective_check") continue;
    const in_ = inputs(e);
    const raw = Array.isArray(in_.objectives) ? (in_.objectives as Array<Record<string, unknown>>) : [];
    const objectives: ObjectiveRow[] = raw
      .filter((r) => typeof r.id === "string" && typeof r.label === "string")
      .map((r) => ({
        id: String(r.id),
        label: String(r.label),
        step: (typeof r.step === "string" ? r.step : "discovery") as FlowStep,
        status: r.status === "done" || r.status === "unclear" ? r.status : "open",
        confidence: num(r.confidence),
      }));
    return {
      ms: e.ms,
      objectives,
      modelId: typeof in_.modelId === "string" ? in_.modelId : null,
      asked: num(in_.asked) ?? 0,
      ok: e.data?.success !== false,
      reason: typeof e.data?.reason === "string" ? e.data.reason : null,
      trigger: typeof in_.trigger === "string" ? in_.trigger : null,
    };
  }
  return null;
}
