import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { DecisionModuleRegistry, getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { startInteractiveCall, type InteractiveCall } from "../../src/decision/interactive.js";
import { resetActiveTree } from "../../src/decision/tree-source.js";
import type { DecisionModel } from "../../src/decision-models/types.js";
import { getActionJudge, resetJudges } from "../../src/judge/index.js";
import { applyDecisionModuleChoice, DECISION_MODULE_ENV } from "../../src/server/live-judge-wiring.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";
import { ScriptedModel } from "../helpers/scripted-model.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const STAND_IN_ID = "scripted-stand-in";

const catalogOf = (model: DecisionModel, fellBackToMock = false) => ({
  get: (id: string) => (id === "scripted" ? { model, fellBackToMock, ...(fellBackToMock ? { reason: "no_credential" as const } : {}) } : undefined),
});

let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "decision-module-switch-test-")));
  traceBus.reset();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  delete process.env.VOICE_HARNESS_DECISION_MODULE;
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

const open: InteractiveCall[] = [];
afterEach(async () => {
  for (const call of open.splice(0)) if (call.status === "connected") await call.hangUp();
  fetchSpy.mockRestore();
  resetDecisionRegistry();
});

const play = async (lines: string[]) => {
  const harness = new CallHarness({ now: () => new Date(IN_WINDOW) }, undefined, getModuleRegistry());
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness });
  open.push(call);
  for (const line of lines) await call.say(line);
  return { call, events: traceBus.history().filter((e) => e.callId === call.callId) };
};
const ofType = (events: TraceEvent[], type: TraceEvent["type"]) => events.filter((e) => e.type === type);
const dispositionOf = (events: TraceEvent[]) => ofType(events, "disposition").at(-1)?.data;

describe("VOICE_HARNESS_DECISION_MODULE: the explicit opt-in to another decision module", () => {
  it("does nothing when unset or empty: the keyword module stays, no catalog is built, no model is asked", () => {
    const catalog = { get: vi.fn() };
    for (const env of [{}, { [DECISION_MODULE_ENV]: "" }, { [DECISION_MODULE_ENV]: "   " }]) {
      const registry = new DecisionModuleRegistry();
      const choice = applyDecisionModuleChoice({ env, catalog, registry });
      expect(choice).toEqual({ requested: null, selected: "jev-mock", outcome: "default" });
      expect(registry.selectedModuleId()).toBe("jev-mock");
    }
    expect(catalog.get).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("selects a module the registry already has without registering it again", () => {
    const registry = new DecisionModuleRegistry();
    const ids = registry.list().map((m) => m.id);
    const other = ids.find((id) => id !== "jev-mock")!;
    const catalog = { get: vi.fn() };
    expect(applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: other }, catalog, registry })).toMatchObject({ outcome: "selected_registered", selected: other });
    expect(registry.selectedModuleId()).toBe(other);
    expect(registry.list().map((m) => m.id)).toEqual(ids);
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("registers a catalog model as a decision module and selects it", () => {
    const registry = new DecisionModuleRegistry();
    const model = new ScriptedModel({});
    const choice = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "scripted" }, catalog: catalogOf(model), registry });
    expect(choice).toEqual({ requested: "scripted", selected: STAND_IN_ID, outcome: "registered_from_catalog" });
    expect(registry.selectedModuleId()).toBe(STAND_IN_ID);
    expect(registry.list().filter((m) => m.id === STAND_IN_ID)).toHaveLength(1);
    // Asking again does not register twice.
    applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "scripted" }, catalog: catalogOf(model), registry });
    expect(registry.list().filter((m) => m.id === STAND_IN_ID)).toHaveLength(1);
  });

  it("refuses an unknown id and keeps the keyword module", () => {
    const registry = new DecisionModuleRegistry();
    const choice = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "no-such-module" }, catalog: catalogOf(new ScriptedModel({})), registry });
    expect(choice).toEqual({ requested: "no-such-module", selected: "jev-mock", outcome: "refused", reason: "unknown_decision_module" });
    expect(registry.selectedModuleId()).toBe("jev-mock");
  });

  it("refuses a real model whose credential is missing: a mock is never run under a real model's name", () => {
    const registry = new DecisionModuleRegistry();
    const choice = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "scripted" }, catalog: catalogOf(new ScriptedModel({}), true), registry });
    expect(choice).toMatchObject({ outcome: "refused", reason: "no_credential", selected: "jev-mock" });
    expect(registry.list().some((m) => m.id === STAND_IN_ID)).toBe(false);
  });

  it("with no catalog at all (credential file unreadable) refuses instead of failing", () => {
    const registry = new DecisionModuleRegistry();
    expect(applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "scripted" }, catalog: null, registry })).toMatchObject({ outcome: "refused", reason: "unknown_decision_module" });
  });
});

describe("a scripted Northwind call through the real rule judge", () => {
  const useStandIn = (script: Record<string, string[]>) => {
    const model = new ScriptedModel(script);
    const choice = applyDecisionModuleChoice({ env: { [DECISION_MODULE_ENV]: "scripted" }, catalog: catalogOf(model), registry: getDecisionRegistry() });
    expect(choice.outcome).toBe("registered_from_catalog");
    expect(getActionJudge().id).toBe("rule-based-local");
    return model;
  };

  it("uses the selected module for every decision and books a producer call", async () => {
    const model = useStandIn({
      "entry.greeting": ["consents"],
      "identity.confirm": ["right_person"],
      "discovery.employees": ["gave_count"],
      "discovery.payroll": ["gave_payroll"],
      "booking.offer": ["accepts"],
      "booking.time": ["gave_time"],
      "booking.confirm": ["confirms"],
    });
    const { events } = await play(["Yes", "Yes, I handle it", "Six employees", "Four hundred thousand", "Yes", "Tuesday at 10 am", "Yes"]);
    expect(model.asked).toContain("booking.confirm");
    const decisions = ofType(events, "decision").filter((event) => event.data.nodeId !== "interrupts");
    expect(decisions.map((event) => event.data.module)).toEqual(decisions.map(() => STAND_IN_ID));
    expect(decisions.map((event) => event.data.router)).toEqual(decisions.map(() => "decision_model"));
    expect(ofType(events, "judge_verdict").find((event) => event.data.action === "book")?.data.allowed).toBe(true);
    expect(getLead("lead-1")!.bookings).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows not_interested when the caller's words support it", async () => {
    useStandIn({ "entry.greeting": ["consents"], "identity.confirm": ["not_interested"] });
    const { call, events } = await play(["Yes", "I handle it, but I am not interested"]);
    expect(dispositionOf(events)).toMatchObject({ value: "not_interested" });
    expect(call.status).toBe("ended");
  });

  it("refuses not_interested when the caller's words do not support it", async () => {
    useStandIn({ "entry.greeting": ["consents"], "identity.confirm": ["not_interested"] });
    const { call, events } = await play(["Yes", "I handle the renewal"]);
    expect(dispositionOf(events)).toBeUndefined();
    expect(call.status).toBe("connected");
  });
});
