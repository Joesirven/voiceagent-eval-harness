import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { act, api } from "@/lib/api";

/** GET and POST /api/setups/agent (src/setups/agent-settings.ts). */
interface AgentSettingsState {
  promptSetups: { id: string; label: string }[];
  promptSetupId: string;
  leadContextGate: "on" | "off";
  thinker: { enabled: boolean; deployment?: string; toolCount: number };
  talkWriteBack: boolean;
  writeBack: boolean;
  preset: "lab" | "default" | "custom";
}

function SwitchRow({ id, label, checked, note, onChange }: { id: string; label: string; checked: boolean; note?: string; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={id} className="min-w-0 text-xs font-normal"><span className="truncate">{label}{note ? <span className="text-muted-foreground">, {note}</span> : null}</span></Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * The lab voice agent's settings for the next call: the prompt, the lead context, Talk transcripts to
 * Supabase and the experimental thinker, plus two presets. It reads and writes its own state, so it can be
 * mounted anywhere (the Console's Context pane, a call setup dialog) without props.
 */
export function AgentSettings() {
  const [s, setS] = useState<AgentSettingsState | null>(null);
  const load = useCallback(() => act(async () => setS(await api<AgentSettingsState>("/api/setups/agent"))), []);
  useEffect(() => { void load(); }, [load]);
  const post = (body: object) => act(async () => setS(await api<AgentSettingsState>("/api/setups/agent", body)));
  if (!s) return null;
  return (
    <section id="agentSettings" aria-label="Lab voice agent settings" className="mb-2 grid min-w-0 grid-cols-1 gap-1.5 border-b pb-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Agent for the next call</span>
        <div className="flex gap-1">
          <Button id="agentPresetLab" size="sm" variant={s.preset === "lab" ? "secondary" : "outline"} className="h-6 px-2 text-[11px]" aria-pressed={s.preset === "lab"} onClick={() => void post({ preset: "lab" })}>Lab voice agent</Button>
          <Button id="agentPresetDefault" size="sm" variant={s.preset === "default" ? "secondary" : "outline"} className="h-6 px-2 text-[11px]" aria-pressed={s.preset === "default"} onClick={() => void post({ preset: "default" })}>Default</Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="agentPromptSetup" className="text-xs font-normal">Prompt</Label>
        <Select value={s.promptSetupId} onValueChange={(v) => void post({ promptSetupId: v })}>
          <SelectTrigger id="agentPromptSetup" className="h-7 w-full max-w-56 min-w-0 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{s.promptSetups.map((p) => <SelectItem key={p.id} value={p.id} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <SwitchRow id="agentLeadContext" label="Full lead context from the first word" checked={s.leadContextGate === "off"} onChange={(on) => void post({ leadContextGate: on ? "off" : "on" })} />
      <SwitchRow id="agentTalkWriteBack" label="Transcript to Supabase after the call" checked={s.talkWriteBack} note={s.writeBack ? undefined : "run write-back is off"} onChange={(on) => void post({ talkWriteBack: on })} />
      <SwitchRow id="agentThinker" label="Thinker with tools" checked={s.thinker.enabled} note={s.thinker.enabled && s.thinker.deployment ? `${s.thinker.deployment}, experimental` : "experimental"} onChange={(on) => void post({ thinker: on })} />
    </section>
  );
}
