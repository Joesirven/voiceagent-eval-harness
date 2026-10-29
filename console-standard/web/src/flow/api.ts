/** The three page-server routes the panel uses, with the failure messages kept apart. */
import { type Catalog, EMPTY_CATALOG, normalizeCatalog } from "./catalogView";

export interface ImportResult {
  kind: "imported" | "refused" | "error";
  path?: string;
  lines: string[];
  warnings: string[];
  handlersChecked?: boolean;
  at: Date;
}

export type CurrentFlow =
  | { kind: "ok"; flowName: string; yaml: string; modifiedAt?: string }
  | { kind: "missing" }
  | { kind: "failed"; code: string };

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await res.json();
    return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The error code a route sends as {error: code}, or the HTTP status when there is none. */
function errorCode(json: Record<string, unknown> | null, res: Response): string {
  return json && typeof json.error === "string" && json.error ? json.error : `HTTP ${res.status}`;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** GET /api/flow-tools/catalog. A missing and a failed catalog give different notes; both give an empty catalog. */
export async function loadCatalog(): Promise<{ catalog: Catalog; note: string }> {
  try {
    const res = await fetch("/api/flow-tools/catalog");
    if (res.status === 404) return { catalog: EMPTY_CATALOG, note: "Note: catalog not written yet. The editor received an empty catalog." };
    const body = res.ok ? await res.json().catch(() => null) : await readJson(res);
    if (!res.ok) return { catalog: EMPTY_CATALOG, note: `The catalog could not be read: ${errorCode(body as Record<string, unknown> | null, res)}. The editor received an empty catalog.` };
    return { catalog: normalizeCatalog(body), note: "" };
  } catch {
    return { catalog: EMPTY_CATALOG, note: "The catalog could not be read: network error. The editor received an empty catalog." };
  }
}

/** GET /api/flows/current: {path, flowName, yaml, modifiedAt}, or 404 when there is no runtime flow yet. */
export async function loadCurrentFlow(): Promise<CurrentFlow> {
  try {
    const res = await fetch("/api/flows/current");
    const json = await readJson(res);
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "failed", code: errorCode(json, res) };
    if (!json || typeof json.yaml !== "string") return { kind: "failed", code: "unexpected response" };
    return {
      kind: "ok",
      flowName: typeof json.flowName === "string" && json.flowName ? json.flowName : "runtime-flow",
      yaml: json.yaml,
      modifiedAt: typeof json.modifiedAt === "string" ? json.modifiedAt : undefined,
    };
  } catch { return { kind: "failed", code: "network error" }; }
}

/** POST /api/flows/import. Only ok === true counts as imported. */
export async function importSavedFlow(flowName: string, yaml: string): Promise<ImportResult> {
  try {
    const res = await fetch("/api/flows/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flowName, yaml }),
    });
    const json = await readJson(res);
    if (res.ok && json?.ok === true) {
      return {
        kind: "imported", path: typeof json.path === "string" ? json.path : undefined, lines: [],
        warnings: textList(json.warnings), handlersChecked: typeof json.handlersChecked === "boolean" ? json.handlersChecked : undefined, at: new Date(),
      };
    }
    const problems = textList(json?.problems);
    return { kind: "refused", lines: problems.length ? problems : [errorCode(json, res)], warnings: [], at: new Date() };
  } catch (e) {
    return { kind: "error", lines: [e instanceof Error ? e.message : String(e)], warnings: [], at: new Date() };
  }
}
