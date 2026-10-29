/**
 * Routes behind the prompt panel: read the instructions the agent gets, list, read, save,
 * remove, preview and select prompt setups. Loopback only, with its own Origin check so a
 * page served from another local port (the panel) may call it. The development server only
 * registers handlePromptRoute at the top of its request handler.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { OUTBOUND_SCRIPTED_OPENING } from "../orchestration/call-loop.js";
import { inboundOpeningScript } from "../compliance/disclosures.js";
import { installBehaviourPromptBuilder } from "../behaviour/install-prompt.js";
import {
  PROMPT_LAYERS,
  buildSystemPrompt,
  getPromptSetupRegistry,
  listPersonalities,
  promptContextFromPacket,
  renderSetupSections,
  validateSetup,
  type PromptLayerId,
  type PromptSetup,
} from "../behaviour/prompt/index.js";
import { getLegalBlocks } from "../behaviour/switches.js";
import { defaultAgencyName } from "../lead-context/route.js";
import { buildLeadContextPacket } from "../memory/context.js";
import { buildAgentSystemInstruction } from "../modules/agent-instructions.js";
import { formatLeadContextBlock } from "../modules/prompt-setup.js";
import { ensureCustomSetupsLoaded, saveCustomSetups } from "../setups/prompt-setup-store.js";
import { ensurePlayLeads } from "./play-wiring.js";
import { getLead } from "../store/lead-store.js";

type Direction = "inbound" | "outbound";

const MAX_BODY_BYTES = 1_000_000;
const ID_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_IDS = new Set(["preview"]);
const EXTRA_ORIGIN_PORTS = new Set<number>([4351, 4361, ...Array.from({ length: 10 }, (_, i) => 4370 + i)]);

const LAYER_TITLES: Record<PromptLayerId, string> = {
  identity: "Who you are",
  rules: "Rules",
  disclosure: "Opening line and disclosures",
  flow: "Call flow",
  openers: "Openers",
  gatekeepers: "Gatekeepers",
  discovery: "Discovery questions",
  objections: "Objections and questions for the producer",
  booking: "Booking and handoff",
  followup: "Follow-up messages",
  segment: "Contractors",
  personality: "How you sound",
  facts: "Facts on file",
};

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) {
    super(code);
  }
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** True when the Origin header (already known to be present) is a page this panel may be served from. */
export function isAllowedOrigin(origin: string, ownPort: number | undefined): boolean {
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(origin);
  if (!match) return false;
  const port = Number(match[1]);
  return port === ownPort || EXTRA_ORIGIN_PORTS.has(port);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) throw new RouteError(415, "content_type_must_be_json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new RouteError(413, "body_too_large");
    chunks.push(buf);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RouteError(400, "json_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RouteError(400, "body_must_be_an_object");
  return parsed as Record<string, unknown>;
}

function parseDirection(value: string | null | unknown): Direction {
  if (value === null || value === undefined || value === "") return "inbound";
  if (value === "inbound" || value === "outbound") return value;
  throw new RouteError(400, "direction_invalid");
}

function openingFor(direction: Direction): string {
  return direction === "inbound" ? inboundOpeningScript() : OUTBOUND_SCRIPTED_OPENING;
}

function leadFor(leadId: string) {
  ensurePlayLeads();
  const lead = getLead(leadId);
  if (!lead) throw new RouteError(404, "lead_not_found");
  return lead;
}

/** The instruction text the agent gets for a registered setup id or a draft setup. */
function instructionText(setup: string | PromptSetup, leadId: string, direction: Direction): string {
  installBehaviourPromptBuilder();
  const lead = leadFor(leadId);
  const packet = buildLeadContextPacket(lead);
  const call = {
    leadFirstName: lead.name.trim().split(/\s+/)[0] ?? lead.name,
    direction,
    disclosure: openingFor(direction),
    agencyName: defaultAgencyName(leadId),
  };
  if (typeof setup === "string") return buildAgentSystemInstruction(setup, call, packet);
  const ctx = promptContextFromPacket(packet, { direction, agencyName: call.agencyName });
  const standing = buildSystemPrompt(setup, ctx, { legalBlocks: getLegalBlocks() }).text;
  return `${standing}\n\n${formatLeadContextBlock(packet, { direction, agencyName: call.agencyName })}`;
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

function toEntry(setup: PromptSetup, shipped: boolean) {
  const entry: Record<string, unknown> = {
    id: setup.id,
    label: setup.label,
    description: setup.description,
    shipped,
    layers: [...setup.layers],
    personalityId: setup.personalityId,
    overrides: { ...(setup.overrides ?? {}) },
  };
  if (setup.notes !== undefined) entry.notes = setup.notes;
  return entry;
}

/** A body that describes a setup, checked and ready to build or save. Throws a RouteError. */
function draftFromBody(body: Record<string, unknown>, id: string): PromptSetup {
  const overrides = body.overrides;
  if (typeof overrides === "object" && overrides !== null && "disclosure" in overrides) throw new RouteError(400, "disclosure_locked");
  const candidate: Record<string, unknown> = { ...body, id, overrides: overrides ?? {} };
  const errors = validateSetup(candidate);
  if (errors.length) throw new RouteError(400, errors.includes("disclosure_locked") ? "disclosure_locked" : "setup_invalid", errors);
  const setup: PromptSetup = {
    id,
    label: (candidate.label as string).trim(),
    description: candidate.description as string,
    layers: PROMPT_LAYERS.filter((l) => l === "disclosure" || (candidate.layers as string[]).includes(l)),
    personalityId: candidate.personalityId as string,
    overrides: { ...(candidate.overrides as Partial<Record<PromptLayerId, string>>) },
  };
  if (typeof candidate.notes === "string") setup.notes = candidate.notes;
  return setup;
}

/** The built text must still carry the disclosure section exactly as the template renders it, for both directions. */
function assertDisclosureKept(setup: PromptSetup): void {
  for (const direction of ["inbound", "outbound"] as const) {
    let sections;
    try {
      sections = renderSetupSections(setup, { direction });
    } catch (err) {
      throw new RouteError(400, "setup_invalid", [err instanceof Error ? err.message : String(err)]);
    }
    const disclosure = sections.find((s) => s.id === "disclosure");
    const text = sections.map((s) => s.text).join("\n\n");
    if (!disclosure || disclosure.overridden || !text.includes(disclosure.defaultText)) throw new RouteError(400, "disclosure_missing");
  }
}

function setupOrThrow(id: string): PromptSetup {
  const found = getPromptSetupRegistry().get(id);
  if (!found) throw new RouteError(404, "setup_unknown");
  return found;
}

function disclosureTexts() {
  const text = (direction: Direction) => renderSetupSections({ id: "disclosure-only", label: "d", description: "d", layers: ["disclosure"], personalityId: "none" }, { direction }).find((s) => s.id === "disclosure")?.text ?? "";
  return { text: text("inbound"), outboundText: text("outbound") };
}

async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  const registry = getPromptSetupRegistry();

  if (method === "GET" && path === "/api/agent-instructions") {
    const rawSetup = url.searchParams.get("setup") || "default";
    const setupId = rawSetup === "default" ? registry.selectedId() : rawSetup;
    if (!registry.get(setupId)) throw new RouteError(404, "setup_unknown");
    const leadId = url.searchParams.get("lead") || "lead-1";
    const direction = parseDirection(url.searchParams.get("direction"));
    const text = instructionText(setupId, leadId, direction);
    if (String(req.headers.accept ?? "").includes("text/plain")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
      return;
    }
    return json(res, 200, { text, setupId, direction, leadId, approxTokens: approxTokens(text) });
  }

  if (method === "GET" && path === "/api/prompt-setups") {
    return json(res, 200, {
      setups: registry.list().map(({ shipped, ...setup }) => toEntry(setup, shipped)),
      selectedId: registry.selectedId(),
      layers: PROMPT_LAYERS.map((id) => ({ id, title: LAYER_TITLES[id], editable: id !== "disclosure" })),
      personalities: listPersonalities().map((p) => ({ id: p.id, label: p.label })),
      disclosure: { ...disclosureTexts(), locked: true, note: "The opening line and disclosures are fixed. They are always part of a setup and cannot be replaced." },
    });
  }

  if (method === "POST" && path === "/api/prompt-setups/preview") {
    const body = await readJsonBody(req);
    const draftBody = body.setup;
    if (typeof draftBody !== "object" || draftBody === null || Array.isArray(draftBody)) throw new RouteError(400, "setup_invalid", ["setup_not_an_object"]);
    const rawId = (draftBody as Record<string, unknown>).id;
    const draft = draftFromBody(draftBody as Record<string, unknown>, typeof rawId === "string" && ID_FORMAT.test(rawId) ? rawId : "draft-preview");
    assertDisclosureKept(draft);
    const direction = parseDirection(body.direction);
    const text = instructionText(draft, typeof body.lead === "string" && body.lead ? body.lead : "lead-1", direction);
    return json(res, 200, { text, approxTokens: approxTokens(text) });
  }

  const sectionsMatch = /^\/api\/prompt-setups\/([^/]+)\/sections$/.exec(path);
  if (method === "GET" && sectionsMatch) {
    const setup = setupOrThrow(decodeURIComponent(sectionsMatch[1]!));
    const direction = parseDirection(url.searchParams.get("direction"));
    const sections = renderSetupSections(setup, { direction }).map((s) => ({ ...s, editable: s.id !== "floor" && s.id !== "disclosure" }));
    return json(res, 200, { sections });
  }

  const selectMatch = /^\/api\/prompt-setups\/([^/]+)\/select$/.exec(path);
  if (method === "POST" && selectMatch) {
    const id = decodeURIComponent(selectMatch[1]!);
    setupOrThrow(id);
    registry.select(id);
    return json(res, 200, { selectedId: id });
  }

  const idMatch = /^\/api\/prompt-setups\/([^/]+)$/.exec(path);
  if (idMatch && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(idMatch[1]!);
    if (registry.isShipped(id)) throw new RouteError(409, "setup_is_shipped");
    if (method === "DELETE") {
      const previous = setupOrThrow(id);
      const wasSelected = registry.selectedId() === id;
      registry.remove(id);
      try {
        saveCustomSetups(registry);
      } catch {
        registry.register(previous);
        if (wasSelected) registry.select(id);
        throw new RouteError(500, "save_failed");
      }
      return json(res, 200, { removed: id, selectedId: registry.selectedId() });
    }
    if (!ID_FORMAT.test(id) || RESERVED_IDS.has(id)) throw new RouteError(400, "setup_id_invalid");
    const body = await readJsonBody(req);
    const draft = draftFromBody(body, id);
    assertDisclosureKept(draft);
    const previous = registry.get(id);
    const saved = registry.register(draft);
    try {
      saveCustomSetups(registry);
    } catch {
      if (previous) registry.register(previous);
      else registry.remove(id);
      throw new RouteError(500, "save_failed");
    }
    return json(res, 200, toEntry(saved, false));
  }

  throw new RouteError(404, "not_found");
}

function isOneOfOurPaths(path: string): boolean {
  return path === "/api/agent-instructions" || path === "/api/prompt-setups" || path.startsWith("/api/prompt-setups/");
}

/** Handles the prompt routes. Returns false when the path is not one of them, so the caller carries on. */
export async function handlePromptRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!isOneOfOurPaths(url.pathname)) return false;
  try {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      json(res, 403, { error: "forbidden_non_loopback_request" });
      return true;
    }
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    if (origin !== undefined) {
      if (!isAllowedOrigin(origin, req.socket.localPort)) {
        json(res, 403, { error: "origin_not_allowed" });
        return true;
      }
      Object.assign(cors, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, accept",
        vary: "Origin",
      });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (origin !== undefined) {
      // Headers set early so error replies carry them too.
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    ensureCustomSetupsLoaded();
    await dispatch(req, res, url);
  } catch (err) {
    if (err instanceof RouteError) json(res, err.status, err.details === undefined ? { error: err.code } : { error: err.code, details: err.details });
    else json(res, 500, { error: "internal_error" });
  }
  return true;
}
