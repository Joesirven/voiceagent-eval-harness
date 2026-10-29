import type { MetricPoint, MetricSeries } from "@/hooks/use-pipecat-metrics";
import { buildTranscript } from "../../../src/server/live-view-core.js";
import type { SortedEvent } from "../../../src/server/live-view-core.js";

/** Series labels. The words in parentheses are what tells a reader whether the number was waited for. */
export const SIMULATED_SUFFIX = "(simulated)";
export const MEASURED_SUFFIX = "(measured)";
export const DECISION_TREE_LABEL = "Decision tree";
export const LIVE_JUDGE_LABEL = "Live judge";
export const AGENT_CHARACTERS_LABEL = "Agent speech characters (Deepgram)";

/**
 * Whether a decision module reports a simulated time. The built-in keyword
 * modules and every mock model carry an identifier ending in "-mock", plus
 * the keyword fallback used when no credential exists. Their time is a
 * configured number that is never slept. Any other module is a model that was
 * actually asked, and its time was measured.
 */
export function isSimulatedDecisionModule(moduleId: unknown): boolean {
  const id = String(moduleId ?? "");
  return /-mock$/.test(id) || id === "keyword-no-credential";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when the session open trace names the Deepgram voice path. */
export function isDeepgramPath(sorted: SortedEvent[]): boolean {
  return sorted.some((e) => {
    if (e.type !== "tool_call" || e.data?.tool !== "voice_session_open") return false;
    const inputs = e.data.inputs as { provider?: unknown } | undefined;
    return inputs?.provider === "deepgram";
  });
}

/** Whether any series in the list is a simulated one, for the caption. */
export function hasSimulatedSeries(series: MetricSeries[]): boolean {
  return series.some((s) => s.processor.endsWith(SIMULATED_SUFFIX));
}

/**
 * Turns the trace into the kit's metric series. Values for the processing
 * category are in seconds, as the kit multiplies them by 1000 for display.
 *
 * - Decision tree time comes from decision events (not the live judge ones)
 *   and the live judge time from the live judge's own decision events. Each is
 *   split into a simulated series and a measured series by who reported it.
 * - Agent characters are counted only when the session open names the
 *   Deepgram path, from the agent's final transcript lines, as a running total.
 * - Token counts are left out so the token tiles stay hidden.
 * - Time to first audio is left out: no event marks when the agent's audio
 *   starts. An agent line event is recorded when the line is reported, so the
 *   gap from the caller's line would not be an honest first audio time.
 */
export function traceToMetricSeries(sorted: SortedEvent[]): MetricSeries[] {
  const buckets = new Map<string, MetricSeries>();
  const add = (category: MetricSeries["category"], processor: string, time: number, value: number) => {
    const key = `${category}:${processor}`;
    const point: MetricPoint = { time, value };
    const existing = buckets.get(key);
    if (existing) {
      existing.points.push(point);
      existing.latest = value;
    } else buckets.set(key, { category, processor, latest: value, points: [point] });
  };
  const timeOf = (e: SortedEvent) => {
    const at = Date.parse(e.at);
    return Number.isFinite(at) ? at : e.ms;
  };

  for (const e of sorted) {
    if (e.type !== "decision") continue;
    const d = e.data ?? {};
    const ms = finiteNumber(d.latencyMs);
    if (ms === null) continue;
    if (d.kind === "live_judge") {
      // No decision model asked (rules only): there is no time to report.
      if (d.modelId === "none" || !(finiteNumber(d.attemptCount) ?? 0)) continue;
      if (d.modelKind !== "mock" && d.modelKind !== "real") continue;
      const suffix = d.modelKind === "mock" ? SIMULATED_SUFFIX : MEASURED_SUFFIX;
      add("processing", `${LIVE_JUDGE_LABEL} ${suffix}`, timeOf(e), ms / 1000);
    } else {
      if (d.module === "none") continue;
      const suffix = isSimulatedDecisionModule(d.module) ? SIMULATED_SUFFIX : MEASURED_SUFFIX;
      add("processing", `${DECISION_TREE_LABEL} ${suffix}`, timeOf(e), ms / 1000);
    }
  }

  if (isDeepgramPath(sorted)) {
    const first = sorted[0];
    const base = first ? timeOf(first) - first.ms : 0;
    let total = 0;
    for (const line of buildTranscript(sorted)) {
      if (line.role !== "agent" || !line.final) continue;
      total += line.text.length;
      add("characters", AGENT_CHARACTERS_LABEL, base + line.ms, total);
    }
  }

  return [...buckets.values()].sort((a, b) => a.category.localeCompare(b.category) || a.processor.localeCompare(b.processor));
}
