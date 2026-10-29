import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildLeadContext, callerLineConfirms, handleLeadContextRoute, leadContextGateOn, leadContextRouteDeps } from "../../src/lead-context/index.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import { formatLeadContextBlock } from "../../src/modules/prompt-setup.js";
import type { LeadRecord } from "../../src/store/lead-store.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const lead = {
  id: "lead-1", agencyId: "a", name: "Jane Doe", phone: "+15550111", timezone: "America/Los_Angeles", priorCallSummaries: ["Asked about a Thursday call."],
  quoteFields: { employee_count: { value: "12", evidenceSpan: "twelve of us" } }, handoffNotes: [], messages: [], bookings: [],
  briefing: { business: "Doe Roofing", ownerName: "Jane Doe", trade: "roofing", xDate: { date: "2026-11-19", carrier: "State Fund" }, carriersCurrent: ["State Fund"], priorCalls: [], priorTexts: [], missedOutboundCalls: [] },
} as unknown as LeadRecord;

let server: Server | undefined;
const original = { ...leadContextRouteDeps };
afterEach(() => {
  server?.close();
  server = undefined;
  Object.assign(leadContextRouteDeps, original);
  delete process.env.VOICE_HARNESS_LEAD_CONTEXT_GATE;
});
async function call(path: string, init?: RequestInit) {
  Object.assign(leadContextRouteDeps, { getLead: async (id: string) => (id === "lead-1" ? lead : undefined), now: () => NOW, lastCall: () => undefined });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleLeadContextRoute(req.method ?? "GET", url.pathname, req, res).then((h) => { if (!h) { res.writeHead(404); res.end("{}"); } });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
  return { status: r.status, body: (await r.json()) as any, raw: "" };
}
const post = (body: unknown, type = "application/json") => ({ method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

describe("confirmation gate setting", () => {
  it("is on by default and off only for VOICE_HARNESS_LEAD_CONTEXT_GATE=off", () => {
    expect(leadContextGateOn({})).toBe(true);
    expect(leadContextGateOn({ VOICE_HARNESS_LEAD_CONTEXT_GATE: "on" })).toBe(true);
    expect(leadContextGateOn({ VOICE_HARNESS_LEAD_CONTEXT_GATE: "OFF" })).toBe(false);
  });
  it("with the gate off, the start block carries known values, missing quote fields and renewal days before confirmation", () => {
    const packet = buildLeadContextPacket(lead);
    const gated = buildLeadContext({ packet, direction: "inbound", now: NOW }).text;
    expect(gated).not.toContain("Doe Roofing");
    process.env.VOICE_HARNESS_LEAD_CONTEXT_GATE = "off";
    const open = buildLeadContext({ packet, direction: "inbound", now: NOW }).text;
    expect(open).toContain("Doe Roofing");
    expect(open).toContain("Still needed");
    expect(open).toMatch(/30 days/);
    const block = formatLeadContextBlock(packet, { direction: "inbound", now: NOW });
    expect(block).toContain("employee_count: 12");
    expect(block).toContain("Asked about a Thursday call.");
  });
  it("with the gate off, both routes serve the full content with no stage and no caller line", async () => {
    process.env.VOICE_HARNESS_LEAD_CONTEXT_GATE = "off";
    const update = await call("/api/lead-context/update", post({ leadId: "lead-1", direction: "inbound" }));
    expect(update.body).toMatchObject({ confirmed: true, confirmedBy: "gate_off" });
    expect(update.body.text).toContain("Still needed");
    server!.close();
    const block = await call("/api/lead-context?leadId=lead-1");
    expect(block.body.text).toContain("Doe Roofing");
    expect(JSON.stringify(block.body.json)).not.toContain("withheld");
  });
});

describe("GET /api/lead-context/state", () => {
  it("lists what is known with its source, the quote fields still missing, and the renewal days", async () => {
    const { status, body } = await call("/api/lead-context/state?leadId=lead-1");
    expect(status).toBe(200);
    expect(body.known).toContainEqual(expect.objectContaining({ field: "employee_count", value: "12", source: "said by the caller" }));
    expect(body.known).toContainEqual(expect.objectContaining({ field: "x_date", value: "2026-11-19" }));
    expect(body.known.every((k: any) => typeof k.field === "string" && typeof k.value === "string" && typeof k.source === "string")).toBe(true);
    expect(body.missing).toContain("payroll");
    expect(body.missing).not.toContain("employee_count");
    expect(body.renewalDays).toBe(30);
    expect(JSON.stringify(body)).not.toContain("+15550111");
  });
  it("gives null renewal days without a date, and 404 for an unknown lead", async () => {
    const noDate = { ...lead, briefing: { ...(lead.briefing as object), xDate: undefined } } as unknown as LeadRecord;
    Object.assign(leadContextRouteDeps, {});
    const first = await call("/api/lead-context/state?leadId=nobody");
    expect(first.status).toBe(404);
    server!.close();
    leadContextRouteDeps.getLead = async () => noDate;
    server = createServer((req, res) => { void handleLeadContextRoute("GET", new URL(req.url ?? "/", "http://x").pathname, req, res); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead-context/state?leadId=lead-1`);
    expect(((await r.json()) as any).renewalDays).toBeNull();
  });
});

describe("single prompt confirmation from the first caller line", () => {
  const names = ["Jane"];
  it.each(["Yes", "yeah, that's me", "Speaking.", "This is Jane", "jane here", "Hi it's Jane Doe", "Yep!", "Sí, soy yo", "this is she", "That's right"])("confirms: %s", (line) => {
    expect(callerLineConfirms(line, names).confirmed).toBe(true);
  });
  it.each(["No, Jane isn't here", "Jane's not available right now", "This is Bob, her husband", "Who is this?", "Not right now", "wrong number", "", "uh", "hello?", "yes she's at work", "yeah hold on I'll get her", "Jane's my wife", "Jane?", "Janet speaking", "Bob here", "yesterday was busy", "yes... no, wrong number", "I'm her assistant"])("keeps the gate: %s", (line) => {
    expect(callerLineConfirms(line, names).confirmed).toBe(false);
  });
  it("keeps the gate with no caller line, and its reason never repeats the caller's words", () => {
    expect(callerLineConfirms(undefined, names)).toEqual({ confirmed: false, reason: "no caller line yet" });
    expect(callerLineConfirms("Jane secretword", names).reason).not.toContain("secretword");
  });
  it("the update route opens on a confirming line with no stage, a stage wins over the line, and the line is never echoed", async () => {
    const yes = await call("/api/lead-context/update", post({ leadId: "lead-1", direction: "outbound", firstCallerLine: "Yes, this is Jane, secretword" }));
    expect(yes.body).toMatchObject({ confirmed: true, confirmedBy: "caller_line" });
    expect(yes.body.text).toContain("Still needed");
    expect(JSON.stringify(yes.body)).not.toContain("secretword");
    server!.close();
    const staged = await call("/api/lead-context/update", post({ leadId: "lead-1", direction: "outbound", flowStep: "recognize_lead", firstCallerLine: "Yes" }));
    expect(staged.body.confirmed).toBe(false);
    server!.close();
    const no = await call("/api/lead-context/update", post({ leadId: "lead-1", direction: "outbound", firstCallerLine: "No, she's out" }));
    expect(no.body.confirmed).toBe(false);
    expect(no.body.text).not.toContain("Doe Roofing");
  });
  it("refuses a non JSON body, an oversized line, and still answers GET with the line as a query value", async () => {
    expect((await call("/api/lead-context/update", post({ leadId: "lead-1" }, "text/plain"))).status).toBe(415);
    server!.close();
    expect((await call("/api/lead-context/update", post({ leadId: "lead-1", firstCallerLine: "x".repeat(501) }))).status).toBe(400);
    server!.close();
    const get = await call("/api/lead-context/update?leadId=lead-1&direction=inbound&firstCallerLine=speaking");
    expect(get.body.confirmed).toBe(true);
  });
});
