import { describe, expect, it } from "vitest";
import { createContextUpdater, UPDATE_HEADING } from "../../src/lead-context/index.js";
import type { LeadRecord } from "../../src/store/lead-store.js";
import type { TraceEvent } from "../../src/trace/events.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");

function lead(quoteFields: LeadRecord["quoteFields"] = {}): LeadRecord {
  return {
    id: "lead-1", name: "Maria Ortega", agencyId: "agency-1", phone: "+15550199", timezone: "America/Los_Angeles",
    priorCallSummaries: [], quoteFields, handoffNotes: [], messages: [], bookings: [],
    briefing: {
      business: "Ortega Landscaping", xDate: { date: "2026-11-19" }, carriersCurrent: [], priorCalls: [], priorTexts: [], missedOutboundCalls: [],
    },
  } as unknown as LeadRecord;
}

function setup(record: () => LeadRecord) {
  let listener: ((e: TraceEvent) => void) | undefined;
  let stopped = false;
  const updater = createContextUpdater({
    callId: "call-1", leadId: "lead-1", direction: "inbound", now: () => NOW,
    subscribe: (l) => ((listener = l), () => { stopped = true; }),
    getLead: () => record(),
  });
  const enter = (flowStep: string, callId = "call-1") => listener!({ type: "node_enter", callId, flowStep, data: {} } as unknown as TraceEvent);
  return { updater, enter, stopped: () => stopped };
}

describe("live context updates", () => {
  it("sends nothing before the tree has entered a node", async () => {
    const { updater } = setup(() => lead());
    expect(await updater.next()).toBeUndefined();
  });

  it("carries the stage alone while the named person may not be confirmed (account and renewal stay held)", async () => {
    const { updater, enter } = setup(() => lead());
    enter("recognize_lead");
    const text = (await updater.next())!;
    expect(text.startsWith(UPDATE_HEADING)).toBe(true);
    expect(text).toContain("recognize_lead");
    expect(text).not.toMatch(/Ortega Landscaping|2026-11-19|days/);
  });

  it("carries the stage, the quote checklist and the days to renewal once past confirmation, and resends only on change", async () => {
    let fields: LeadRecord["quoteFields"] = {};
    const { updater, enter } = setup(() => lead(fields));
    enter("discovery");
    const first = (await updater.next())!;
    expect(first).toContain("discovery");
    expect(first).toMatch(/30 days|in 30/);
    expect(await updater.next()).toBeUndefined();
    fields = { employee_count: { value: "12", evidenceSpan: "twelve of us" } };
    const second = (await updater.next())!;
    expect(second).not.toEqual(first);
    expect(second).toContain("twelve of us");
    expect(await updater.next()).toBeUndefined();
    enter("quote_fields");
    expect(await updater.next()).toContain("quote_fields");
  });

  it("ignores another call's node events and stops listening on stop", async () => {
    const { updater, enter, stopped } = setup(() => lead());
    enter("discovery", "other-call");
    expect(await updater.next()).toBeUndefined();
    updater.stop();
    expect(stopped()).toBe(true);
  });

  it("sends nothing when the lead cannot be read", async () => {
    const { updater, enter } = setup(() => undefined as unknown as LeadRecord);
    enter("discovery");
    expect(await updater.next()).toBeUndefined();
  });
});
