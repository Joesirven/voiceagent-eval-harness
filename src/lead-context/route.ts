/**
 * GET /api/lead-context: the block for the lead of the live or last call.
 * Read only: it reads the lead and the trace history and writes nothing.
 * It serves the call console bot on port 4351. The development server only
 * registers this handler.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { FlowStep } from "../decision-tree/types.js";
import { buildLeadContextPacket } from "../memory/context.js";
import { getActiveSetup } from "../setups/active-setup.js";
import { getActiveLeadStore } from "../store/active-store.js";
import type { LeadRecord } from "../store/lead-store.js";
import { traceBus } from "../trace/events.js";
import { loadDecisionTree } from "../decision-tree/loader.js";
import { buildLeadContext, buildLeadContextJson, leadContextGateOn } from "./build.js";
import { stepIsConfirmed, UPDATE_HEADING, updateBodyFor } from "./live-update.js";
import { callerLineConfirms, confirmationNames } from "./confirmation.js";
import type { LeadContextJson } from "./types.js";

/** The tree the console bot compiles its flow from: VOICE_HARNESS_DECISION_TREE, else the full tree. */
const TREE_FOR_NODES = process.env.VOICE_HARNESS_DECISION_TREE ?? fileURLToPath(new URL("../decision-tree/full-tree.json", import.meta.url));

const WITHHELD = "withheld until the named person is confirmed on the call";

/** Replaces every held value with a plain withheld marker, so the json cannot be read around the gate. */
export function withholdHeldValues(json: LeadContextJson): LeadContextJson {
  return {
    ...json,
    facts: json.facts.map((f) => (f.held ? { ...f, value: WITHHELD, alternates: undefined } : f)),
    checklist: json.checklist.map((r) =>
      r.held && r.status === "known" ? { ...r, value: WITHHELD, evidenceSpan: undefined } : r,
    ),
    renewal: json.renewal.held
      ? { approximate: json.renewal.approximate, held: true, sentence: `The renewal date is ${WITHHELD}.` }
      : json.renewal,
  };
}

export interface LeadContextRouteDeps {
  getLead: (leadId: string) => Promise<LeadRecord | undefined>;
  /** The lead and direction of the live or last call, and its newest flow step, when any is known. */
  lastCall: () => { leadId: string; direction: "inbound" | "outbound" | "unknown"; flowStep?: FlowStep } | undefined;
  /** The agency name for the lead, when a call setup supplies one. The default reads it from the active setup's lead profile, and only for that setup's own lead. Otherwise the name reads as unknown. */
  agencyName?: (leadId: string) => string | undefined;
  now: () => Date;
}

const FLOW_STEPS: readonly string[] = ["disclosure", "recognize_lead", "discovery", "quote_fields", "objection", "booking", "message", "handoff"];

function defaultLastCall(): ReturnType<LeadContextRouteDeps["lastCall"]> {
  const history = traceBus.history();
  const last = [...history].reverse().find((e) => e.channel === "call");
  if (last) {
    const step = [...history].reverse().find((e) => e.callId === last.callId && e.type === "node_enter" && e.flowStep && FLOW_STEPS.includes(e.flowStep));
    return { leadId: last.leadId, direction: last.direction ?? "unknown", flowStep: step?.flowStep as FlowStep | undefined };
  }
  const setup = getActiveSetup();
  return setup ? { leadId: setup.profile.leadId, direction: "unknown" } : undefined;
}

/** The agency name from the active setup, only when the asked lead is the setup's own lead. */
export function defaultAgencyName(leadId: string): string | undefined {
  const profile = getActiveSetup()?.profile;
  return profile && profile.leadId === leadId ? profile.agencyName : undefined;
}

export const leadContextRouteDeps: LeadContextRouteDeps = {
  getLead: (id) => getActiveLeadStore().getLead(id),
  lastCall: defaultLastCall,
  agencyName: defaultAgencyName,
  now: () => new Date(),
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Returns true when it handled the request. Optional query: leadId. The confirmed block is never served here: there is no confirmation state behind this route, and a query string is not one. */
export async function handleLeadContextRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (path === "/api/lead-context/update") return handleUpdateRoute(method, req, res);
  if (path === "/api/lead-context/state") return handleStateRoute(method, req, res);
  if (path !== "/api/lead-context") return false;
  if (method !== "GET") {
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const asked = url.searchParams.get("leadId") || undefined;
  try {
    const last = leadContextRouteDeps.lastCall();
    const leadId = asked ?? last?.leadId;
    if (!leadId || !/^[\w-]{1,60}$/.test(leadId)) {
      send(res, 404, { error: "no_lead_known" });
      return true;
    }
    const lead = await leadContextRouteDeps.getLead(leadId);
    if (!lead) {
      send(res, 404, { error: "lead_not_found" });
      return true;
    }
    const sameCall = last && last.leadId === leadId;
    const out = buildLeadContext({
      packet: buildLeadContextPacket(lead),
      direction: sameCall ? last.direction : "unknown",
      flowStep: sameCall ? last.flowStep : undefined,
      // No confirmation state exists behind this route, so it never renders the confirmed block.
      confirmed: false,
      agencyName: leadContextRouteDeps.agencyName?.(leadId),
      now: leadContextRouteDeps.now(),
    });
    send(res, 200, { text: out.text, json: withholdHeldValues(out.json) });
  } catch (err) {
    send(res, 500, { error: "lead_context_failed", detail: err instanceof Error ? err.message : "unknown" });
  }
  return true;
}

/**
 * GET or POST /api/lead-context/update: the mid-call update for a console bot
 * that runs its own call. Parameters (query for GET, JSON body for POST):
 * leadId, direction, flowStep or treeNode, firstCallerLine. The bot uses POST
 * so the caller's words never sit in a URL. The stage decides confirmation
 * when one is known (a flow step, or a tree node the harness maps to its
 * step); with no stage, the first caller line after the disclosure decides
 * (callerLineConfirms). Before confirmation only the stage and the gate
 * sentence go out. Stateless and read only; the caller line is never echoed
 * or logged.
 */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CALLER_LINE = 500;

interface UpdateParams { leadId: string; direction: string; flowStep?: string; treeNode?: string; firstCallerLine?: string }

async function readUpdateParams(method: string, req: IncomingMessage): Promise<UpdateParams | { error: string; status: number }> {
  if (method === "GET") {
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    return { leadId: q.get("leadId") ?? "", direction: q.get("direction") ?? "", flowStep: q.get("flowStep") ?? undefined, treeNode: q.get("treeNode") ?? undefined, firstCallerLine: q.get("firstCallerLine") ?? undefined };
  }
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return { error: "json_body_required", status: 415 };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { error: "body_too_large", status: 413 };
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return { error: "body_not_json", status: 400 };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body_not_an_object", status: 400 };
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { leadId: str(b.leadId) ?? "", direction: str(b.direction) ?? "", flowStep: str(b.flowStep), treeNode: str(b.treeNode), firstCallerLine: str(b.firstCallerLine) };
}

async function handleUpdateRoute(method: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (method !== "GET" && method !== "POST") {
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    const params = await readUpdateParams(method, req);
    if ("error" in params) {
      send(res, params.status, { error: params.error });
      return true;
    }
    const direction = params.direction === "outbound" ? "outbound" : params.direction === "inbound" ? "inbound" : "unknown";
    if (!/^[\w-]{1,60}$/.test(params.leadId)) {
      send(res, 404, { error: "no_lead_known" });
      return true;
    }
    if (params.firstCallerLine !== undefined && params.firstCallerLine.length > MAX_CALLER_LINE) {
      send(res, 400, { error: "caller_line_too_long" });
      return true;
    }
    let flowStep: FlowStep | undefined;
    if (params.flowStep) {
      if (!FLOW_STEPS.includes(params.flowStep)) {
        send(res, 400, { error: "flow_step_unknown" });
        return true;
      }
      flowStep = params.flowStep as FlowStep;
    } else if (params.treeNode && /^[\w.-]{1,80}$/.test(params.treeNode)) {
      flowStep = loadDecisionTree(TREE_FOR_NODES).byId.get(params.treeNode)?.flowStep;
    }
    const lead = await leadContextRouteDeps.getLead(params.leadId);
    if (!lead) {
      send(res, 404, { error: "lead_not_found" });
      return true;
    }
    const packet = buildLeadContextPacket(lead);
    let confirmed: boolean;
    let confirmedBy: "stage" | "caller_line" | "gate_off" | "none";
    let confirmationReason: string;
    if (flowStep) {
      confirmed = stepIsConfirmed(flowStep);
      confirmedBy = confirmed ? "stage" : "none";
      confirmationReason = confirmed ? "the call has reached a step after confirmation" : "the call has not reached a step after confirmation";
    } else {
      const verdict = callerLineConfirms(params.firstCallerLine, confirmationNames(packet.name, packet.briefing?.ownerName));
      confirmed = verdict.confirmed;
      confirmedBy = confirmed ? "caller_line" : "none";
      confirmationReason = verdict.reason;
    }
    if (!confirmed && !leadContextGateOn()) {
      confirmed = true;
      confirmedBy = "gate_off";
      confirmationReason = "the confirmation gate is off (VOICE_HARNESS_LEAD_CONTEXT_GATE=off)";
    }
    const json = buildLeadContextJson({
      packet,
      direction,
      flowStep,
      confirmed,
      agencyName: leadContextRouteDeps.agencyName?.(params.leadId),
      now: leadContextRouteDeps.now(),
    });
    send(res, 200, { text: `${UPDATE_HEADING}\n${updateBodyFor(json)}`, stage: json.stage.flowStep, confirmed: json.confirmed, confirmedBy, confirmationReason });
  } catch (err) {
    send(res, 500, { error: "lead_context_failed", detail: err instanceof Error ? err.message : "unknown" });
  }
  return true;
}

/**
 * GET /api/lead-context/state?leadId=: what we know about the lead and what a quote still needs, for the
 * console. Known entries are the quote fields on file or said by the caller, then the other facts on the
 * lead record; missing lists the quote fields still needed; renewalDays is the whole days until renewal in
 * the lead's time zone, or null when no renewal date is on file. Read only. This is the operator's view of
 * the record, so it is not shaped by the confirmation gate (the gate governs what the agent may say).
 */
async function handleStateRoute(method: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (method !== "GET") {
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const leadId = new URL(req.url ?? "/", "http://localhost").searchParams.get("leadId") ?? leadContextRouteDeps.lastCall()?.leadId ?? "";
  try {
    if (!/^[\w-]{1,60}$/.test(leadId)) {
      send(res, 404, { error: "no_lead_known" });
      return true;
    }
    const lead = await leadContextRouteDeps.getLead(leadId);
    if (!lead) {
      send(res, 404, { error: "lead_not_found" });
      return true;
    }
    const json = buildLeadContextJson({ packet: buildLeadContextPacket(lead), direction: "unknown", confirmed: true, agencyName: leadContextRouteDeps.agencyName?.(leadId), now: leadContextRouteDeps.now() });
    const quoteKnown = json.checklist
      .filter((r) => r.status === "known" && r.value !== undefined)
      .map((r) => ({ field: r.field, label: r.label, value: r.value as string, source: r.basis === "caller" ? "said by the caller" : "on the lead record, confirm with the caller", kind: "quote" as const }));
    const factKnown = json.facts
      .filter((f) => f.value !== "unknown" && f.value.trim() !== "")
      .map((f) => ({ field: f.key, label: f.label, value: f.value, source: f.source, kind: "fact" as const }));
    send(res, 200, {
      leadId,
      known: [...quoteKnown, ...factKnown],
      missing: json.checklist.filter((r) => r.status === "still_needed").map((r) => r.field),
      missingLabels: json.checklist.filter((r) => r.status === "still_needed").map((r) => r.label),
      renewalDays: json.renewal.days ?? null,
      renewalSentence: json.renewal.sentence,
      producerName: json.producerName,
      agencyName: json.agencyName,
      gate: leadContextGateOn() ? "on" : "off",
    });
  } catch (err) {
    send(res, 500, { error: "lead_context_failed", detail: err instanceof Error ? err.message : "unknown" });
  }
  return true;
}
