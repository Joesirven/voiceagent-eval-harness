import { useEffect, useRef, useState } from "react";
import type { StageView } from "../../../src/server/live-view-core.js";
import { cn } from "@/lib/utils";

/** Where the call is in the tree: path so far, the question, and each branch with its score bar. */
export function Stage({ stage, loading }: { stage: StageView | null; loading: boolean }) {
  const last = useRef<string | null>(null);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!stage?.nodeId || stage.nodeId === last.current) return;
    last.current = stage.nodeId;
    setMoved(true);
    const t = setTimeout(() => setMoved(false), 650);
    return () => clearTimeout(t);
  }, [stage?.nodeId]);

  if (loading || !stage) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const modLabel = stage.module ? (String(stage.module).startsWith("jev") ? "Jev (mock)" : stage.module) : null;
  return (
    <div className={cn("rounded-md border p-3 transition-colors", moved && "bg-accent")} aria-live="polite">
      {stage.path.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
          {stage.path.map((p, i) => (
            <span key={i} className={cn(p.nodeId === stage.nodeId && "font-semibold text-primary")}>
              {p.label}{i < stage.path.length - 1 ? " ›" : ""}
            </span>
          ))}
        </div>
      )}
      {stage.label && <h4 className="text-sm font-semibold">{stage.label}</h4>}
      {stage.question && <p className="mb-2 text-xs text-muted-foreground">{stage.question}</p>}
      {modLabel && <p className="mb-1.5 text-[11px] text-muted-foreground">Scores from {modLabel}</p>}
      <ul className="text-xs">
        {!stage.branches.length && (
          <li className="text-muted-foreground">{stage.nodeId ? "No branches from here." : "Waiting for the call to start…"}</li>
        )}
        {stage.branches.map((b, i) => {
          const min = b.minConfidence != null ? Math.round(Number(b.minConfidence) * 100) : null;
          const model = b.modelConfidence != null ? Math.round(Number(b.modelConfidence) * 100) : null;
          const low = model != null && min != null && model < min;
          return (
            <li key={i} className={cn("grid grid-cols-1 gap-1 border-t py-1.5 sm:grid-cols-[minmax(72px,1fr)_minmax(80px,1.2fr)_minmax(100px,1.4fr)] sm:items-center sm:gap-2", b.taken && "font-semibold")}>
              <span>{b.answer}{b.taken ? " ←" : ""}</span>
              <span className="text-[11px] text-muted-foreground">{b.destination}</span>
              {model != null ? (
                <div>
                  <div className="relative h-2 overflow-hidden rounded bg-muted">
                    <div className={cn("absolute inset-y-0 left-0 rounded", low ? "bg-destructive" : "bg-primary")} style={{ width: `${model}%` }} />
                    {min != null && <div className="absolute -inset-y-0.5 w-0.5 bg-foreground" style={{ left: `${min}%` }} />}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">{min != null ? `${model}% · need ${min}%` : `${model}%`}</div>
                </div>
              ) : <span className="text-muted-foreground">—</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

