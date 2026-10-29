/**
 * JSON routes for the flows editor page of the console, mounted by the dev server
 * behind its loopback Host guard:
 *
 *   GET  /api/flow-tools/catalog   the tool catalog (src/flow-tools/catalog.json)
 *   GET  /api/flows/current        the runtime flow file: {path, flowName, yaml, modifiedAt}
 *   POST /api/flows/import         {flowName?, yaml}: validate through the bridge, then write the runtime file
 *
 * The import route refuses, in this order: a content type other than application/json (415),
 * an Origin that is not this server's own loopback origin (403), a body over 2 megabytes
 * (413), and a body that is not JSON with a non-empty yaml string (400). The text goes to a
 * fresh temporary directory, the bridge checks it, and the directory is always removed.
 * The interpreter comes from resolvePipecatPython, never from browser input.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePipecatPython } from "../orchestration-modules/pipecat-config.js";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface BridgeRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type BridgeRunner = (python: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<BridgeRun>;

export interface FlowEditorDeps {
  /** Repository root: the catalog, the default runtime flow and artifacts/flows-editor live under it. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs the interpreter without a shell. Tests may replace it. */
  run?: BridgeRunner;
  /** The bridge script. Defaults to scripts/flows-editor/flow_bridge.py under the root. */
  bridgeScript?: string;
  /** Passed to the bridge as --handlers only when this file exists. */
  handlersFile?: string;
}

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const defaultRun: BridgeRunner = (python, args, options) =>
  new Promise((done, fail) => {
    execFile(python, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return done({ status: 0, stdout, stderr });
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === "number") return done({ status: code, stdout, stderr });
      fail(error);
    });
  });

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
  return true;
}

function runtimeFlowPath(root: string, env: NodeJS.ProcessEnv): string {
  const configured = env.VOICE_HARNESS_FLOW_FILE?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(root, configured);
  return join(root, "src", "decision-tree", "full-tree.flow.yaml");
}

function flowNameFor(path: string): string {
  return basename(path).replace(/\.flow\.ya?ml$/i, "").replace(/\.(ya?ml|json)$/i, "");
}

/** The Origin must be this server's own origin on a loopback host name (the port comes from the Host header). */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  const port = /:(\d+)$/.exec(host)?.[1] ?? "80";
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** Reads the body as a stream; stops collecting once the cap is passed. Returns undefined when over the cap. */
async function readCapped(req: IncomingMessage): Promise<Buffer | undefined> {
  const declared = Number(req.headers["content-length"]);
  const chunks: Buffer[] = [];
  let size = 0;
  let over = Number.isFinite(declared) && declared > MAX_IMPORT_BYTES;
  for await (const chunk of req) {
    if (over) continue; // drain without keeping anything
    size += (chunk as Buffer).length;
    if (size > MAX_IMPORT_BYTES) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  return over ? undefined : Buffer.concat(chunks);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/**
 * Turns the bridge's standard error into problem lines that are safe to show in a browser:
 * interpreter traceback lines are dropped, the temporary file and directory and the repository
 * root are named in words, and any other absolute path becomes "<path>".
 */
export function safeProblems(stderr: string, known: { file: string; dir: string; root: string }): string[] {
  const cut = stderr.search(/^Traceback \(most recent call last\):/m);
  const text = cut >= 0 ? stderr.slice(0, cut) : stderr;
  const out = lines(text)
    .filter((line) => !line.startsWith("warning:"))
    .map((line) =>
      line
        .split(known.file).join("the submitted flow")
        .split(known.dir).join("the submitted flow directory")
        .split(known.root).join("<harness>")
        .replace(/(?<![\w.:\/])(?:\/[\w.@+~-]+){2,}\/?/g, "<path>"),
    );
  return out.length > 0 ? out : ["the flow could not be checked"];
}

async function importFlow(req: IncomingMessage, res: ServerResponse, deps: Required<Pick<FlowEditorDeps, "root" | "env" | "run">> & FlowEditorDeps): Promise<true> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return send(res, 415, { error: "unsupported_media_type" });
  if (!originAllowed(req)) return send(res, 403, { error: "origin_not_allowed" });

  const body = await readCapped(req);
  if (!body) return send(res, 413, { error: "body_too_large" }, { connection: "close" });

  let yaml: unknown;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    yaml = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).yaml : undefined;
  } catch {
    return send(res, 400, { error: "invalid_json" });
  }
  if (typeof yaml !== "string" || yaml.trim() === "") return send(res, 400, { error: "yaml_required" });

  const python = resolvePipecatPython(deps.env);
  if (!python) return send(res, 503, { error: "pipecat_python_not_configured" });

  const { root, env } = deps;
  const script = deps.bridgeScript ?? join(root, "scripts", "flows-editor", "flow_bridge.py");
  const handlersFile = deps.handlersFile ?? join(root, "src", "orchestration-modules", "pipecat", "flow_handlers.py");
  const handlersChecked = existsSync(handlersFile);

  const base = join(root, "artifacts", "flows-editor");
  let dir: string | undefined;
  try {
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, "import-"));
    const file = join(dir, "editor-saved.flow.yaml");
    writeFileSync(file, yaml, { encoding: "utf8", mode: 0o600 });
    const args = ["-I", script, "import", file];
    if (handlersChecked) args.push("--handlers", handlersFile);
    const result = await deps.run(python, args, { cwd: root, env });
    if (result.status === 0) {
      const all = lines(result.stderr);
      return send(res, 200, {
        ok: true,
        path: lines(result.stdout).pop() ?? runtimeFlowPath(root, env),
        warnings: all.filter((line) => line.startsWith("warning:")),
        handlersChecked,
      });
    }
    return send(res, 422, { ok: false, problems: safeProblems(result.stderr, { file, dir, root }) });
  } catch {
    return send(res, 500, { error: "import_failed" });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Returns true when the request was one of the flows editor routes (and has been answered). */
export async function handleFlowEditorRoute(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: FlowEditorDeps = {},
): Promise<boolean> {
  const root = deps.root ?? defaultRoot;
  const env = deps.env ?? process.env;

  if (method === "GET" && path === "/api/flow-tools/catalog") {
    const file = join(root, "src", "flow-tools", "catalog.json");
    if (!existsSync(file)) return send(res, 404, { error: "catalog_not_found" });
    try {
      return send(res, 200, JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return send(res, 500, { error: "catalog_invalid" });
    }
  }

  if (method === "GET" && path === "/api/flows/current") {
    const file = runtimeFlowPath(root, env);
    if (!existsSync(file)) return send(res, 404, { error: "runtime_flow_not_found" });
    try {
      return send(res, 200, {
        path: file,
        flowName: flowNameFor(file),
        yaml: readFileSync(file, "utf8"),
        modifiedAt: statSync(file).mtime.toISOString(),
      });
    } catch {
      return send(res, 500, { error: "runtime_flow_unreadable" });
    }
  }

  if (method === "POST" && path === "/api/flows/import") {
    return importFlow(req, res, { ...deps, root, env, run: deps.run ?? defaultRun });
  }

  return false;
}
