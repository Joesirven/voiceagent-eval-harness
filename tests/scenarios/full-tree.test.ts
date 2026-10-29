import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeDialog } from "../../src/decision/engine.js";
import { DecisionModuleRegistry } from "../../src/decision/registry.js";
import { toTreeView } from "../../src/decision/tree.js";
import { asDecisionModule } from "../../src/decision-models/bridge.js";
import { FULL_TREE_FILE, loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import { ScriptedModel } from "../helpers/scripted-model.js";

afterEach(() => {
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
});

function dialog(script: Record<string, string[]>) {
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
  const instance = new TreeDialog({
    tree: loadActiveTree(),
    decisions,
    gate: { judge: { id: "allow", judge: async () => ({ allowed: true, reason: "test", scores: [] }) }, leadId: "lead-1", callId: "call-1" },
    actions,
    recorder: { record: () => undefined },
    direction: "inbound",
    firstName: "Maria",
    timeZone: "America/Los_Angeles",
    clock: { now: () => new Date("2026-10-15T14:00:00.000Z") },
  });
  return { instance, actions };
}

describe("the shipped Northwind renewal tree", () => {
  it("is the default tree and has a view with every ending", () => {
    const tree = loadActiveTree();
    expect(tree.id).toBe("northwind-renewal");
    expect(tree.start).toBe("entry.greeting");
    expect(Object.keys(tree.nodes)).toHaveLength(9);
    const view = toTreeView(tree);
    expect(view.start).toBe("entry.greeting");
    expect(new Set(view.nodes.filter((node) => node.disposition).map((node) => node.disposition))).toEqual(
      new Set(["booked", "completed", "not_interested", "do_not_contact"]),
    );
  });

  it("matches the source file and keeps every node reachable", () => {
    const raw = JSON.parse(readFileSync(FULL_TREE_FILE, "utf8"));
    expect(raw.id).toBe("northwind-renewal");
    const reached = new Set<string>();
    const visit = (id: string) => {
      if (reached.has(id)) return;
      reached.add(id);
      const node = raw.nodes.find((item: any) => item.id === id);
      for (const answer of node?.decision?.answers ?? []) if (answer.next) visit(answer.next);
    };
    visit(raw.start);
    visit(raw.starts.outbound);
    for (const answer of raw.interrupts.answers) if (answer.next) visit(answer.next);
    expect(reached).toEqual(new Set(raw.nodes.map((node: any) => node.id)));
  });

  it("books after consent, renewal confirmation, quote facts and a confirmed time", async () => {
    const { instance, actions } = dialog({
      "entry.greeting": ["consents"],
      "identity.confirm": ["right_person"],
      "discovery.employees": ["gave_count"],
      "discovery.payroll": ["gave_payroll"],
      "booking.offer": ["accepts"],
      "booking.time": ["gave_time"],
      "booking.confirm": ["confirms"],
    });
    expect(await instance.open()).toContain("AI assistant");
    for (const line of ["Yes", "Yes", "Six employees", "Four hundred thousand", "Yes", "Tuesday at 10 am", "Yes"]) await instance.step(line);
    expect(actions.saveQuoteField).toHaveBeenCalledTimes(2);
    expect(actions.book).toHaveBeenCalledTimes(1);
    expect(actions.endWithDisposition).toHaveBeenCalledWith("booked", false);
  });

  it("records a durable not-interested ending only after the caller says it", async () => {
    const { instance, actions } = dialog({ "entry.greeting": ["consents"], "identity.confirm": ["not_interested"] });
    await instance.open();
    await instance.step("Yes, continue.");
    const result = await instance.step("I am not interested.");
    expect(result.ended).toBe(true);
    expect(actions.endWithDisposition).toHaveBeenCalledWith("not_interested", true);
  });

  it("answers an automation interrupt and resumes the current question", async () => {
    const { instance } = dialog({ interrupts: ["asks_if_automated"], "entry.greeting": ["consents"] });
    await instance.open();
    const result = await instance.step("Are you automated?");
    expect(result.reply).toContain("automated assistant for Northwind Insurance Agency");
    expect(result.reply).toContain("business insurance renewal for Riverside Plumbing");
    expect(result.ended).toBe(false);
  });
});
