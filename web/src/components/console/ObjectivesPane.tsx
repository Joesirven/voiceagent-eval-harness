import { CircleCheckIcon, CircleDashedIcon, CircleHelpIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LeadContextJson } from "../../../../src/lead-context/types.js";
import { buildTranscript } from "../../../../src/server/live-view-core.js";
import { ConsolePanel, ConsolePanelContent, ConsolePanelHeader, ConsolePanelTitle } from "@/components/console/panel";
import { CALL_OBJECTIVES, FLOW_STEP_LABELS, FLOW_STEP_ORDER, callStage, objectiveState, stepIndex, type ObjectiveRow } from "@/lib/call-metrics";
import type { CallViewModel } from "@/lib/use-call-view";
import { cn } from "@/lib/utils";

const ICONS = {
  done: { Icon: CircleCheckIcon, className: "text-emerald-600", word: "done" },
  open: { Icon: CircleDashedIcon, className: "text-muted-foreground", word: "not yet" },
  unclear: { Icon: CircleHelpIcon, className: "text-amber-600", word: "unclear" },
} as const;

type Checklist = { confirmed: boolean; rows: LeadContextJson["checklist"] };

/**
 * Where the call is and what the agent still has to do: the stage strip from
 * the tree's flow steps, the objectives the judge checks off in the background,
 * and the quote fields the lead record still needs (read live from the server).
 */
export function ObjectivesPane({ model, leadId: leadInView }: { model: Pick<CallViewModel, "sorted" | "replay">; leadId?: string }) {
  const { sorted, replay } = model;
  // The lead the page has in view, else the lead of the call in view (the Console tab passes none).
  const leadId = leadInView ?? (typeof sorted[0]?.leadId === "string" ? sorted[0].leadId : undefined);
  const stage = useMemo(() => callStage(sorted), [sorted]);
  const state = useMemo(() => objectiveState(sorted), [sorted]);
  const rows: ObjectiveRow[] = state?.objectives.length ? state.objectives : CALL_OBJECTIVES.map((o) => ({ id: o.id, label: o.label, step: o.step, status: "open" as const, confidence: null }));
  const current = stepIndex(stage.step);
  const replaying = replay.data !== null;
  const lineCount = useMemo(() => buildTranscript(sorted).filter((l) => l.final).length, [sorted]);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [checklistError, setChecklistError] = useState<string | null>(null);

  // The checklist is the live server's view of the lead record (the lead in view, else the last call's lead), so it is read again after each line and never in replay.
  useEffect(() => {
    if (replaying) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(leadId ? `/api/lead-context?leadId=${encodeURIComponent(leadId)}` : "/api/lead-context");
        const json = await res.json();
        if (cancelled) return;
        if (res.status === 404 && json?.error === "no_lead_known") { setChecklist(null); setChecklistError("no_lead"); return; }
        if (!res.ok || !json?.json?.checklist) throw new Error(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
        setChecklist({ confirmed: Boolean(json.json.confirmed), rows: json.json.checklist });
        setChecklistError(null);
      } catch (e) {
        if (!cancelled) setChecklistError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [lineCount, replaying, leadId]);

  const needed = checklist?.rows.filter((r) => r.status === "still_needed") ?? [];
  const known = checklist?.rows.filter((r) => r.status === "known") ?? [];
  const done = rows.filter((r) => r.status === "done").length;

  return (
    <ConsolePanel aria-label="Call stage and objectives" id="objectivesPane">
      <ConsolePanelHeader>
        <ConsolePanelTitle>Call stage and objectives</ConsolePanelTitle>
      </ConsolePanelHeader>
      <ConsolePanelContent className="grid content-start gap-4">
        <section aria-label="Call stage" className="grid gap-1.5">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Stage</h3>
          <ol className="flex flex-wrap gap-1" id="stageStrip">
            {FLOW_STEP_ORDER.map((step, i) => (
              <li
                key={step}
                data-step={step}
                data-state={i === current ? "current" : i < current ? "past" : "upcoming"}
                aria-current={i === current ? "step" : undefined}
                className={cn("rounded-full border px-2 py-0.5 text-[11px]", i === current ? "border-primary bg-primary text-primary-foreground" : i < current ? "bg-muted text-muted-foreground" : "text-muted-foreground")}
              >
                {FLOW_STEP_LABELS[step]}
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground" id="stageNote">
            {stage.ended
              ? `Call ended${stage.disposition ? `: ${stage.disposition}` : ""}.`
              : stage.step
                ? stage.fromObjectives
                  ? `${FLOW_STEP_LABELS[stage.step]} · stage from the objectives (no decision tree on this call)`
                  : `${FLOW_STEP_LABELS[stage.step]}${stage.nodeLabel ? ` · ${stage.nodeLabel}` : ""}`
                : "The stage appears once the call enters the tree."}
          </p>
        </section>

        <section aria-label="Objectives" className="grid gap-1.5">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Objectives · {done} of {rows.length} done</h3>
          <ul className="grid gap-1" id="objectivesList">
            {rows.map((r) => {
              const { Icon, className, word } = ICONS[r.status];
              return (
                <li key={r.id} data-objective={r.id} data-status={r.status} className="flex items-center gap-2 text-xs">
                  <Icon className={cn("size-4 shrink-0", className)} aria-label={word} />
                  <span className={cn("min-w-0 flex-1", r.status === "done" && "line-through decoration-muted-foreground/60")}>{r.label}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{FLOW_STEP_LABELS[r.step]}{r.confidence !== null ? ` · ${Math.round(r.confidence * 100)}%` : ""}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground" id="objectivesNote">
            {!state
              ? "Not judged yet: the decision model checks the objectives in the background after each line."
              : !state.ok
                ? state.reason === "no_decision_model" ? "No decision model is configured, so the objectives stay unjudged." : `The last check failed${state.reason ? ` (${state.reason})` : ""}.`
                : `Judged by ${state.modelId ?? "the decision model"} at ${(state.ms / 1000).toFixed(1)}s, ${state.asked} asked${state.trigger === "call_end" ? ", final" : ""}.`}
          </p>
        </section>

        <section aria-label="Information still needed" className="grid gap-1.5">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Still needed for a quote</h3>
          {replaying
            ? <p className="text-xs text-muted-foreground">Read live from the lead record; not available in replay.</p>
            : checklistError === "no_lead"
              ? <p className="text-xs text-muted-foreground">Pick a lead on the left or in the call bar; the fields a quote still needs show here once one is known.</p>
            : checklistError
              ? <p className="text-xs text-destructive">Lead context unavailable: {checklistError}</p>
              : !checklist
                ? <p className="text-xs text-muted-foreground">Loading…</p>
                : (
                  <>
                    {needed.length === 0
                      ? <p className="text-xs text-muted-foreground">Every quote field is on file.</p>
                      : <ul className="flex flex-wrap gap-1" id="stillNeeded">{needed.map((r) => <li key={r.field} className="rounded border px-1.5 py-0.5 text-[11px]">{r.label}</li>)}</ul>}
                    {known.length > 0 && (
                      <p className="text-[11px] text-muted-foreground" id="knownFields">
                        On file: {known.map((r) => r.label).join(", ")}{checklist.confirmed ? "" : " (values withheld until the named person is confirmed)"}.
                      </p>
                    )}
                  </>
                )}
        </section>
      </ConsolePanelContent>
    </ConsolePanel>
  );
}
