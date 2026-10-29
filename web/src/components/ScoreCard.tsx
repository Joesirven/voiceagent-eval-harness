import type { Summary } from "../../../src/server/live-view-core.js";
import { RatingsBoard } from "@/components/RateCallDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const GRADE_WORDS: Record<string, string> = { strong: "Strong call", fair: "Fair call", weak: "Weak call", unclear: "Could not grade", rules_only: "Scored by the rules only" };

function tone(score: number): string {
  return score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
}

/** The post-call score: one number, the model's grade, and each criterion with a bar and one plain line. */
export function ScoreCard({ sum, onRate, canRate }: { sum: Summary; onRate?: () => void; canRate?: boolean }) {
  const score = sum.score as { score?: number; grade?: string; modelId?: string | null; judgedAt?: string; criteria?: Array<{ criterion: string; score: number; note: string }> } | null;
  const header = (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Your ratings by setup</h3>
      {onRate && <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" id="rateCallOpen" onClick={onRate} disabled={!canRate} title={canRate ? "Rate the call in view" : "Rate a call once it has ended"}>Rate this call</Button>}
    </div>
  );
  if (!score || typeof score.score !== "number") {
    return (
      <div className="grid gap-2 p-2">
        {header}
        <RatingsBoard />
        <p className="text-[11px] text-muted-foreground">{sum.ended ? "The automatic score is on its way…" : "After each call: a pop-up for your rating, and an automatic score from the transcript."}</p>
      </div>
    );
  }
  const criteria = score.criteria ?? [];
  return (
    <div className="grid gap-2 p-2" id="postCallScore" aria-label="Post-call score">
      {header}
      <RatingsBoard />
      <h3 className="mt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Automatic score</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("grid size-12 place-items-center rounded-full text-lg font-semibold text-white tabular-nums", tone(score.score))}>{Math.round(score.score)}</span>
        <div className="grid gap-0.5">
          <span className="text-sm font-semibold">{GRADE_WORDS[score.grade ?? "rules_only"] ?? score.grade}</span>
          <span className="text-[11px] text-muted-foreground">
            {score.modelId && score.grade !== "rules_only" ? `Graded by ${score.modelId} once, after the call; ` : ""}criteria scored from what was said and done.
          </span>
        </div>
      </div>
      <ul className="grid gap-1.5" id="postCallCriteria">
        {criteria.map((c) => (
          <li key={c.criterion} className="grid grid-cols-[14rem_6rem_1fr] items-center gap-2 text-xs" data-criterion={c.criterion}>
            <span className="truncate" title={c.criterion}>{c.criterion}</span>
            <span className="flex items-center gap-1.5">
              <span className="relative h-2 flex-1 rounded bg-muted"><span className={cn("absolute inset-y-0 left-0 rounded", tone(c.score))} style={{ width: `${Math.max(2, Math.min(100, c.score))}%` }} /></span>
              <Badge variant="outline" className="h-4 w-9 justify-center px-1 text-[10px] tabular-nums">{Math.round(c.score)}</Badge>
            </span>
            <span className="min-w-0 truncate text-muted-foreground" title={c.note}>{c.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
