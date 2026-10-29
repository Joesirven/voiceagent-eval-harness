import { describe, expect, it } from "vitest";
import { startInteractiveCall } from "../../src/decision/interactive.js";
import { toTreeView } from "../../src/decision/tree.js";
import { loadActiveTree } from "../../src/decision/tree-source.js";
import type { StartInteractiveCall } from "../../src/server/fake-interactive.js";
import type { TreeJson } from "../../src/server/live-view-core.js";

// These assignments only compile while the decision module's real start and tree
// keep the shapes the views expect, so swapping them in stays a one-line change.
describe("the decision module fits the views", () => {
  it("has a start function and a tree in the shapes the views read", () => {
    const start: StartInteractiveCall = startInteractiveCall;
    const tree: TreeJson = toTreeView(loadActiveTree());
    expect(typeof start).toBe("function");
    expect(tree.nodes.length).toBeGreaterThan(0);
  });
});
