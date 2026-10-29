/**
 * Regression checks that apply to the short Northwind renewal tree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDecisionTree } from "../../src/decision-tree/index.js";
import { FULL_TREE_FILE } from "../../src/decision/tree-source.js";

const raw = JSON.parse(readFileSync(FULL_TREE_FILE, "utf8")) as any;
const tree = validateDecisionTree(raw);

describe("Northwind renewal tree safety regressions", () => {
  it("passes the decision tree validator", () => {
    expect(tree.id).toBe("northwind-renewal");
    expect(tree.start).toBe("entry.greeting");
    expect(tree.nodes).toHaveLength(9);
  });

  it("keeps goodbye claims on endings, not entry lines", () => {
    for (const node of tree.nodes) {
      for (const line of node.agentLines ?? []) expect(line.line, node.id).not.toMatch(/goodbye/i);
      for (const answer of node.decision?.answers ?? []) {
        if (answer.disposition) expect(answer.say, `${node.id}:${answer.answer}`).toMatch(/goodbye/i);
      }
    }
  });

  it("gates every ending and gives it a closing line", () => {
    for (const node of tree.nodes) {
      for (const answer of node.decision?.answers ?? []) {
        if (!answer.disposition) continue;
        expect(answer.say, `${node.id}:${answer.answer}`).toBeTruthy();
        expect(answer.judge, `${node.id}:${answer.answer}`).toBeDefined();
        expect(answer.onBlocked?.say, `${node.id}:${answer.answer}`).toBeTruthy();
      }
    }
  });

  it("uses a confidence bar of at least 0.85 for durable endings", () => {
    const durable = new Set(tree.dispositions.filter((disposition) => disposition.durable).map((disposition) => disposition.name));
    for (const node of tree.nodes) {
      for (const answer of node.decision?.answers ?? []) {
        if (answer.disposition && durable.has(answer.disposition)) {
          expect(answer.minConfidence, `${node.id}:${answer.answer}`).toBeGreaterThanOrEqual(0.85);
          expect(answer.judge?.minConfidence, `${node.id}:${answer.answer}`).toBeGreaterThanOrEqual(0.85);
        }
      }
    }
  });

  it("never claims that recording stopped or paused", () => {
    const lines = [
      ...tree.nodes.flatMap((node) => [
        ...(node.agentLines ?? []).map((line) => line.line),
        node.clarify ?? "",
        ...(node.decision?.answers ?? []).flatMap((answer) => [answer.say ?? "", answer.onBlocked?.say ?? ""]),
      ]),
      tree.escalation.say,
      tree.repeatRule.say,
    ];
    expect(lines.join("\n")).not.toMatch(/recording (stopped|paused)|stopped (the )?recording|paused (the )?recording/i);
  });

  it("clarifies before the tree-level escalation", () => {
    expect(tree.maxClarifications).toBe(2);
    for (const node of tree.nodes.filter((item) => item.decision)) {
      expect(node.decision!.answers.some((answer) => answer.answer === "unclear"), node.id).toBe(true);
      expect(node.clarify, node.id).toBeTruthy();
    }
    expect(tree.escalation.disposition).toBe("completed");
  });
});
