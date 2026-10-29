/**
 * The person's own rating of a call, given in the console's pop-up after the
 * call ends: a few 1 to 5 marks, a note, and a snapshot of the setup the call
 * ran on (engine, voice path, model, voice, prompt setup, decision tree), so
 * the ratings say which models and configurations people liked.
 *
 *   POST /api/calls/rating   {callId, engine, scores:{overall, natural, understood, quick, helpful}, note?, setup:{...}}
 *   GET  /api/calls/ratings  {ratings:[...newest first], bySetup:[{key, label, count, overall, natural, understood, quick, helpful}]}
 *
 * Ratings go to data/user-ratings.jsonl, one line each, whatever engine the
 * call ran on. A harness call also gets a user_rating tool row in its trace,
 * so the run write-back carries it to the local harness table.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { traceBus } from "../trace/events.js";
import { voiceLiveDecisionTreeOn } from "./voice/manager.js";

const here = dirname(fileURLToPath(import.meta.url));
export const RATINGS_FILE = process.env.VOICE_HARNESS_RATINGS_FILE ?? join(here, "..", "..", "data", "user-ratings.jsonl");

export const RATING_KEYS = ["overall", "natural", "understood", "quick", "helpful"] as const;
export type RatingKey = (typeof RATING_KEYS)[number];
export const RATING_LABELS: Record<RatingKey, string> = { overall: "Overall", natural: "Sounded natural", understood: "Understood me", quick: "Quick to answer", helpful: "Helpful" };

export interface RatingSetup {
  engine: string;
  orchestrator?: string;
  voicePath?: string;
  model?: string;
  voice?: string;
  promptSetup?: string;
  decisionTree?: string;
  decisionModule?: string;
  preset?: string;
  /** Azure Voice Live: "step_by_step" or "one_prompt". */
  flow?: string;
  extra?: Record<string, string | number | boolean>;
}

export interface UserRating {
  id: string;
  at: string;
  callId: string;
  leadId?: string;
  scores: Record<RatingKey, number>;
  note?: string;
  setup: RatingSetup;
}

const SHORT = /^[A-Za-z0-9 _.:\/()+,-]{0,120}$/;

function str(v: unknown, max = 120): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t ? t : undefined;
}

/** Validates the body; throws a short code. The note is free text (the rater's own words) and is kept as is, capped. */
export function ratingFrom(body: Record<string, unknown>, now: () => Date = () => new Date()): UserRating {
  const callId = str(body.callId, 80);
  if (!callId) throw new Error("rating_call_id_missing");
  const rawScores = body.scores && typeof body.scores === "object" ? (body.scores as Record<string, unknown>) : {};
  const scores = {} as Record<RatingKey, number>;
  for (const k of RATING_KEYS) {
    const v = rawScores[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) throw new Error(`rating_${k}_invalid`);
    scores[k] = v;
  }
  const rawSetup = body.setup && typeof body.setup === "object" ? (body.setup as Record<string, unknown>) : {};
  const engine = str(rawSetup.engine) ?? str(body.engine);
  if (!engine || !SHORT.test(engine)) throw new Error("rating_engine_missing");
  const setup: RatingSetup = { engine };
  for (const k of ["orchestrator", "voicePath", "model", "voice", "promptSetup", "decisionTree", "decisionModule", "preset", "flow"] as const) {
    const v = str(rawSetup[k]);
    if (v && SHORT.test(v)) setup[k] = v;
  }
  if (rawSetup.extra && typeof rawSetup.extra === "object") {
    const extra: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(rawSetup.extra as Record<string, unknown>).slice(0, 12)) {
      if (SHORT.test(k) && (typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && SHORT.test(v)))) extra[k] = v;
    }
    if (Object.keys(extra).length) setup.extra = extra;
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  const at = now().toISOString();
  return { id: `rating_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at, callId, leadId: str(body.leadId, 80), scores, ...(note ? { note } : {}), setup };
}

export function saveRating(rating: UserRating, file: string = RATINGS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rating)}\n`, { mode: 0o600 });
}

export function readRatings(file: string = RATINGS_FILE): UserRating[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as UserRating]; } catch { return []; }
  }).reverse();
}

/** The setup words that tell one configuration from another, as one key and one label. */
export function setupKey(s: RatingSetup): { key: string; label: string } {
  const parts = [s.engine, s.preset ?? s.voicePath, s.model, s.voice, s.promptSetup, s.flow ? s.flow.replace(/_/g, " ") : undefined].filter((p): p is string => Boolean(p));
  return { key: parts.join("|"), label: parts.join(" · ") };
}

export interface SetupSummary { key: string; label: string; count: number; overall: number; natural: number; understood: number; quick: number; helpful: number; latestAt: string }

export function summarizeBySetup(ratings: UserRating[]): SetupSummary[] {
  const groups = new Map<string, { label: string; rows: UserRating[] }>();
  for (const r of ratings) {
    const { key, label } = setupKey(r.setup);
    const g = groups.get(key) ?? { label, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const avg = (rows: UserRating[], k: RatingKey) => Math.round((rows.reduce((n, r) => n + r.scores[k], 0) / rows.length) * 10) / 10;
  return [...groups.entries()].map(([key, g]) => ({
    key, label: g.label, count: g.rows.length,
    overall: avg(g.rows, "overall"), natural: avg(g.rows, "natural"), understood: avg(g.rows, "understood"), quick: avg(g.rows, "quick"), helpful: avg(g.rows, "helpful"),
    latestAt: g.rows.map((r) => r.at).sort().pop() ?? "",
  })).sort((a, b) => b.overall - a.overall || b.count - a.count);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const json = JSON.parse(text);
  return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
}

/** Returns true when it handled the request. */
export async function handleRatingRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path === "/api/calls/ratings" && method === "GET") {
    const ratings = readRatings();
    return send(res, 200, { ratings: ratings.slice(0, 200), bySetup: summarizeBySetup(ratings) }), true;
  }
  if (path !== "/api/calls/rating") return false;
  if (method !== "POST") return send(res, 405, { error: "method_not_allowed" }), true;
  let rating: UserRating;
  try {
    rating = ratingFrom(await readJson(req));
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : "rating_invalid" }), true;
  }
  // A harness call's rating records the model and voice the call ran, from its own voice_session_open row, whatever the page sent.
  const own = traceBus.history().find((e) => e.callId === rating.callId);
  const openRow = own ? [...traceBus.history()].reverse().find((e) => e.callId === rating.callId && e.type === "tool_call" && e.data.tool === "voice_session_open") : undefined;
  const openInputs = (openRow?.data.inputs ?? {}) as Record<string, unknown>;
  for (const key of ["model", "voice"] as const) {
    const v = openInputs[key];
    if (typeof v === "string" && v) rating.setup[key] = v.slice(0, 120);
  }
  if (typeof openInputs.provider === "string" && openInputs.provider === "azure_voice_live") rating.setup.engine = "Azure Voice Live";
  else if (typeof openInputs.provider === "string" && openInputs.provider === "deepgram") rating.setup.engine = "Deepgram";
  // The decision tree the call ran with, on every engine: the open row's decisionTree, else the agent context row's, else the toggle as it stands now (a rating follows its call closely).
  const contextRow = own ? [...traceBus.history()].reverse().find((e) => e.callId === rating.callId && e.type === "tool_call" && e.data.tool === "agent_context") : undefined;
  const contextInputs = (contextRow?.data.inputs ?? {}) as Record<string, unknown>;
  const treeSaid = openInputs.decisionTree ?? contextInputs.decisionTree;
  // Voice Live's flow from the call: the open row's decisionRouter voice_live_flow means the five steps ran; else the agent context row's choice.
  if (openInputs.provider === "azure_voice_live") {
    const flow = openInputs.decisionRouter === "voice_live_flow" ? "step_by_step" : typeof contextInputs.voiceLiveFlow === "string" ? contextInputs.voiceLiveFlow : undefined;
    if (flow && SHORT.test(flow)) rating.setup.flow = flow;
  }
  if (own && openInputs.provider !== "pipecat") {
    const treeOn = treeSaid === "on" ? true : treeSaid === "off" ? false : voiceLiveDecisionTreeOn();
    if (!treeOn) rating.setup.decisionTree = "off";
    rating.setup.extra = { ...(rating.setup.extra ?? {}), voiceLiveDecisionTree: treeOn };
  }
  saveRating(rating);
  // A harness call gets the rating in its own trace too, so the run write-back carries it.
  if (own) {
    traceBus.emit({
      type: "tool_call", leadId: own.leadId, leadLabel: own.leadLabel, recordId: own.recordId, channel: own.channel, direction: own.direction, callId: own.callId,
      data: { tool: "user_rating", inputs: { scores: rating.scores, setup: rating.setup, ...(rating.note ? { note: rating.note } : {}) }, result: null, success: true, durationMs: 0 },
    });
  }
  return send(res, 200, { ok: true, rating }), true;
}
