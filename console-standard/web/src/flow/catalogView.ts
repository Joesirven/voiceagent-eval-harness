/** What the panel reads from the catalog route: only the documented fields, and only well-formed entries. */

export interface CatalogTool {
  name: string;
  area?: unknown;
  risk?: unknown;
  judgeAction?: unknown;
  credential?: unknown;
  status?: unknown;
  statusNote?: unknown;
}
export interface Catalog { version: number; tools: CatalogTool[] }

export const EMPTY_CATALOG: Catalog = { version: 0, tools: [] };

/** The statuses, as readable words. */
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

/** Keeps only entries that are objects with a text name, so one malformed entry cannot break the view. */
export function normalizeCatalog(json: unknown): Catalog {
  if (json && typeof json === "object" && Array.isArray((json as Catalog).tools)) {
    const c = json as Catalog;
    const tools = c.tools.filter((t): t is CatalogTool => !!t && typeof t === "object" && !Array.isArray(t) && typeof (t as CatalogTool).name === "string");
    return { version: typeof c.version === "number" ? c.version : 0, tools };
  }
  return EMPTY_CATALOG;
}

export type RiskTone = "danger" | "write" | "plain";
export function riskTone(risk: unknown): RiskTone {
  if (risk === "hard_to_undo") return "danger";
  if (risk === "reversible_write") return "write";
  return "plain";
}

export interface ToolRow {
  name: string;
  area: string;
  risk: string;
  riskTone: RiskTone;
  judgeAction: string;
  credential: string;
  status: string;
  statusNote?: string;
  usedIn: string;
}

/** One table row of text, with the defaults the panel shows for missing fields. */
export function toolRow(tool: CatalogTool, used: Record<string, string[]>): ToolRow {
  const nodes = used[tool.name] ?? [];
  return {
    name: tool.name,
    area: String(tool.area ?? ""),
    risk: String(tool.risk ?? "unknown").replace(/_/g, " "),
    riskTone: riskTone(tool.risk),
    judgeAction: String(tool.judgeAction ?? "not gated"),
    credential: String(tool.credential ?? "none"),
    status: statusWords(tool.status),
    statusNote: typeof tool.statusNote === "string" ? tool.statusNote : undefined,
    usedIn: nodes.length ? nodes.join(", ") : "not used",
  };
}

export interface ToolWarning { name: string; status: string; nodes: string[] }

/** Tools the current flow uses whose status needs attention. */
export function warningsFor(catalog: Catalog, used: Record<string, string[]>): ToolWarning[] {
  return catalog.tools
    .filter((t) => WARNING_STATUSES.has(String(t.status ?? "")) && used[t.name]?.length)
    .map((t) => ({ name: t.name, status: statusWords(t.status), nodes: used[t.name] }));
}
