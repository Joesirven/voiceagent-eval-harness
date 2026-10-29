/**
 * Lists every problem in a decision tree file. Exit 0 when the tree is sound.
 * Usage: tsx scripts/validate-decision-tree.ts [path/to/tree.json]
 */

import { readFileSync } from "node:fs";
import { TREE_FILE, toLiveTreeJson, treeProblems, validateDecisionTree } from "../src/decision-tree/index.js";

const file = process.argv[2] ?? TREE_FILE;
const raw = JSON.parse(readFileSync(file, "utf8"));
const problems = treeProblems(raw);
if (problems.length) {
  console.log(`${problems.length} problems in ${file}:`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
const tree = validateDecisionTree(raw);
const answers = tree.nodes.reduce((n, x) => n + (x.decision?.answers.length ?? 0), 0);
console.log(`ok: ${tree.nodes.length} nodes, ${answers} answers, ${tree.dispositions.length} dispositions, ${toLiveTreeJson(tree).nodes.length} view nodes`);
