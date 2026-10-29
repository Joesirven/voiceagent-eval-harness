import { afterEach, describe, expect, it } from "vitest";
import { toTreeView } from "../../src/decision/tree.js";
import {
  FULL_TREE_FILE,
  IMPROVED_TREE_FILE,
  loadActiveTree,
  resetActiveTree,
} from "../../src/decision/tree-source.js";

afterEach(() => {
  delete process.env.VOICE_HARNESS_DECISION_TREE;
  resetActiveTree();
});

describe("the alternate tree file after the public scrub", () => {
  it("loads the same short Northwind renewal tree as the full tree file", () => {
    process.env.VOICE_HARNESS_DECISION_TREE = IMPROVED_TREE_FILE;
    resetActiveTree();
    const alternate = loadActiveTree();
    expect(alternate.id).toBe("northwind-renewal");
    expect(alternate.start).toBe("entry.greeting");
    expect(Object.keys(alternate.nodes)).toHaveLength(9);

    process.env.VOICE_HARNESS_DECISION_TREE = FULL_TREE_FILE;
    resetActiveTree();
    const full = loadActiveTree();
    expect(Object.keys(alternate.nodes)).toEqual(Object.keys(full.nodes));
    expect(alternate.dispositions).toEqual(full.dispositions);
  });

  it("keeps inbound, outbound and known-lead entries", () => {
    process.env.VOICE_HARNESS_DECISION_TREE = IMPROVED_TREE_FILE;
    resetActiveTree();
    expect(loadActiveTree().starts).toEqual({
      inbound: "entry.greeting",
      outbound: "entry.outbound",
      knownLead: "identity.confirm",
    });
  });

  it("builds a tree view with the Northwind endings", () => {
    process.env.VOICE_HARNESS_DECISION_TREE = IMPROVED_TREE_FILE;
    resetActiveTree();
    const view = toTreeView(loadActiveTree());
    expect(view.start).toBe("entry.greeting");
    expect(view.nodes.filter((node) => node.disposition).map((node) => node.disposition).sort()).toEqual([
      "booked",
      "completed",
      "do_not_contact",
      "not_interested",
    ]);
  });
});
