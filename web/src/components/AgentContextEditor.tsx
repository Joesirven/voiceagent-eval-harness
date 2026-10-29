import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { act, api, apiErrorMessage } from "@/lib/api";

/** GET, POST and DELETE /api/setups/agent-context (src/setups/agent-context.ts). */
interface AgentContextView {
  leadId: string | null;
  leadLabel: string | null;
  direction: "inbound" | "outbound";
  setupId: string;
  standingRules: string;
  override: { text: string; setAt: string } | null;
  leadBlock: string;
  nextCallText: string;
  maxChars: number;
  note?: string;
}

/** The lead and direction chosen in the call bar, as the dialog reads them, so the preview is for the call about to start. */
function contextQuery(): string {
  const lead = (document.getElementById("playLead") as HTMLSelectElement | null)?.value;
  const dir = (document.getElementById("playDir") as HTMLInputElement | null)?.value;
  const q = new URLSearchParams();
  if (lead) q.set("leadId", lead);
  if (dir) q.set("direction", dir);
  const text = q.toString();
  return text ? `?${text}` : "";
}

async function del(path: string): Promise<AgentContextView> {
  const res = await fetch(path, { method: "DELETE" });
  const json = await res.json();
  if (!res.ok) throw new Error(apiErrorMessage(json, res));
  return json as AgentContextView;
}

/**
 * What the agent is given on the next call, editable before Go: the standing
 * rules (the user's text replaces them for every call until reset) and, read
 * only, the lead block the call appends (facts, what the call needs, the
 * objectives). Loads and saves itself, so it mounts anywhere without props.
 */
export function AgentContextEditor() {
  const [view, setView] = useState<AgentContextView | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => act(async () => {
    const v = await api<AgentContextView>(`/api/setups/agent-context${contextQuery()}`);
    setView(v);
    setDraft(v.override?.text ?? v.standingRules);
  }), []);
  useEffect(() => { void load(); }, [load]);
  if (!view) return <p className="text-xs text-muted-foreground">Loading the agent's context…</p>;

  const current = view.override?.text ?? view.standingRules;
  const dirty = draft.trim() !== current.trim();
  const save = () => act(async () => {
    setSaving(true);
    try {
      const v = await api<AgentContextView>(`/api/setups/agent-context${contextQuery()}`, { text: draft });
      setView(v);
      setDraft(v.override?.text ?? v.standingRules);
      toast.success("Standing rules saved for the next calls.");
    } finally { setSaving(false); }
  });
  const reset = () => act(async () => {
    setSaving(true);
    try {
      const v = await del(`/api/setups/agent-context${contextQuery()}`);
      setView(v);
      setDraft(v.standingRules);
      toast.success(`Back to the ${v.setupId} prompt's own standing rules.`);
    } finally { setSaving(false); }
  });

  return (
    <section id="agentContext" aria-label="Context sent to the agent" className="grid min-w-0 grid-cols-1 gap-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Standing rules the agent gets</span>
        <span id="agentContextStatus" className="text-[11px] text-muted-foreground">
          {view.override ? `your text, saved ${view.override.setAt.slice(11, 16)} UTC` : `from the ${view.setupId} prompt`}
        </span>
      </div>
      <textarea
        id="agentContextText"
        aria-label="Standing rules for the next call"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={8}
        maxLength={view.maxChars}
        spellCheck={false}
        className="h-40 min-w-0 resize-none rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-1.5">
        <Button id="agentContextSave" size="sm" className="h-6 px-2 text-[11px]" disabled={!dirty || saving || !draft.trim()} onClick={() => void save()}>Save for the next calls</Button>
        <Button id="agentContextReset" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={saving || (!view.override && !dirty)} onClick={() => (view.override ? void reset() : setDraft(view.standingRules))}>
          {view.override ? "Reset to the prompt" : "Discard edits"}
        </Button>
        <span className="text-[11px] text-muted-foreground">{draft.length.toLocaleString()} characters</span>
      </div>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" id="agentContextLeadBlock" className="group h-6 w-fit gap-1 px-1 text-[11px] text-muted-foreground">
            <ChevronDownIcon className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
            Lead block added live for {view.leadLabel ?? "the lead"} ({view.direction}); not editable
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {view.leadBlock
            ? <pre id="agentContextLead" className="max-h-56 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">{view.leadBlock}</pre>
            : <p className="text-[11px] text-muted-foreground">{view.note ?? "No lead block."}</p>}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
