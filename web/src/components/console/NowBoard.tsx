import type { Summary } from "../../../../src/server/live-view-core.js";

/** The current state of the call: disposition, latest decision, what the agent said next and the judge scoreboard. */
export function NowBoard({ sum }: { sum: Summary }) {
  const d = sum.decision;
  const pct = d ? Math.round(Number(d.confidence) * 100) : 0;
  const min = d ? Math.round(Number(d.minConfidence) * 100) : 0;
  return (
    <div className="space-y-1 text-xs">
      <div>Disposition: {sum.disposition ?? "none yet"}{sum.ended ? " (call ended)" : ""}</div>
      {d && (
        <>
          <div>Latest decision: {d.answer} (module {d.module}, {d.routed})</div>
          <div className="relative h-2 max-w-sm rounded bg-muted">
            <div className={`absolute inset-y-0 left-0 rounded ${pct < min ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
            <div className="absolute -inset-y-0.5 w-0.5 bg-foreground" style={{ left: `${min}%` }} />
          </div>
          <div className="text-muted-foreground">Confidence {pct}% against a minimum of {min}%. {d.reason ?? ""}</div>
        </>
      )}
      <div>Agent said next: {sum.agentSaid ? sum.agentSaid.text : "nothing yet"}</div>
      <div className="pt-1 font-semibold">Judge scoreboard</div>
      {sum.verdicts.map((v, i) => (
        <div key={i} className={v.allowed ? "" : "font-semibold text-destructive"}>{v.allowed ? "allowed" : "BLOCKED"} {v.action}: {v.reason}</div>
      ))}
      {!sum.verdicts.length && <div className="text-muted-foreground">No verdicts yet.</div>}
      {sum.score && (
        <>
          <div className="pt-1">Post-call score: {sum.score.score}</div>
          {(sum.score.criteria ?? []).map((c: any, i: number) => <div key={i} className="text-muted-foreground">{c.criterion}: {c.score} ({c.note})</div>)}
        </>
      )}
    </div>
  );
}
