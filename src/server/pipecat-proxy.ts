/**
 * The local Pipecat engine (http://127.0.0.1:4352) accepts calls only from this
 * machine and never cross-origin from a browser, so the 4318 server proxies the
 * paths the console needs under /api/pipecat/. The prefix is stripped; the
 * engine sees a loopback request with no Origin header. Bodies and responses
 * stream through as they are (the live call feed is server-sent events), so a
 * long response never buffers here. Brief: research note, pipecat-engine-for-4318.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

export const PIPECAT_PROXY_PREFIX = "/api/pipecat";
export const PIPECAT_ENGINE_ORIGIN = process.env.VOICE_HARNESS_PIPECAT_ENGINE ?? "http://127.0.0.1:4352";

/** The engine paths the console may reach, and the methods for each. Nothing else passes. */
const ALLOWED: Array<{ pattern: RegExp; methods: string[] }> = [
  { pattern: /^\/start(\?.*)?$/, methods: ["POST"] },
  { pattern: /^\/sessions\/[0-9a-f-]{36}\/api\/offer(\?.*)?$/, methods: ["POST", "PATCH"] },
  { pattern: /^\/api\/health$/, methods: ["GET"] },
  { pattern: /^\/api\/engine-config$/, methods: ["GET"] },
  { pattern: /^\/api\/calls\/live(\?.*)?$/, methods: ["GET"] },
  { pattern: /^\/api\/calls\/history(\/[A-Za-z0-9_-]+)?(\?.*)?$/, methods: ["GET"] },
];

/** The engine key file; the key is read on each live feed request and never logged, sent to the browser or stored elsewhere. */
export const ENGINE_KEY_FILE = process.env.VOICE_HARNESS_PIPECAT_ENGINE_ENV_FILE ?? join(homedir(), ".voice-harness-secrets", "console-engine.env");
/** The CRM development agency the engine files calls under. */
export const ENGINE_AGENCY_ID = "00000000-0000-0000-0000-0000000d0001";

/** ENGINE_API_KEY from the key file, or undefined when the file or the line is missing. */
export function engineApiKey(file: string = ENGINE_KEY_FILE): string | undefined {
  try {
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("ENGINE_API_KEY="));
    const value = line?.slice("ENGINE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Every engine route but the health check needs the key and the agency: without them the engine answers as the empty "local" agency, or refuses. */
export function needsEngineKey(path: string): boolean {
  return !/^\/api\/health$/.test(path);
}

/** The engine path for a console request, or null when the request is not for the engine or is not allowed. */
export function enginePathFor(method: string, url: string): string | null {
  if (!url.startsWith(`${PIPECAT_PROXY_PREFIX}/`)) return null;
  const rest = url.slice(PIPECAT_PROXY_PREFIX.length);
  const rule = ALLOWED.find((r) => r.pattern.test(rest));
  return rule && rule.methods.includes(method) ? rest : null;
}

/** Proxies one request to the engine. Returns false when the request is not for the engine; writes 403 when it is but is not allowed. */
export function handlePipecatProxy(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "/";
  if (!url.startsWith(`${PIPECAT_PROXY_PREFIX}/`)) return false;
  const method = req.method ?? "GET";
  const path = enginePathFor(method, url);
  if (!path) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "pipecat_path_not_allowed" }));
    return true;
  }
  const target = new URL(path, PIPECAT_ENGINE_ORIGIN);
  // Only the headers the engine needs; never the browser's Origin, Host or cookies.
  const headers: Record<string, string> = { host: target.host, accept: String(req.headers.accept ?? "*/*") };
  if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
  if (req.headers["content-length"]) headers["content-length"] = String(req.headers["content-length"]);
  if (needsEngineKey(path)) {
    const key = engineApiKey();
    if (!key) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "pipecat_engine_key_missing", fix: `Put ENGINE_API_KEY in ${ENGINE_KEY_FILE}` }));
      return true;
    }
    headers.authorization = `Bearer ${key}`;
    headers["x-voice-harness-agency"] = ENGINE_AGENCY_ID;
  }
  const upstream = httpRequest({ method, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers }, (up) => {
    const out: Record<string, string> = { "cache-control": "no-store" };
    for (const [k, v] of Object.entries(up.headers)) {
      if (typeof v === "string" && /^(content-type|content-length|transfer-encoding)$/i.test(k)) out[k] = v;
    }
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
    up.on("error", () => res.end());
  });
  upstream.on("error", (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "pipecat_engine_unreachable", detail: err instanceof Error ? err.message : String(err) }));
  });
  // The page's live feed closes with the page; the engine request goes with it.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
  return true;
}
