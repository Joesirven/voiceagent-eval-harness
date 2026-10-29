import { StarIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const RATING_KEYS = ["overall", "natural", "understood", "quick", "helpful"] as const;
export type RatingKey = (typeof RATING_KEYS)[number];
export const RATING_LABELS: Record<RatingKey, string> = { overall: "Overall", natural: "Sounded natural", understood: "Understood me", quick: "Quick to answer", helpful: "Helpful" };

/** The setup a rated call ran on; the words that tell one configuration from another. */
export interface RatingSetup {
  engine: string;
  orchestrator?: string;
  voicePath?: string;
  model?: string;
  voice?: string;
  promptSetup?: string;
  decisionTree?: string;
  decisionModule?: string;
  preset?: string;
  /** Azure Voice Live: "step_by_step" or "one_prompt", from the call's open row. */
  flow?: string;
  extra?: Record<string, string | number | boolean>;
}

export interface RatingTarget { callId: string; leadId?: string; setup: RatingSetup }

function Stars({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-0.5" role="radiogroup" aria-label={id}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of 5`} onClick={() => onChange(n)}
          className={cn("rounded p-0.5 transition-colors hover:text-amber-500", n <= value ? "text-amber-500" : "text-muted-foreground/40")}>
          <StarIcon className="size-4" fill={n <= value ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

export function setupWords(s: RatingSetup): string {
  return [s.engine, s.preset ?? s.voicePath, s.model, s.voice, s.promptSetup].filter(Boolean).join(" · ");
}

/**
 * The pop-up after a call: five marks out of five and a note, saved with the
 * setup the call ran on (POST /api/calls/rating), so the ratings say which
 * models and configurations people liked. Skip leaves nothing behind.
 */
export function RateCallDialog({ target, onClose }: { target: RatingTarget | null; onClose: () => void }) {
  const [scores, setScores] = useState<Record<RatingKey, number>>({ overall: 0, natural: 0, understood: 0, quick: 0, helpful: 0 });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (target) { setScores({ overall: 0, natural: 0, understood: 0, quick: 0, helpful: 0 }); setNote(""); } }, [target]);
  const complete = RATING_KEYS.every((k) => scores[k] > 0);
  const save = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch("/api/calls/rating", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: target.callId, leadId: target.leadId, scores, note, setup: target.setup }) });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
      toast.success("Rating saved.", { description: setupWords(target.setup) });
      window.dispatchEvent(new Event("call-rated"));
      onClose();
    } catch (e) {
      toast.error("The rating could not be saved", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent id="rateCallDialog" className="grid-cols-1 gap-3 p-4 sm:max-w-sm">
        <DialogHeader className="gap-0.5">
          <DialogTitle className="text-base">How was that call?</DialogTitle>
          <DialogDescription className="truncate text-xs">{target ? setupWords(target.setup) : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {RATING_KEYS.map((k) => (
            <div key={k} className="flex items-center justify-between gap-3 text-xs">
              <span className={k === "overall" ? "font-medium" : ""}>{RATING_LABELS[k]}</span>
              <Stars id={RATING_LABELS[k]} value={scores[k]} onChange={(v) => setScores((s) => ({ ...s, [k]: v }))} />
            </div>
          ))}
        </div>
        <textarea id="rateCallNote" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="Anything worth remembering about this setup (optional)"
          className="min-w-0 resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        <DialogFooter className="gap-1.5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Skip</Button>
          <Button id="rateCallSave" size="sm" onClick={() => void save()} disabled={!complete || saving}>Save rating</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SetupSummary { key: string; label: string; count: number; overall: number; natural: number; understood: number; quick: number; helpful: number; latestAt: string }

/** Which setups people liked: one row per configuration, best overall first (GET /api/calls/ratings). */
export function RatingsBoard() {
  const [rows, setRows] = useState<SetupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/calls/ratings").then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`); setRows(j.bySetup ?? []); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    load();
    window.addEventListener("call-rated", load);
    return () => window.removeEventListener("call-rated", load);
  }, []);
  if (error) return <p className="text-[11px] text-muted-foreground">Ratings unavailable: {error}</p>;
  if (!rows) return <p className="text-[11px] text-muted-foreground">Loading ratings…</p>;
  if (!rows.length) return <p className="text-[11px] text-muted-foreground">No ratings yet. The pop-up after each call asks for one.</p>;
  return (
    <table className="w-full text-[11px]" id="ratingsBoard" aria-label="Ratings by setup">
      <thead><tr className="text-left text-muted-foreground"><th className="py-0.5 pr-2 font-medium">Setup</th><th className="px-1 text-right font-medium">Calls</th>{RATING_KEYS.map((k) => <th key={k} className="px-1 text-right font-medium" title={RATING_LABELS[k]}>{RATING_LABELS[k].split(" ")[0]}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t">
            <td className="max-w-[18rem] truncate py-0.5 pr-2" title={r.label}>{r.label}</td>
            <td className="px-1 text-right tabular-nums">{r.count}</td>
            {RATING_KEYS.map((k) => <td key={k} className={cn("px-1 text-right tabular-nums", k === "overall" && "font-semibold")}>{r[k].toFixed(1)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
