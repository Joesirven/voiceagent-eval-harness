/**
 * JSON routes for lead setups, mounted by the dev server the way the play
 * routes are (behind its loopback Host and Origin guard):
 *
 *   GET  /api/setups/options              voice modules, decision modules, prompt setups, personas, saved setups, the applied setup
 *   GET  /api/setups/leads?...            the picker (search, trade, xFrom, xTo, history=yes|no, random=1, limit, agencyId)
 *   GET  /api/setups/leads/:id/persona    the lead's persona card and its briefing (personaId, promptSetupId optional)
 *   GET  /api/setups                      saved setups
 *   POST /api/setups                      save a named setup (409 when the name exists, unless overwrite is true)
 *   POST /api/setups/apply                apply a saved setup by name, or a setup sent whole
 *   GET  /api/setups/active               the applied setup, its persona card and prompt
 *   GET  /api/setups/runs                 write-back status per call
 *   POST /api/setups/runs/:recordId/write-back   write one call to the harness database again
 *   POST /api/setups/write-back           {enabled} switches run write-back on or off
 *   GET  /api/setups/agent                the lab voice agent settings (prompt setup, lead context gate, thinker, Talk transcripts)
 *   POST /api/setups/agent                {preset?, promptSetupId?, leadContextGate?, thinker?, talkWriteBack?} for the next call
 *   GET  /api/setups/agent-context        the standing rules and lead block the next call sends, and the user's override when set
 *   POST /api/setups/agent-context        {text} replaces the standing rules for every call until cleared
 *   DELETE /api/setups/agent-context      clears the override
 *   GET  /setups                          a small page over the routes above
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHarnessConfig } from "../config.js";
import { getModuleRegistry } from "../modules/registry.js";
import { createProfileDb, applySetup, getActiveSetup, type ApplyDeps } from "./active-setup.js";
import { getDecisionCatalog } from "./decision-catalog.js";
import { pickLeads, type PickerFilters } from "./lead-picker.js";
import { readLeadProfile } from "./lead-profile.js";
import { buildPersonaCard, choosePersona, listPersonas, loadLeadScripts, type LeadScripts } from "./persona-card.js";
import { PROMPT_SETUPS, DEFAULT_PROMPT_SETUP_ID, getPromptSetup } from "./prompt-setups.js";
import { attachRunWriter, getRunWriter, isRunWriteBackEnabled, setRunWriteBack } from "./run-writer.js";
import { agentSettings, applyAgentSettings } from "./agent-settings.js";
import { agentContextView, applyAgentContextOverride, clearAgentContextOverride } from "./agent-context.js";
import { setupStore, type SetupInput } from "./setup-store.js";
import { UUID } from "./util.js";
import type { DbClient } from "../store/database-client.js";

const here = dirname(fileURLToPath(import.meta.url));

attachRunWriter();

/** Tests replace these. A host application can supply a database adapter and a scripts file. */
export const routeDeps: { db: () => DbClient; apply: ApplyDeps; scripts: () => LeadScripts | undefined } = {
  db: createProfileDb,
  apply: {},
  scripts: () => {
    try {
      return loadLeadScripts();
    } catch {
      return undefined;
    }
  },
};

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): true {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  return true;
}

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function filtersFrom(q: URLSearchParams): PickerFilters {
  const history = q.get("history");
  const limit = q.get("limit");
  return {
    agencyId: q.get("agencyId") || undefined,
    search: q.get("search") || undefined,
    trade: q.get("trade") || undefined,
    xDateFrom: q.get("xFrom") || undefined,
    xDateTo: q.get("xTo") || undefined,
    hasCallHistory: history === "yes" ? true : history === "no" ? false : undefined,
    random: q.get("random") === "1",
    limit: limit ? Number(limit) : undefined,
  };
}

function setupInput(body: Record<string, unknown>): SetupInput {
  return {
    name: String(body.name ?? ""),
    voiceModuleId: String(body.voiceModuleId ?? ""),
    decisionModuleId: String(body.decisionModuleId ?? ""),
    promptSetupId: String(body.promptSetupId ?? ""),
    leadId: String(body.leadId ?? ""),
    direction: body.direction === "outbound" ? "outbound" : "inbound",
    ...(typeof body.personaId === "string" && body.personaId ? { personaId: body.personaId } : {}),
    ...(typeof body.notes === "string" && body.notes ? { notes: body.notes } : {}),
  };
}

function options() {
  const scripts = routeDeps.scripts();
  return {
    voiceModules: getModuleRegistry().list().map((m) => ({ id: m.id, label: m.label })),
    selectedVoiceModuleId: getModuleRegistry().selectedModuleId(),
    decisionModules: getDecisionCatalog().list(),
    selectedDecisionModuleId: getDecisionCatalog().selectedId(),
    promptSetups: PROMPT_SETUPS.map((p) => ({ id: p.id, label: p.label, includesBriefing: p.includesBriefing })),
    defaultPromptSetupId: DEFAULT_PROMPT_SETUP_ID,
    personas: scripts ? listPersonas(scripts) : [],
    personasAvailable: scripts !== undefined,
    setups: setupStore.list(),
    active: getActiveSetup()?.snapshot ?? null,
    runWriteBack: isRunWriteBackEnabled(),
  };
}

export async function handleSetupRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!path.startsWith("/api/setups") && path !== "/setups") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (method === "GET" && path === "/setups") {
      return send(res, 200, readFileSync(join(here, "setups-page.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (method === "GET" && path === "/api/setups/options") return send(res, 200, options());
    if (method === "GET" && path === "/api/setups/leads") {
      return send(res, 200, await pickLeads(routeDeps.db(), filtersFrom(url.searchParams)));
    }
    const personaMatch = path.match(/^\/api\/setups\/leads\/([0-9a-fA-F-]{36})\/persona$/);
    if (method === "GET" && personaMatch) {
      const leadId = personaMatch[1]!;
      if (!UUID.test(leadId)) throw new Error("bad_lead_id");
      const profile = await readLeadProfile(routeDeps.db(), leadId);
      if (!profile) return send(res, 404, { error: "lead_not_found" });
      const promptSetup = getPromptSetup(url.searchParams.get("promptSetupId") || DEFAULT_PROMPT_SETUP_ID);
      const scripts = routeDeps.scripts();
      const script = scripts ? choosePersona(scripts, leadId, profile.briefing, { personaId: url.searchParams.get("personaId") || undefined }) : undefined;
      return send(res, 200, {
        briefing: profile.briefing,
        card: buildPersonaCard(profile.briefing, script, { briefingInAgentPacket: promptSetup.includesBriefing }),
      });
    }
    if (method === "GET" && path === "/api/setups") return send(res, 200, setupStore.list());
    if (method === "POST" && path === "/api/setups") {
      const body = await readJson(req);
      const input = setupInput(body);
      // Replacing a saved setup is a deliberate act: the caller must say so.
      if (setupStore.exists(input.name) && body.overwrite !== true) return send(res, 409, { error: "setup_name_exists" });
      return send(res, 200, setupStore.save(input));
    }
    if (method === "POST" && path === "/api/setups/apply") {
      const body = await readJson(req);
      let setup;
      if (typeof body.name === "string" && !body.leadId) {
        setup = setupStore.get(body.name);
        if (!setup) return send(res, 404, { error: "setup_not_found" });
      } else {
        setup = { ...setupInput(body), savedAt: new Date().toISOString() };
      }
      const { snapshot, card, promptPreview, aiCallingEnabledForAgency } = await applySetup(setup, { ...routeDeps.apply, db: routeDeps.db, scripts: routeDeps.scripts });
      return send(res, 200, { snapshot, card, promptPreview, aiCallingEnabledForAgency });
    }
    if (method === "GET" && path === "/api/setups/active") {
      const a = getActiveSetup();
      return send(res, 200, a ? { snapshot: a.snapshot, card: a.card, promptPreview: a.snapshot.renderedPrompt } : null);
    }
    if (method === "GET" && path === "/api/setups/runs") {
      return send(res, 200, { enabled: isRunWriteBackEnabled(), runs: getRunWriter().statuses() });
    }
    const runMatch = path.match(/^\/api\/setups\/runs\/([\w-]+)\/write-back$/);
    if (method === "POST" && runMatch) {
      const status = await getRunWriter().writeBack(runMatch[1]!);
      return send(res, status.status === "refused" ? 409 : 200, status);
    }
    // The lab voice agent's runtime settings: the prompt setup, the lead context gate, the thinker, Talk transcripts.
    if (method === "GET" && path === "/api/setups/agent") return send(res, 200, agentSettings());
    if (method === "POST" && path === "/api/setups/agent") return send(res, 200, applyAgentSettings(await readJson(req)));
    if (path === "/api/setups/agent-context") {
      if (method === "POST") applyAgentContextOverride(await readJson(req));
      else if (method === "DELETE") clearAgentContextOverride();
      else if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, await agentContextView({ leadId: url.searchParams.get("leadId") ?? undefined, direction: url.searchParams.get("direction") ?? undefined }));
    }
    if (method === "POST" && path === "/api/setups/write-back") {
      const { enabled } = await readJson(req);
      if (typeof enabled !== "boolean") throw new Error("bad_write_back_request");
      setRunWriteBack(enabled);
      return send(res, 200, { enabled: isRunWriteBackEnabled() });
    }
    return send(res, 404, { error: "not_found" });
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
