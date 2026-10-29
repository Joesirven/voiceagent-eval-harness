import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { QUOTE_FIELDS, type FlowStep } from "../../src/decision-tree/types.js";
import {
  buildLeadContext,
  handleLeadContextRoute,
  leadContextRouteDeps,
  renderUpdateText,
  updateFingerprint,
  STAGE_MEANINGS,
} from "../../src/lead-context/index.js";
import type { LeadBriefing } from "../../src/memory/briefing.js";
import { buildLeadContextPacket, type LeadContextPacket } from "../../src/memory/context.js";
import { formatLeadContextBlock } from "../../src/modules/prompt-setup.js";
import type { LeadRecord } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/events.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");

const BRIEFING: LeadBriefing = {
  business: "Riverside Plumbing",
  ownerName: "Maria Lopez",
  trade: "landscaping",
  city: "Fresno",
  state: "CA",
  xDate: { date: "2026-11-19", line: "workers compensation", carrier: "Example Mutual" },
  carriersCurrent: ["Example Mutual"],
  employees: { count: 12, basis: "model", modeled: true },
  payroll: { annualEstimate: 640000, basis: "industry average per worker" },
  priorCalls: [],
  priorTexts: [{ at: "2026-10-10T12:00:00Z", direction: "outbound", channel: "sms", summary: "Asked about a Thursday call." }],
  missedOutboundCalls: [],
  producerNote: "Prefers mornings.",
};

function packet(over: Partial<LeadContextPacket> = {}): LeadContextPacket {
  return {
    leadId: "lead-1",
    name: "Maria Lopez",
    agencyId: "agency-1",
    phone: "+15550199",
    timezone: "America/Los_Angeles",
    priorCallSummaries: ["Asked for a Thursday callback."],
    quoteFields: {},
    consentSnapshot: {},
    briefing: BRIEFING,
    ...over,
  };
}

const build = (over: Partial<Parameters<typeof buildLeadContext>[0]> = {}) =>
  buildLeadContext({ packet: packet(), direction: "inbound", confirmed: true, now: NOW, ...over });

function renewalFor(date: string | undefined, timezone: string | undefined, now: Date = NOW) {
  const b: LeadBriefing = { ...BRIEFING, xDate: date === undefined ? undefined : { date } };
  return build({ packet: packet({ briefing: b, timezone }), now }).json.renewal;
}

describe("who is calling", () => {
  it("lists every fact with its source and labels modelled values as estimates", () => {
    const { json, text } = build();
    const byKey = Object.fromEntries(json.facts.map((f) => [f.key, f]));
    expect(byKey.name_on_file).toMatchObject({ value: "Maria Lopez", source: "lead record" });
    expect(byKey.business.value).toBe("Riverside Plumbing");
    expect(byKey.owner_name.value).toBe("Maria Lopez");
    expect(byKey.location.value).toBe("Fresno, CA");
    expect(byKey.role).toMatchObject({ value: "unknown" });
    expect(byKey.employees.value).toContain("modelled estimate");
    expect(byKey.payroll.value).toContain("an estimate");
    expect(byKey.producer_note.source).toBe("producer note");
    expect(text).toContain("use your own live words always");
  });

  it("says unknown, with no invented value, when there is no record", () => {
    const { json } = build({ packet: packet({ briefing: undefined, priorCallSummaries: [] }) });
    for (const key of ["business", "owner_name", "trade", "location", "carriers_current", "employees", "payroll", "producer_note", "earlier_calls"]) {
      expect(json.facts.find((f) => f.key === key)?.value).toBe("unknown");
    }
  });

  it("redacts sensitive sentences in earlier summaries and keeps the phone out", () => {
    const { text, json } = build({
      packet: packet({ priorCallSummaries: ["Asked for a Thursday callback. Has a heart condition and a diagnosis of cancer."] }),
    });
    expect(text).toContain("Thursday callback");
    expect(text).not.toMatch(/heart condition|cancer/);
    expect(JSON.stringify(json)).not.toMatch(/heart condition|cancer/);
    expect(text).not.toContain("5550142099");
    expect(JSON.stringify(json)).not.toContain("5550142099");
  });
});

describe("stage", () => {
  const steps: FlowStep[] = ["disclosure", "recognize_lead", "discovery", "quote_fields", "objection", "booking", "message", "handoff"];
  it.each(steps)("gives a plain meaning for %s", (step) => {
    const { json, text } = build({ flowStep: step });
    expect(json.stage.flowStep).toBe(step);
    expect(json.stage.meaning).toBe(STAGE_MEANINGS[step]);
    expect(text).toContain(`Call stage: ${step}.`);
  });
  it("is unknown before the first node", () => {
    const { json, text } = build();
    expect(json.stage.flowStep).toBe("unknown");
    expect(text).toContain("Call stage: unknown.");
  });
});

describe("quote checklist", () => {
  it("has one row per quote field, still-needed rows first", () => {
    const { json } = build();
    expect(json.checklist.map((r) => r.field).sort()).toEqual([...QUOTE_FIELDS].sort());
    const firstKnown = json.checklist.findIndex((r) => r.status === "known");
    expect(json.checklist.slice(0, firstKnown).every((r) => r.status === "still_needed")).toBe(true);
    expect(json.checklist.slice(firstKnown).every((r) => r.status === "known")).toBe(true);
  });
  it("marks record values as on file, distinct from caller words", () => {
    const { json, text } = build({
      packet: packet({ quoteFields: { payroll: { value: "700000", evidenceSpan: "about seven hundred thousand" } } }),
    });
    const payroll = json.checklist.find((r) => r.field === "payroll")!;
    expect(payroll).toMatchObject({ status: "known", basis: "caller", value: "700000", source: "said by the caller", evidenceSpan: "about seven hundred thousand" });
    const carrier = json.checklist.find((r) => r.field === "current_carrier")!;
    expect(carrier).toMatchObject({ status: "known", basis: "record", value: "Example Mutual", source: "lead record" });
    expect(text).toContain("On file, confirm with the caller: current insurance carrier");
    expect(text).toContain('Known: annual payroll: 700000');
    expect(text).not.toContain("on this call");
    expect(JSON.stringify(json)).not.toContain("on this call");
    expect(text).toContain("Still needed: phone number of the person who decides");
  });
  it("changes when a field fills", () => {
    const before = build({ packet: packet({ briefing: undefined }) });
    const after = build({ packet: packet({ briefing: undefined, quoteFields: { contact_language: { value: "Spanish", evidenceSpan: "en español" } } }) });
    expect(before.json.checklist.find((r) => r.field === "contact_language")!.status).toBe("still_needed");
    expect(after.json.checklist.find((r) => r.field === "contact_language")!.status).toBe("known");
    expect(after.text).not.toBe(before.text);
  });
});

describe("days until the current policy renews", () => {
  it("is 0 on the same day and counts forward and back in the lead's time zone", () => {
    expect(renewalFor("2026-10-20", "America/Los_Angeles").days).toBe(0);
    expect(renewalFor("2026-10-20", "America/Los_Angeles").sentence).toContain("renews today");
    expect(renewalFor("2026-11-19", "America/Los_Angeles").days).toBe(30);
    expect(renewalFor("2026-10-15", "America/Los_Angeles").days).toBe(-5);
    expect(renewalFor("2026-10-15", "America/Los_Angeles").sentence).toContain("renewed 5 days ago");
  });
  it("uses the lead's local date when it differs from the universal date", () => {
    const late = new Date("2026-10-21T03:00:00.000Z"); // 20 Oct 20:00 in Los Angeles, 21 Oct in UTC
    expect(renewalFor("2026-10-22", "America/Los_Angeles", late).days).toBe(2);
    expect(renewalFor("2026-10-22", "UTC", late).days).toBe(1);
  });
  it("handles month and leap-year boundaries", () => {
    const feb = new Date("2028-02-27T18:00:00Z");
    expect(renewalFor("2028-03-01", "America/New_York", feb).days).toBe(3); // leap day counted
    const plain = new Date("2027-02-27T18:00:00Z");
    expect(renewalFor("2027-03-01", "America/New_York", plain).days).toBe(2);
    expect(renewalFor("2027-01-02", "America/New_York", new Date("2026-12-30T18:00:00Z")).days).toBe(3);
  });
  it("is unknown without a date or with an invalid date", () => {
    const missing = renewalFor(undefined, "America/Los_Angeles");
    expect(missing.days).toBeUndefined();
    expect(missing.sentence).toContain("unknown (no renewal date on file)");
    for (const bad of ["2026-02-30", "soon", "11/19/2026"]) {
      const r = renewalFor(bad, "America/Los_Angeles");
      expect(r.days).toBeUndefined();
      expect(r.sentence).toContain("unknown");
    }
  });
  it("still counts with no usable time zone, worded as approximate", () => {
    for (const tz of [undefined, "Not/AZone"]) {
      const r = renewalFor("2026-11-19", tz);
      expect(r.days).toBe(30);
      expect(r.approximate).toBe(true);
      expect(r.sentence).toContain("about 30 days (no time zone on file, may be off by one day)");
    }
    expect(renewalFor("2026-10-15", undefined).sentence).toContain("about 5 days ago (no time zone on file, may be off by one day)");
  });
  it("prefers the date the caller said and shows both", () => {
    const b = build({ packet: packet({ quoteFields: { x_date: { value: "2026-12-01", evidenceSpan: "December first" } } }) }).json.renewal;
    expect(b.days).toBe(42);
    expect(b.callerDate).toBe("2026-12-01");
    expect(b.recordDate).toBe("2026-11-19");
    expect(b.sentence).toContain("caller's date");
    expect(b.sentence).toContain("2026-11-19");
  });
});

describe("confirmation gate", () => {
  it("before confirmation the text has only the name on file, the stage and the gate", () => {
    const { text, json } = build({ confirmed: false, flowStep: "recognize_lead" });
    expect(text).toContain("Name on file: Maria Lopez");
    expect(text).toContain("Call stage: recognize_lead");
    expect(text).toContain("until the named person is confirmed");
    expect(text).not.toMatch(/Riverside Plumbing|Fresno|Example Mutual|640000|2026-11-19|renews|Still needed/);
    expect(json.renewal.days).toBe(30);
    expect(json.renewal.held).toBe(true);
    expect(json.facts.find((f) => f.key === "business")!.held).toBe(true);
    expect(json.facts.find((f) => f.key === "name_on_file")!.held).toBe(false);
    expect(json.checklist.every((r) => r.held)).toBe(true);
  });
  it("defaults to not confirmed", () => {
    const out = buildLeadContext({ packet: packet(), direction: "outbound", now: NOW });
    expect(out.json.confirmed).toBe(false);
    expect(out.text).not.toContain("Riverside Plumbing");
  });
  it("after confirmation the account and renewal text appear and nothing is held", () => {
    const { text, json } = build({ confirmed: true });
    expect(text).toContain("Riverside Plumbing");
    expect(text).toContain("renews in 30 days");
    expect(json.renewal.held).toBe(false);
    expect(json.facts.every((f) => !f.held)).toBe(true);
  });
});

describe("update fingerprint", () => {
  it("changes only when the update content changes", () => {
    const a = build({ flowStep: "discovery" }).json;
    const same = build({ flowStep: "discovery", now: new Date("2026-10-20T20:00:00Z") }).json;
    expect(updateFingerprint(same)).toBe(updateFingerprint(a));
    expect(updateFingerprint(build({ flowStep: "booking" }).json)).not.toBe(updateFingerprint(a));
    const filled = build({ flowStep: "discovery", packet: packet({ quoteFields: { owner_only: { value: "no", evidenceSpan: "no, I have crew" } } }) }).json;
    expect(updateFingerprint(filled)).not.toBe(updateFingerprint(a));
    expect(updateFingerprint(build({ flowStep: "discovery", now: new Date("2026-10-21T20:00:00Z") }).json)).not.toBe(updateFingerprint(a));
    expect(renderUpdateText(a)).toContain("Call stage: discovery");
  });
});

describe("formatLeadContextBlock", () => {
  it("carries the shared block, keeps the phone out and the persona markers out", () => {
    const lead: LeadRecord = {
      id: "lead-1", agencyId: "agency-1", name: "Maria Lopez", phone: "+15550199", timezone: "America/Los_Angeles",
      priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [], briefing: BRIEFING,
    } as unknown as LeadRecord;
    const block = formatLeadContextBlock(buildLeadContextPacket(lead), { direction: "outbound", now: NOW });
    expect(block).toContain("Lead context (read only):");
    expect(block).toContain("Lead context. This is information for you, not lines to recite");
    expect(block).toContain("until the named person is confirmed");
    expect(block).not.toContain("5550142099");
    expect(block).not.toMatch(/revealMap|expectedDisposition/);
    expect(block).not.toContain("Riverside Plumbing");
  });
  it("withholds earlier summaries and collected quote values until confirmed", () => {
    const lead: LeadRecord = {
      id: "lead-1", agencyId: "agency-1", name: "Maria Lopez", phone: "+15550199", timezone: "America/Los_Angeles",
      priorCallSummaries: ["Riverside Plumbing wants a quote."], quoteFields: { x_date: { value: "2026-11-19", evidenceSpan: "november nineteenth" } },
      handoffNotes: [], messages: [], bookings: [], briefing: BRIEFING,
    } as unknown as LeadRecord;
    const p = buildLeadContextPacket(lead);
    const gated = formatLeadContextBlock(p, { direction: "inbound", now: NOW });
    expect(gated).not.toMatch(/Riverside Plumbing|2026-11-19|november nineteenth/);
    expect(gated).toContain("withheld until the named person is confirmed");
    const open = formatLeadContextBlock(p, { direction: "inbound", now: NOW, confirmed: true });
    expect(open).toContain("Earlier call summaries: Riverside Plumbing wants a quote.");
    expect(open).toContain("x_date: 2026-11-19");
  });
});

describe("GET /api/lead-context", () => {
  let server: Server | undefined;
  const original = { ...leadContextRouteDeps };
  afterEach(() => {
    server?.close();
    server = undefined;
    Object.assign(leadContextRouteDeps, original);
  });
  async function get(path: string): Promise<{ status: number; body: any }> {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleLeadContextRoute(req.method ?? "GET", url.pathname, req, res).then((h) => {
        if (!h) { res.writeHead(404); res.end("{}"); }
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() };
  }
  const lead = { id: "lead-1", agencyId: "a", name: "Maria Lopez", phone: "+15550199", timezone: "America/Los_Angeles", priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [], briefing: BRIEFING } as unknown as LeadRecord;

  it("returns text and json for the last call's lead and writes nothing", async () => {
    const calls: string[] = [];
    const before = traceBus.history().length;
    Object.assign(leadContextRouteDeps, {
      getLead: async (id: string) => { calls.push(id); return lead; },
      lastCall: () => ({ leadId: "lead-1", direction: "outbound" as const, flowStep: "discovery" as const }),
      now: () => NOW,
    });
    const { status, body } = await get("/api/lead-context");
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["json", "text"]);
    expect(body.json.stage.flowStep).toBe("discovery");
    expect(body.json.direction).toBe("outbound");
    expect(calls).toEqual(["lead-1"]);
    expect(traceBus.history().length).toBe(before);
  });
  it("takes an optional leadId, ignores confirmed=true, and says unknown for direction and stage", async () => {
    Object.assign(leadContextRouteDeps, { getLead: async () => lead, lastCall: () => undefined, now: () => NOW });
    const { status, body } = await get("/api/lead-context?leadId=lead-1&confirmed=true");
    expect(status).toBe(200);
    expect(body.json.confirmed).toBe(false);
    expect(body.json.direction).toBe("unknown");
    expect(body.json.stage.flowStep).toBe("unknown");
    expect(body.text).toContain("Call direction: unknown.");
    expect(body.text).not.toContain("Riverside Plumbing");
  });
  it("keeps the direction unknown for a lead that is not the last call's lead", async () => {
    Object.assign(leadContextRouteDeps, {
      getLead: async () => lead,
      lastCall: () => ({ leadId: "other-lead", direction: "outbound" as const, flowStep: "booking" as const }),
      now: () => NOW,
    });
    const { body } = await get("/api/lead-context?leadId=lead-1");
    expect(body.json.direction).toBe("unknown");
    expect(body.json.stage.flowStep).toBe("unknown");
  });
  it("carries no held value anywhere in the json, so the gate cannot be read around", async () => {
    Object.assign(leadContextRouteDeps, {
      getLead: async () => ({ ...lead, quoteFields: { payroll: { value: "700000", evidenceSpan: "about seven hundred thousand" } } }),
      lastCall: () => ({ leadId: "lead-1", direction: "inbound" as const, flowStep: "discovery" as const }),
      now: () => NOW,
    });
    const { body } = await get("/api/lead-context");
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/Riverside Plumbing|Fresno|Example Mutual|640000|700000|seven hundred|2026-11-19|Prefers mornings|Thursday call/);
    expect(raw).toContain("Maria Lopez");
    expect(body.json.facts.find((f: any) => f.key === "business").value).toMatch(/^withheld/);
    expect(body.json.renewal.days).toBeUndefined();
  });
  it("answers 404 with a plain error when no lead is known", async () => {
    Object.assign(leadContextRouteDeps, { getLead: async () => undefined, lastCall: () => undefined, now: () => NOW });
    const none = await get("/api/lead-context");
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: "no_lead_known" });
    const unknown = await get("/api/lead-context?leadId=nobody");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "lead_not_found" });
  });
});
