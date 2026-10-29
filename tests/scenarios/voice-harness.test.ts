import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness, deriveCallKey } from "../../src/harness/call-harness.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { azureGetContextPacket } from "../../src/modules/azure-realtime.js";
import { getCallLogs, clearCallLogs } from "../../src/store/call-log.js";
import {
  getLead,
  resetLeadStore,
  seedLead,
  hasIdempotencyKey,
} from "../../src/store/lead-store.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";
import {
  INBOUND_AI_DISCLOSURE,
  OUTBOUND_AI_TRUTHFUL_ANSWER,
} from "../../src/compliance/disclosures.js";
import { collectFinalTranscript, eventsFromScript } from "../../src/orchestration/call-loop.js";
import { buildHandoffNote } from "../../src/memory/handoff.js";

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/** 10:00 Eastern during EDT (UTC-4) */
const IN_WINDOW_UTC = "2026-10-15T14:00:00.000Z";
/** 22:00 Eastern */
const OUTSIDE_WINDOW_UTC = "2026-10-15T02:00:00.000Z";

beforeEach(() => {
  resetHarnessConfig();
  resetModuleRegistry();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
});

afterEach(() => {
  resetHarnessConfig();
});

describe("1. Recognized-lead inbound", () => {
  it("disclosure, quote from speech, handoff filed", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const result = await harness.runInbound("lead-1", "+15550143", {
      idempotencyKey: "inb-1",
      callerUtterances: [
        "Hi, I am Jane Doe, I need an auto quote.",
        "I drive a 2019 Honda Civic.",
      ],
    });

    expect(result.status).toBe("ai_handled");
    expect(result.disclosures?.some((d) => d.includes(INBOUND_AI_DISCLOSURE))).toBe(true);

    const lead = getLead("lead-1");
    expect(lead?.quoteFields.vehicle_year?.value).toBe("2019");
    expect(lead?.handoffNotes.length).toBe(1);
    expect(lead?.handoffNotes[0]?.callerWanted).toBe("Auto quote");
  });
});

describe("2. Outbound at agreed time", () => {
  it("consent, window, truthful AI answer, handoff", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const result = await harness.runOutbound("lead-1", "+15550167", {
      idempotencyKey: "out-1",
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Are you an AI?"],
    });
    expect(result.status).toBe("placed");
    const logs = getCallLogs();
    expect(logs.some((l) => l.outcome === "placed" && l.direction === "outbound")).toBe(true);
    const lead = getLead("lead-1");
    expect(lead?.handoffNotes.length).toBe(1);
    expect(lead?.handoffNotes[0]?.callerWanted).toBe("Are you an AI?");
    expect(OUTBOUND_AI_TRUTHFUL_ANSWER).toContain("AI assistant");
  });
});

describe("3. Quiet-hours refusal", () => {
  it("blocks outbound and SMS outside 8–21 local", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(OUTSIDE_WINDOW_UTC));
    const call = await harness.runOutbound("lead-1", "+15550167", {
      idempotencyKey: "out-quiet",
      scheduledReason: "text_agreed_callback",
    });
    expect(call.status).toBe("blocked");
    expect(call.reason).toMatch(/outside_quiet_hours/);

    const sms = await harness.sendText("lead-1", "Hello", "sms-quiet");
    expect(sms.status).toBe("blocked");
    expect(sms.reason).toMatch(/outside_quiet_hours/);

    const reasons = getCallLogs()
      .filter((l) => l.outcome === "blocked")
      .map((l) => l.reason);
    expect(reasons.some((r) => r.includes("outside_quiet_hours"))).toBe(true);
  });

  it("inbound falls back to normal answering outside quiet hours", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(OUTSIDE_WINDOW_UTC));
    const result = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "in-quiet",
      callerUtterances: ["Hello"],
    });
    expect(result.status).toBe("normal_answering");
    expect(
      getCallLogs().some((l) => l.reason.includes("outside_quiet_hours") && l.outcome === "skipped"),
    ).toBe(true);
    expect(hasIdempotencyKey(deriveCallKey("inbound", baseLead(), "in-quiet"))).toBe(false);
  });
});

describe("4. STOP / suppression", () => {
  it("blocks outbound with log reason", async () => {
    seedLead(baseLead({ onStopList: true }));
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const result = await harness.runOutbound("lead-1", "+15550167", {
      idempotencyKey: "out-stop",
      scheduledReason: "text_agreed_callback",
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("stop_list");
    expect(getCallLogs().some((l) => l.reason === "stop_list")).toBe(true);
    expect(hasIdempotencyKey(deriveCallKey("outbound", baseLead(), "out-stop"))).toBe(false);
  });

  it("inbound falls back when on stop list", async () => {
    seedLead(baseLead({ onStopList: true }));
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const result = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "in-stop",
      callerUtterances: ["Hi"],
    });
    expect(result.status).toBe("normal_answering");
    expect(getCallLogs().some((l) => l.reason.includes("stop_list"))).toBe(true);
  });
});

describe("5. Duplicate webhook", () => {
  it("second delivery does not place a second call", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const key = "webhook-dup-1";
    const first = await harness.runOutbound("lead-1", "+15550167", {
      idempotencyKey: key,
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Are you an AI?"],
    });
    expect(first.status).toBe("placed");
    const second = await harness.runOutbound("lead-1", "+15550167", {
      idempotencyKey: key,
      scheduledReason: "text_agreed_callback",
    });
    expect(second.status).toBe("skipped_duplicate");
    const placed = getCallLogs().filter(
      (l) => l.outcome === "placed" && l.direction === "outbound" && l.requestKey === key,
    );
    expect(placed.length).toBe(1);
    expect(hasIdempotencyKey(deriveCallKey("outbound", baseLead(), key))).toBe(true);
  });

  it("blocked first attempt does not burn idempotency key", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const key = "webhook-retry-1";
    const blocked = await harness.runOutbound("lead-1", "+1", {
      idempotencyKey: key,
    });
    expect(blocked.status).toBe("blocked");
    expect(hasIdempotencyKey(deriveCallKey("outbound", baseLead(), key))).toBe(false);
    const placed = await harness.runOutbound("lead-1", "+1", {
      idempotencyKey: key,
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Hi"],
    });
    expect(placed.status).toBe("placed");
  });
});

describe("6. Logging completeness", () => {
  it("placed, answered, skipped, blocked each log a reason", async () => {
    seedLead(baseLead());
    const harnessOn = new CallHarness(fixedClock(IN_WINDOW_UTC));
    await harnessOn.runInbound("lead-1", "+1", {
      idempotencyKey: "log-in",
      callerUtterances: ["Hi, Jane Doe, auto quote", "2019 Civic"],
    });
    await harnessOn.runOutbound("lead-1", "+1", {
      idempotencyKey: "log-out",
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Hello"],
    });

    setAiCallingEnabled("agency-demo", false);
    const harnessOff = new CallHarness(fixedClock(IN_WINDOW_UTC));
    await harnessOff.runInbound("lead-1", "+1", { idempotencyKey: "log-skip" });

    setAiCallingEnabled("agency-demo", true);
    seedLead(baseLead({ onDncList: true }));
    await harnessOn.runOutbound("lead-1", "+1", {
      idempotencyKey: "log-block",
      scheduledReason: "text_agreed_callback",
    });

    const outcomes = new Set(getCallLogs().map((l) => l.outcome));
    for (const o of ["placed", "answered", "skipped", "blocked"] as const) {
      expect(outcomes.has(o)).toBe(true);
    }
    expect(getCallLogs().every((l) => l.reason.length > 0)).toBe(true);
  });
});

describe("7. Feature flag off", () => {
  it("inbound normal answering; outbound not placed; on runs AI", async () => {
    seedLead(baseLead());
    setAiCallingEnabled("agency-demo", false);
    const off = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const inOff = await off.runInbound("lead-1", "+1", { idempotencyKey: "ff-in-off" });
    expect(inOff.status).toBe("normal_answering");
    const outOff = await off.runOutbound("lead-1", "+1", { idempotencyKey: "ff-out-off" });
    expect(outOff.status).toBe("blocked");
    expect(outOff.reason).toBe("ai_calling_disabled");

    setAiCallingEnabled("agency-demo", true);
    const on = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const inOn = await on.runInbound("lead-1", "+1", {
      idempotencyKey: "ff-in-on",
      callerUtterances: ["Hi Jane Doe auto quote"],
    });
    expect(inOn.status).toBe("ai_handled");
  });
});

describe("8. Invented fact rejected", () => {
  it("field without evidence span is not written", async () => {
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "hall-1",
      callerUtterances: ["Hello", "I want a 500 dollar deductible"],
    });
    const lead = getLead("lead-1");
    expect(lead?.quoteFields.premium).toBeUndefined();
    expect(lead?.quoteFields.deductible?.value).toBe("500");
    expect(lead?.quoteFields.premium).toBeUndefined();
  });

  it("invented handoff line is not stored", async () => {
    const transcript = [{ role: "caller" as const, text: "Hello", turnIndex: 0, spoken: true }];
    const note = buildHandoffNote(
      "call_test",
      transcript,
      "Invented caller request",
      "Invented promise",
      ["Invented question"],
      {},
    );
    expect(note).toBeNull();
    seedLead(baseLead());
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "hall-handoff",
      callerUtterances: ["Hello"],
    });
    expect(getLead("lead-1")?.handoffNotes.length).toBe(0);
  });
});

describe("9. Barge-in trims agent transcript", () => {
  it("keeps only spoken agent words after interrupt", () => {
    const longAgent =
      "This is a very long agent response that would keep going but the caller interrupted.";
    const spokenOnly = "This is a very";
    const script = [
      { role: "caller" as const, text: "Hello", turnIndex: 0, spoken: true },
      { role: "agent" as const, text: longAgent, turnIndex: 1 },
    ];
    const events = eventsFromScript(script, 1);
    const final = collectFinalTranscript(events, spokenOnly);
    const agent = final.find((t) => t.role === "agent" && t.turnIndex === 1);
    expect(agent?.text).toBe(spokenOnly);
    expect(agent?.text).not.toContain("interrupted");
  });
});

describe("10. Context packet on voice path", () => {
  it("azure session receives lead packet at call start", async () => {
    seedLead(baseLead({ name: "Packet Test" }));
    const harness = new CallHarness(fixedClock(IN_WINDOW_UTC));
    const result = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "ctx-1",
      callerUtterances: ["Hi Packet Test auto quote"],
    });
    expect(result.callId).toBeDefined();
    const packet = azureGetContextPacket(result.callId!);
    expect(packet?.name).toBe("Packet Test");
    expect(packet?.leadId).toBe("lead-1");
  });
});
