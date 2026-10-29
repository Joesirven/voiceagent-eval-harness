/**
 * Compiles the full decision tree into the Pipecat Flows configuration the
 * cascaded Deepgram voice path and the Pipecat Flows visual editor read.
 *
 * Usage: tsx scripts/compile-tree-flow.ts [--tree file] [--out file] [--report]
 *
 * Input:  src/decision-tree/full-tree.json (validated first).
 * Output: src/decision-tree/full-tree.flow.yaml, never edited by hand. The
 *         script is deterministic: same tree in, same bytes out, and a test
 *         checks the committed file against a fresh compile.
 * --report prints the compile report (counts, what was carried as data, what
 * is lost) as JSON.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTreeToFlow, toFlowYaml } from "../src/decision-tree/flow-compiler.js";
import { validateDecisionTree } from "../src/decision-tree/index.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const treeFile = flag("--tree") ?? join(repo, "src/decision-tree/full-tree.json");
const outFile = flag("--out") ?? join(repo, "src/decision-tree/full-tree.flow.yaml");

const compiled = compileTreeToFlow(validateDecisionTree(JSON.parse(readFileSync(treeFile, "utf8"))));
writeFileSync(outFile, toFlowYaml(compiled));
const c = compiled.report.counts;
console.log(`wrote ${outFile}: ${c.flowNodes} flow nodes (${c.emittedTreeNodes} tree nodes, ${c.foldedNodes} folded, ${c.sayCopies} say copies, ${c.blockedCopies} blocked copies, ${c.endings} endings), ${c.branchCases} branch cases (${c.branchCasesInYaml} in the YAML, copies included)`);
if (args.includes("--report")) console.log(JSON.stringify(compiled.report, null, 2));
