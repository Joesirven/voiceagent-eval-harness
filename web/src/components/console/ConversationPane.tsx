import type { FunctionCallData } from "@pipecat-ai/client-react";
import { ChevronRightIcon, CircleAlertIcon, DotIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Group, JudgeRow, SortedEvent, Summary } from "../../../../src/server/live-view-core.js";
import { NowBoard } from "@/components/console/NowBoard";
import { ConversationView } from "@/components/pipecat/conversation";
import { MetricsView } from "@/components/pipecat/metrics/metrics";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toConversationMessages, type ReasoningResult } from "@/lib/conversation-adapter";
import { hasSimulatedSeries, traceToMetricSeries } from "@/lib/metrics-adapter";
import { cn } from "@/lib/utils";

/** One reasoning row (decision, judge verdict, tool call, check) drawn through the kit's function call renderer hook. */
function ReasoningRow({ call }: { call: FunctionCallData }) {
  const [open, setOpen] = useState(false);
  const result = (call.result ?? {}) as Partial<ReasoningResult>;
  const bad = result.bad === true;
  const Icon = bad ? CircleAlertIcon : DotIcon;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="reasoning-row" className="ml-2 border-l pl-3">
      <CollapsibleTrigger title="Developer detail" className={cn("flex w-full items-center gap-2 text-left font-mono text-xs", bad && "text-destructive")}>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{result.summary ?? call.function_name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{((result.atSeconds ?? 0)).toFixed(2)}s</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {result.plain && <p className="mt-1 text-xs">{result.plain}</p>}
        <span className="text-[11px]">Developer detail</span>
        <pre className="mt-1 max-h-52 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(call.args ?? {}, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

const renderReasoning = (call: FunctionCallData) => <ReasoningRow call={call} />;

/**
 * The conversation column of the console. Tabs: the transcript with its
 * reasoning rows, the metrics, and the current state of the call.
 * Caller words reach the page only as text, never as markup.
 */
export function ConversationPane({ sorted, groups, judged, sum, plain, replaying }: {
  sorted: SortedEvent[];
  groups: Group[];
  judged: JudgeRow[];
  sum: Summary;
  plain: (e: SortedEvent) => string | undefined;
  replaying: boolean;
}) {
  const messages = useMemo(() => toConversationMessages({ sorted, groups, judged, plain }), [sorted, groups, judged, plain]);
  const series = useMemo(() => traceToMetricSeries(sorted), [sorted]);
  const simulated = hasSimulatedSeries(series);
  const empty = replaying
    ? "Nothing to replay yet. Load a recorded call to see its transcript and reasoning here."
    : "No call yet. Press Play to start a live voice call. The transcript and its reasoning appear here as they happen.";
  return (
    <Tabs defaultValue="conversation" className="flex h-full min-h-0 flex-col" data-slot="conversation-pane">
      <TabsList className="mx-2 mt-2 w-fit">
        <TabsTrigger value="conversation">Conversation</TabsTrigger>
        <TabsTrigger value="metrics">Metrics</TabsTrigger>
        <TabsTrigger value="now">Now</TabsTrigger>
      </TabsList>
      <TabsContent value="conversation" className="min-h-0 flex-1" role="region" aria-label="Live transcript and reasoning">
        <ConversationView
          messages={messages}
          functionCallRenderer={renderReasoning}
          textRenderMode="instant"
          clientLabel="caller"
          assistantLabel="agent"
          empty={<p className="max-w-xs p-4 text-center text-sm text-muted-foreground">{empty}</p>}
        />
      </TabsContent>
      <TabsContent value="metrics" className="min-h-0 flex-1 overflow-auto p-3">
        <MetricsView
          series={series}
          performanceProps={{ categories: ["processing"], empty: <span className="text-sm text-muted-foreground">No decision tree or judge times yet.</span> }}
          usageProps={{ empty: <span className="text-sm text-muted-foreground">Agent characters are counted on the Deepgram voice path only.</span> }}
        />
        {simulated && (
          <p className="mt-3 text-xs text-muted-foreground" data-slot="simulated-caption">
            Times marked simulated come from the built-in modules. They are numbers the module reports and were never waited for. Times marked measured were timed on a real model.
          </p>
        )}
      </TabsContent>
      <TabsContent value="now" className="min-h-0 flex-1 overflow-auto p-2"><NowBoard sum={sum} /></TabsContent>
    </Tabs>
  );
}
