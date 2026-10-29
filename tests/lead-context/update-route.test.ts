import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleLeadContextRoute, leadContextRouteDeps } from "../../src/lead-context/index.js";
import type { LeadRecord } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/events.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const lead = {
  id: "lead-1", agencyId: "a", name: "Maria Ortega", phone: "+1555", timezone: "America/Los_Angeles", priorCallSummaries: [], quoteFields: {}, handoffNotes: [], messages: [], bookings: [],
  briefing: { business: "Ortega Landscaping", xDate: { date: "2026-11-19" }, carriersCurrent: [], priorCalls: [], priorTexts: [], missedOutboundCalls: [] },
} as unknown as LeadRecord;

describe("GET /api/lead-context/update", () => {
  let server: Server | undefined;
  const original = { ...leadContextRouteDeps };
  afterEach(() => { server?.close(); server = undefined; Object.assign(leadContextRouteDeps, original); });
  async function get(path: string) {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleLeadContextRoute(req.method ?? "GET", url.pathname, req, res).then((h) => { if (!h) { res.writeHead(404); res.end("{}"); } });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: r.status, body: await r.json() as any };
  }
  const use = () => Object.assign(leadContextRouteDeps, { getLead: async () => lead, now: () => NOW });

  it("holds account facts before confirmation: stage and the gate sentence only", async () => {
    use();
    for (const q of ["flowStep=recognize_lead", "flowStep=objection", ""]) {
      const { status, body } = await get(`/api/lead-context/update?leadId=lead-1&direction=inbound&${q}`);
      expect(status).toBe(200);
      expect(body.confirmed).toBe(false);
      expect(body.text).toContain("Call context update (information for you, not lines to say):");
      expect(body.text).toContain("until the named person is confirmed");
      expect(body.text).not.toMatch(/Ortega Landscaping|2026-11-19|Still needed/);
    }
  });
  it("carries the checklist and days to renewal from discovery on, from a flow step or a tree node", async () => {
    use();
    for (const q of ["flowStep=discovery", "flowStep=quote_fields", "treeNode=discovery.employees"]) {
      const { body } = await get(`/api/lead-context/update?leadId=lead-1&direction=outbound&${q}`);
      expect(body.confirmed, q).toBe(true);
      expect(body.text, q).toContain("Still needed");
      expect(body.text, q).toMatch(/30 days/);
    }
  });
  it("refuses an unknown flow step, an unknown lead and a bad lead id, and writes nothing", async () => {
    use();
    const before = traceBus.history().length;
    expect((await get("/api/lead-context/update?leadId=lead-1&flowStep=bogus")).status).toBe(400);
    expect((await get("/api/lead-context/update?leadId=..%2Fx")).status).toBe(404);
    Object.assign(leadContextRouteDeps, { getLead: async () => undefined });
    expect((await get("/api/lead-context/update?leadId=nobody&flowStep=discovery")).status).toBe(404);
    expect(traceBus.history().length).toBe(before);
  });
});
