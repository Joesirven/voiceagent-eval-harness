import { describe, expect, it } from "vitest";
import { pickLeads } from "../../src/setups/lead-picker.js";
import { missedOutboundCalls, readLeadProfile } from "../../src/setups/lead-profile.js";
import { renderAgentPrompt, getPromptSetup, renderBriefing } from "../../src/setups/prompt-setups.js";
import { ELECTRICIAN, LIVE_AGENCY, PLUMBER, ROOFER, RangeFakeDb, WAREHOUSED, seedSetupWorld } from "../helpers/setups-fixtures.js";

const world = () => seedSetupWorld(new RangeFakeDb()) as RangeFakeDb;
const ids = (r: { candidates: Array<{ leadId: string }> }) => r.candidates.map((c) => c.leadId);

describe("lead picker", () => {
  it("lists only the agency's leads, soonest X-date first, with no phone or email", async () => {
    const r = await pickLeads(world(), { agencyId: LIVE_AGENCY });
    expect(ids(r)).toEqual([ELECTRICIAN, ROOFER, PLUMBER]);
    expect(JSON.stringify(r)).not.toMatch(/555|@example|phone|email/);
    expect(r.truncated).toBe(false);
    expect(r.scanned).toBe(3);
  });

  it("filters by trade, X-date window, call history and search", async () => {
    const db = world();
    expect(ids(await pickLeads(db, { trade: "ROOF" }))).toEqual([ROOFER]);
    expect(ids(await pickLeads(db, { xDateFrom: "2026-12-01", xDateTo: "2027-03-01" }))).toEqual([ROOFER, PLUMBER]);
    expect(ids(await pickLeads(db, { xDateFrom: "2027-01-01" }))).toEqual([PLUMBER]);
    expect(ids(await pickLeads(db, { hasCallHistory: true }))).toEqual([ELECTRICIAN, ROOFER]);
    expect(ids(await pickLeads(db, { hasCallHistory: false }))).toEqual([PLUMBER]); // a text alone is not call history
    expect(ids(await pickLeads(db, { search: "volt" }))).toEqual([ELECTRICIAN]);
    expect(ids(await pickLeads(db, { search: "dana" }))).toEqual([ROOFER]);
    expect(ids(await pickLeads(db, { trade: "plumbing", hasCallHistory: true }))).toEqual([]);
  });

  it("counts calls and voicemails for the history flag", async () => {
    const r = await pickLeads(world(), {});
    expect(r.candidates.find((c) => c.leadId === ROOFER)).toMatchObject({ callCount: 2, hasCallHistory: true });
  });

  it("random mode shuffles with the injected source and honours the limit", async () => {
    const first = await pickLeads(world(), { random: true, limit: 1 }, { random: () => 0 });
    const second = await pickLeads(world(), { random: true, limit: 1 }, { random: () => 0.99 });
    expect(first.candidates).toHaveLength(1);
    expect(ids(first)).not.toEqual(ids(second));
  });

  it("says when the agency has more leads than were scanned", async () => {
    const r = await pickLeads(world(), { scanLimit: 2 });
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBe(2);
  });

  it("refuses a malformed agency or date", async () => {
    await expect(pickLeads(world(), { agencyId: "nope" })).rejects.toThrow("bad_agency_id");
    await expect(pickLeads(world(), { xDateFrom: "12/14/2026" })).rejects.toThrow("bad_x_date");
  });

  it("defaults to the first live agency that has leads, skipping dormant and empty ones", async () => {
    const db = world();
    db.tables.crm_agency = [
      { id: "a0000000-0000-0000-0000-000000000100", dormant_at: "2026-09-24T00:00:00Z" },
      { id: "a0000000-0000-0000-0000-0000000000ee", dormant_at: null },
      { id: LIVE_AGENCY, dormant_at: null },
    ];
    expect(ids(await pickLeads(db, {}))).toEqual([ELECTRICIAN, ROOFER, PLUMBER]);
  });

  it("never looks at another agency's leads", async () => {
    const r = await pickLeads(world(), { trade: "roofing", agencyId: LIVE_AGENCY });
    expect(ids(r)).not.toContain(WAREHOUSED);
  });
});

describe("lead profile", () => {
  const now = () => new Date("2026-10-19T12:00:00Z");

  it("collects the business, X-date, carrier, headcount, newest payroll with its basis, calls, texts and real missed calls", async () => {
    const p = await readLeadProfile(world(), ROOFER, now);
    const b = p!.briefing;
    expect(b).toMatchObject({
      business: "Example Ridge Roofing",
      ownerName: "Dana Roofer",
      trade: "residential roofing",
      xDate: { date: "2026-12-14", line: "workers_comp", carrier: "Sample Mutual" },
      carriersCurrent: ["Sample Mutual"],
      employees: { count: 6, basis: "per-firm" },
      payroll: { annualEstimate: 280000, basis: "employees times county trade wage" },
    });
    expect(b.priorCalls.map((c) => c.channel).sort()).toEqual(["call", "voicemail"]);
    expect(b.priorTexts).toHaveLength(1);
    expect(b.missedOutboundCalls).toEqual([
      { at: "2026-10-16T17:00:00Z", simulated: false },
      { at: "2026-10-17T18:30:00Z", simulated: false },
    ]);
    expect(p!.callCount).toBe(1);
  });

  it("leaves unknown things unknown and marks stand-in missed calls as simulated", async () => {
    const p = await readLeadProfile(world(), PLUMBER, now);
    const b = p!.briefing;
    expect(b.payroll).toBeUndefined();
    expect(b.xDate).toMatchObject({ date: "2027-02-10" });
    expect(b.xDate!.carrier).toBeUndefined();
    expect(b.employees).toMatchObject({ count: 3, modeled: true });
    expect(b.missedOutboundCalls).toHaveLength(2);
    expect(b.missedOutboundCalls.every((c) => c.simulated)).toBe(true);
  });

  it("pads to two with one simulated call when only one real call is on file", async () => {
    const b = (await readLeadProfile(world(), ELECTRICIAN, now))!.briefing;
    expect(b.missedOutboundCalls.filter((c) => c.simulated)).toHaveLength(1);
    expect(b.missedOutboundCalls.filter((c) => !c.simulated)).toHaveLength(1);
    expect(b.missedOutboundCalls).toHaveLength(2);
  });

  it("carries no phone number or email", async () => {
    const p = await readLeadProfile(world(), ROOFER, now);
    expect(JSON.stringify(p)).not.toMatch(/\+1650|@example\.com/);
  });

  it("returns nothing for an unknown or malformed lead id", async () => {
    expect(await readLeadProfile(world(), "00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
    expect(await readLeadProfile(world(), "lead-1")).toBeUndefined();
  });

  it("simulated missed calls fall on the two days before now", () => {
    const calls = missedOutboundCalls([], now());
    expect(calls.map((c) => c.at.slice(0, 10))).toEqual(["2026-10-17", "2026-10-18"]);
  });
});

describe("prompt setups", () => {
  it("writes the lead record into the prompt only when the setup includes it, and says what is unknown", async () => {
    const b = (await readLeadProfile(world(), PLUMBER))!.briefing;
    const withRecord = renderAgentPrompt(getPromptSetup("baseline-with-lead-record"), { name: "Sam", briefing: b });
    expect(withRecord).toContain("Example Pipe Works");
    expect(withRecord).toContain("Annual payroll: unknown. Ask.");
    expect(withRecord).toContain("a modelled estimate");
    const control = renderAgentPrompt(getPromptSetup("baseline-no-lead-record"), { name: "Sam", briefing: b });
    expect(control).not.toContain("Example Pipe Works");
    expect(control).toContain("artificial intelligence");
  });

  it("states real payroll with its basis and never invents a figure", async () => {
    const text = renderBriefing((await readLeadProfile(world(), ROOFER))!.briefing);
    expect(text).toContain("280000 dollars (basis: employees times county trade wage)");
  });
});
