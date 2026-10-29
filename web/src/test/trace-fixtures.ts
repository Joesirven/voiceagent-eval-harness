import { align, eventsFor, judgeRows, summarize } from "../../../src/server/live-view-core.js";
import type { SortedEvent } from "../../../src/server/live-view-core.js";

const START = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Builds trace events in order; `ms` is the time since the call start. */
export function makeEvents(rows: Array<{ ms: number; type: string; data: Record<string, unknown> }>): SortedEvent[] {
  const events = rows.map((r, i) => ({
    seq: i + 1,
    recordSeq: i + 1,
    at: new Date(START + r.ms).toISOString(),
    atMs: r.ms,
    type: r.type,
    leadId: "lead",
    recordId: "record",
    channel: "call",
    callId: "call-1",
    data: r.data,
  }));
  return eventsFor(events as any, "call-1");
}

/** A small call: open, the caller speaks, a decision, a judge verdict and the agent answers. */
export function sampleCall(options: { provider?: "deepgram" | "azure"; decisionModule?: string; judgeKind?: "mock" | "real" } = {}): SortedEvent[] {
  return makeEvents([
    { ms: 0, type: "tool_call", data: { tool: "voice_session_open", inputs: { provider: options.provider ?? "azure" }, success: true } },
    { ms: 10, type: "tool_call", data: { tool: "agent_context", inputs: {}, success: true } },
    { ms: 100, type: "turn", data: { role: "agent", text: "Hello, this is the agent.", turnIndex: 0 } },
    { ms: 1000, type: "transcript_final", data: { role: "caller", text: "<b>I want a quote</b>", turnIndex: 1 } },
    { ms: 1100, type: "decision", data: { nodeId: "n1", answer: "wants_quote", confidence: 0.9, minConfidence: 0.7, reason: "keywords", module: options.decisionModule ?? "jev-mock", routed: "proceed", latencyMs: 100 } },
    { ms: 1150, type: "decision", data: { kind: "live_judge", action: "speak", modelId: "judge-model", modelKind: options.judgeKind ?? "mock", answer: "allow", confidence: 0.8, latencyMs: 250, attemptCount: 1, attempts: [{ n: 1, outcome: "answered", latencyMs: 250 }] } },
    { ms: 1160, type: "judge_verdict", data: { action: "speak", allowed: true, reason: "ok", scores: [{ score: 1 }] } },
    { ms: 1500, type: "turn", data: { role: "agent", text: "Great, let us start a quote.", turnIndex: 2 } },
    { ms: 2500, type: "decision", data: { nodeId: "n2", answer: "yes", confidence: 0.95, minConfidence: 0.7, reason: "keywords", module: options.decisionModule ?? "jev-mock", routed: "proceed", latencyMs: 120 } },
  ]);
}

export function derive(sorted: SortedEvent[]) {
  return { groups: align(sorted), judged: judgeRows(sorted), sum: summarize(sorted) };
}
