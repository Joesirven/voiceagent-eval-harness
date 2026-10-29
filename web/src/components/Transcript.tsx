import { BrainIcon, CircleAlertIcon, DotIcon } from "lucide-react";
import { useState } from "react";
import * as core from "../../../src/server/live-view-core.js";
import type { Group, JudgeRow, SortedEvent } from "../../../src/server/live-view-core.js";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const rowKey = (e: SortedEvent) => `${e.recordId ?? ""}:${e.recordSeq ?? e.seq}`;

function Step({ row, plain }: { row: core.Row; plain?: string }) {
  const [open, setOpen] = useState(false);
  const Icon = row.bad ? CircleAlertIcon : DotIcon;
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger title="Developer detail">
        <TraceLine status={row.bad ? "error" : undefined}>
          <TraceIcon><Icon /></TraceIcon>
          <TraceTitle className="font-mono text-xs">{row.text}</TraceTitle>
          <TraceDescription className="font-mono text-[11px]">{(row.event.ms / 1000).toFixed(2)}s</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        {plain && plain !== row.text && <p className="mb-1 text-xs">{plain}</p>}
        <span className="text-[11px]">Developer detail</span>
        <pre className="mt-1 max-h-52 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(row.event, null, 2)}</pre>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * One column: each caller or agent line is followed by the reasoning rows that belong to it, in time order.
 * Everything renders as React text, never markup: caller words are untrusted.
 */
export function Transcript({ sorted, groups, judge, plain, score }: {
  sorted: SortedEvent[];
  groups: Group[];
  judge: JudgeRow[];
  plain: (e: SortedEvent) => string | undefined;
  score: { score: number } | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const judgeByKey = new Map(judge.map((r) => [r.key, r]));
  return (
    <Conversation className="relative h-full min-h-0" role="region" aria-label="Live transcript and reasoning">
      <ConversationContent className="gap-3 p-2">
        {sorted.length === 0 && <ConversationEmptyState title="No call yet" description="Press Play to start a live voice call. The transcript and its reasoning appear here as they happen." />}
        {groups.map((group, i) => {
          // The agent context has its own panel, so it is not repeated as a reasoning row.
          const isFiller = (r: Group["rows"][number]) => r.event.type === "tool_call" && r.event.data.tool === "interim_response";
          const fillers = group.rows.filter(isFiller);
          const g = { ...group, rows: group.rows.filter((r) => !isFiller(r) && !(r.event.type === "tool_call" && r.event.data.tool === "agent_context")) };
          const key = g.line ? g.line.key : "start";
          const chips = g.rows.filter((r) => r.event.type === "judge_verdict")
            .map((r) => judgeByKey.get(rowKey(r.event))).filter((j): j is JudgeRow => Boolean(j));
          const on = selected === key;
          return (
            <div key={`${key}-${i}`} className={cn("flex flex-col gap-2 rounded-md p-1", on && "bg-accent/60")}>
              {g.line ? (
                <Message from={g.line.role === "caller" ? "user" : "assistant"} onClick={() => setSelected(on ? null : key)} className="cursor-pointer">
                  <MessageContent className={cn(!g.line.final && "italic opacity-60")}>
                    <span className="text-[11px] text-muted-foreground">{(g.line.ms / 1000).toFixed(1)}s {g.line.role}</span>
                    {g.line.text}
                  </MessageContent>
                </Message>
              ) : <p className="text-xs text-muted-foreground">(call start)</p>}
              {fillers.map((r) => {
                const i = (r.event.data.inputs ?? {}) as { text?: unknown; tool?: unknown };
                return (
                  <p key={rowKey(r.event)} className="flex items-center gap-1.5 pl-2 text-xs italic text-muted-foreground" data-filler>
                    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal not-italic">filler</Badge>
                    <span className="text-[11px]">{(r.event.ms / 1000).toFixed(1)}s</span>
                    <span>{typeof i.text === "string" ? i.text : "…"}</span>
                    {typeof i.tool === "string" && i.tool ? <span className="text-[11px] not-italic">while {i.tool} ran</span> : null}
                  </p>
                );
              })}
              {chips.map((j) => (
                <Badge key={j.key} variant={j.allowed ? "secondary" : "destructive"} className="h-auto whitespace-normal font-mono text-[11px] font-normal">{core.judgeLine(j)}</Badge>
              ))}
              {g.rows.length > 0 && (
                <TraceCollapsible defaultOpen className="ml-2 border-l pl-3">
                  <TraceCollapsibleTrigger>
                    <TraceLine><TraceIcon><BrainIcon /></TraceIcon><TraceTitle>Reasoning · {g.rows.length} {g.rows.length === 1 ? "step" : "steps"}</TraceTitle></TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent className="border-l-0 pl-0">
                    <Trace>{g.rows.map((r) => <Step key={rowKey(r.event)} row={r} plain={plain(r.event)} />)}</Trace>
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              )}
            </div>
          );
        })}
        {score && <Badge variant="outline" className="w-fit font-mono text-[11px] font-normal">post-call score {score.score}</Badge>}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

