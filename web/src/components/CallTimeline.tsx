import { useMemo } from "react";
import type { JudgeRow, SortedEvent, Summary } from "../../../src/server/live-view-core.js";
import { buildTranscript } from "../../../src/server/live-view-core.js";
import { Badge } from "@/components/ui/badge";
import { replyTimings, stats, toolTimings } from "@/lib/call-metrics";
import { cn } from "@/lib/utils";

interface Mark { ms: number; endMs?: number; label: string; tone: "caller" | "agent" | "ok" | "warn" | "bad" | "muted" | "tool" | "latency"; title: string }

const TONE: Record<Mark["tone"], string> = {
  caller: "bg-sky-500/80",
  agent: "bg-[#1f7c74]/80",
  ok: "bg-emerald-500/80",
  warn: "bg-amber-500/90",
  bad: "bg-red-500/90",
  muted: "bg-muted-foreground/40",
  tool: "bg-violet-500/70",
  latency: "bg-orange-400/70",
};

function sec(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

/** One lane: a label and its marks placed along the call's time. A mark with an end is a bar; without one, a dot. */
function Lane({ name, marks, total, count }: { name: string; marks: Mark[]; total: number; count?: string }) {
  const x = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2" data-lane={name}>
      <div className="truncate text-[11px] text-muted-foreground">{name}{count ? <span className="ml-1 tabular-nums">{count}</span> : null}</div>
      <div className="relative h-4 rounded bg-muted/40">
        {marks.map((m, i) => {
          const start = m.endMs !== undefined ? Math.min(m.ms, m.endMs) : m.ms;
          const end = m.endMs !== undefined ? Math.max(m.ms, m.endMs) : undefined;
          return end !== undefined ? (
            <div key={i} title={m.title} className={cn("absolute top-1 h-2 rounded-sm", TONE[m.tone])} style={{ left: x(start), width: `max(3px, calc(${x(end)} - ${x(start)}))` }} />
          ) : (
            <div key={i} title={m.title} className={cn("absolute top-0.5 size-3 -translate-x-1/2 rounded-full ring-1 ring-background", TONE[m.tone])} style={{ left: x(start) }} />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The call on one time axis: who spoke when, every decision with its confidence, each judge verdict, the tools and
 * how long they took, and the wait before each reply. Hover a mark for its detail. Above it, the call's totals.
 */
export function CallTimeline({ sorted, judged, sum }: { sorted: SortedEvent[]; judged: JudgeRow[]; sum: Summary }) {
  const view = useMemo(() => {
    const lines = buildTranscript(sorted).filter((l) => l.final);
    const last = sorted.length ? sorted[sorted.length - 1].ms : 0;
    const total = Math.max(10_000, last + 1000);
    const caller: Mark[] = lines.filter((l) => l.role === "caller").map((l) => ({ ms: l.ms, endMs: Math.max(l.endMs, l.ms + 600), label: "caller", tone: "caller", title: `${sec(l.ms)} caller: ${l.text}` }));
    const agent: Mark[] = lines.filter((l) => l.role === "agent").map((l) => ({ ms: l.ms, endMs: Math.max(l.endMs, l.ms + 600), label: "agent", tone: "agent", title: `${sec(l.ms)} agent: ${l.text}` }));
    const decisions: Mark[] = sorted.filter((e) => e.type === "decision" && e.data?.kind !== "live_judge").map((e) => {
      const c = Number(e.data?.confidence ?? 0), min = Number(e.data?.minConfidence ?? 0);
      const clarify = e.data?.routed === "clarify";
      return { ms: e.ms, label: "decision", tone: clarify ? "warn" : c >= min ? "ok" : "warn", title: `${sec(e.ms)} decision ${e.data?.answer ?? "?"}: ${Math.round(c * 100)}% (needs ${Math.round(min * 100)}%)${clarify ? ", clarified" : ""}${e.data?.latencyMs ? `, ${e.data.latencyMs} ms` : ""}` };
    });
    const verdicts: Mark[] = judged.map((j) => ({ ms: j.ms, label: j.action, tone: j.allowed ? "ok" : "bad", title: `${sec(j.ms)} judge ${j.action}: ${j.allowed ? "allowed" : "BLOCKED"} (${j.reasonCode})${j.latencyMs !== null ? `, ${j.latencyMs} ms` : ""}` }));
    const tools: Mark[] = toolTimings(sorted).map((t) => ({ ms: t.ms - t.durationMs, endMs: t.ms, label: t.name, tone: t.ok ? "tool" : "bad", title: `${sec(t.ms - t.durationMs)} ${t.name}: ${t.durationMs} ms${t.ok ? "" : ` failed${t.reason ? ` (${t.reason})` : ""}`}` }));
    const replies = replyTimings(sorted);
    const latency: Mark[] = replies.filter((r) => r.latencyMs !== null).map((r) => ({ ms: r.ms - r.latencyMs!, endMs: r.ms, label: "wait", tone: r.latencyMs! > 2500 ? "bad" : r.latencyMs! > 1500 ? "warn" : "latency", title: `${sec(r.ms - r.latencyMs!)} caller stopped; first audio after ${r.latencyMs} ms${r.modelMs !== null ? ` (model ${r.modelMs} ms)` : ""}` }));
    const blocked = judged.filter((j) => !j.allowed).length;
    const clarified = decisions.filter((d) => d.tone === "warn").length;
    const lat = stats(replies.map((r) => r.latencyMs));
    const ticks = Array.from({ length: 6 }, (_, i) => (total * i) / 5);
    return { total, caller, agent, decisions, verdicts, tools, latency, blocked, clarified, lat, ticks, lines: lines.length, ended: sum.ended, disposition: sum.disposition };
  }, [sorted, judged, sum]);

  if (!sorted.length) return <p className="p-2 text-xs text-muted-foreground">The call's timeline appears here: who spoke when, each decision and verdict, the tools, and the wait before each reply.</p>;
  const v = view;
  return (
    <div className="grid gap-2 p-2" id="callTimeline" aria-label="Call timeline">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge variant="outline" className="h-5 px-1.5 font-normal">{sec(v.total - 1000)}{v.ended ? ` · ended${v.disposition ? `: ${v.disposition}` : ""}` : " · live"}</Badge>
        <Badge variant="outline" className="h-5 px-1.5 font-normal">{v.lines} lines</Badge>
        <Badge variant="outline" className={cn("h-5 px-1.5 font-normal", v.clarified && "border-amber-500 text-amber-700")}>{v.decisions.length} decisions{v.clarified ? `, ${v.clarified} clarified` : ""}</Badge>
        <Badge variant="outline" className={cn("h-5 px-1.5 font-normal", v.blocked && "border-red-500 text-red-700")}>{v.verdicts.length} verdicts{v.blocked ? `, ${v.blocked} blocked` : ""}</Badge>
        <Badge variant="outline" className="h-5 px-1.5 font-normal">{v.tools.length} tool calls</Badge>
        {v.lat.count > 0 && <Badge variant="outline" className={cn("h-5 px-1.5 font-normal", (v.lat.median ?? 0) > 1500 && "border-amber-500 text-amber-700")}>wait median {Math.round(v.lat.median!)} ms, max {Math.round(v.lat.max!)} ms</Badge>}
      </div>
      <div className="grid gap-1">
        <Lane name="Caller" marks={v.caller} total={v.total} />
        <Lane name="Agent" marks={v.agent} total={v.total} />
        <Lane name="Wait" marks={v.latency} total={v.total} count={v.latency.length ? String(v.latency.length) : undefined} />
        <Lane name="Decisions" marks={v.decisions} total={v.total} count={v.decisions.length ? String(v.decisions.length) : undefined} />
        <Lane name="Judge" marks={v.verdicts} total={v.total} count={v.verdicts.length ? String(v.verdicts.length) : undefined} />
        <Lane name="Tools" marks={v.tools} total={v.total} count={v.tools.length ? String(v.tools.length) : undefined} />
        <div className="grid grid-cols-[6.5rem_1fr] gap-2">
          <div />
          <div className="relative h-3 text-[10px] text-muted-foreground">
            {v.ticks.map((t, i) => <span key={i} className="absolute -translate-x-1/2" style={{ left: `${(i / 5) * 100}%` }}>{sec(t)}</span>)}
          </div>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">Green: allowed or confident. Amber: clarified, below the needed confidence, or a slow wait. Red: blocked, failed, or a wait over 2.5 seconds. Hover a mark for its words.</p>
    </div>
  );
}
