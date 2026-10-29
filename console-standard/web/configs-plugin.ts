import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  COMMON_VOICES, DIRECTION_LABELS, ENDPOINTING_VALUES, LEAD_LABELS, ORCHESTRATION_LABELS, REPLY_LABELS, STT_LABELS,
  VAD_STOP_VALUES, VOICE_PATH_LABELS, type Choice, type Config, type Options,
} from "./src/config/options";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schema = JSON.parse(readFileSync(join(root, "configs-schema.json"), "utf8"));
const SEED = join(root, "configs.seed.json");
const SAVED = join(root, "configs.saved.json");
const voicePattern = new RegExp(schema.voicePattern);

const promptSetupPattern = new RegExp(schema.promptSetupPattern);
const PROMPT_SETUPS_URL = `${process.env.CONSOLE_STANDARD_HARNESS_URL ?? "http://127.0.0.1:4311"}/api/prompt-setups`;

// A missing, unreadable or corrupt file reads as empty (with a warning) so it can never crash the page server.
const readRaw = (file: string): any[] => {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("not a list");
    return parsed;
  } catch (err) {
    console.warn(`configs: ${file} ignored (${err instanceof Error ? err.message : "unreadable"})`);
    return [];
  }
};
/** A seed entry without the newer fields takes the schema defaults. */
const readSeed = (): Config[] => readRaw(SEED).filter((e) => e && typeof e === "object").map((e) => ({ ...schema.defaults, ...e }));
/** Saved entries are re-validated on load, so a hand-edited file cannot put unvalidated values in the dropdown. */
const readSaved = (): Config[] => {
  const out: Config[] = [];
  for (const entry of readRaw(SAVED)) {
    try {
      const { id, ...fields } = entry;
      const clean = validateConfig(fields);
      if (id === clean.id) out.push(clean);
    } catch { /* dropped */ }
  }
  return out;
};
const nameKey = (name: string) => name.trim().toLowerCase();
const hasControl = (s: string) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
const inRange = (v: unknown, r: { min: number; max: number }, integer: boolean) =>
  typeof v === "number" && Number.isFinite(v) && (!integer || Number.isInteger(v)) && v >= r.min && v <= r.max;

/** Checks a configuration against the same allowlist the bot enforces. Only model ids and settings: no credentials. */
export function validateConfig(raw: any): Config {
  const allowed = new Set(["name", "note", "sttModel", "replyDeployment", "voice", "endpointingMs", "vadStopSecs", "voicePath", "orchestration", "promptSetup", "lead", "direction"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config");
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`field ${key}`);
  // A missing newer field takes the schema default; a present one is checked like the rest.
  const d = schema.defaults;
  for (const key of ["voicePath", "orchestration", "promptSetup", "lead", "direction"]) if (raw[key] === undefined) raw = { ...raw, [key]: d[key] };
  if (!schema.voicePaths.includes(raw.voicePath)) throw new Error("voicePath");
  if (!schema.orchestrations.includes(raw.orchestration)) throw new Error("orchestration");
  if (typeof raw.promptSetup !== "string" || !promptSetupPattern.test(raw.promptSetup)) throw new Error("promptSetup");
  if (!schema.leads.includes(raw.lead)) throw new Error("lead");
  if (!schema.directions.includes(raw.direction)) throw new Error("direction");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > schema.nameMaxLength || hasControl(name)) throw new Error("name");
  if (!schema.sttModels.includes(raw.sttModel)) throw new Error("sttModel");
  if (!schema.replyDeployments.includes(raw.replyDeployment)) throw new Error("replyDeployment");
  if (typeof raw.voice !== "string" || !voicePattern.test(raw.voice)) throw new Error("voice");
  if (!inRange(raw.endpointingMs, schema.endpointingMs, true)) throw new Error("endpointingMs");
  if (!inRange(raw.vadStopSecs, schema.vadStopSecs, false)) throw new Error("vadStopSecs");
  if (raw.note !== undefined && (typeof raw.note !== "string" || raw.note.length > 120 || hasControl(raw.note))) throw new Error("note");
  const note = raw.note || undefined;
  // The id carries a short hash of the lower-cased name, so different names never share an id and the same name replaces itself.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "config";
  const id = `saved-${slug}-${createHash("sha256").update(nameKey(name)).digest("hex").slice(0, 8)}`;
  return { id, name, ...(note ? { note } : {}), sttModel: raw.sttModel, replyDeployment: raw.replyDeployment, voice: raw.voice, endpointingMs: raw.endpointingMs, vadStopSecs: raw.vadStopSecs, voicePath: raw.voicePath, orchestration: raw.orchestration, promptSetup: raw.promptSetup, lead: raw.lead, direction: raw.direction };
}

const pick = (map: Record<string, [string, string]>, id: string): Choice => ({ id, label: map[id]?.[0] ?? id, description: map[id]?.[1] ?? "" });

/** Reads prompt setup ids from the harness page; any failure or odd shape means just "default". Ids are checked by the schema pattern. */
export async function fetchPromptSetups(fetchImpl: typeof fetch = fetch, url = PROMPT_SETUPS_URL): Promise<Choice[]> {
  const fallback: Choice[] = [{ id: "default", label: "Default", description: "The standard prompt setup." }];
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return fallback;
    const body: any = await res.json();
    const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.promptSetups) ? body.promptSetups : Array.isArray(body?.setups) ? body.setups : [];
    const seen = new Set<string>();
    const out: Choice[] = [];
    for (const item of list) {
      const id = typeof item === "string" ? item : item?.id;
      if (typeof id !== "string" || !promptSetupPattern.test(id) || seen.has(id)) continue;
      seen.add(id);
      const label = typeof item?.name === "string" && item.name.length <= 60 && !hasControl(item.name) ? item.name : id;
      const description = typeof item?.description === "string" && item.description.length <= 160 && !hasControl(item.description) ? item.description : "";
      out.push({ id, label, description });
    }
    if (!seen.has("default")) out.unshift(fallback[0]);
    return out.slice(0, 50);
  } catch {
    return fallback;
  }
}

/** The allowed choices, built from the schema with plain labels. Only identifiers and text: no credentials. */
export async function buildOptions(promptSetups: () => Promise<Choice[]> = fetchPromptSetups): Promise<Options> {
  return {
    voicePaths: schema.voicePaths.map((id: string) => ({ ...pick(VOICE_PATH_LABELS, id), available: true })).concat([
      { ...pick(VOICE_PATH_LABELS, "azure_speech_to_speech"), available: false, reason: "not built yet" },
    ]),
    sttModels: schema.sttModels.map((id: string) => pick(STT_LABELS, id)),
    replyDeployments: schema.replyDeployments.map((id: string) => pick(REPLY_LABELS, id)),
    voices: COMMON_VOICES.filter((v) => voicePattern.test(v.id)),
    endpointingMs: ENDPOINTING_VALUES.filter((v) => inRange(v, schema.endpointingMs, true)).map((v) => ({ id: v, label: `${v} ms`, description: v <= 200 ? "Quick: answers sooner, may cut in on pauses." : v >= 600 ? "Patient: waits through longer pauses." : "Balanced pause before the caller counts as finished." })),
    vadStopSecs: VAD_STOP_VALUES.filter((v) => inRange(v, schema.vadStopSecs, false)).map((v) => ({ id: v, label: `${v} s`, description: "Silence that ends the caller's turn in voice detection." })),
    orchestrations: schema.orchestrations.map((id: string) => pick(ORCHESTRATION_LABELS, id)),
    promptSetups: await promptSetups(),
    leads: schema.leads.map((id: string) => pick(LEAD_LABELS, id)),
    directions: schema.directions.map((id: string) => pick(DIRECTION_LABELS, id)),
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("too_large")); req.pause(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const isPageOrigin = (origin: string | undefined, port: number) => origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

/** POST /start (the Connect click) must come from this page, as JSON, with a small declared length; nothing else is forwarded to the bot. */
export function startGuard(port: number, limit = 4096) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url || req.url.split("?")[0] !== "/start") return next();
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    if (!isPageOrigin(req.headers.origin, port)) return send(res, 403, { error: "forbidden_origin" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "json_only" });
    const length = Number(req.headers["content-length"]);
    if (!Number.isInteger(length) || length < 0) return send(res, 411, { error: "length_required" });
    if (length > limit) return send(res, 413, { error: "too_large" });
    return next();
  };
}

/** GET /options lists the allowed choices. GET /configs lists seeded and saved configurations; POST /configs saves one. Same origin only. */
export function configsPlugin(port: number): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split("?")[0];
    if (path === "/options") {
      if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      try { return send(res, 200, await buildOptions()); } catch { return send(res, 500, { error: "server_error" }); }
    }
    if (!req.url || path !== "/configs") return next();
    try {
      if (req.method === "GET") return send(res, 200, { configs: [...readSeed(), ...readSaved()] });
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      if (!isPageOrigin(req.headers.origin, port)) return send(res, 403, { error: "forbidden_origin" });
      let config: Config;
      try {
        config = validateConfig(JSON.parse(await readBody(req)));
      } catch (err) {
        if (err instanceof Error && err.message === "too_large") return send(res, 413, { error: "too_large" });
        return send(res, 400, { error: err instanceof Error && !(err instanceof SyntaxError) ? err.message : "bad_request" });
      }
      if (readSeed().some((c) => nameKey(c.name) === nameKey(config.name))) return send(res, 409, { error: "name_taken" });
      const saved = readSaved().filter((c) => c.id !== config.id);
      if (saved.length >= schema.maxSaved) return send(res, 409, { error: "too_many_saved" });
      // Write to a temporary file and rename it, so an interrupted write cannot leave a truncated file.
      const temporary = `${SAVED}.tmp`;
      writeFileSync(temporary, JSON.stringify([...saved, config], null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, SAVED);
      return send(res, 200, { config });
    } catch (err) {
      console.warn(`configs: request failed (${err instanceof Error ? err.message : "error"})`);
      return send(res, 500, { error: "server_error" });
    }
  };
  const guard = startGuard(port);
  return {
    name: "crm-console-configs",
    configureServer: (server) => { server.middlewares.use(guard); server.middlewares.use(handler); },
    configurePreviewServer: (server) => { server.middlewares.use(guard); server.middlewares.use(handler); },
  };
}
