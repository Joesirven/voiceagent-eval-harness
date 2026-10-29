import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { baseLead } from "../helpers/fixtures.js";

const clock = { now: () => new Date("2026-10-15T14:00:00.000Z") };
const EXPECTED_IDS = [
  "azure-gpt-live",
  "openai-realtime",
  "vapi",
  "retell",
  "elevenlabs-agents",
  "bland",
  "fish-audio",
  "sesame",
];

beforeEach(() => {
  resetHarnessConfig();
  setAiCallingEnabled("agency-demo", true);
  resetModuleRegistry();
  resetLeadStore();
  clearCallLogs();
  seedLead(baseLead());
});

describe("voice modules behind one interface", () => {
  it("registers all eight options with typed config", () => {
    const infos = getModuleRegistry().list();
    expect(infos.map((m) => m.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const m of infos) {
      expect(m.config.voice).toBeTruthy();
      expect(m.config.model).toBeTruthy();
      expect(m.config.latency.firstResponseMs).toBeGreaterThan(0);
    }
  });

  it.each(EXPECTED_IDS)("%s runs inbound and outbound end to end", async (id) => {
    const registry = getModuleRegistry();
    registry.setEnabled(id, true);
    registry.select(id);
    const harness = new CallHarness(clock);
    const inbound = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: `in-${id}`,
      callerUtterances: ["Hi, Jane Doe, auto quote", "2019 Civic"],
    });
    expect(inbound.status).toBe("ai_handled");
    expect(inbound.moduleId).toBe(id);
    const outbound = await harness.runOutbound("lead-1", "+1", {
      idempotencyKey: `out-${id}`,
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Are you an AI?"],
    });
    expect(outbound.status).toBe("placed");
    expect(outbound.moduleId).toBe(id);
  });

  it("modifies config and rejects invalid values without changing state", () => {
    const registry = getModuleRegistry();
    registry.update("vapi", { voice: "nova", latency: { firstResponseMs: 900 } });
    const vapi = registry.get("vapi").getConfig();
    expect(vapi.voice).toBe("nova");
    expect(vapi.latency).toEqual({ firstResponseMs: 900, endpointingMs: 400 });
    expect(() => registry.update("vapi", { latency: { endpointingMs: -5 } })).toThrow();
    expect(() => registry.update("vapi", { voice: " " })).toThrow();
    expect(registry.get("vapi").getConfig()).toEqual(vapi);
  });

  it("a disabled module takes no calls; inbound falls back and is logged", async () => {
    const registry = getModuleRegistry();
    registry.setEnabled("azure-gpt-live", false);
    const harness = new CallHarness(clock);
    const result = await harness.runInbound("lead-1", "+1", { idempotencyKey: "mod-off" });
    expect(result.status).toBe("normal_answering");
    expect(getCallLogs().some((l) => l.reason.startsWith("no_voice_module_enabled"))).toBe(true);
    const out = await harness.runOutbound("lead-1", "+1", {
      idempotencyKey: "mod-off-out",
      scheduledReason: "text_agreed_callback",
    });
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("no_voice_module_enabled");
  });

  it("call result records the settings in force at start", async () => {
    const registry = getModuleRegistry();
    registry.update("retell", { enabled: true, voice: "custom-voice" });
    registry.select("retell");
    const result = await new CallHarness(clock).runInbound("lead-1", "+1", {
      idempotencyKey: "snap",
      callerUtterances: ["Hi"],
    });
    expect(result.moduleSnapshot?.voice).toBe("custom-voice");
    expect(result.moduleSnapshot?.moduleId).toBe("retell");
  });
});

describe("per-agency AI-calling flag", () => {
  it("is on for one agency only and off takes effect on the next call", async () => {
    seedLead(baseLead({ id: "lead-other", agencyId: "agency-other" }));
    const harness = new CallHarness(clock);
    const other = await harness.runInbound("lead-other", "+1", { idempotencyKey: "ag-other" });
    expect(other.status).toBe("normal_answering");

    const mine = await harness.runInbound("lead-1", "+1", {
      idempotencyKey: "ag-mine-1",
      callerUtterances: ["Hi Jane Doe auto quote"],
    });
    expect(mine.status).toBe("ai_handled");

    setAiCallingEnabled("agency-demo", false);
    const after = await harness.runInbound("lead-1", "+1", { idempotencyKey: "ag-mine-2" });
    expect(after.status).toBe("normal_answering");
    expect(
      getCallLogs().filter((l) => l.reason === "ai_calling_disabled_normal_answering").length,
    ).toBe(2);

    setAiCallingEnabled("agency-other", true);
    const flipped = await harness.runInbound("lead-other", "+1", {
      idempotencyKey: "ag-other-2",
      callerUtterances: ["Hi"],
    });
    expect(flipped.status).toBe("ai_handled");
  });
});
