import * as core from "../../../src/server/live-view-core.js";
import type { JudgeRow, Summary } from "../../../src/server/live-view-core.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const HEADS = ["Action", "Result", "Reason", "Model answer", "Confidence", "Block threshold", "Latency", "Attempts"];

/** Who judged, then every verdict of this call, then the post-call score. Reasons are the judge's own sentences. */
export function JudgeBody({ rows, sum }: { rows: JudgeRow[]; sum: Summary }) {
  const model = rows.find((r) => r.modelId && r.modelId !== "none");
  const intro = model
    ? `Judge in use: decision model ${model.modelId}${model.modelKind ? ` (${model.modelKind})` : ""}, after the code rules. An action goes ahead unless the model says block at or above the block threshold.`
    : rows.length
      ? "Judge in use: the code rules only (no decision model: Azure is not configured, so actions go ahead after the code rules)."
      : "Judge in use: not shown until the first verdict.";
  return (
    <div className="space-y-3 text-sm">
      <p>{intro}</p>
      {rows.length ? (
        <Table>
          <TableHeader><TableRow>{HEADS.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>{r.action}</TableCell>
                <TableCell className={cn(r.allowed ? "text-green-700" : "text-destructive")}>{r.allowed ? "allowed" : "refused"}</TableCell>
                <TableCell className="whitespace-normal">{r.reasonCode}</TableCell>
                <TableCell>{r.answer != null ? r.answer : r.failureReason != null ? `no answer (${r.failureReason})` : "none"}</TableCell>
                <TableCell>{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "none"}</TableCell>
                <TableCell>{r.blockThreshold != null ? `${Math.round(r.blockThreshold * 100)}%` : "none"}</TableCell>
                <TableCell>{r.latencyMs != null ? `${r.latencyMs}ms` : "none"}</TableCell>
                <TableCell className="whitespace-normal">{r.attemptCount != null ? `${r.attemptCount}: ${core.attemptsText(r)}` : "none"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <p className="text-muted-foreground">No verdicts in this call yet.</p>}
      {sum.score ? (
        <div>
          <h4 className="font-semibold">Post-call score: {sum.score.score}</h4>
          {(sum.score.criteria ?? []).map((c: any, i: number) => <div key={i} className="text-muted-foreground">{c.criterion}: {c.score} ({c.note})</div>)}
        </div>
      ) : <p className="text-muted-foreground">{sum.ended ? "No post-call score recorded." : "The post-call score appears when the call ends."}</p>}
    </div>
  );
}
