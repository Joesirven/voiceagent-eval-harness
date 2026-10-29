import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldTree, words } from "../../web/src/lib/tree.js";

const full = JSON.parse(readFileSync(new URL("../../src/decision-tree/full-tree.json", import.meta.url), "utf8"));
const tree = { start: full.start, dispositions: full.dispositions, nodes: full.nodes.map((n: any) => ({ id: n.id, label: n.label, question: n.question, disposition: n.disposition, edges: (n.edges ?? []).map((e: any) => ({ answer: e.answer, to: e.to ?? null })) })) };

describe("folding follow-up nodes into their parent", () => {
  it("leaves a tree without follow-up nodes unchanged", () => {
    const folded = foldTree(tree);
    const more = tree.nodes.filter((n: any) => /_more\d*$/.test(n.id));
    expect(more).toEqual([]);
    expect(folded.tree.nodes).toHaveLength(tree.nodes.length);
    expect(folded.tree.nodes.some((n) => /_more\d*$/.test(n.id))).toBe(false);
    expect(folded.resolve("entry.greeting")).toBe("entry.greeting");
    expect(folded.resolve(null)).toBeNull();
  });

  it("leaves no edge pointing at a folded node or back at its own node", () => {
    const folded = foldTree(tree);
    const ids = new Set(folded.tree.nodes.map((n) => n.id));
    for (const n of folded.tree.nodes) for (const e of n.edges) {
      if (e.to) expect(ids.has(e.to), `${n.id} -> ${e.to}`).toBe(true);
      expect(e.to === n.id).toBe(false);
    }
  });

  it("turns answers into words", () => {
    expect(words("asks_for_a_person")).toBe("asks for a person");
  });
});
