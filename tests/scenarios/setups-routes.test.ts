import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig } from "../../src/config.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { clearActiveSetup } from "../../src/setups/active-setup.js";
import { setDecisionCatalog } from "../../src/setups/decision-catalog.js";
import { routeDeps } from "../../src/setups/routes.js";
import { resetRunWriter, setRunWriteBack } from "../../src/setups/run-writer.js";
import { ELECTRICIAN, LIVE_AGENCY, ROOFER, RangeFakeDb, seedSetupWorld, syntheticScripts } from "../helpers/setups-fixtures.js";

let server: Server;
let base: string;
let db: RangeFakeDb;
const original = { ...routeDeps };

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  resetHarnessConfig();
  resetModuleRegistry();
  setDecisionCatalog(null);
  db = seedSetupWorld(new RangeFakeDb()) as RangeFakeDb;
  routeDeps.db = () => db;
  routeDeps.scripts = syntheticScripts;
  routeDeps.apply = {};
});
afterEach(() => {
  Object.assign(routeDeps, original);
  clearActiveSetup();
  resetRunWriter();
  setRunWriteBack(undefined);
  resetHarnessConfig();
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, json: (await r.json()) as any };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const setup = { name: "Roofer baseline", voiceModuleId: "vapi", decisionModuleId: "jev-mock", promptSetupId: "baseline-with-lead-record", leadId: ROOFER, direction: "inbound" };

describe("setup routes", () => {
  it("lists every choice a setup can make", async () => {
    const o = (await get("/api/setups/options")).json;
    expect(o.voiceModules.map((m: any) => m.id)).toContain("vapi");
    expect(o.decisionModules.map((m: any) => m.id)).toEqual(["jev-mock", "openai-mock"]);
    expect(o.selectedDecisionModuleId).toBe("jev-mock");
    expect(o.promptSetups.map((p: any) => p.id)).toContain("baseline-no-lead-record");
    expect(o.personas.length).toBe(4);
  });

  it("picks leads with the filters from the query string", async () => {
    const r = (await get("/api/setups/leads?trade=roof&history=yes&xFrom=2026-12-01&xTo=2026-12-31")).json;
    expect(r.candidates.map((c: any) => c.leadId)).toEqual([ROOFER]);
    expect((await get("/api/setups/leads?history=no")).json.candidates.map((c: any) => c.leadId)).not.toContain(ROOFER);
    expect((await get("/api/setups/leads?random=1&limit=1")).json.candidates).toHaveLength(1);
    expect((await get("/api/setups/leads?xFrom=tomorrow")).status).toBe(400);
  });

  it("gives a lead's persona card and briefing", async () => {
    const r = await get(`/api/setups/leads/${ROOFER}/persona`);
    expect(r.status).toBe(200);
    expect(r.json.briefing.business).toBe("Example Ridge Roofing");
    expect(r.json.card.you.name).toBe("Dana Roofer");
    const control = await get(`/api/setups/leads/${ROOFER}/persona?promptSetupId=baseline-no-lead-record&personaId=callback-b`);
    expect(control.json.card.personaId).toBe("callback-b");
    expect(control.json.card.facts.every((f: any) => !f.inAgentPacket)).toBe(true);
    expect((await get("/api/setups/leads/00000000-0000-4000-8000-0000000000ff/persona")).status).toBe(404);
  });

  it("saves a setup, refuses to replace it unless told, then applies it by name", async () => {
    expect((await post("/api/setups", setup)).status).toBe(200);
    expect((await post("/api/setups", setup)).json.error).toBe("setup_name_exists");
    expect((await post("/api/setups", { ...setup, overwrite: true, notes: "second" })).json.notes).toBe("second");
    expect((await get("/api/setups")).json).toHaveLength(1);

    const applied = await post("/api/setups/apply", { name: "Roofer baseline" });
    expect(applied.status).toBe(200);
    expect(applied.json.snapshot.lead.businessName).toBe("Example Ridge Roofing");
    expect(applied.json.aiCallingEnabledForAgency).toBe(LIVE_AGENCY);
    const active = (await get("/api/setups/active")).json;
    expect(active.snapshot.name).toBe("Roofer baseline");
    expect(active.promptPreview).toContain("Example Ridge Roofing");
    expect((await post("/api/setups/apply", { name: "Never saved" })).status).toBe(404);
  });

  it("applies a setup sent whole, without saving it", async () => {
    const r = await post("/api/setups/apply", { ...setup, name: "unsaved", leadId: ELECTRICIAN });
    expect(r.status).toBe(200);
    expect(r.json.snapshot.lead.businessName).toBe("Example Volt Electric");
    expect((await get("/api/setups")).json).toEqual([]);
  });

  it("refuses a bad setup without changing anything", async () => {
    expect((await post("/api/setups", { ...setup, name: "../x" })).json.error).toBe("bad_setup_name");
    expect((await post("/api/setups/apply", { ...setup, voiceModuleId: "nope" })).json.error).toBe("unknown_module:nope");
    expect((await get("/api/setups/active")).json).toBeNull();
  });

  it("switches run write-back and reports run status", async () => {
    expect((await post("/api/setups/write-back", { enabled: true })).json.enabled).toBe(true);
    expect((await get("/api/setups/runs")).json.enabled).toBe(true);
    expect((await post("/api/setups/write-back", { enabled: "yes" })).status).toBe(400);
    expect((await post("/api/setups/runs/call_missing/write-back")).json).toMatchObject({ status: "failed", error: "run_record_not_found" });
    // With the switch off, a single call cannot be written either.
    expect((await post("/api/setups/write-back", { enabled: false })).json.enabled).toBe(false);
    const refused = await post("/api/setups/runs/call_missing/write-back");
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ status: "refused", error: "run_writeback_off" });
  });

  // The Talk play list stays the configured development leads (play-wiring listPlayLeads); the picker is served on /setups.
  it("serves the setups page", async () => {
    const page = await fetch(base + "/setups");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Persona card");
    expect((await get("/api/play/leads")).json[0].id).toBe("lead-1");
  });

  it("refuses a request that did not come from the page's own origin", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = request(base + "/api/setups/options", { headers: { origin: "https://evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
  });
});
