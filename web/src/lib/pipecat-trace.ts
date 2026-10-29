/**
 * A Pipecat call in the console's own panels. The Pipecat client's events
 * (transcripts, the engine's server messages, errors) and the engine's call
 * record (polled every two seconds through the proxy, once more after the
 * end) are turned into the same trace rows every other engine writes, and fed
 * to the page's live view, so the transcript, metrics, timeline, trace and
 * score panels show a Pipecat call like any other.
 */

import { toast } from "sonner";
import { ingestFrame } from "@/lib/live";
import type { FlowStep } from "../../../src/decision-tree/types.js";
import { inferFlowStep } from "../../../src/judging/objective-definitions.js";

/** The engine's quote flow (flows/quote-prototype.flow.json) names its nodes differently from the harness tree; this maps each to a call stage. */
const PIPECAT_NODE_STEPS: Record<string, FlowStep> = {
  greet: "disclosure",
  frame_call: "recognize_lead",
  callback: "recognize_lead",
  wrong_person: "recognize_lead",
  collect_quote_info: "quote_fields",
  deliver_quote: "quote_fields",
  producer_available: "handoff",
  transferred: "handoff",
  producer_unavailable: "booking",
  producer_call: "booking",
  wrap_up: "booking",
  end: "booking",
};

/** The full tree's nodes carry their area in the name (open., discovery., close., compliance., end.); inferFlowStep knows open. and discovery. */
function pipecatStep(nodeId: string): FlowStep | undefined {
  const id = nodeId.toLowerCase();
  if (id.startsWith("compliance.")) return "disclosure";
  if (id.startsWith("close.") || id.startsWith("end.")) return "booking";
  return PIPECAT_NODE_STEPS[nodeId] ?? inferFlowStep(nodeId) ?? undefined;
}

export interface PipecatFeedStart {
  leadId: string;
  leadLabel: string;
  direction: "inbound" | "outbound";
  presetId: string;
  presetName: string;
  config: Record<string, string | number>;
}

interface Row { type: string; data: Record<string, unknown>; flowStep?: string }

const POLL_MS = 2000;
/** How long after the end the engine's record is still read for its final disposition. */
const END_POLL_MS = 15_000;

export class PipecatTraceFeed {
  /** The id the panels group by: the engine's call id once known, else a local one. */
  readonly callId: string;
  private engineCallId: string | null = null;
  private seq = Date.now() * 10;
  private recordSeq = 0;
  private readonly startedAt = Date.now();
  private turn = 0;
  private callerFinalAt: number | null = null;
  private botText = "";
  private botSpeakingSince: number | null = null;
  private ended = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly seenLines = new Set<string>();
  private readonly seenTools = new Set<string>();
  private readonly seenSteps = new Set<string>();
  private seenTurns = 0;

  constructor(private readonly o: PipecatFeedStart) {
    this.callId = `pipecat_${Date.now().toString(36)}`;
    this.emit({ type: "tool_call", data: { tool: "voice_session_open", inputs: { provider: "pipecat", model: String(o.config.replyDeployment ?? ""), voicePath: String(o.config.voicePath ?? ""), voice: String(o.config.voice ?? ""), preset: o.presetName }, result: null, success: true, durationMs: 0 } }, `Opened a Pipecat call for ${o.leadLabel}: ${o.presetName}.`);
    this.emit({ type: "tool_call", data: { tool: "agent_context", inputs: { setupId: o.presetId }, result: { text: `Pipecat engine (local), preset ${o.presetName}\n${Object.entries(o.config).map(([k, v]) => `${k}: ${v}`).join("\n")}` }, success: true, durationMs: 0 } });
  }

  /**
   * Every row goes to the server (POST /api/trace/pipecat) in order and comes back on /api/events like a harness row,
   * so the objectives judge, the post-call scorer and the records see the call. Only when the server refuses or is
   * down does the row go straight into the page, so the call still shows.
   */
  private emit(row: Row, plain?: string): void {
    this.queue.push({ row, plain });
    void this.flush();
  }

  private readonly queue: Array<{ row: Row; plain?: string }> = [];
  private flushing = false;
  private serverDown = false;

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 50);
        if (this.serverDown) { for (const b of batch) this.showLocally(b.row, b.plain); continue; }
        try {
          const res = await fetch("/api/trace/pipecat", {
            method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(4000),
            body: JSON.stringify({ callId: this.callId, leadId: this.o.leadId, leadLabel: this.o.leadLabel.split(" ")[0], direction: this.o.direction, rows: batch.map((b) => b.row) }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          // A server that cannot take the rows (down, or an older build without the route): the page shows them itself from here on.
          this.serverDown = true;
          console.warn("Pipecat rows stay on the page:", err instanceof Error ? err.message : String(err));
          for (const b of batch) this.showLocally(b.row, b.plain);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private showLocally(row: Row, plain?: string): void {
    const now = Date.now();
    this.seq += 1;
    this.recordSeq += 1;
    const event = {
      seq: this.seq, recordSeq: this.recordSeq, at: new Date(now).toISOString(), atMs: now - this.startedAt,
      type: row.type, leadId: this.o.leadId, leadLabel: this.o.leadLabel.split(" ")[0], recordId: this.callId, channel: "call", direction: this.o.direction, callId: this.callId,
      data: row.data, ...(row.flowStep ? { flowStep: row.flowStep } : {}),
    };
    ingestFrame(JSON.stringify({ event, ...(plain ? { plain } : {}) }));
  }

  // Live events from the Pipecat client.

  callerPartial(text: string): void {
    if (text.trim()) this.emit({ type: "transcript_partial", data: { role: "caller", text, turnIndex: this.turn } });
  }

  callerFinal(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.seenLines.add(`caller:${t}`);
    this.emit({ type: "transcript_final", data: { role: "caller", text: t, turnIndex: this.turn, source: "voice_module" } });
    this.turn += 1;
    this.callerFinalAt = Date.now();
  }

  botStartedSpeaking(): void {
    this.botSpeakingSince = Date.now();
    if (this.callerFinalAt !== null) {
      const ms = Date.now() - this.callerFinalAt;
      this.emit({ type: "tool_call", data: { tool: "reply_timing", inputs: { source: "pipecat", callerFinalToFirstAudioMs: ms }, result: null, success: true, durationMs: ms } });
      this.callerFinalAt = null;
    }
  }

  botTranscript(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.botText = this.botText ? `${this.botText} ${t}` : t;
    this.emit({ type: "transcript_partial", data: { role: "agent", text: this.botText, turnIndex: this.turn } });
  }

  botStoppedSpeaking(): void {
    this.flushBot(false);
  }

  private flushBot(interrupted: boolean): void {
    const t = this.botText.trim();
    this.botText = "";
    this.botSpeakingSince = null;
    if (!t) return;
    this.seenLines.add(`agent:${t}`);
    this.emit({ type: "transcript_final", data: { role: "agent", text: t, turnIndex: this.turn, spoken: !interrupted, source: "voice_module" } });
    this.turn += 1;
  }

  /** The engine's own messages, as the old console reads them. */
  serverMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const m = data as Record<string, unknown>;
    const type = String(m.type ?? "");
    if (type === "call" && typeof m.callId === "string") {
      this.engineCallId = m.callId;
      this.emit({ type: "tool_call", data: { tool: "pipecat_call", inputs: { callId: m.callId }, result: null, success: true, durationMs: 0 } }, `The engine opened call ${m.callId.slice(0, 8)}.`);
      this.startPolling();
      return;
    }
    if (type === "configuration") {
      this.emit({ type: "tool_call", data: { tool: "pipecat_configuration", inputs: { text: String(m.text ?? "") }, result: null, success: true, durationMs: 0 } }, String(m.text ?? "Configuration."));
      return;
    }
    if (type === "flow") {
      const ev = String(m.event ?? "");
      const name = String(m.name ?? "");
      if (ev === "tool") {
        this.emit({ type: "tool_call", data: { tool: "flow_tool_call", inputs: { name, args: m.args ?? {} }, result: null, success: true, durationMs: 0 } }, `Flow tool ${name} called.`);
      } else if (ev === "tool_result") {
        const ok = m.ok !== false && m.success !== false;
        this.seenTools.add(`${name}:${JSON.stringify(m.result ?? null).slice(0, 80)}`);
        this.emit({ type: "tool_call", data: { tool: name || "flow_tool", inputs: { ...(m.args && typeof m.args === "object" ? (m.args as Record<string, unknown>) : {}), engine: "pipecat" }, result: m.result ?? null, success: ok, ...(ok ? {} : { reason: String(m.error ?? m.reason ?? "refused") }), durationMs: typeof m.durationMs === "number" ? m.durationMs : 0 } }, `${name} ${ok ? "ran" : "was refused"}.`);
      } else if (ev === "node" || ev === "route" || ev === "step") {
        const to = String(m.to ?? m.node ?? name);
        const from = typeof m.from === "string" ? m.from : undefined;
        const routeLabel = typeof m.label === "string" ? m.label : undefined;
        this.seenSteps.add(to);
        this.emit(
          { type: "node_enter", data: { nodeId: to, label: to.replace(/_/g, " "), flowNode: to, ...(from ? { from } : {}), ...(routeLabel ? { route: routeLabel } : {}) }, flowStep: pipecatStep(to) },
          from ? `Flow went ${from} to ${to}${routeLabel ? ` (${routeLabel})` : ""}.` : `Flow started at ${to}.`,
        );
      } else {
        this.emit({ type: "tool_call", data: { tool: `flow_${ev || "event"}`, inputs: { name, ...(m.args && typeof m.args === "object" ? { args: m.args } : {}) }, result: null, success: m.ok !== false, durationMs: 0 } });
      }
      return;
    }
    if (type === "error") {
      this.error("Engine error", String(m.error ?? m.message ?? "unknown"), String(m.source ?? "engine"));
      return;
    }
    if (type === "session" && m.event === "ended") {
      this.end(String(m.reason ?? "engine_ended"));
      return;
    }
    this.emit({ type: "tool_call", data: { tool: `pipecat_${type || "message"}`, inputs: { ...m }, result: null, success: m.ok !== false, durationMs: 0 } });
  }

  error(title: string, detail: string, source = "engine"): void {
    const code = detail.replace(/[^a-z0-9_]+/gi, "_").slice(0, 40).toLowerCase() || "engine_error";
    this.emit({ type: "tool_call", data: { tool: "engine_error", inputs: { source, detail }, result: null, success: false, reason: code, durationMs: 0 } }, `${title}: ${detail}`);
    const details = `Time: ${new Date().toISOString()}\nCall: ${this.engineCallId ?? this.callId}\nSetup: ${this.o.presetName}\nSource: ${source}\nError: ${detail}`;
    toast.error(title, { description: detail, duration: 12_000, action: { label: "Copy details", onClick: () => void navigator.clipboard?.writeText(details) } });
  }

  // The engine's record, the server truth.

  private startPolling(): void {
    if (this.poll || !this.engineCallId) return;
    this.poll = setInterval(() => void this.reconcile(), POLL_MS);
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (!this.engineCallId) return;
    try {
      const res = await fetch(`/api/pipecat/api/calls/history/${encodeURIComponent(this.engineCallId)}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const j = await res.json();
      const c = (j?.call ?? j) as Record<string, unknown>;
      for (const l of (Array.isArray(c.transcript) ? c.transcript : []) as Array<{ role?: string; speaker?: string; text?: string }>) {
        const role = (l.role ?? l.speaker) === "caller" || (l.role ?? l.speaker) === "user" ? "caller" : "agent";
        const t = String(l.text ?? "").trim();
        if (!t || this.seenLines.has(`${role}:${t}`)) continue;
        this.seenLines.add(`${role}:${t}`);
        this.emit({ type: "transcript_final", data: { role, text: t, turnIndex: this.turn, source: "engine_record" } });
        this.turn += 1;
      }
      for (const s of (Array.isArray(c.flowSteps) ? c.flowSteps : []) as Array<{ node?: string; name?: string; to?: string; from?: string; label?: string; at?: number }>) {
        const id = String(s.to ?? s.node ?? s.name ?? "");
        const key = `${s.from ?? ""}>${id}:${s.label ?? ""}`;
        if (!id || this.seenSteps.has(key) || this.seenSteps.has(id)) continue;
        this.seenSteps.add(key);
        this.emit({ type: "node_enter", data: { nodeId: id, label: id.replace(/_/g, " "), flowNode: id, ...(s.from ? { from: s.from } : {}), ...(s.label ? { route: s.label } : {}), ...(typeof s.at === "number" ? { atSeconds: s.at } : {}) }, flowStep: pipecatStep(id) });
      }
      for (const t of (Array.isArray(c.toolEvents) ? c.toolEvents : []) as Array<{ name?: string; tool?: string; ok?: boolean; result?: unknown; args?: unknown; field?: string; source?: string; startedAt?: string | number; ms?: number; durationMs?: number; error?: string }>) {
        const name = String(t.name ?? t.tool ?? "flow_tool");
        const key = `${name}:${t.startedAt ?? ""}:${t.field ?? ""}:${JSON.stringify(t.result ?? null).slice(0, 80)}`;
        if (this.seenTools.has(key)) continue;
        this.seenTools.add(key);
        const inputs = { ...(t.args && typeof t.args === "object" ? (t.args as Record<string, unknown>) : {}), ...(t.field ? { field: t.field } : {}), ...(t.source ? { source: t.source } : {}), record: true, engine: "pipecat" };
        const ms = typeof t.durationMs === "number" ? t.durationMs : typeof t.ms === "number" ? t.ms : 0;
        this.emit({ type: "tool_call", data: { tool: name, inputs, result: t.result ?? null, success: t.ok !== false, ...(t.ok === false ? { reason: String(t.error ?? "failed") } : {}), durationMs: ms } });
      }
      const turns = (Array.isArray(c.turns) ? c.turns : []) as Array<{ turnMs?: number }>;
      for (const t of turns.slice(this.seenTurns)) {
        if (typeof t.turnMs === "number") this.emit({ type: "tool_call", data: { tool: "reply_timing", inputs: { source: "pipecat_record", callerFinalToFirstAudioMs: t.turnMs }, result: null, success: true, durationMs: t.turnMs } });
      }
      this.seenTurns = turns.length;
      const disposition = (c.measured as { disposition?: unknown } | undefined)?.disposition;
      const settled = c.status === "ended" && typeof disposition === "string" && disposition.length > 0;
      if (this.ended && settled && !this.dispositionSent) {
        this.dispositionSent = true;
        this.emit({ type: "disposition", data: { value: disposition as string } }, `The engine's disposition: ${disposition}.`);
      }
      // After the end: keep reading until the record is final (the engine files and measures the call after the session ends), for at most END_POLL_MS.
      if (this.ended && this.poll && (settled || Date.now() - (this.endedAt ?? 0) > END_POLL_MS)) { clearInterval(this.poll); this.poll = null; }
    } catch { /* the next poll tries again */ }
  }
  private dispositionSent = false;
  private endedAt: number | null = null;

  /** The call is over: the last agent words, the outcome row, one more read of the record. */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
    this.flushBot(true);
    this.emit({ type: "call_outcome", data: { status: /error|fail/i.test(reason) ? "failed" : "ai_handled", reason, providerCallId: this.engineCallId } }, `The Pipecat call ended: ${reason}.`);
    if (this.engineCallId) {
      // The record is read every two seconds until its status is ended and its disposition is there, capped at END_POLL_MS.
      if (!this.poll) this.poll = setInterval(() => void this.reconcile(), POLL_MS);
      setTimeout(() => void this.reconcile(), 1500);
    }
  }

  get engineId(): string | null {
    return this.engineCallId;
  }
}
