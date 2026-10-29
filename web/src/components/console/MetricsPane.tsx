import { HistoryIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ConsolePanel, ConsolePanelActions, ConsolePanelContent, ConsolePanelHeader, ConsolePanelTitle } from "@/components/console/panel";
import { WatchReplayControls } from "@/components/console/WatchReplayControls";
import { Metric } from "@/components/pipecat/metric";
import { MetricSeriesChart } from "@/components/pipecat/metrics/chart";
import { Button } from "@/components/ui/button";
import type { MetricSeries } from "@/hooks/use-pipecat-metrics";
import { interimResponses, replyTimings, stats, toolTimings, type Stats } from "@/lib/call-metrics";
import type { CallViewModel } from "@/lib/use-call-view";

const ms = (v: number) => Math.round(v).toLocaleString();
const seconds = (v: number) => `${(v / 1000).toFixed(1)}s`;

/** One tile: the latest value, with the median and the worst over the call underneath. */
function Tile({ id, label, s, note }: { id: string; label: string; s: Stats; note?: string }) {
  return (
    <div className="grid gap-0.5" data-testid={id}>
      <Metric label={label} value={s.latest} unit="ms" format={ms} empty="–" />
      <span className="text-[11px] text-muted-foreground">
        {s.count ? `median ${ms(s.median!)} · max ${ms(s.max!)} · ${s.count} ${s.count === 1 ? "sample" : "samples"}` : (note ?? "no samples yet")}
      </span>
    </div>
  );
}

/**
 * Running metrics of the call in view: how long the caller waited for the
 * agent's first audio, the speaking model's own response time, the time
 * each flow tool took, and the interim responses said while a tool ran.
 * Watch and replay stay a mode of this column.
 */
export function MetricsPane({ model }: { model: CallViewModel }) {
  const [watching, setWatching] = useState(false);
  const { sorted, replay } = model;
  const replies = useMemo(() => replyTimings(sorted), [sorted]);
  const tools = useMemo(() => toolTimings(sorted), [sorted]);
  const interim = useMemo(() => interimResponses(sorted), [sorted]);
  const latency = useMemo(() => stats(replies.map((r) => r.latencyMs)), [replies]);
  const response = useMemo(() => stats(replies.map((r) => r.modelMs)), [replies]);
  const decision = useMemo(() => stats(replies.map((r) => r.decisionMs)), [replies]);
  const toolTime = useMemo(() => stats(tools.map((t) => t.durationMs)), [tools]);
  const estimated = replies.some((r) => r.estimated);
  const series = useMemo<MetricSeries[]>(() => {
    const out: MetricSeries[] = [];
    const lat = replies.filter((r) => r.latencyMs !== null).map((r) => ({ time: r.at, value: r.latencyMs! }));
    if (lat.length) out.push({ category: "ttfa", processor: "Latency", latest: lat[lat.length - 1].value, points: lat });
    const res = replies.filter((r) => r.modelMs !== null).map((r) => ({ time: r.at, value: r.modelMs! }));
    if (res.length) out.push({ category: "ttfb", processor: "Agent response", latest: res[res.length - 1].value, points: res });
    return out;
  }, [replies]);

  return (
    <ConsolePanel aria-label="Running metrics" id="metricsPane">
      <ConsolePanelHeader>
        <ConsolePanelTitle>{watching ? "Watch and replay" : "Running metrics"}{replay.data ? " (replay)" : ""}</ConsolePanelTitle>
        <ConsolePanelActions>
          <Button variant={watching ? "secondary" : "ghost"} size="icon" className="size-6" id="watchToggle" aria-label="Watch and replay" aria-pressed={watching} title="Watch another call or replay a stored one" onClick={() => setWatching((v) => !v)}><HistoryIcon /></Button>
        </ConsolePanelActions>
      </ConsolePanelHeader>
      <ConsolePanelContent className="grid content-start gap-4">
        {watching ? <WatchReplayControls model={model} /> : (
          <>
            <div className="grid grid-cols-2 gap-3" data-testid="metric-tiles">
              <Tile id="metric-latency" label="Latency (caller stop to first audio)" s={latency} note="after the first caller line" />
              <Tile id="metric-response" label="Agent response time" s={response} note="after the first reply" />
              <Tile id="metric-tools" label="Tool call response time" s={toolTime} note="no tool calls yet" />
              <div className="grid gap-0.5" data-testid="metric-interim">
                <Metric label="Interim responses" value={interim.length} format={(v) => String(v)} />
                <span className="truncate text-[11px] text-muted-foreground" title={interim.length ? interim[interim.length - 1].text : undefined}>
                  {interim.length ? `last: “${interim[interim.length - 1].text}”` : "none said while a tool ran"}
                </span>
              </div>
            </div>
            {decision.count > 0 && (
              <p className="text-[11px] text-muted-foreground" data-testid="metric-decision">
                Decision step: latest {ms(decision.latest!)} ms, median {ms(decision.median!)} ms over {decision.count}.
              </p>
            )}
            {estimated && <p className="text-[11px] text-muted-foreground">On the Deepgram path the latency is the sum of the stage times the sidecar reports, not one measured gap.</p>}
            {series.length > 0 && (
              <section aria-label="Reply times over the call" className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Over the call (ms)</h3>
                <MetricSeriesChart series={series} scale={1} />
              </section>
            )}
            <section aria-label="Tool calls" className="grid gap-1">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Tool calls</h3>
              {tools.length === 0
                ? <p className="text-xs text-muted-foreground">Appears when the agent runs a flow tool.</p>
                : (
                  <ol className="grid gap-0.5 font-mono text-[11px]" id="toolCalls">
                    {tools.slice(-6).map((t, i) => (
                      <li key={`${t.ms}-${i}`} className={t.ok ? "" : "text-destructive"}>
                        <span className="text-muted-foreground">{seconds(t.ms)}</span> {t.name} {ms(t.durationMs)} ms{t.ok ? "" : ` failed${t.reason ? ` (${t.reason})` : ""}`}
                      </li>
                    ))}
                  </ol>
                )}
            </section>
            {interim.length > 0 && (
              <section aria-label="Interim responses" className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Interim responses</h3>
                <ol className="grid gap-0.5 text-[11px]" id="interimResponses">
                  {interim.slice(-4).map((r, i) => (
                    <li key={`${r.ms}-${i}`}><span className="font-mono text-muted-foreground">{seconds(r.ms)}</span> “{r.text}”{r.tool ? <span className="text-muted-foreground"> while {r.tool} ran</span> : null}</li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </ConsolePanelContent>
    </ConsolePanel>
  );
}
