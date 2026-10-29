import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLeadContext, defaultAgencyName, handleLeadContextRoute, leadContextRouteDeps } from "../../src/lead-context/index.js";
import type { LeadBriefing } from "../../src/memory/briefing.js";
import { buildLeadContextPacket, type LeadContextPacket } from "../../src/memory/context.js";
import { formatLeadContextBlock } from "../../src/modules/prompt-setup.js";
import { resetHarnessConfig } from "../../src/config.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { applySetup, clearActiveSetup } from "../../src/setups/active-setup.js";
import { setDecisionCatalog } from "../../src/setups/decision-catalog.js";
import { readLeadProfile } from "../../src/setups/lead-profile.js";
import type { LeadRecord } from "../../src/store/lead-store.js";
import { LIVE_AGENCY, OTHER_AGENCY, RangeFakeDb, ROOFER, PLUMBER, seedSetupWorld, syntheticScripts } from "../helpers/setups-fixtures.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const SEAT = "b0000000-0000-4000-8000-000000000001";
const OLD_SEAT = "b0000000-0000-4000-8000-000000000002";

const BRIEFING: LeadBriefing = {
  business: "Ortega Landscaping",
  ownerName: "Maria Ortega",
  carriersCurrent: [],
  priorCalls: [],
  priorTexts: [],
  missedOutboundCalls: [],
};

function packet(briefing: LeadBriefing | undefined): LeadContextPacket {
  return { leadId: "lead-1", name: "Maria Ortega", agencyId: "agency-1", phone: "+15550199", priorCallSummaries: [], quoteFields: {}, consentSnapshot: {}, briefing };
}

describe("producer name and agency name in the lead context", () => {
  it("known: value and source, before and after confirmation, in json and text", () => {
    for (const confirmed of [false, true]) {
      const out = buildLeadContext({ packet: packet({ ...BRIEFING, producerName: "Pat Rivera" }), direction: "inbound", confirmed, agencyName: "Example Agency", now: NOW });
      expect(out.json.producerName).toEqual({ value: "Pat Rivera", source: "lead record: assigned producer", held: false });
      expect(out.json.agencyName).toEqual({ value: "Example Agency", source: "call setup (agency name)", held: false });
      expect(out.text).toContain("Producer whose assistant you are: Pat Rivera (source: lead record");
      expect(out.text).toContain("Agency name: Example Agency (source: call setup (agency name))");
    }
  });

  it("unknown: exact value and a source", () => {
    const out = buildLeadContext({ packet: packet(BRIEFING), direction: "outbound", now: NOW });
    expect(out.json.producerName).toEqual({ value: "unknown", source: "no producer is assigned on the record", held: false });
    expect(out.json.agencyName.value).toBe("unknown");
    expect(out.json.agencyName.source.length).toBeGreaterThan(0);
    expect(out.text).toContain("Producer whose assistant you are: unknown");
    const blank = buildLeadContext({ packet: packet({ ...BRIEFING, producerName: "  " }), direction: "outbound", agencyName: " ", now: NOW });
    expect(blank.json.producerName.value).toBe("unknown");
    expect(blank.json.agencyName.value).toBe("unknown");
  });

  it("the gate still holds the account facts while both names show", () => {
    const out = buildLeadContext({ packet: packet({ ...BRIEFING, producerName: "Pat Rivera" }), direction: "inbound", agencyName: "Example Agency", now: NOW });
    expect(out.text).toContain("Pat Rivera");
    expect(out.text).not.toContain("Ortega Landscaping");
    expect(out.json.facts.find((f) => f.key === "business")?.held).toBe(true);
  });

  it("the session block threads the agency name from the call setup", () => {
    const text = formatLeadContextBlock(packet({ ...BRIEFING, producerName: "Pat Rivera" }), { direction: "inbound", agencyName: "Example Agency", now: NOW });
    expect(text).toContain("Agency name: Example Agency");
    expect(text).toContain("Producer whose assistant you are: Pat Rivera");
  });
});

describe("reader maps the producer holding to the seat name", () => {
  function world(): RangeFakeDb {
    const db = seedSetupWorld(new RangeFakeDb()) as RangeFakeDb;
    db.seed("crm_app_user",
      { id: SEAT, agency_id: LIVE_AGENCY, name: "Pat Rivera" },
      { id: OLD_SEAT, agency_id: LIVE_AGENCY, name: "Former Seat" },
    );
    db.seed("crm_lead_holding",
      { id: "h1", agency_id: LIVE_AGENCY, lead_id: ROOFER, app_user_id: OLD_SEAT, held_at: "2026-09-01T00:00:00Z", released_at: "2026-09-20T00:00:00Z" },
      { id: "h2", agency_id: LIVE_AGENCY, lead_id: ROOFER, app_user_id: SEAT, held_at: "2026-09-21T00:00:00Z", released_at: null },
    );
    return db;
  }

  it("uses the live holding, not a released one", async () => {
    const profile = await readLeadProfile(world(), ROOFER, () => NOW);
    expect(profile?.briefing.producerName).toBe("Pat Rivera");
  });

  it("leaves the name absent when nobody holds the lead", async () => {
    const profile = await readLeadProfile(world(), PLUMBER, () => NOW);
    expect(profile).toBeDefined();
    expect("producerName" in (profile?.briefing ?? {})).toBe(false);
  });

  it("does not read a seat from another agency", async () => {
    const db = world();
    db.seed("crm_app_user", { id: "b0000000-0000-4000-8000-000000000003", agency_id: OTHER_AGENCY, name: "Outsider" });
    db.seed("crm_lead_holding", { id: "h3", agency_id: LIVE_AGENCY, lead_id: PLUMBER, app_user_id: "b0000000-0000-4000-8000-000000000003", held_at: "2026-09-21T00:00:00Z", released_at: null });
    const profile = await readLeadProfile(db, PLUMBER, () => NOW);
    expect("producerName" in (profile?.briefing ?? {})).toBe(false);
  });

  it("stays unknown when the holding table is missing or fails", async () => {
    const db = world();
    const failing = Object.create(db) as RangeFakeDb;
    failing.select = async (table, q) => {
      if (table === "crm_lead_holding") throw new Error("database_error:GET:crm_lead_holding:404");
      return db.select(table, q);
    };
    const profile = await readLeadProfile(failing, ROOFER, () => NOW);
    expect(profile).toBeDefined();
    expect("producerName" in (profile?.briefing ?? {})).toBe(false);
  });
});

describe("GET /api/lead-context carries both names", () => {
  let server: Server | undefined;
  const original = { ...leadContextRouteDeps };
  afterEach(() => {
    server?.close();
    server = undefined;
    Object.assign(leadContextRouteDeps, original);
  });
  async function get(): Promise<any> {
    server = createServer((req, res) => {
      void handleLeadContextRoute("GET", "/api/lead-context", req, res);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return (await fetch(`http://127.0.0.1:${port}/api/lead-context`)).json();
  }
  const lead = (briefing: LeadBriefing) =>
    ({ id: "lead-1", agencyId: "a", name: "Maria Ortega", phone: "+1555", priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [], briefing }) as unknown as LeadRecord;

  it("known names appear unconfirmed in json and text", async () => {
    Object.assign(leadContextRouteDeps, {
      getLead: async () => lead({ ...BRIEFING, producerName: "Pat Rivera" }),
      lastCall: () => ({ leadId: "lead-1", direction: "inbound" as const }),
      agencyName: () => "Example Agency",
      now: () => NOW,
    });
    const body = await get();
    expect(body.json.producerName.value).toBe("Pat Rivera");
    expect(body.json.agencyName).toEqual({ value: "Example Agency", source: "call setup (agency name)", held: false });
    expect(body.text).toContain("Pat Rivera");
    expect(body.text).toContain("Example Agency");
  });

  it("missing names read as unknown with a source", async () => {
    Object.assign(leadContextRouteDeps, { getLead: async () => lead(BRIEFING), lastCall: () => ({ leadId: "lead-1", direction: "unknown" as const }), now: () => NOW });
    const body = await get();
    expect(body.json.producerName).toEqual({ value: "unknown", source: "no producer is assigned on the record", held: false });
    expect(body.json.agencyName.value).toBe("unknown");
    expect(body.json.agencyName.source).toBeTruthy();
  });
});

describe("the agency name reaches the route from the applied setup", () => {
  let server: Server | undefined;
  const original = { ...leadContextRouteDeps };
  let db: RangeFakeDb;
  const deps = () => ({
    db: () => db,
    now: () => NOW,
    scripts: syntheticScripts,
  });
  const setup = (leadId: string) => ({ name: "Agency name", voiceModuleId: "vapi", decisionModuleId: "openai-mock", promptSetupId: "baseline-with-lead-record", leadId, direction: "inbound" as const });

  beforeEach(() => {
    resetHarnessConfig();
    resetModuleRegistry();
    setDecisionCatalog(null);
    clearActiveSetup();
    db = seedSetupWorld(new RangeFakeDb()) as RangeFakeDb;
  });
  afterEach(() => {
    server?.close();
    server = undefined;
    Object.assign(leadContextRouteDeps, original);
    clearActiveSetup();
    resetHarnessConfig();
    resetModuleRegistry();
    setDecisionCatalog(null);
  });

  async function get(query: string): Promise<any> {
    server = createServer((req, res) => {
      void handleLeadContextRoute("GET", "/api/lead-context", req, res);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return (await fetch(`http://127.0.0.1:${port}/api/lead-context${query}`)).json();
  }

  it("the profile reads the agency's own name, and leaves it absent when the row has none or the read fails", async () => {
    db.tables.crm_agency![0]!.name = "Example Agency";
    expect((await readLeadProfile(db, ROOFER, () => NOW))?.agencyName).toBe("Example Agency");
    db.tables.crm_agency![0]!.name = "  ";
    const blank = await readLeadProfile(db, ROOFER, () => NOW);
    expect(blank).toBeDefined();
    expect("agencyName" in (blank ?? {})).toBe(false);
    const failing = Object.create(db) as RangeFakeDb;
    failing.select = async (table, q) => {
      if (table === "crm_agency") throw new Error("database_error:GET:crm_agency:404");
      return db.select(table, q);
    };
    const failed = await readLeadProfile(failing, ROOFER, () => NOW);
    expect(failed).toBeDefined();
    expect("agencyName" in (failed ?? {})).toBe(false);
  });

  it("with nothing applied the default reads no name", () => {
    expect(defaultAgencyName(ROOFER)).toBeUndefined();
  });

  it("the default route shows the applied setup's agency name for that lead, and unknown for any other lead", async () => {
    db.tables.crm_agency![0]!.name = "Example Agency";
    await applySetup(setup(ROOFER), deps());
    expect(defaultAgencyName(ROOFER)).toBe("Example Agency");
    expect(defaultAgencyName(PLUMBER)).toBeUndefined();
    Object.assign(leadContextRouteDeps, {
      getLead: async (id: string) => ({ id, agencyId: LIVE_AGENCY, name: "Maria Ortega", phone: "+1555", priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [], briefing: BRIEFING }) as unknown as LeadRecord,
      lastCall: () => ({ leadId: ROOFER, direction: "inbound" as const }),
      now: () => NOW,
    });
    const own = await get(`?leadId=${ROOFER}`);
    expect(own.json.agencyName).toEqual({ value: "Example Agency", source: "call setup (agency name)", held: false });
    expect(own.text).toContain("Example Agency");
    const other = await get(`?leadId=${PLUMBER}`);
    expect(other.json.agencyName.value).toBe("unknown");
  });
});
