/**
 * Loopback proxy for the Flow panel. The panel calls three routes on its own page server;
 * this plugin forwards exactly those three to the harness server and nothing else:
 *
 *   GET  /api/flow-tools/catalog
 *   GET  /api/flows/current
 *   POST /api/flows/import
 *
 * Every other path (including every other path under /api/) falls through to Vite. A query
 * string never reaches the harness and never widens the allowlist. The incoming connection
 * must be loopback. A POST must be application/json (415), must carry an Origin that is
 * exactly this page's own loopback origin (403), and may not exceed 2 megabytes counted as it
 * streams (413). The request to the harness is made with node:http (no shell, no redirects)
 * with Host and Origin rewritten to the harness's own address, because the harness compares
 * the Origin of an import with its own Host port. A harness that is down gives
 * 502 {error: "harness_unreachable"}.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const HARNESS_TIMEOUT_MS = 60_000;

export interface FlowProxyOptions {
  /** The port this page server listens on; the only port a POST Origin may name. */
  pagePort: number;
  /** The harness port. Defaults to CONSOLE_STANDARD_HARNESS_PORT, then 4311. */
  harnessPort?: number;
}

type Next = (error?: unknown) => void;

const ROUTES: Record<string, string> = {
  "/api/flow-tools/catalog": "GET",
  "/api/flows/current": "GET",
  "/api/flows/import": "POST",
};
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

function harnessPortFrom(options: FlowProxyOptions): number {
  if (options.harnessPort !== undefined) return options.harnessPort;
  const fromEnv = Number(process.env.CONSOLE_STANDARD_HARNESS_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : 4311;
}

/** The middleware itself, exported so it can be tested without starting Vite. */
export function createFlowProxyMiddleware(options: FlowProxyOptions) {
  const allowedOrigins = new Set([`http://127.0.0.1:${options.pagePort}`, `http://localhost:${options.pagePort}`]);

  return function flowProxy(req: IncomingMessage, res: ServerResponse, next: Next): void {
    // Exact comparison on the raw path before the query string: no decoding, no normalising.
    const raw = req.url ?? "";
    const cut = raw.indexOf("?");
    const path = cut < 0 ? raw : raw.slice(0, cut);
    const method = req.method ?? "GET";
    const allowedMethod = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!allowedMethod) return next();
    if (method !== allowedMethod) return sendJson(res, 405, { error: "method_not_allowed" }, { allow: allowedMethod });

    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) return sendJson(res, 403, { error: "loopback_only" });

    const port = harnessPortFrom(options);
    if (method === "GET") { forward(req, res, port, path, "GET", undefined); return; }

    const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return sendJson(res, 415, { error: "unsupported_media_type" });
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) return sendJson(res, 403, { error: "origin_not_allowed" });

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_PROXY_BODY_BYTES) {
      // Answer first, then read and discard the rest, so the sender sees the 413 instead of a reset.
      sendJson(res, 413, { error: "body_too_large" });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        sendJson(res, 413, { error: "body_too_large" }, { connection: "close" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => { if (!res.headersSent) sendJson(res, 400, { error: "request_aborted" }); });
    req.on("end", () => { if (!over) forward(req, res, port, path, "POST", Buffer.concat(chunks)); });
  };
}

function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string, method: "GET" | "POST", body: Buffer | undefined): void {
  const headers: Record<string, string | number> = {
    host: `127.0.0.1:${port}`,
    accept: "application/json",
  };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = body.length;
    headers.origin = `http://127.0.0.1:${port}`;
  }
  // Fixed path, no query string; node:http does not follow redirects.
  const upstream = httpRequest({ host: "127.0.0.1", port, method, path, headers, timeout: HARNESS_TIMEOUT_MS }, (reply) => {
    const out: Record<string, string> = { "cache-control": "no-store" };
    const type = reply.headers["content-type"];
    if (typeof type === "string") out["content-type"] = type;
    res.writeHead(reply.statusCode ?? 502, out);
    reply.pipe(res);
    reply.on("error", () => res.destroy());
  });
  upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ETIMEDOUT") return sendJson(res, 504, { error: "harness_timeout" });
    sendJson(res, 502, { error: "harness_unreachable" });
  });
  res.on("close", () => { if (!upstream.destroyed && !res.writableEnded) upstream.destroy(); });
  upstream.end(body);
}

/** Vite plugin: the proxy for both the dev server and the preview server. */
export function flowProxyPlugin(options: FlowProxyOptions): Plugin {
  const middleware = createFlowProxyMiddleware(options);
  return {
    name: "crm-flow-proxy",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
