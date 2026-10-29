/**
 * POST /api/trace/pipecat: the console page's rows for a Pipecat call, put on
 * the server trace bus. The page builds a Pipecat call's rows itself (the
 * engine talks to the browser, not to this server), and the objectives judge,
 * the post-call scorer and the records only see the bus. The page sends every
 * row here and shows what comes back on /api/events, so nothing is doubled.
 * Only Pipecat call ids are taken, only the row types the page produces, and
 * a bounded batch per request.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { traceBus, type TraceEventInput, type TraceEventType } from "../trace/events.js";

export const PIPECAT_TRACE_PATH = "/api/trace/pipecat";
const CALL_ID = /^pipecat_[a-z0-9]{6,16}$/;
const LEAD_ID = /^[\w-]{1,80}$/;
const TYPES = new Set<TraceEventType>(["transcript_partial", "transcript_final", "tool_call", "node_enter", "disposition", "call_outcome"]);
const MAX_ROWS = 100;
const MAX_BODY = 512 * 1024;

export interface PipecatTraceRow {
  type: string;
  data: Record<string, unknown>;
  flowStep?: string;
}

export interface PipecatTraceBatch {
  callId: string;
  leadId: string;
  leadLabel?: string;
  direction?: "inbound" | "outbound";
  rows: PipecatTraceRow[];
}

/** Validates one batch; throws a short code. */
export function batchFrom(body: unknown): PipecatTraceBatch {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const callId = typeof b.callId === "string" ? b.callId : "";
  if (!CALL_ID.test(callId)) throw new Error("bad_call_id");
  const leadId = typeof b.leadId === "string" ? b.leadId : "";
  if (!LEAD_ID.test(leadId)) throw new Error("bad_lead_id");
  const leadLabel = typeof b.leadLabel === "string" ? b.leadLabel.slice(0, 40) : undefined;
  const direction = b.direction === "outbound" ? "outbound" : b.direction === "inbound" ? "inbound" : undefined;
  if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > MAX_ROWS) throw new Error("bad_rows");
  const rows: PipecatTraceRow[] = [];
  for (const r of b.rows as unknown[]) {
    const row = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const type = typeof row.type === "string" ? row.type : "";
    if (!TYPES.has(type as TraceEventType)) throw new Error("bad_row_type");
    const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : null;
    if (!data) throw new Error("bad_row_data");
    rows.push({ type, data, ...(typeof row.flowStep === "string" ? { flowStep: row.flowStep } : {}) });
  }
  return { callId, leadId, leadLabel, direction, rows };
}

/** Puts the batch on the bus in order; returns the sequence numbers the rows got. */
export function emitBatch(batch: PipecatTraceBatch, emit: (input: TraceEventInput) => { seq: number } = (input) => traceBus.emit(input)): number[] {
  return batch.rows.map((r) => emit({
    type: r.type as TraceEventType, leadId: batch.leadId, leadLabel: batch.leadLabel, recordId: batch.callId, channel: "call",
    direction: batch.direction, callId: batch.callId, data: r.data, ...(r.flowStep ? { flowStep: r.flowStep as TraceEventInput["flowStep"] } : {}),
  }).seq);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) throw new Error("body_too_large");
  }
  return JSON.parse(text);
}

/** Returns true when it handled the request. */
export async function handlePipecatTraceRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path !== PIPECAT_TRACE_PATH) return false;
  if (method !== "POST") return send(res, 405, { error: "method_not_allowed" }), true;
  let batch: PipecatTraceBatch;
  try {
    batch = batchFrom(await readJson(req));
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "bad_batch" }), true;
  }
  return send(res, 200, { ok: true, seqs: emitBatch(batch) }), true;
}
