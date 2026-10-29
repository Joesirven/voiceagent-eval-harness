/**
 * The CRM tool catalog for Pipecat flows: one entry per harness function
 * a flow may call, with the schema the model sees, the trace name the
 * after-call score reads, the risk, the judge action that gates it, the
 * CRM call it mirrors, the credential that call needs and what the tool
 * does today. `catalog.json` is the one source; the loader refuses a catalog
 * that breaks a rule and lists every problem at once.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JUDGE_ACTIONS } from "../judge/types.js";

export const FLOW_TOOL_AREAS = [
  "lead_and_contact",
  "scheduling_and_booking",
  "transfer_and_handoff",
  "messaging",
  "endings",
  "information_lookups",
  "quote_prototype",
] as const;
export const FLOW_TOOL_RISKS = ["read_only", "reversible_write", "hard_to_undo"] as const;
/**
 * What the tool does today. runs_in_harness_memory acts during the call in harness memory only;
 * queued_after_call runs the gate and queues a lasting CRM write for filing after the call;
 * reads_development_project reads through the service role key; the two needs_ statuses refuse,
 * and the agent says a producer will follow up; not_yet_built means no handler is wired yet;
 * runs_in_console is a quote prototype tool the console bot calls itself (console-standard/bot),
 * outside the dispatcher and the judge, real or simulated as its `implementation` says;
 * calls_crm_app runs the gate, then the configured CRM client during the call.
 */
export const FLOW_TOOL_STATUSES = [
  "runs_in_harness_memory",
  "queued_after_call",
  "reads_development_project",
  "needs_seat_session",
  "needs_admin_machine_credential",
  "not_yet_built",
  "runs_in_console",
  "calls_crm_app",
] as const;
/** How a runs_in_console tool is carried out: a real CRM call, or a simulated result. */
export const FLOW_TOOL_IMPLEMENTATIONS = ["crm", "simulated"] as const;
/** The credential the mirrored CRM call needs. */
export const FLOW_TOOL_CREDENTIALS = ["service_role_key", "seat_session", "admin_machine_credential"] as const;
/** The only tools that act during the call in harness memory. */
export const IN_CALL_TOOLS = ["book_producer", "transfer_to_human", "send_text", "end_call"] as const;
/** The credential each status requires; runs_in_harness_memory and not_yet_built take any. */
const STATUS_CREDENTIAL: Partial<Record<string, string>> = {
  queued_after_call: "service_role_key",
  reads_development_project: "service_role_key",
  needs_seat_session: "seat_session",
  needs_admin_machine_credential: "admin_machine_credential",
  calls_crm_app: "seat_session",
};
/** The harness's own trace names: a catalog tool tracing under one would be scored as the harness step. */
export const RESERVED_TRACE_NAMES = ["end_call", "record_stop", "append_handoff_note"] as const;
/** Judge actions the catalog uses before the judge knows them; the judge change adds them to `JUDGE_ACTIONS`. */
export const PLANNED_JUDGE_ACTIONS = ["send_email", "start_quote", "set_eligibility", "cancel_booking"] as const;
export const CATALOG_JUDGE_ACTIONS: readonly string[] = [...new Set<string>([...JUDGE_ACTIONS, ...PLANNED_JUDGE_ACTIONS])];

export type FlowToolArea = (typeof FLOW_TOOL_AREAS)[number];
export type FlowToolRisk = (typeof FLOW_TOOL_RISKS)[number];
export type FlowToolStatus = (typeof FLOW_TOOL_STATUSES)[number];
export type FlowToolCredential = (typeof FLOW_TOOL_CREDENTIALS)[number];

export interface FlowToolParameter {
  type: "string";
  enum?: string[];
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
}

export interface FlowToolParameters {
  type: "object";
  properties: Record<string, FlowToolParameter>;
  required: string[];
  additionalProperties: false;
}

export interface FlowTool {
  name: string;
  area: FlowToolArea;
  /** The text the model reads. */
  description: string;
  parameters: FlowToolParameters;
  /** The `tool_call` trace name the after-call score maps to a judged action. */
  trace: string;
  handler: string;
  /** The exact CRM call mirrored, with path:line citations in the CRM checkout. */
  crmTarget: string;
  risk: FlowToolRisk;
  /** Null exactly when the tool is read only. */
  judgeAction: string | null;
  credential: FlowToolCredential;
  status: FlowToolStatus;
  /** May say which side effect waits for the credential. */
  statusNote?: string;
  /** Only on runs_in_console tools. */
  implementation?: (typeof FLOW_TOOL_IMPLEMENTATIONS)[number];
}

export interface FlowToolCatalog {
  version: 1;
  /** The fixed texts send_text may send, by template name. */
  templates: Record<string, string>;
  tools: FlowTool[];
}

export const CATALOG_FILE = fileURLToPath(new URL("./catalog.json", import.meta.url));

const NAME = /^[a-z][a-z0-9_]*$/;
const TOOL_KEYS = new Set(["name", "area", "description", "parameters", "trace", "handler", "crmTarget", "risk", "judgeAction", "credential", "status", "statusNote", "implementation"]);
const PARAMETER_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const PROPERTY_KEYS = new Set(["type", "enum", "maxLength", "minLength", "pattern", "format"]);
const MAX_TEMPLATE_LENGTH = 320;
/** end_call needs the quote only for a durable disposition, which the dispatcher checks. */
const EVIDENCE_OPTIONAL = new Set(["end_call"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isIdentifierKey = (key: string) => key === "id" || key.endsWith("_id");
const oneOf = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function propertyProblems(where: string, key: string, raw: unknown): string[] {
  if (isIdentifierKey(key)) return [`${where}: parameter "${key}" is an identifier; the dispatcher fills identifiers in`];
  if (!isRecord(raw)) return [`${where}: parameter "${key}" is not an object`];
  const out = Object.keys(raw).filter((k) => !PROPERTY_KEYS.has(k)).map((k) => `${where}: parameter "${key}" has unsupported keyword "${k}"`);
  if (raw.type !== "string") out.push(`${where}: parameter "${key}" is not of type string`);
  if (raw.enum !== undefined && !(Array.isArray(raw.enum) && raw.enum.length > 0 && raw.enum.every(isText))) out.push(`${where}: parameter "${key}" has a bad enum`);
  for (const bound of ["maxLength", "minLength"] as const) {
    if (raw[bound] !== undefined && !(Number.isInteger(raw[bound]) && (raw[bound] as number) >= 0)) out.push(`${where}: parameter "${key}" has a bad ${bound}`);
  }
  if (raw.pattern !== undefined && !(typeof raw.pattern === "string" && compiles(raw.pattern))) out.push(`${where}: parameter "${key}" has a bad pattern`);
  if (raw.format !== undefined && !isText(raw.format)) out.push(`${where}: parameter "${key}" has a bad format`);
  return out;
}

function toolProblems(raw: unknown, index: number, templates: string[]): string[] {
  if (!isRecord(raw)) return [`tools[${index}] is not an object`];
  const where = isText(raw.name) ? `tool "${raw.name}"` : `tools[${index}]`;
  const out = Object.keys(raw).filter((k) => !TOOL_KEYS.has(k)).map((k) => `${where}: unknown key "${k}"`);
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!NAME.test(name)) out.push(`${where}: name must match ${NAME.source}`);
  if (name.startsWith("decide_") || name === "interrupt") out.push(`${where}: name clashes with the flow compiler's decide_ functions or interrupt`);
  if (!oneOf(FLOW_TOOL_AREAS, raw.area)) out.push(`${where}: unknown area`);
  for (const key of ["description", "handler", "crmTarget"]) if (!isText(raw[key])) out.push(`${where}: ${key} is missing`);
  if (raw.statusNote !== undefined && !isText(raw.statusNote)) out.push(`${where}: statusNote is empty`);
  if (typeof raw.trace !== "string" || !NAME.test(raw.trace)) out.push(`${where}: trace must match ${NAME.source}`);
  else if (oneOf(RESERVED_TRACE_NAMES, raw.trace)) out.push(`${where}: trace "${raw.trace}" is reserved for the harness`);
  if (!oneOf(FLOW_TOOL_RISKS, raw.risk)) out.push(`${where}: unknown risk`);
  if (!oneOf(FLOW_TOOL_STATUSES, raw.status)) out.push(`${where}: unknown status`);
  if (!oneOf(FLOW_TOOL_CREDENTIALS, raw.credential)) out.push(`${where}: unknown credential`);
  const needed = typeof raw.status === "string" ? STATUS_CREDENTIAL[raw.status] : undefined;
  if (needed !== undefined && raw.credential !== needed) out.push(`${where}: status ${String(raw.status)} requires credential ${needed}`);
  if (raw.status === "runs_in_harness_memory" && !oneOf(IN_CALL_TOOLS, name)) out.push(`${where}: only ${IN_CALL_TOOLS.join(", ")} run in harness memory`);
  if (raw.status === "reads_development_project" && raw.risk !== "read_only") out.push(`${where}: status reads_development_project requires risk read_only`);
  if (raw.status === "queued_after_call" && (raw.risk === "read_only" || !oneOf(FLOW_TOOL_RISKS, raw.risk))) out.push(`${where}: status queued_after_call requires a write risk`);
  if (raw.status === "calls_crm_app" && (raw.risk === "read_only" || !oneOf(FLOW_TOOL_RISKS, raw.risk))) out.push(`${where}: status calls_crm_app requires a write risk`);
  const inConsole = raw.status === "runs_in_console";
  if (inConsole !== (raw.area === "quote_prototype")) out.push(`${where}: runs_in_console and the quote_prototype area go together`);
  if (inConsole !== (raw.implementation !== undefined)) out.push(`${where}: implementation is set exactly on runs_in_console tools`);
  if (raw.implementation !== undefined && !oneOf(FLOW_TOOL_IMPLEMENTATIONS, raw.implementation)) out.push(`${where}: unknown implementation`);
  if (inConsole && raw.judgeAction !== null) out.push(`${where}: a runs_in_console tool is not judged here, so it has no judge action`);
  if (raw.risk === "read_only" && raw.judgeAction !== null) out.push(`${where}: a read-only tool has no judge action`);
  if (!inConsole && raw.risk !== "read_only" && raw.judgeAction === null) out.push(`${where}: a ${String(raw.risk)} tool needs a judge action`);
  if (raw.judgeAction !== null && !oneOf(CATALOG_JUDGE_ACTIONS, raw.judgeAction)) out.push(`${where}: unknown judge action`);

  const p = raw.parameters;
  if (!isRecord(p) || p.type !== "object" || !isRecord(p.properties) || !Array.isArray(p.required) || p.additionalProperties !== false) {
    return [...out, `${where}: parameters must be {type: "object", properties, required, additionalProperties: false}`];
  }
  out.push(...Object.keys(p).filter((k) => !PARAMETER_KEYS.has(k)).map((k) => `${where}: parameters has unsupported keyword "${k}"`));
  const properties = p.properties;
  for (const [key, value] of Object.entries(properties)) out.push(...propertyProblems(where, key, value));
  for (const key of p.required) if (typeof key !== "string" || !(key in properties)) out.push(`${where}: required "${String(key)}" is not a parameter`);
  if (raw.risk !== "read_only" && !inConsole) {
    const quote = properties.evidence_quote;
    if (!isRecord(quote) || quote.type !== "string" || quote.maxLength !== 500) out.push(`${where}: a write tool needs evidence_quote (string, maxLength 500)`);
    else if (!EVIDENCE_OPTIONAL.has(name) && !p.required.includes("evidence_quote")) out.push(`${where}: evidence_quote must be required`);
  }
  if (name === "send_text") {
    const listed = isRecord(properties.template) && Array.isArray(properties.template.enum) ? [...properties.template.enum].sort() : [];
    if (JSON.stringify(listed) !== JSON.stringify([...templates].sort())) out.push(`${where}: the template enum must equal the template names`);
  }
  return out;
}

/** Every rule the catalog breaks, one line each; empty when it is valid. */
export function catalogProblems(raw: unknown): string[] {
  if (!isRecord(raw)) return ["the catalog is not an object"];
  const out: string[] = [];
  if (raw.version !== 1) out.push("version must be 1");
  const templates = isRecord(raw.templates) ? raw.templates : {};
  if (!isRecord(raw.templates)) out.push("templates is not an object");
  for (const [key, text] of Object.entries(templates)) {
    if (!NAME.test(key)) out.push(`template "${key}": name must match ${NAME.source}`);
    if (!isText(text) || text.length > MAX_TEMPLATE_LENGTH) out.push(`template "${key}": text must be 1 to ${MAX_TEMPLATE_LENGTH} characters`);
    else if (/[{}<>[\]]/.test(text)) out.push(`template "${key}": text has a placeholder`);
  }
  if (!Array.isArray(raw.tools)) return [...out, "tools is not a list"];
  const seen = new Set<string>();
  raw.tools.forEach((tool, i) => {
    out.push(...toolProblems(tool, i, Object.keys(templates)));
    const name = isRecord(tool) ? tool.name : undefined;
    if (typeof name === "string" && seen.has(name)) out.push(`tool "${name}": duplicate name`);
    if (typeof name === "string") seen.add(name);
  });
  return out;
}

export function loadFlowToolCatalog(raw: unknown = JSON.parse(readFileSync(CATALOG_FILE, "utf8"))): FlowToolCatalog {
  const problems = catalogProblems(raw);
  if (problems.length > 0) throw new Error(`The flow tool catalog is invalid:\n${problems.join("\n")}`);
  return raw as FlowToolCatalog;
}

export const FLOW_TOOL_CATALOG: FlowToolCatalog = loadFlowToolCatalog();

/** A tool that is not yet built has no handler; a needs_ one has a handler that refuses. */
export function isRunnable(tool: FlowTool): boolean {
  return tool.status !== "not_yet_built";
}

/** The tools the harness dispatcher carries out: runnable, and not one the console bot calls itself. */
export function isDispatched(tool: FlowTool): boolean {
  return isRunnable(tool) && tool.status !== "runs_in_console";
}

export interface FlowToolCounts {
  byCredential: Record<FlowToolCredential, number>;
  byStatus: Record<FlowToolStatus, number>;
}

/** How many tools need each credential and sit in each status, every one listed even at zero. */
export function flowToolCounts(catalog: FlowToolCatalog = FLOW_TOOL_CATALOG): FlowToolCounts {
  const byCredential = Object.fromEntries(FLOW_TOOL_CREDENTIALS.map((c) => [c, 0])) as Record<FlowToolCredential, number>;
  const byStatus = Object.fromEntries(FLOW_TOOL_STATUSES.map((s) => [s, 0])) as Record<FlowToolStatus, number>;
  for (const tool of catalog.tools) {
    byCredential[tool.credential] += 1;
    byStatus[tool.status] += 1;
  }
  return { byCredential, byStatus };
}

/** Every way `args` breaks the tool's schema; empty when the call may go ahead. */
export function validateToolArguments(tool: FlowTool, args: unknown): string[] {
  if (!isRecord(args)) return ["the arguments are not an object"];
  const { properties, required } = tool.parameters;
  const out: string[] = [];
  for (const key of required) if (!(key in args)) out.push(`"${key}" is missing`);
  for (const [key, value] of Object.entries(args)) {
    if (isIdentifierKey(key)) out.push(`"${key}" is an identifier, which the model never supplies`);
    const rule = properties[key];
    if (!rule) {
      if (!isIdentifierKey(key)) out.push(`"${key}" is not a parameter`);
      continue;
    }
    if (typeof value !== "string") {
      out.push(`"${key}" must be a string`);
      continue;
    }
    if (rule.enum && !rule.enum.includes(value)) out.push(`"${key}" is not one of the allowed values`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) out.push(`"${key}" is longer than ${rule.maxLength} characters`);
    if (rule.minLength !== undefined && value.length < rule.minLength) out.push(`"${key}" is shorter than ${rule.minLength} characters`);
    if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) out.push(`"${key}" does not match the expected pattern`);
  }
  return out;
}
