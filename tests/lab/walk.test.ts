/**
 * The lab story helpers must walk the shipped Northwind renewal tree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FULL_TREE_FILE } from "../../src/decision/tree-source.js";
import { EXAMPLE_CALLS } from "../../lab/src/stories/examples.js";
import { buildWalk, stepAtFrame, stepStartFrame, walkDurationInFrames, walkFromRecord, type LabTree } from "../../lab/src/stories/walk.js";
import { answerWords, endingWords, nodeWords } from "../../lab/src/stories/plain-words.js";
import { computeLights, lightOfChoice } from "../../lab/src/stories/lights.js";

const tree = JSON.parse(readFileSync(FULL_TREE_FILE, "utf8")) as LabTree;

describe("tree story helpers over the Northwind renewal tree", () => {
  it("walks each example from the inbound entry to its stated ending", () => {
    expect(EXAMPLE_CALLS).toHaveLength(3);
    for (const example of EXAMPLE_CALLS) {
      const walk = buildWalk(tree, example);
      expect(walk.steps[0]!.nodeId).toBe(tree.starts.inbound);
      expect(walk.steps.at(-1)!.ending?.name).toBe(example.ending);
      expect(walk.steps.every((step) => Boolean(step.headingTo?.length))).toBe(true);
    }
  });

  it("uses the tree lines and answer replacement lines", () => {
    const walk = buildWalk(tree, EXAMPLE_CALLS[0]!);
    expect(walk.steps[0]!.say).toContain("Northwind Insurance Agency");
    expect(walk.steps.find((step) => step.nodeId === "booking.confirm")!.say).toContain("Thursday at ten in the morning");
    expect(walk.steps.at(-1)!.ending?.closing).toContain("booked");
    expect(walk.areasTouched).toEqual(["entry", "open", "discovery"]);
  });

  it("computes lights for every node and ending", () => {
    const lights = computeLights(tree);
    expect(lights.size).toBe(tree.nodes.length);
    expect(lights.get("booking.confirm")!.light).toBe("good");
    expect(lightOfChoice(lights, "booked", true)).toBe("good");
  });

  it("refuses a turn or ending the tree does not have", () => {
    const base = EXAMPLE_CALLS[0]!;
    expect(() => buildWalk(tree, { ...base, turns: [{ at: "entry.greeting", caller: "x", answer: "no_such_answer", why: "" }] })).toThrow(/no answer "no_such_answer"/);
    expect(() => buildWalk(tree, { ...base, turns: base.turns.slice(0, 2) })).toThrow(/without an ending/);
    expect(() => buildWalk(tree, { ...base, ending: "completed" })).toThrow(/ends with "booked", not "completed"/);
  });

  it("maps frames to steps", () => {
    const walk = buildWalk(tree, EXAMPLE_CALLS[2]!);
    expect(stepAtFrame(walk, 0)).toBe(-1);
    expect(stepAtFrame(walk, stepStartFrame(0))).toBe(0);
    expect(stepAtFrame(walk, walkDurationInFrames(walk) - 1)).toBe(walk.steps.length - 1);
  });

  it("turns a harness record into story steps", () => {
    const walk = walkFromRecord(tree, {
      recordId: "call_test",
      direction: "inbound",
      events: [
        { type: "node_enter", data: { nodeId: "entry.greeting", label: "Greeting and consent" } },
        { type: "transcript_final", data: { role: "agent", text: "May I continue?", spoken: true } },
        { type: "transcript_final", data: { role: "caller", text: "No, thank you." } },
        { type: "decision", data: { nodeId: "entry.greeting", answer: "declines", confidence: 0.95 } },
        { type: "disposition", data: { value: "completed", nodeId: "entry.greeting" } },
      ],
    });
    expect(walk.title).toBe("Recorded call call_test");
    expect(walk.steps[0]).toMatchObject({ nodeId: "entry.greeting", caller: "No, thank you." });
    expect(walk.steps[0]!.ending?.name).toBe("completed");
  });

  it("has plain words for every identifier", () => {
    for (const node of tree.nodes) expect(nodeWords(node.id, node.label), node.id).not.toMatch(/[._]/);
    for (const disposition of tree.dispositions) expect(endingWords(disposition.name, disposition.label)).not.toMatch(/_/);
    expect(answerWords("gave_payroll")).toBe("Gave payroll");
  });
});
