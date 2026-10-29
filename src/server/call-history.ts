/**
 * GET /api/calls and GET /api/calls/<id>: the call history across every
 * engine, read only. Three sources, merged newest first:
 * - "memory": this machine's call records (the record store on disk);
 * - "harness_run": rows of voice_harness.harness_run in the harness database
 *   that are not already on disk (matched by record id), one select, 3 seconds
 *   at most; a failure drops this source and logs one line with a fixed code;
 * - "pipecat_engine": the local Pipecat engine's own history, with the key and
 *   agency header the proxy uses; when the engine is down its calls are missing.
 * The shapes are fixed (research note, leads-calls/shapes.md). Each source is
 * read at most limit + 1 rows deep. When a source's window came back full,
 * anything older than its oldest row is left for the next page, so paging
 * never skips a call (a filtered page can come back short, with a cursor).
 *
 * Which engine ran a harness call is read from its trace: voice_session_open
 * names the provider for Azure Voice Live and Deepgram. The Pipecat relay
 * (Azure gpt-live through the Pipecat orchestrator) writes exactly the rows a
 * direct gpt-live session writes, so it shows as pipecat_relay only when a
 * voice error on the Pipecat path is in the trace; otherwise it reads as
 * azure_gpt_live.
 *
 * Phone numbers in transcript lines and the agent context leave as the last
 * four digits only. Nothing personal is logged.
 */

import { execFile } from "node:child_process";
import { request as httpRequest, type ServerResponse } from "node:http";
import { createPsqlRunner, loadLocalPostgres, type ExecFile } from "../setups/local-postgres.js";
import { HARNESS_RUN_TABLE } from "../setups/run-sink.js";
import { recordStore, type HarnessRecord, type TraceEvent } from "../trace/index.js";
import { ENGINE_AGENCY_ID, PIPECAT_ENGINE_ORIGIN, engineApiKey } from "./pipecat-proxy.js";
import { DEEPGRAM_MODE } from "./voice/deepgram-voice-session.js";

export type CallEngine = "azure_gpt_live" | "azure_voice_live" | "deepgram" | "pipecat_relay" | "pipecat_engine" | "unknown";
export type CallSource = "memory" | "harness_run" | "pipecat_engine";
const ENGINES: readonly CallEngine[] = ["azure_gpt_live", "azure_voice_live", "deepgram", "pipecat_relay", "pipecat_engine", "unknown"];

export interface CallItem {
  id: string;
  leadId: string | null;
  leadName: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  direction: "inbound" | "outbound" | null;
  engine: CallEngine;
  sessionMode: string | null;
  model: string | null;
  outcome: { status: string | null; disposition: string | null };
  score: unknown;
  /** Null when the source only knows the total (the engine's list rows). */
  turns: { caller: number | null; agent: number | null };
  source: CallSource;
  /** The record id when the call has a record on this machine (GET /api/records/<id> replays it). */
  recordId: string | null;
}

export interface CallDetail {
  call: CallItem;
  transcript: Array<{ role: "agent" | "caller"; text: string; at: string | null; spoken: boolean }>;
  metrics: {
    replies: Array<{ at: string | null; source: string | null; decisionMs: number | null; createToFirstAudioMs: number | null; callerFinalToFirstAudioMs: number | null }>;
    tools: Array<{ at: string | null; name: string | null; ok: boolean; reason: string | null; durationMs: number | null }>;
    bargeIns: Array<{ at: string; reason: string | null }>;
    summary: { medianReplyMs: number | null; maxReplyMs: number | null; toolCalls: number; toolFailures: number; bargeIns: number };
  };
  score: unknown;
  agentContext: string | null;
  settingsEcho: Record<string, unknown> | null;
  /** The call's trace rows (phone numbers masked), when its trace is known. */
  events: TraceEvent[] | null;
  replayable: boolean;
}

const CALL_ID = /^[A-Za-z0-9_-]{1,80}$/;
const LEAD_ID = /^[\w.:@+-]{1,120}$/;
const CURSOR_ID = /^[\w.:-]{1,200}$/;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The engine refuses a larger page. */
const ENGINE_MAX_LIMIT = 200;
const HARNESS_TIMEOUT_MS = 3_000;
// The engine reads its own history from the local harness database, so it takes as long as that read can.
const ENGINE_TIMEOUT_MS = 3_000;
const ENGINE_MAX_BYTES = 16 * 1024 * 1024;

// --- small readers for untyped JSON ---

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function msOf(iso: unknown): number | null {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function isoOf(v: unknown): string | null {
  const ms = msOf(v);
  return ms === null ? null : new Date(ms).toISOString();
}
function directionOf(v: unknown): "inbound" | "outbound" | null {
  return v === "inbound" || v === "outbound" ? v : null;
}
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** A North American number (with or without +1, parentheses or separators) or an international one: only its last four digits leave. */
const PHONE_LIKE = /(?<!\w)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)|\+\d{10,14}(?!\d)/g;
function maskPhones(text: string): string {
  return text.replace(PHONE_LIKE, (m) => `***-***-${m.replace(/\D/g, "").slice(-4)}`);
}
/** Every string inside a value, masked. */
function maskDeep(v: unknown): unknown {
  if (typeof v === "string") return maskPhones(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  const o = obj(v);
  if (!o) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = maskDeep(x);
  return out;
}

// --- order and cursor ---

interface Key {
  ms: number;
  id: string;
}

/** Newest first; within one millisecond, the larger id first (plain code unit order, as collate "C" in the database). */
function compareKeys(a: Key, b: Key): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
/** True when `a` comes after `b` in the list (it is older). */
function isAfter(a: Key, b: Key): boolean {
  return compareKeys(a, b) > 0;
}

function encodeCursor(key: Key): string {
  return Buffer.from(JSON.stringify({ at: new Date(key.ms).toISOString(), id: key.id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Key | undefined {
  try {
    const parsed = obj(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const at = parsed?.at;
    const id = parsed?.id;
    if (typeof at !== "string" || !CURSOR_AT.test(at) || typeof id !== "string" || !CURSOR_ID.test(id)) return undefined;
    const ms = msOf(at);
    return ms === null ? undefined : { ms, id };
  } catch {
    return undefined;
  }
}

// --- which engine ran a harness call, from its trace ---

interface Signals {
  /** The session mode the voice manager wrote on the agent_context row (calls from 2026-10-21 on). */
  contextMode?: string;
  openSeen: boolean;
  openInputs: Record<string, unknown> | undefined;
  thinkerSeen: boolean;
  /** The distinct `path` values of the call's voice_error rows. */
  errorPaths: string[];
  leadLabel: string | null;
}

/** The same rule as ENGINE_CASE_SQL, in the same order. */
function engineOf(s: Signals): CallEngine {
  const mode = s.contextMode;
  if (mode?.startsWith("azure_voice_live")) return "azure_voice_live";
  if (mode === DEEPGRAM_MODE) return "deepgram";
  if (mode?.startsWith("pipecat")) return "pipecat_relay";
  if (mode?.startsWith("direct_azure")) return "azure_gpt_live";
  const provider = str(s.openInputs?.provider);
  if (provider === "azure_voice_live") return "azure_voice_live";
  if (provider === "deepgram") return "deepgram";
  // A thinker tool call only happens on the direct path; a Pipecat path error only on the relay.
  if (s.errorPaths.includes("pipecat") && !s.thinkerSeen) return "pipecat_relay";
  if (s.openSeen) return "azure_gpt_live";
  if (s.errorPaths.includes("azure_voice_live")) return "azure_voice_live";
  if (s.errorPaths.includes("deepgram")) return "deepgram";
  if (s.errorPaths.includes("azure_gpt_live")) return "azure_gpt_live";
  return "unknown";
}

const ENGINE_CASE_SQL = `case
  when context_mode like 'azure_voice_live%' then 'azure_voice_live'
  when context_mode = '${DEEPGRAM_MODE}' then 'deepgram'
  when context_mode like 'pipecat%' then 'pipecat_relay'
  when context_mode like 'direct_azure%' then 'azure_gpt_live'
  when open_inputs->>'provider' = 'azure_voice_live' then 'azure_voice_live'
  when open_inputs->>'provider' = 'deepgram' then 'deepgram'
  when error_paths ? 'pipecat' and not thinker_seen then 'pipecat_relay'
  when open_seen then 'azure_gpt_live'
  when error_paths ? 'azure_voice_live' then 'azure_voice_live'
  when error_paths ? 'deepgram' then 'deepgram'
  when error_paths ? 'azure_gpt_live' then 'azure_gpt_live'
  else 'unknown' end`;

/** The session mode when the trace settles it: written by the session, else the only mode of its engine. Voice Live text or microphone is not recorded. */
function sessionModeOf(engine: CallEngine, s: Signals): string | null {
  const written = s.contextMode ?? str(s.openInputs?.sessionMode);
  if (written) return written;
  if (engine === "deepgram") return DEEPGRAM_MODE;
  if (engine === "pipecat_relay") return "pipecat_microphone";
  return null;
}

function signalsOf(events: TraceEvent[]): Signals {
  const s: Signals = { openSeen: false, openInputs: undefined, thinkerSeen: false, errorPaths: [], leadLabel: null };
  for (const e of events) {
    if (!s.leadLabel) s.leadLabel = str(e.leadLabel);
    const data = obj(e.data);
    if (e.type === "voice_error") {
      const path = str(data?.path);
      if (path && !s.errorPaths.includes(path)) s.errorPaths.push(path);
    } else if (e.type === "tool_call") {
      if (data?.tool === "voice_session_open" && !s.openSeen) {
        s.openSeen = true;
        s.openInputs = obj(data.inputs);
      } else if (data?.tool === "thinker_tool_call") s.thinkerSeen = true;
      else if (data?.tool === "agent_context" && !s.contextMode) s.contextMode = str(obj(data.inputs)?.sessionMode) ?? undefined;
    }
  }
  return s;
}

interface TraceBase {
  id: string;
  leadId: string | null;
  direction: unknown;
  startedAt: unknown;
  endedAt: unknown;
  outcomeStatus: unknown;
  disposition: unknown;
  score: unknown;
  turns: { caller: number | null; agent: number | null };
  source: "memory" | "harness_run";
}

function itemFromSignals(base: TraceBase, s: Signals): CallItem {
  const engine = engineOf(s);
  const started = msOf(base.startedAt);
  const ended = msOf(base.endedAt);
  return {
    id: base.id,
    leadId: base.leadId,
    leadName: s.leadLabel ? maskPhones(s.leadLabel) : null,
    startedAt: started === null ? new Date(0).toISOString() : new Date(started).toISOString(),
    endedAt: ended === null ? null : new Date(ended).toISOString(),
    durationMs: started !== null && ended !== null ? Math.max(0, ended - started) : null,
    direction: directionOf(base.direction),
    engine,
    sessionMode: sessionModeOf(engine, s),
    model: str(s.openInputs?.model),
    outcome: { status: str(base.outcomeStatus), disposition: str(base.disposition) },
    // The judge's notes are free text about the call, so they can quote a number.
    score: base.score == null ? null : maskDeep(base.score),
    turns: base.turns,
    source: base.source,
    // A harness_run row read back has no record on this machine to replay.
    recordId: base.source === "memory" ? base.id : null,
  };
}

function turnsOf(transcript: unknown[]): { caller: number; agent: number } {
  let caller = 0;
  let agent = 0;
  for (const line of transcript) {
    const role = obj(line)?.role;
    if (role === "caller") caller += 1;
    else if (role === "agent") agent += 1;
  }
  return { caller, agent };
}

/** A call as its trace tells it: a record on disk or a harness_run row read back. */
interface TraceCall {
  base: TraceBase;
  events: TraceEvent[];
  transcript: unknown[];
}

function lastOf(events: TraceEvent[], type: TraceEvent["type"]): TraceEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i];
  return undefined;
}

/** The record's fields as buildRunRow writes them to harness_run, so both sources read the same. */
function traceCallFromRecord(record: HarnessRecord): TraceCall {
  const events = record.events;
  return {
    base: {
      id: record.recordId,
      leadId: record.leadId,
      direction: record.direction,
      startedAt: record.openedAt,
      endedAt: record.outcome ? (lastOf(events, "call_outcome")?.at ?? null) : null,
      outcomeStatus: record.outcome?.status,
      disposition: obj(lastOf(events, "disposition")?.data)?.value,
      score: obj(lastOf(events, "judge_score")?.data) ?? record.judge ?? null,
      turns: turnsOf(record.transcript),
      source: "memory",
    },
    events,
    transcript: record.transcript,
  };
}

function traceCallFromRow(row: Record<string, unknown>): TraceCall {
  const transcript = arr(row.transcript);
  return {
    base: {
      id: String(row.record_id),
      leadId: str(row.lead_id),
      direction: row.direction,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcomeStatus: row.outcome_status,
      disposition: row.disposition,
      score: row.judge_score ?? null,
      turns: turnsOf(transcript),
      source: "harness_run",
    },
    events: arr(row.trace).filter((e): e is TraceEvent => obj(e) !== undefined),
    transcript,
  };
}

function itemFromTraceCall(call: TraceCall): CallItem {
  return itemFromSignals(call.base, signalsOf(call.events));
}

function summaryOf(replies: CallDetail["metrics"]["replies"], tools: CallDetail["metrics"]["tools"], bargeIns: number, fallback?: { median: number | null; max: number | null }): CallDetail["metrics"]["summary"] {
  const replyMs = replies.map((r) => r.callerFinalToFirstAudioMs).filter((v): v is number => v !== null);
  return {
    medianReplyMs: replyMs.length ? median(replyMs) : (fallback?.median ?? null),
    maxReplyMs: replyMs.length ? Math.max(...replyMs) : (fallback?.max ?? null),
    toolCalls: tools.length,
    toolFailures: tools.filter((t) => !t.ok).length,
    bargeIns,
  };
}

function detailFromTraceCall(call: TraceCall): CallDetail {
  const replies: CallDetail["metrics"]["replies"] = [];
  const tools: CallDetail["metrics"]["tools"] = [];
  const bargeIns: CallDetail["metrics"]["bargeIns"] = [];
  let agentContext: string | null = null;
  let settingsEcho: Record<string, unknown> | null = null;
  for (const e of call.events) {
    if (e.type !== "tool_call") continue;
    const data = obj(e.data) ?? {};
    const inputs = obj(data.inputs) ?? {};
    const at = str(e.at);
    switch (data.tool) {
      case "voice_live_reply_timing":
      case "reply_timing":
        replies.push({
          at,
          // The gpt-live row names its path, not the kind of reply; it is only written for a caller line.
          source: data.tool === "reply_timing" ? "caller_line" : str(inputs.source),
          decisionMs: num(inputs.decisionMs),
          createToFirstAudioMs: num(inputs.createToFirstAudioMs),
          callerFinalToFirstAudioMs: num(inputs.callerFinalToFirstAudioMs),
        });
        break;
      case "voice_live_tool_call":
      case "thinker_tool_call":
        tools.push({ at, name: str(inputs.name), ok: data.success === true, reason: str(data.reason), durationMs: num(data.durationMs) });
        break;
      case "clear_playback":
        if (at) bargeIns.push({ at, reason: str(inputs.reason) });
        break;
      case "agent_context": {
        const text = str(obj(data.result)?.text);
        if (text) agentContext = maskPhones(text);
        break;
      }
      case "voice_live_session_echo":
        settingsEcho ??= obj(data.inputs) ?? null;
        break;
    }
  }
  const transcript: CallDetail["transcript"] = [];
  for (const raw of call.transcript) {
    const line = obj(raw);
    const role = line?.role;
    if ((role !== "agent" && role !== "caller") || typeof line?.text !== "string") continue;
    transcript.push({ role, text: maskPhones(line.text), at: str(line.at), spoken: line.spoken !== false });
  }
  const item = itemFromTraceCall(call);
  return {
    call: item,
    transcript,
    metrics: { replies, tools, bargeIns, summary: summaryOf(replies, tools, bargeIns.length) },
    score: item.score,
    agentContext,
    settingsEcho,
    events: maskDeep(call.events) as TraceEvent[],
    // Replay is GET /api/records/<id>, which reads records on this machine only.
    replayable: item.recordId !== null,
  };
}

// --- source: the record store ---

function memoryCalls(): HarnessRecord[] {
  try {
    return recordStore.list().filter((r) => r.kind === "call");
  } catch (err) {
    console.error(`call history: memory source dropped (${errorCode(err, "records_unreadable")})`);
    return [];
  }
}

// --- source: the harness database ---

function errorCode(err: unknown, fallback: string): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,100}$/.test(err.message) ? err.message : fallback;
}

/** A literal for values already checked against a strict pattern; single quotes doubled all the same. */
function sqlText(value: string): string {
  if (value.includes("\0")) throw new Error("call_history_bad_literal");
  return `'${value.replace(/'/g, "''")}'`;
}

/** One select on the local harness database, with a three-second limit. */
async function harnessSelect(sql: string): Promise<unknown> {
  const target = loadLocalPostgres();
  const quick: ExecFile = (file, args, options, callback) =>
    (execFile as unknown as ExecFile)(file, args, { ...options, timeout: HARNESS_TIMEOUT_MS }, callback);
  const runner = createPsqlRunner({ libpqEnv: { ...target.libpqEnv, PGCONNECT_TIMEOUT: "3" } }, quick);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("harness_run_read_timeout")), HARNESS_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([runner.json(sql), limit]);
  } finally {
    clearTimeout(timer);
  }
}

const ORDER_SQL = `order by started_at desc, record_id collate "C" desc`;
const elements = (column: string) => `jsonb_array_elements(case jsonb_typeof(h.${column}) when 'array' then h.${column} else '[]'::jsonb end)`;
const SIGNALS_SQL = [
  `(select e->'data'->'inputs' from ${elements("trace")} e where e->>'type' = 'tool_call' and e->'data'->>'tool' = 'voice_session_open' limit 1) as open_inputs`,
  `(select e->'data'->'inputs'->>'sessionMode' from ${elements("trace")} e where e->>'type' = 'tool_call' and e->'data'->>'tool' = 'agent_context' limit 1) as context_mode`,
  `exists (select 1 from ${elements("trace")} e where e->>'type' = 'tool_call' and e->'data'->>'tool' = 'voice_session_open') as open_seen`,
  `exists (select 1 from ${elements("trace")} e where e->>'type' = 'tool_call' and e->'data'->>'tool' = 'thinker_tool_call') as thinker_seen`,
  `(select coalesce(jsonb_agg(distinct e->'data'->>'path'), '[]'::jsonb) from ${elements("trace")} e where e->>'type' = 'voice_error' and e->'data'->>'path' is not null) as error_paths`,
  `(select e->>'leadLabel' from ${elements("trace")} e where coalesce(e->>'leadLabel', '') <> '' limit 1) as lead_label`,
  `(select count(*) from ${elements("transcript")} t where t->>'role' = 'caller')::int as caller_turns`,
  `(select count(*) from ${elements("transcript")} t where t->>'role' = 'agent')::int as agent_turns`,
].join(",\n  ");
const LIST_COLUMNS_SQL = "h.record_id, h.lead_id, h.direction, h.started_at, h.ended_at, h.outcome_status, h.disposition, h.judge_score";

/** Newest first, after the cursor, at most `window` rows; the trace is read in the database and only its signals come back. */
export function harnessListSql(q: { leadId?: string; engine?: CallEngine; cursor?: Key }, window: number): string {
  const where = ["kind = 'call'"];
  if (q.leadId) where.push(`lead_id = ${sqlText(q.leadId)}`);
  if (q.cursor) {
    const at = `${sqlText(new Date(q.cursor.ms).toISOString())}::timestamptz`;
    where.push(`(started_at < ${at} or (started_at = ${at} and record_id collate "C" < ${sqlText(q.cursor.id)}))`);
  }
  const aggregate = `coalesce(json_agg(r order by r.started_at desc, r.record_id collate "C" desc), '[]'::json)`;
  if (!q.engine) {
    // Order and limit first, so only the rows returned have their trace read.
    return `select ${aggregate} from (select ${LIST_COLUMNS_SQL},\n  ${SIGNALS_SQL}\nfrom (select * from ${HARNESS_RUN_TABLE} where ${where.join(" and ")} ${ORDER_SQL} limit ${window}) h) r;`;
  }
  return `select ${aggregate} from (select * from (select ${LIST_COLUMNS_SQL},\n  ${SIGNALS_SQL}\nfrom ${HARNESS_RUN_TABLE} h where ${where.join(" and ")}) s where (${ENGINE_CASE_SQL}) = ${sqlText(q.engine)} ${ORDER_SQL} limit ${window}) r;`;
}

function itemFromHarnessRow(row: Record<string, unknown>): CallItem {
  const signals: Signals = {
    openSeen: row.open_seen === true,
    contextMode: str(row.context_mode) ?? undefined,
    openInputs: obj(row.open_inputs),
    thinkerSeen: row.thinker_seen === true,
    errorPaths: arr(row.error_paths).filter((p): p is string => typeof p === "string"),
    leadLabel: str(row.lead_label),
  };
  return itemFromSignals(
    {
      id: String(row.record_id),
      leadId: str(row.lead_id),
      direction: row.direction,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcomeStatus: row.outcome_status,
      disposition: row.disposition,
      score: row.judge_score ?? null,
      turns: { caller: num(row.caller_turns), agent: num(row.agent_turns) },
      source: "harness_run",
    },
    signals,
  );
}

async function harnessRowById(id: string): Promise<Record<string, unknown> | undefined> {
  try {
    const answer = await harnessSelect(
      `select row_to_json(r) from (select record_id, lead_id, direction, started_at, ended_at, outcome_status, disposition, judge_score, transcript, trace from ${HARNESS_RUN_TABLE} where kind = 'call' and record_id = ${sqlText(id)} limit 1) r;`,
    );
    return obj(answer);
  } catch (err) {
    console.error(`call history: harness_run source dropped (${errorCode(err, "harness_run_read_failed")})`);
    return undefined;
  }
}

// --- source: the local Pipecat engine ---

/** One GET to the engine with the proxy's key and agency header. Undefined when the key is missing or the engine is unreachable. */
function engineGet(path: string): Promise<{ status: number; body: unknown } | undefined> {
  const key = engineApiKey();
  if (!key) return Promise.resolve(undefined);
  const target = new URL(path, PIPECAT_ENGINE_ORIGIN);
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.host, accept: "application/json", authorization: `Bearer ${key}`, "x-voice-harness-agency": ENGINE_AGENCY_ID },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ENGINE_MAX_BYTES) return req.destroy();
          chunks.push(chunk);
        });
        res.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("error", () => resolve(undefined));
      },
    );
    const timer = setTimeout(() => req.destroy(), ENGINE_TIMEOUT_MS);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

function engineKeyOf(row: Record<string, unknown>): Key | undefined {
  const ms = msOf(row.startedAt);
  const id = str(row.callId);
  return ms === null || !id ? undefined : { ms, id };
}

/** An engine row (list or detail) as one list item. Built field by field: the engine's commit, port and agency stay out. */
function itemFromEngineRow(row: Record<string, unknown>, transcript?: unknown[]): CallItem {
  const lead = obj(row.lead);
  const config = obj(row.config) ?? {};
  const started = msOf(row.startedAt);
  const ended = msOf(row.endedAt);
  const leadName = str(lead?.name);
  return {
    id: String(row.callId),
    leadId: str(lead?.id),
    leadName: leadName ? maskPhones(leadName) : null,
    startedAt: started === null ? new Date(0).toISOString() : new Date(started).toISOString(),
    endedAt: ended === null ? null : new Date(ended).toISOString(),
    durationMs: started !== null && ended !== null ? Math.max(0, ended - started) : null,
    direction: directionOf(row.direction),
    engine: "pipecat_engine",
    sessionMode: str(config.voicePath),
    model: str(config.realtimeModel) ?? str(config.replyModel) ?? str(config.replyDeployment),
    outcome: { status: str(row.status), disposition: str(obj(row.measured)?.disposition) },
    // The engine keeps its own score rows (people and its judge), not a post-call judge_score.
    score: null,
    turns: transcript ? turnsOf(transcript.map((l) => ({ role: roleOf(obj(l)) }))) : { caller: null, agent: null },
    source: "pipecat_engine",
    recordId: null,
  };
}

function roleOf(line: Record<string, unknown> | undefined): "agent" | "caller" | null {
  const who = str(line?.role) ?? str(line?.speaker);
  if (!who) return null;
  if (["agent", "assistant", "bot"].includes(who)) return "agent";
  if (["caller", "user", "human", "customer"].includes(who)) return "caller";
  return null;
}

function detailFromEngine(row: Record<string, unknown>): CallDetail {
  const rawTranscript = arr(row.transcript);
  const call = itemFromEngineRow(row, rawTranscript);
  const transcript: CallDetail["transcript"] = [];
  for (const raw of rawTranscript) {
    const line = obj(raw);
    const role = roleOf(line);
    if (!role || typeof line?.text !== "string") continue;
    transcript.push({ role, text: maskPhones(line.text), at: isoOf(line.at), spoken: true });
  }
  const replies: CallDetail["metrics"]["replies"] = arr(row.turns)
    .map((t) => num(obj(t)?.turnMs))
    .filter((ms): ms is number => ms !== null)
    .map((ms) => ({ at: null, source: "engine_turn", decisionMs: null, createToFirstAudioMs: null, callerFinalToFirstAudioMs: ms }));
  const startedMs = msOf(row.startedAt);
  const tools: CallDetail["metrics"]["tools"] = arr(row.toolEvents).map((raw) => {
    const t = obj(raw) ?? {};
    // startedAt is seconds since the call started.
    const offset = num(t.startedAt);
    return {
      at: startedMs !== null && offset !== null ? new Date(startedMs + Math.round(offset * 1000)).toISOString() : null,
      name: str(t.name),
      ok: t.ok === true,
      reason: str(t.reason),
      durationMs: num(t.ms),
    };
  });
  const latency = obj(row.latency);
  return {
    call,
    transcript,
    metrics: { replies, tools, bargeIns: [], summary: summaryOf(replies, tools, 0, { median: num(latency?.medianMs), max: num(latency?.worstMs) }) },
    score: null,
    agentContext: null,
    settingsEcho: null,
    events: null,
    replayable: false,
  };
}

// --- the list ---

interface ListQuery {
  limit: number;
  leadId?: string;
  engine?: CallEngine;
  cursor?: Key;
}

interface SourcePage {
  items: Array<{ key: Key; item: CallItem }>;
  /** Set when the window came back full: the oldest row read, past which this source was not looked at. */
  horizon?: Key;
}

function parseListQuery(url: URL): ListQuery | { error: string } {
  const q: ListQuery = { limit: DEFAULT_LIMIT };
  const limit = url.searchParams.get("limit");
  if (limit !== null && limit !== "") {
    const n = Number(limit);
    q.limit = Number.isInteger(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;
  }
  const leadId = url.searchParams.get("leadId");
  if (leadId) {
    if (!LEAD_ID.test(leadId)) return { error: "lead_id_invalid" };
    q.leadId = leadId;
  }
  const engine = url.searchParams.get("engine");
  if (engine) {
    if (!ENGINES.includes(engine as CallEngine)) return { error: "engine_unknown" };
    q.engine = engine as CallEngine;
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const key = decodeCursor(cursor);
    if (!key) return { error: "cursor_invalid" };
    q.cursor = key;
  }
  return q;
}

function memoryPage(records: HarnessRecord[], q: ListQuery, window: number): SourcePage {
  const rows: Array<{ key: Key; item: CallItem }> = [];
  for (const record of records) {
    if (q.leadId && record.leadId !== q.leadId) continue;
    const ms = msOf(record.openedAt) ?? 0;
    const key = { ms, id: record.recordId };
    if (q.cursor && !isAfter(key, q.cursor)) continue;
    const item = itemFromTraceCall(traceCallFromRecord(record));
    if (q.engine && item.engine !== q.engine) continue;
    rows.push({ key, item });
  }
  rows.sort((a, b) => compareKeys(a.key, b.key));
  const items = rows.slice(0, window);
  return { items, horizon: items.length === window ? items[items.length - 1]!.key : undefined };
}

async function harnessPage(q: ListQuery, window: number, onDisk: Set<string>): Promise<SourcePage> {
  if (q.engine === "pipecat_engine") return { items: [] };
  let answer: unknown;
  try {
    answer = await harnessSelect(harnessListSql(q, window));
  } catch (err) {
    console.error(`call history: harness_run source dropped (${errorCode(err, "harness_run_read_failed")})`);
    return { items: [] };
  }
  const rows = arr(answer).map(obj).filter((r): r is Record<string, unknown> => r !== undefined);
  const read = rows
    .map((row) => ({ key: { ms: msOf(row.started_at) ?? 0, id: String(row.record_id) }, row }))
    .sort((a, b) => compareKeys(a.key, b.key));
  return {
    items: read.filter(({ row }) => !onDisk.has(String(row.record_id))).map(({ key, row }) => ({ key, item: itemFromHarnessRow(row) })),
    horizon: read.length === window ? read[read.length - 1]!.key : undefined,
  };
}

async function enginePage(q: ListQuery, window: number): Promise<SourcePage> {
  if (q.engine && q.engine !== "pipecat_engine") return { items: [] };
  const size = Math.min(window, ENGINE_MAX_LIMIT);
  // One millisecond past the cursor, so rows in the cursor's own millisecond come back and the id decides.
  const before = q.cursor ? `&before=${encodeURIComponent(new Date(q.cursor.ms + 1).toISOString())}` : "";
  const answer = await engineGet(`/api/calls/history?limit=${size}${before}`);
  if (!answer) return { items: [] };
  if (answer.status !== 200) {
    console.error(`call history: pipecat engine source dropped (status ${answer.status})`);
    return { items: [] };
  }
  const read: Array<{ key: Key; row: Record<string, unknown> }> = [];
  for (const raw of arr(obj(answer.body)?.calls)) {
    const row = obj(raw);
    const key = row && engineKeyOf(row);
    if (row && key) read.push({ key, row });
  }
  read.sort((a, b) => compareKeys(a.key, b.key));
  const items = read
    .filter(({ key, row }) => (!q.cursor || isAfter(key, q.cursor)) && (!q.leadId || str(obj(row.lead)?.id) === q.leadId))
    .map(({ key, row }) => ({ key, item: itemFromEngineRow(row) }));
  return { items, horizon: read.length === size ? read[read.length - 1]!.key : undefined };
}

/**
 * The engine call id a Pipecat call's record on this machine stands for (the page sends Pipecat rows to
 * POST /api/trace/pipecat, recordId pipecat_<base36>): its call_outcome row's providerCallId, else its pipecat_call
 * row's inputs.callId. Undefined for any other record.
 */
function engineCallIdOf(record: HarnessRecord): string | undefined {
  if (!record.recordId.startsWith("pipecat_")) return undefined;
  for (const e of record.events) {
    const data = obj(e.data);
    if (e.type === "call_outcome" && str(data?.providerCallId)) return str(data?.providerCallId) ?? undefined;
    if (e.type === "tool_call" && data?.tool === "pipecat_call" && str(obj(data.inputs)?.callId)) return str(obj(data.inputs)?.callId) ?? undefined;
  }
  return undefined;
}

export async function listCalls(q: ListQuery): Promise<{ calls: CallItem[]; nextCursor: string | null }> {
  const window = q.limit + 1;
  // A Pipecat call is listed once, as the engine's row, with the record on this machine as its recordId (so the
  // console can replay it); the record itself is left out of the memory source.
  const engineRecords = new Map<string, string>();
  const records = memoryCalls().filter((r) => {
    const engineId = engineCallIdOf(r);
    if (engineId) engineRecords.set(engineId, r.recordId);
    return !engineId;
  });
  const onDisk = new Set(records.map((r) => r.recordId));
  const memory: SourcePage = q.engine === "pipecat_engine" ? { items: [] } : memoryPage(records, q, window);
  const [harness, engine] = await Promise.all([harnessPage(q, window, onDisk), enginePage(q, window)]);
  const seen = new Set<string>();
  const merged: Array<{ key: Key; item: CallItem }> = [];
  for (const page of [memory, harness, engine]) {
    for (const entry of page.items) {
      if (seen.has(entry.item.id)) continue;
      seen.add(entry.item.id);
      merged.push(entry);
    }
  }
  for (const entry of merged) {
    const recordId = entry.item.source === "pipecat_engine" ? engineRecords.get(entry.item.id) : undefined;
    if (recordId) entry.item.recordId = recordId;
  }
  merged.sort((a, b) => compareKeys(a.key, b.key));
  // The nearest horizon bounds the page: a source that stopped reading there may hold older calls not yet seen.
  let horizon: Key | undefined;
  for (const page of [memory, harness, engine]) {
    if (page.horizon && (!horizon || compareKeys(page.horizon, horizon) < 0)) horizon = page.horizon;
  }
  const kept = horizon ? merged.filter((e) => !isAfter(e.key, horizon!)) : merged;
  const page = kept.slice(0, q.limit);
  let nextCursor: string | null = null;
  if (kept.length > q.limit) nextCursor = encodeCursor(page[page.length - 1]!.key);
  else if (horizon) nextCursor = encodeCursor(horizon);
  return { calls: page.map((e) => e.item), nextCursor };
}

// --- one call ---

export async function callDetail(id: string): Promise<CallDetail | undefined> {
  let record: HarnessRecord | undefined;
  try {
    record = recordStore.read(id);
  } catch {
    record = undefined; // an unreadable file reads as not on disk
  }
  if (record && record.kind === "call") return detailFromTraceCall(traceCallFromRecord(record));
  const [row, engine] = await Promise.all([harnessRowById(id), engineGet(`/api/calls/history/${encodeURIComponent(id)}`)]);
  if (row) return detailFromTraceCall(traceCallFromRow(row));
  const engineRow = engine?.status === 200 ? obj(engine.body) : undefined;
  return engineRow ? detailFromEngine(engineRow) : undefined;
}

// --- the route ---

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** GET /api/calls and GET /api/calls/<id>. Returns false for anything else. */
export async function handleCallsRoute(method: string, path: string, url: URL, res: ServerResponse): Promise<boolean> {
  if (method !== "GET") return false;
  if (path === "/api/calls") {
    const q = parseListQuery(url);
    if ("error" in q) {
      send(res, 400, { error: q.error });
      return true;
    }
    send(res, 200, await listCalls(q));
    return true;
  }
  const match = path.match(/^\/api\/calls\/([^/]+)$/);
  if (!match || !CALL_ID.test(match[1]!)) return false;
  const detail = await callDetail(match[1]!);
  if (detail) send(res, 200, detail);
  else send(res, 404, { error: "call_not_found" });
  return true;
}
