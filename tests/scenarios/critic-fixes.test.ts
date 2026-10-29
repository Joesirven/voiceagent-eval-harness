/** Regression tests for the critic's blocking findings (docs/scenario-coverage.md). */
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { VapiModule } from "../../src/modules/vapi.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { takeClearanceIssuer, type CallClearance } from "../../src/provider/clearance.js";
import type { CallSession, TranscriptEvent, TranscriptTurn } from "../../src/provider/interface.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead, writeQuoteField } from "../../src/store/lead-store.js";
import { mockLeadStore, type LeadStore } from "../../src/store/lead-store-seam.js";
import { claimSupportedByTranscript } from "../../src/memory/handoff.js";
import { evidenceSupportsValue } from "../../src/memory/evidence.js";
import { baseLead } from "../helpers/fixtures.js";
import { narrate, traceBus } from "../../src/trace/index.js";

const clock = { now: () => new Date("2026-10-15T14:00:00.000Z") };
const contextPacket = {
  leadId: "lead-1",
  name: "Jane Doe",
  agencyId: "agency-demo",
  phone: "+1",
  priorCallSummaries: [],
  quoteFields: {},
  consentSnapshot: {},
};

beforeEach(() => {
  resetHarnessConfig();
  setAiCallingEnabled("agency-demo", true);
  resetModuleRegistry();
  resetLeadStore();
  clearCallLogs();
  seedLead(baseLead());
});

describe("1. modules accept only a clearance minted by the harness", () => {
  it("a direct call with no clearance is a type error and throws", async () => {
    seedLead(baseLead({ onStopList: true }));
    const mod = getModuleRegistry().get("azure-gpt-live");
    await expect(
      // @ts-expect-error clearance is required
      mod.startOutboundCall({ leadId: "lead-1", toNumber: "+1", idempotencyKey: "k", contextPacket }),
    ).rejects.toThrow("call_not_cleared");
    await expect(
      mod.startInboundCall({
        leadId: "lead-1",
        fromNumber: "+1",
        idempotencyKey: "k",
        contextPacket,
        clearance: { leadId: "lead-1", direction: "inbound", idempotencyKey: "k" } as unknown as CallClearance,
      }),
    ).rejects.toThrow("call_not_cleared");
  });

  it("no second issuer can be taken", () => {
    expect(() => takeClearanceIssuer()).toThrow("clearance_issuer_already_taken");
  });

  it("the harness refuses a STOP-listed lead and never reaches the module", async () => {
    seedLead(baseLead({ onStopList: true }));
    const r = await new CallHarness(clock).runOutbound("lead-1", "+1", {
      idempotencyKey: "k1",
      scheduledReason: "text_agreed_callback",
    });
    expect(r.status).toBe("blocked");
    expect(getCallLogs().some((l) => l.outcome === "placed")).toBe(false);
  });
});

describe("2. the harness owns the disclosure turn", () => {
  class SkippingModule extends VapiModule {
    override async *streamTranscript(
      _session: CallSession,
      script: TranscriptTurn[],
    ): AsyncGenerator<TranscriptEvent, void, undefined> {
      for (const turn of script.filter((t) => t.turnIndex >= 0)) {
        yield { type: "final", turn: { ...turn, spoken: true } };
      }
    }
  }

  it("a module that overrides streamTranscript and skips it is caught and logged", async () => {
    const registry = getModuleRegistry();
    const skipping = new SkippingModule();
    skipping.setEnabled(true);
    (registry as unknown as { modules: Map<string, unknown> }).modules.set("vapi", skipping);
    registry.select("vapi");
    await expect(
      new CallHarness(clock).runInbound("lead-1", "+1", {
        idempotencyKey: "d1",
        callerUtterances: ["Hi, Jane Doe, auto quote"],
      }),
    ).rejects.toThrow("inbound_disclosure_not_first");
    expect(getCallLogs().some((l) => l.reason.includes("inbound_disclosure_not_first"))).toBe(true);
  });

  it("on a normal call the first turn is exactly the disclosure", async () => {
    const r = await new CallHarness(clock).runInbound("lead-1", "+1", {
      idempotencyKey: "d2",
      callerUtterances: ["Hello"],
    });
    expect(r.transcript?.[0]).toMatchObject({ role: "agent", text: inboundOpeningScript() });
  });
});

describe("3. the harness derives the call key and locks the lead", () => {
  const outbound = (h: CallHarness, key: string) =>
    h.runOutbound("lead-1", "+1", {
      idempotencyKey: key,
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Hello"],
    });

  it("concurrent duplicates with different caller keys place one call", async () => {
    const h = new CallHarness(clock);
    const results = await Promise.all([outbound(h, "a"), outbound(h, "b"), outbound(h, "a")]);
    expect(results.filter((r) => r.status === "placed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "skipped_duplicate")).toHaveLength(2);
    expect(getCallLogs().filter((l) => l.outcome === "placed")).toHaveLength(1);
  });

  it("an inbound and an outbound for one lead do not overlap", async () => {
    const h = new CallHarness(clock);
    const [out, inn] = await Promise.all([
      outbound(h, "a"),
      h.runInbound("lead-1", "+1", { idempotencyKey: "i", callerUtterances: ["Hi"] }),
    ]);
    expect([out.status, inn.status].filter((s) => s === "placed" || s === "ai_handled")).toHaveLength(1);
  });

  it("a later call after the first finished is still a duplicate for the same slot", async () => {
    const h = new CallHarness(clock);
    expect((await outbound(h, "a")).status).toBe("placed");
    expect((await outbound(h, "zzz")).status).toBe("skipped_duplicate");
  });

  it("a text with a repeated key is sent once", async () => {
    const h = new CallHarness(clock);
    expect((await h.sendText("lead-1", "hi", "t1")).status).toBe("recorded");
    expect((await h.sendText("lead-1", "hi", "t1")).status).toBe("skipped_duplicate");
    expect(getCallLogs().filter((l) => l.outcome === "message_sent")).toHaveLength(1);
  });

  it("a text that passes every gate is recorded, never reported as sent, because no sender is connected", async () => {
    const h = new CallHarness(clock);
    traceBus.reset();
    expect((await h.sendText("lead-1", "hi", "t-honest")).status).toBe("recorded");
    const texts = traceBus.history().filter((e) => e.type === "text");
    expect(texts.map((e) => e.data.status)).toEqual(["recorded"]);
    expect(narrate(texts[0]!)).toMatch(/nothing was sent/);
    expect(getCallLogs().find((l) => l.channel === "sms")?.reason).toBe("sms_recorded_no_sender");
  });

  it("a start failure is logged as blocked and releases the key for a retry", async () => {
    const registry = getModuleRegistry();
    const h = new CallHarness(clock);
    const real = registry.get("azure-gpt-live");
    const original = real.startOutboundCall.bind(real);
    real.startOutboundCall = async () => {
      throw new Error("provider_down");
    };
    const failed = await outbound(h, "a");
    expect(failed.status).toBe("blocked");
    expect(failed.reason).toContain("provider_down");
    expect(getCallLogs().some((l) => l.outcome === "blocked" && l.reason.includes("provider_down"))).toBe(true);
    real.startOutboundCall = original;
    expect((await outbound(h, "a")).status).toBe("placed");
  });
});

describe("4. quote fields need caller words, matched by whole word", () => {
  it("the store refuses 999 with the span 'not said'", () => {
    expect(writeQuoteField("lead-1", "premium", "999", "not said", ["Hello there"])).toBe(false);
    expect(getLead("lead-1")?.quoteFields.premium).toBeUndefined();
  });

  it("the store refuses a span that no caller turn contains, even if it holds the value", () => {
    expect(writeQuoteField("lead-1", "premium", "999", "premium is 999", ["Hello there"])).toBe(false);
  });

  it("whole-word matching: 50 is not supported by 500 or 2019", () => {
    expect(evidenceSupportsValue("50", "I want a 500 dollar deductible", ["I want a 500 dollar deductible"])).toBe(false);
    expect(evidenceSupportsValue("201", "a 2019 Civic", ["a 2019 Civic"])).toBe(false);
    expect(evidenceSupportsValue("2019", "a 2019 Civic", ["It is a 2019 Civic."])).toBe(true);
  });

  it("an agent-only span is not caller evidence", async () => {
    const accepted = await mockLeadStore.writeQuoteField("lead-1", "x", "email", "We will email your quote", [
      "Hello",
    ]);
    expect(accepted).toBe(false);
  });
});

describe("5. a connected call is never redialled after a late failure", () => {
  it("handoff write throws, retry for the same slot is a duplicate, one dial logged", async () => {
    const failing: LeadStore = {
      ...mockLeadStore,
      appendHandoffNote: async () => {
        throw new Error("handoff_write_failed");
      },
    };
    const h = new CallHarness(clock, failing);
    const opts = {
      idempotencyKey: "late-1",
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Are you an AI?"],
    };
    await expect(h.runOutbound("lead-1", "+1", opts)).rejects.toThrow("handoff_write_failed");
    const retry = await h.runOutbound("lead-1", "+1", { ...opts, idempotencyKey: "late-2" });
    expect(retry.status).toBe("skipped_duplicate");
    expect(getCallLogs().filter((l) => l.reason === "outbound_ai_dial")).toHaveLength(1);
  });
});

describe("6. handoff claims come from the right side of the call", () => {
  const turns = (caller: string[], agent: string[]): TranscriptTurn[] => [
    ...caller.map((text, i) => ({ role: "caller" as const, text, turnIndex: i, spoken: true })),
    ...agent.map((text, i) => ({ role: "agent" as const, text, turnIndex: 10 + i, spoken: true })),
  ];

  it("what the caller wanted must be in caller turns, not the agent's words", () => {
    const t = turns(["Hello"], ["Would you like an auto quote today?"]);
    expect(claimSupportedByTranscript(t, "Auto quote", "caller")).toBe(false);
    expect(claimSupportedByTranscript(t, "Auto quote", "agent")).toBe(true);
  });

  it("whole words only: 'cat' is not found in 'category'", () => {
    const t = turns(["I have a category question"], []);
    expect(claimSupportedByTranscript(t, "cat question", "caller")).toBe(false);
    expect(claimSupportedByTranscript(t, "category question", "caller")).toBe(true);
  });
});
