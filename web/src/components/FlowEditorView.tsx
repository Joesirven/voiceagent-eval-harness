import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** The pipecat flows editor runs as its own program; the page frames it and talks to it by messages. */
export const EDITOR_ORIGIN = "http://127.0.0.1:4335";
export const HANDSHAKE_TIMEOUT_MS = 5000;
const START_COMMAND = "npx next dev -p 4335";
const TIMEOUT_MESSAGE = `The flow editor did not answer. It is either not running (start it in ../pipecat-flows-editor with: ${START_COMMAND}) or it does not support the harness message contract.`;
const CONFIRM_LOAD = "Loading the runtime flow replaces the draft in the editor. Continue?";

export interface CatalogTool {
  name: string;
  area?: string;
  risk?: string;
  judgeAction?: string | null;
  credential?: string | null;
  status?: string;
  statusNote?: string;
  [key: string]: unknown;
}
export interface Catalog { version: number; tools: CatalogTool[] }
export interface ImportResult {
  kind: "imported" | "refused" | "error";
  path?: string;
  lines: string[];
  warnings: string[];
  handlersChecked?: boolean;
  at: Date;
}

const EMPTY_CATALOG: Catalog = { version: 0, tools: [] };

/** Tool catalog statuses as readable words. */
const STATUS_WORDS: Record<string, string> = {
  runs_in_harness_memory: "runs in harness memory",
  queued_after_call: "queued for after the call",
  reads_development_project: "reads the development project",
  needs_seat_session: "needs a signed-in seat session",
  needs_admin_machine_credential: "needs the administrator machine credential",
  not_yet_built: "not yet built",
};
const WARNING_STATUSES = new Set(["needs_seat_session", "needs_admin_machine_credential", "not_yet_built"]);
export function statusWords(status: unknown): string {
  if (typeof status !== "string" || !status) return "unknown";
  return STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

function riskVariant(risk: unknown): "secondary" | "outline" | "destructive" {
  if (risk === "hard_to_undo") return "destructive";
  if (risk === "reversible_write") return "secondary";
  return "outline";
}

function unquote(raw: string): string {
  let v = raw.trim();
  const hash = v.search(/\s#/);
  if (hash >= 0 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
  return v;
}

/**
 * A tiny tolerant reader limited to the structure nodes: <name>: functions: - name: <tool>.
 * Returns the function names each node uses. Anything it does not understand is skipped, never thrown.
 */
export function functionNamesByNode(yaml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const lines = yaml.replace(/\r/g, "").split("\n");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => l.trim() === "" || l.trim().startsWith("#");
  let i = lines.findIndex((l) => /^nodes\s*:\s*(#.*)?$/.test(l));
  if (i < 0) return out;
  i += 1;
  let nodeIndent = -1;
  let node: string | null = null;
  let fnIndent = -1; // indent of the "functions:" key while inside it, else -1
  let itemKeyIndent = -1; // indent of keys inside the current list item
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) break; // left the nodes block
    const text = line.trim();
    if (nodeIndent < 0) nodeIndent = ind;
    if (ind <= nodeIndent && !text.startsWith("- ")) {
      const m = /^("[^"]*"|'[^']*'|[^:#]+?)\s*:\s*(.*)$/.exec(text);
      if (ind === nodeIndent && m) { node = unquote(m[1]); out[node] ??= []; fnIndent = -1; itemKeyIndent = -1; }
      continue;
    }
    if (node === null) continue;
    if (fnIndent >= 0) {
      const dash = text.startsWith("- ") || text === "-";
      if (ind < fnIndent || (ind === fnIndent && !dash)) fnIndent = -1; // block ended; fall through to key check
      else {
        if (dash) {
          itemKeyIndent = ind + (text.length - text.slice(1).trimStart().length);
          const rest = text.slice(1).trim();
          const m = /^name\s*:\s*(.+)$/.exec(rest);
          if (m) out[node].push(unquote(m[1]));
        } else if (ind === itemKeyIndent) {
          const m = /^name\s*:\s*(.+)$/.exec(text);
          if (m) out[node].push(unquote(m[1]));
        }
        continue;
      }
    }
    if (/^functions\s*:\s*(#.*)?$/.test(text)) { fnIndent = ind; itemKeyIndent = -1; }
  }
  return out;
}

/** For each tool name, the node names whose functions use it. */
export function usedInFlow(yaml: string, toolNames: string[]): Record<string, string[]> {
  const byNode = functionNamesByNode(yaml);
  const used: Record<string, string[]> = {};
  for (const tool of toolNames) used[tool] = Object.keys(byNode).filter((n) => byNode[n].includes(tool));
  return used;
}

/** Keeps only entries that are objects with a text name, so one malformed entry cannot break the view. */
function normalizeCatalog(json: unknown): Catalog {
  if (json && typeof json === "object" && Array.isArray((json as Catalog).tools)) {
    const c = json as Catalog;
    const tools = c.tools.filter((t): t is CatalogTool => !!t && typeof t === "object" && !Array.isArray(t) && typeof (t as CatalogTool).name === "string");
    return { version: typeof c.version === "number" ? c.version : 0, tools };
  }
  return EMPTY_CATALOG;
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

/** The error code a route sends as {error: code}, or the HTTP status when there is none. */
function errorCode(json: any, res: Response): string {
  return json && typeof json.error === "string" && json.error ? json.error : `HTTP ${res.status}`;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

type CurrentFlow =
  | { kind: "ok"; flowName: string; yaml: string; modifiedAt?: string }
  | { kind: "missing" }
  | { kind: "failed"; code: string };

export function FlowEditorView() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogNote, setCatalogNote] = useState("");
  const [flowNote, setFlowNote] = useState("");
  const [yaml, setYaml] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [loadNote, setLoadNote] = useState("");
  const readyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogRef = useRef<Catalog>(EMPTY_CATALOG);

  const src = useMemo(() => `${EDITOR_ORIGIN}/editor?parent=${encodeURIComponent(window.location.origin)}`, []);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const fetchCatalog = useCallback(async (): Promise<Catalog> => {
    const settle = (c: Catalog, note: string) => { setCatalogNote(note); catalogRef.current = c; setCatalog(c); return c; };
    try {
      const res = await fetch("/api/flow-tools/catalog");
      const json = await readJson(res);
      if (res.status === 404) return settle(EMPTY_CATALOG, "Note: catalog not written yet. The editor received an empty catalog.");
      if (!res.ok) return settle(EMPTY_CATALOG, `The catalog could not be read: ${errorCode(json, res)}. The editor received an empty catalog.`);
      return settle(normalizeCatalog(json), "");
    } catch {
      return settle(EMPTY_CATALOG, "The catalog could not be read: network error. The editor received an empty catalog.");
    }
  }, []);

  /** GET /api/flows/current: {path, flowName, yaml, modifiedAt}, or 404 when there is no runtime flow yet. */
  const fetchCurrentFlow = useCallback(async (): Promise<CurrentFlow> => {
    try {
      const res = await fetch("/api/flows/current");
      const json = await readJson(res);
      if (res.status === 404) return { kind: "missing" };
      if (!res.ok) return { kind: "failed", code: errorCode(json, res) };
      if (!json || typeof json !== "object" || typeof json.yaml !== "string") return { kind: "failed", code: "unexpected response" };
      return {
        kind: "ok",
        flowName: typeof json.flowName === "string" && json.flowName ? json.flowName : "runtime-flow",
        yaml: json.yaml,
        modifiedAt: typeof json.modifiedAt === "string" ? json.modifiedAt : undefined,
      };
    } catch { return { kind: "failed", code: "network error" }; }
  }, []);

  const postLoad = useCallback((payload: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ type: "voice-agent-load", ...payload }, EDITOR_ORIGIN);
  }, []);

  const importFlow = useCallback(async (flowName: string, text: string) => {
    try {
      const res = await fetch("/api/flows/import", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flowName, yaml: text }),
      });
      const json = await readJson(res);
      if (res.ok && json?.ok === true) {
        setResult({
          kind: "imported", path: typeof json.path === "string" ? json.path : undefined, lines: [],
          warnings: textList(json.warnings), handlersChecked: typeof json.handlersChecked === "boolean" ? json.handlersChecked : undefined, at: new Date(),
        });
      } else {
        const problems = textList(json?.problems);
        setResult({ kind: "refused", lines: problems.length ? problems : [errorCode(json, res)], warnings: [], at: new Date() });
      }
    } catch (e) {
      setResult({ kind: "error", lines: [e instanceof Error ? e.message : String(e)], warnings: [], at: new Date() });
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== EDITOR_ORIGIN) return;
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "voice-agent-editor-ready") {
        readyRef.current = true; clearTimer(); setTimedOut(false); setReady(true);
        // Fails safe: only an explicit false means there is no draft to protect.
        const noDraft = data.hasDraft === false;
        void (async () => {
          const c = await fetchCatalog();
          const flow = await fetchCurrentFlow();
          setFlowNote(flow.kind === "failed" ? `The runtime flow could not be read: ${flow.code}` : "");
          if (noDraft && flow.kind === "ok") postLoad({ catalog: c, flowName: flow.flowName, yaml: flow.yaml });
          else postLoad({ catalog: c });
        })();
      } else if (data.type === "voice-agent-flow-saved") {
        if (typeof data.yaml === "string") void importFlow(typeof data.flowName === "string" ? data.flowName : "flow", data.yaml);
      } else if (data.type === "voice-agent-flow-changed") {
        if (typeof data.yaml === "string") setYaml(data.yaml);
      }
    };
    window.addEventListener("message", onMessage);
    return () => { window.removeEventListener("message", onMessage); clearTimer(); };
  }, [fetchCatalog, fetchCurrentFlow, postLoad, importFlow]);

  const onFrameLoad = () => {
    if (readyRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => { if (!readyRef.current) setTimedOut(true); }, HANDSHAKE_TIMEOUT_MS);
  };

  const retry = () => {
    clearTimer(); readyRef.current = false; setReady(false); setTimedOut(false); setFrameKey((k) => k + 1);
  };

  const loadRuntimeFlow = async () => {
    if (!window.confirm(CONFIRM_LOAD)) return;
    const flow = await fetchCurrentFlow();
    if (flow.kind === "missing") { setLoadNote("There is no runtime flow to load yet."); return; }
    if (flow.kind === "failed") { setLoadNote(`The runtime flow could not be read: ${flow.code}`); return; }
    setLoadNote(flow.modifiedAt ? `Loaded the runtime flow, last changed ${flow.modifiedAt}.` : "");
    postLoad({ catalog: catalogRef.current, flowName: flow.flowName, yaml: flow.yaml });
  };

  const used = useMemo(() => usedInFlow(yaml, catalog.tools.map((t) => t.name)), [yaml, catalog]);
  const warnings = catalog.tools.filter((t) => WARNING_STATUSES.has(String(t.status ?? "")) && used[t.name]?.length);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Flow editor">
        {timedOut && (
          <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm">
            <AlertTriangle className="size-4" aria-hidden="true" />
            <span className="min-w-0 flex-1">{TIMEOUT_MESSAGE}</span>
            <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
          </div>
        )}
        <iframe key={frameKey} ref={frameRef} src={src} title="Pipecat flows editor" onLoad={onFrameLoad} className="min-h-0 w-full flex-1 border-0 bg-background" />
      </section>
      <aside aria-label="Flow tools" className={panelOpen ? "flex min-h-0 w-[26rem] max-w-[45%] shrink-0 flex-col overflow-hidden border-l bg-card" : "flex shrink-0 flex-col border-l bg-card"}>
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
          <Button size="icon-sm" variant="ghost" aria-label={panelOpen ? "Collapse the side panel" : "Expand the side panel"} aria-expanded={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
            {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
          {panelOpen && <h2 className="text-sm font-medium">Tools in the catalog</h2>}
        </div>
        {panelOpen && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3 text-sm">
            <p className="text-xs text-muted-foreground">The voice agent speaks live words; the tree lines are guidance in task messages, not scripted speech.</p>
            <p className="text-xs text-muted-foreground" aria-live="polite">{ready ? "The editor is connected." : "Waiting for the editor."}</p>
            {catalogNote && <p className="text-xs" role="status">{catalogNote}</p>}
            {flowNote && <p className="text-xs" role="status">{flowNote}</p>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead><TableHead>Area</TableHead><TableHead>Risk</TableHead><TableHead>Judge action</TableHead>
                  <TableHead>Credential</TableHead><TableHead>Status</TableHead><TableHead>Used in this flow</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.tools.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No tools to show.</TableCell></TableRow>}
                {catalog.tools.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="whitespace-normal break-words font-mono text-xs">{t.name}</TableCell>
                    <TableCell className="whitespace-normal">{String(t.area ?? "")}</TableCell>
                    <TableCell><Badge variant={riskVariant(t.risk)}>{String(t.risk ?? "unknown").replace(/_/g, " ")}</Badge></TableCell>
                    <TableCell className="whitespace-normal">{String(t.judgeAction ?? "not gated")}</TableCell>
                    <TableCell className="whitespace-normal">{String(t.credential ?? "none")}</TableCell>
                    <TableCell className="whitespace-normal" title={typeof t.statusNote === "string" ? t.statusNote : undefined}>{statusWords(t.status)}</TableCell>
                    <TableCell className="whitespace-normal break-words">{used[t.name]?.length ? used[t.name].join(", ") : "not used"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {warnings.length > 0 && (
              <div role="region" aria-label="Warnings" className="space-y-1 rounded-md border border-destructive p-2">
                {warnings.map((t) => (
                  <p key={t.name} className="flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span><strong>Warning:</strong> the flow uses {t.name} ({statusWords(t.status)}) in {used[t.name].join(", ")}.</span>
                  </p>
                ))}
              </div>
            )}
            <div role="region" aria-label="Last import" className="space-y-1 rounded-md border p-2" >
              <h3 className="text-xs font-medium">Last import</h3>
              <div role="status" aria-live="polite" className="text-xs">
                {!result && <p className="text-muted-foreground">Nothing imported yet. Save in the editor to import the flow.</p>}
                {result?.kind === "imported" && (
                  <div>
                    <p>Imported{result.path ? <> to <span className="break-all font-mono">{result.path}</span></> : null} at {result.at.toLocaleTimeString()}.</p>
                    {result.handlersChecked === false && <p className="text-muted-foreground">The tool handlers were not checked.</p>}
                    {result.warnings.length > 0 && <ul className="list-disc pl-4">{result.warnings.map((w, i) => <li key={i} className="break-words">{w}</li>)}</ul>}
                  </div>
                )}
                {result && result.kind !== "imported" && (
                  <div>
                    <p className="font-medium">{result.kind === "refused" ? "Import refused" : "Import failed"} at {result.at.toLocaleTimeString()}:</p>
                    <ul className="list-disc pl-4">{result.lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>
                  </div>
                )}
              </div>
            </div>
            <div>
              <Button size="sm" variant="outline" disabled={!ready} onClick={() => void loadRuntimeFlow()}>Load the runtime flow</Button>
              {loadNote && <p className="mt-1 text-xs" role="status">{loadNote}</p>}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
