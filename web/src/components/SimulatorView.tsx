import { useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLayout } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { act, api } from "@/lib/api";
import type { AppState } from "@/lib/types";
import { VOICE_MODULE_ID } from "@/components/SettingsSheet";

const NATIVE = "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const clock = (iso: string) => iso.slice(11, 19);

export function SimulatorView({ state, refresh }: { state: AppState; refresh: (s?: AppState) => Promise<void> }) {
  const m = state.modules.find((x) => x.id === VOICE_MODULE_ID) ?? state.modules[0]!;
  const [voice, setVoice] = useState(m.config.voice);
  const [model, setModel] = useState(m.config.model);
  const [first, setFirst] = useState(String(m.config.latency.firstResponseMs));
  const [end, setEnd] = useState(String(m.config.latency.endpointingMs));
  const [run, setRun] = useState<any>(null);
  const [timelineLead, setTimelineLead] = useState("lead-1");
  const [words, setWords] = useState(false);
  const [timeline, setTimeline] = useState<any>(null);
  const layout = useLayout("simulator");

  const showTimeline = (dev = words, id = timelineLead.trim()) => act(async () => {
    if (id) setTimeline(await api(`/api/leads/${encodeURIComponent(id)}/timeline`).then((t) => ({ ...t, dev })));
  });

  return (
    <ResizablePanelGroup orientation="horizontal" id="simulator" {...layout} className="min-h-0 flex-1">
      <ResizablePanel id="sim-setup" defaultSize={34} minSize={22} className="flex min-w-0 flex-col">
        <div className="flex h-8 shrink-0 items-center border-b bg-muted/40 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Scenarios</div>
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto p-3">
          <div className="grid gap-2">
            <div className="text-sm font-medium">{m.label}</div>
            <p className="text-xs text-muted-foreground">Play and scenarios use Azure gpt-live only.</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1"><Label className="text-xs text-muted-foreground">Voice</Label>
                <Select value={voice} onValueChange={setVoice}><SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{(m.voiceChoices ?? [m.config.voice]).map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1"><Label className="text-xs text-muted-foreground">Model</Label>
                <Select value={model} onValueChange={setModel}><SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{(m.modelChoices ?? [m.config.model]).map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1"><Label htmlFor="firstMs" className="text-xs text-muted-foreground">First response (ms)</Label><input id="firstMs" type="number" className={NATIVE} value={first} onChange={(e) => setFirst(e.target.value)} /></div>
              <div className="grid gap-1"><Label htmlFor="endMs" className="text-xs text-muted-foreground">Endpointing (ms)</Label><input id="endMs" type="number" className={NATIVE} value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            </div>
            <Button size="sm" className="w-fit" onClick={() => act(async () => refresh(await api(`/api/modules/${m.id}`, { voice, model, latency: { firstResponseMs: Number(first), endpointingMs: Number(end) } })))}>Save settings</Button>
          </div>
          <div className="grid gap-2">
            <div className="text-sm font-medium">Run a scenario</div>
            <p className="text-xs text-muted-foreground">Deterministic scripted calls, run against the same compliance checks and judge.</p>
            <div className="flex flex-wrap gap-1.5">
              {state.scenarios.map((s) => (
                <Button key={s.id} variant="outline" size="sm" onClick={() => act(async () => setRun(await api(`/api/scenarios/${s.id}/run`, {})))}>{s.title}</Button>
              ))}
            </div>
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="sim-results" defaultSize={66} minSize={30} className="flex min-w-0 flex-col">
        <Tabs defaultValue="run" className="min-h-0 flex-1 gap-0">
          <div className="flex h-8 shrink-0 items-center border-b bg-muted/40 px-2">
            <TabsList className="h-6 bg-transparent p-0">
              <TabsTrigger value="run" className="h-6 px-2 text-xs">Run result</TabsTrigger>
              <TabsTrigger value="timeline" className="h-6 px-2 text-xs">Timeline</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="run" className="min-h-0 space-y-3 overflow-auto p-3">
            {!run && <p className="text-sm text-muted-foreground">Run a scenario to see its result and log here.</p>}
            {run && (
              <>
                <p className="text-sm"><strong>{run.title}: </strong>{run.summary}</p>
                <details><summary className="cursor-pointer text-sm">Scenario detail (transcript, fields, handoff)</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(run.detail, null, 2)}</pre></details>
                <Table>
                  <TableHeader><TableRow>{["at", "channel", "direction", "outcome", "reason"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>
                    {run.logs.map((l: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell>{clock(l.at)}</TableCell><TableCell>{l.channel}</TableCell><TableCell>{l.direction || ""}</TableCell>
                        <TableCell className={/^(blocked|skipped)$/.test(l.outcome) ? "text-destructive" : /^(placed|answered|message_sent)$/.test(l.outcome) ? "text-green-700" : ""}>{l.outcome}</TableCell>
                        <TableCell className="whitespace-normal">{l.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </TabsContent>
          <TabsContent value="timeline" className="min-h-0 space-y-3 overflow-auto p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1"><Label htmlFor="timelineLead" className="text-xs text-muted-foreground">Lead</Label><input id="timelineLead" className={NATIVE} value={timelineLead} onChange={(e) => setTimelineLead(e.target.value)} /></div>
              <Button id="timelineGo" variant="outline" size="sm" onClick={() => void showTimeline()}>Show</Button>
              <div className="flex items-center gap-2"><Switch id="timelineDev" checked={words} onCheckedChange={(v) => { setWords(v); void showTimeline(v); }} /><Label htmlFor="timelineDev" className="text-xs">Words</Label></div>
            </div>
            {timeline && (
              <div className="space-y-1 text-sm">
                <div className="text-muted-foreground">{timeline.records.length} record(s)</div>
                {timeline.items.map((item: any, i: number) => {
                  const text = item.plain || (timeline.dev && item.turn ? `${item.turn.role}: ${item.turn.text}` : null);
                  return text ? <div key={i} className="border-b py-1"><span className="mr-2 text-xs text-muted-foreground">{item.at.slice(5, 10)} {clock(item.at)} {item.channel}</span>{text}</div> : null;
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
