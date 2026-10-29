/**
 * An excerpt of the last conversation with a lead, read from the harness record
 * store, so the agent can pick up where the last call left off. Information for
 * the agent, never lines to read back. Never throws: any failure returns undefined.
 */

import { redactSensitiveSummaries } from "../behaviour/guard/redaction.js";
import { recordStore } from "../trace/index.js";

const DEFAULT_MAX_LINES = 12;
const MAX_LINE_CHARS = 200;

export interface LastConversationExcerpt {
  /** When that call was opened (ISO). */
  at: string;
  /** The closing lines of that call, as "Caller: ..." or "Agent: ...", sensitive sentences removed. */
  lines: string[];
}

export function lastConversationExcerpt(
  leadId: string,
  options: { excludeCallId?: string; maxLines?: number } = {},
): LastConversationExcerpt | undefined {
  try {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    // The current call has no outcome yet at session start, so an outcome marks an earlier, finished call.
    const earlier = recordStore
      .list()
      .filter((r) => r.kind === "call" && r.leadId === leadId && r.recordId !== options.excludeCallId)
      .filter((r) => r.outcome !== undefined && r.transcript.length > 0);
    const last = earlier[earlier.length - 1];
    if (!last) return undefined;
    const spoken = last.transcript
      .filter((t) => t.role === "caller" || t.role === "agent")
      .slice(-maxLines)
      .map((t) => `${t.role === "caller" ? "Caller" : "Agent"}: ${t.text.trim().slice(0, MAX_LINE_CHARS)}`);
    const lines = redactSensitiveSummaries(spoken).kept;
    if (!lines.length) return undefined;
    return { at: last.openedAt, lines };
  } catch {
    return undefined;
  }
}
