import type { TreeEdge, TreeJson, TreeNode } from "../../../src/server/live-view-core.js";

/** "asks_for_a_person" -> "asks for a person": answers are shown as words, never as ids. */
export const words = (id: string) => id.replace(/_/g, " ");

const MORE = /_more\d*$/;

export interface FoldedTree {
  tree: TreeJson;
  /** Maps any node id (including a folded follow-up) to the node that stands for it. */
  resolve: (id: string | null | undefined) => string | null;
}

/**
 * Folds each "_more" follow-up node into its parent: the follow-up is the same question asked again, so it
 * is not shown as a step of its own. Edges into a follow-up point at the parent, and the follow-up's own
 * exits are added to the parent (unless the parent already has that answer).
 */
export function foldTree(tree: TreeJson): FoldedTree {
  const ids = new Set(tree.nodes.map((n) => n.id));
  const parentOf = (id: string): string => {
    let cur = id;
    while (MORE.test(cur) && ids.has(cur.replace(MORE, ""))) cur = cur.replace(MORE, "");
    return cur;
  };
  const resolve = (id: string | null | undefined) => (id ? parentOf(id) : null);
  const byId = new Map<string, TreeNode>();
  for (const n of tree.nodes) if (parentOf(n.id) === n.id) byId.set(n.id, { ...n, edges: [...n.edges] });
  for (const n of tree.nodes) {
    const parent = parentOf(n.id);
    if (parent === n.id) continue;
    const into = byId.get(parent)!;
    for (const e of n.edges) if (!into.edges.some((x) => x.answer === e.answer)) into.edges.push(e);
  }
  const nodes = [...byId.values()].map((n) => ({
    ...n,
    edges: n.edges
      .map((e): TreeEdge => ({ ...e, to: e.to ? parentOf(e.to) : e.to }))
      .filter((e) => e.to !== n.id || !e.to),
  }));
  return { tree: { ...tree, nodes }, resolve };
}
