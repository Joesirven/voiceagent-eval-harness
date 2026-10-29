import { ErrorsList } from "@/components/ErrorsPanel";
import { JudgeBody } from "@/components/JudgeDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConsolePanel, ConsolePanelContent, ConsolePanelHeader } from "@/components/console/panel";
import { plainBySeq } from "@/lib/live";
import type { VoiceErrorRecord } from "@/lib/types";
import type { CallViewModel } from "@/lib/use-call-view";

/** Bottom pane: the judges, a raw list of trace events with their plain sentence, and recent voice errors. */
export function JudgesPane({ model, errors }: { model: CallViewModel; errors: VoiceErrorRecord[] }) {
  const { judged, sum, sorted } = model;
  return (
    <ConsolePanel>
      <Tabs defaultValue="judges" className="min-h-0 flex-1 gap-0">
        <ConsolePanelHeader>
          <TabsList className="h-6 bg-transparent p-0">
            <TabsTrigger value="judges" className="h-6 px-2 text-xs" id="judgesTab">Judges</TabsTrigger>
            <TabsTrigger value="trace" className="h-6 px-2 text-xs" id="traceTab">Trace</TabsTrigger>
            <TabsTrigger value="errors" className="h-6 px-2 text-xs" id="errorsTab">Errors{errors.length > 0 ? ` (${errors.length})` : ""}</TabsTrigger>
          </TabsList>
        </ConsolePanelHeader>
        <ConsolePanelContent>
          <TabsContent value="judges" id="judgesLive" className="min-h-0 overflow-auto pt-2"><JudgeBody rows={judged} sum={sum} /></TabsContent>
          <TabsContent value="trace" className="min-h-0 overflow-auto pt-2">
            {sorted.length === 0
              ? <p className="text-xs text-muted-foreground">No trace events yet.</p>
              : (
                <ol className="grid gap-1 font-mono text-[11px] leading-snug" aria-label="Trace events">
                  {sorted.map((e) => (
                    <li key={e.seq} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">{(e.ms / 1000).toFixed(1)}s</span>
                      <span className="shrink-0 font-semibold">{e.type}</span>
                      <span className="min-w-0 break-words">{plainBySeq.get(e.seq) ?? ""}</span>
                    </li>
                  ))}
                </ol>
              )}
          </TabsContent>
          <TabsContent value="errors" className="min-h-0 overflow-auto pt-2"><ErrorsList errors={errors} /></TabsContent>
        </ConsolePanelContent>
      </Tabs>
    </ConsolePanel>
  );
}
