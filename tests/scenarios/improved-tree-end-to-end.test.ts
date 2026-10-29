import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeDialog } from "../../src/decision/engine.js";
import { DecisionModuleRegistry } from "../../src/decision/registry.js";
import { asDecisionModule } from "../../src/decision-models/bridge.js";
import { IMPROVED_TREE_FILE, loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import { ScriptedModel } from "../helpers/scripted-model.js";

afterEach(() => {
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
});

function makeDialog(script: Record<string, string[]>) {
  process.env.VOICE_HARNESS_DECISION_TREE = IMPROVED_TREE_FILE;
  resetActiveTree();
  const decisions = new DecisionModuleRegistry();
  const model = new ScriptedModel(script);
  decisions.register(asDecisionModule(model));
  decisions.select(model.id);
  const actions = {
    transfer: vi.fn(async () => true),
    saveQuoteField: vi.fn(async () => true),
    saveDetails: vi.fn(async () => true),
    book: vi.fn(async () => true),
    sendText: vi.fn(async () => true),
    endWithDisposition: vi.fn(async () => true),
  };
  return {
    actions,
    dialog: new TreeDialog({
      tree: loadActiveTree(),
      decisions,
      gate: { judge: { id: "allow", judge: async () => ({ allowed: true, reason: "test", scores: [] }) }, leadId: "lead-1", callId: "call-1" },
      actions,
      recorder: { record: () => undefined },
      direction: "inbound",
      firstName: "Maria",
      timeZone: "UTC",
      clock: { now: () => new Date("2026-10-15T14:00:00.000Z") },
    }),
  };
}

describe("alternate Northwind tree end-to-end", () => {
  it("books a producer call", async () => {
    const { dialog, actions } = makeDialog({
      "entry.greeting": ["consents"],
      "identity.confirm": ["right_person"],
      "discovery.employees": ["gave_count"],
      "discovery.payroll": ["gave_payroll"],
      "booking.offer": ["accepts"],
      "booking.time": ["gave_time"],
      "booking.confirm": ["confirms"],
    });
    await dialog.open();
    for (const line of ["Yes", "Yes", "Six", "Four hundred thousand", "Yes", "Tuesday at 10 am", "Yes"]) await dialog.step(line);
    expect(actions.book).toHaveBeenCalledTimes(1);
    expect(actions.endWithDisposition).toHaveBeenCalledWith("booked", false);
  });

  it("ends when the caller declines consent", async () => {
    const { dialog, actions } = makeDialog({ "entry.greeting": ["declines"] });
    await dialog.open();
    const result = await dialog.step("No, thank you.");
    expect(result.ended).toBe(true);
    expect(actions.endWithDisposition).toHaveBeenCalledWith("completed", false);
  });

  it("clarifies an unclear answer before it escalates", async () => {
    const { dialog } = makeDialog({ "entry.greeting": ["unclear", "unclear"] });
    await dialog.open();
    const first = await dialog.step("Maybe.");
    expect(first.reply).toContain("May I continue");
    expect(first.ended).toBe(false);
    const second = await dialog.step("I am not sure.");
    expect(second.reply).toContain("licensed producer");
    expect(second.ended).toBe(true);
  });
});
