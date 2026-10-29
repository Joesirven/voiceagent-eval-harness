import type { ConversationMessage, FunctionCallData } from "@pipecat-ai/client-react";
import * as core from "../../../src/server/live-view-core.js";
import type { Group, JudgeRow, SortedEvent } from "../../../src/server/live-view-core.js";

/** What the function-call renderer reads back out of `FunctionCallData.result`. */
export interface ReasoningResult {
  /** One short label, the same text the old transcript column showed. */
  summary: string;
  /** A plain-language sentence when it differs from the label. */
  plain?: string;
  /** Seconds since the call started. */
  atSeconds: number;
  /** True when the row is a failure or a block. */
  bad: boolean;
}

const rowKey = (e: SortedEvent) => `${e.recordId ?? ""}:${e.recordSeq ?? e.seq}`;

/** Wall clock time of a trace event, rebuilt from the call start so every message has a stable timestamp. */
function startOf(sorted: SortedEvent[]): number {
  const first = sorted[0];
  const at = first ? Date.parse(first.at) : NaN;
  return Number.isFinite(at) ? at - first!.ms : 0;
}

/**
 * Turns the pure trace functions' output into the kit's conversation messages.
 * Each caller or agent line becomes a user or assistant message, followed by
 * its reasoning rows (decisions, judge verdicts, tool calls, checks) as
 * function-call messages. Caller words are copied as plain strings, which the
 * kit renders as text, never as markup. The agent context tool call is left
 * out because it has its own pane.
 */
export function toConversationMessages(input: {
  sorted: SortedEvent[];
  groups: Group[];
  judged: JudgeRow[];
  plain?: (e: SortedEvent) => string | undefined;
}): ConversationMessage[] {
  const { sorted, groups, judged, plain } = input;
  const base = startOf(sorted);
  const iso = (ms: number) => new Date(base + ms).toISOString();
  const judgeByKey = new Map(judged.map((r) => [r.key, r]));
  const out: ConversationMessage[] = [];
  for (const group of groups) {
    if (group.line) {
      const createdAt = iso(group.line.ms);
      out.push({
        role: group.line.role === "caller" ? "user" : "assistant",
        final: group.line.final,
        createdAt,
        updatedAt: iso(group.line.endMs),
        parts: [{ text: group.line.text, final: group.line.final, createdAt }],
      });
    }
    for (const row of group.rows) {
      // The agent context has its own pane, and so do the background objective checks.
      if (row.event.type === "tool_call" && (row.event.data.tool === "agent_context" || row.event.data.tool === "objective_check")) continue;
      const key = rowKey(row.event);
      const judge = row.event.type === "judge_verdict" ? judgeByKey.get(key) : undefined;
      const summary = judge ? core.judgeLine(judge) : row.text;
      const sentence = plain?.(row.event);
      const result: ReasoningResult = {
        summary,
        ...(sentence && sentence !== summary ? { plain: sentence } : {}),
        atSeconds: row.event.ms / 1000,
        bad: row.bad,
      };
      const functionCall: FunctionCallData = {
        function_name: row.kind,
        tool_call_id: key,
        args: row.event.data,
        result,
        cancelled: row.bad,
        status: "completed",
      };
      const createdAt = iso(row.event.ms);
      out.push({ role: "function_call", final: true, createdAt, parts: [], functionCall });
    }
  }
  return out;
}
