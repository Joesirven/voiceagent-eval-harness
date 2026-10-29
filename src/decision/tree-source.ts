/**
 * Where the active tree comes from. The default is the full assembled tree
 * (`src/decision-tree/full-tree.json`, written by
 * `scripts/assemble-decision-tree.ts` from the six fragments). Set the
 * environment variable `VOICE_HARNESS_DECISION_TREE` to a file path to use another
 * one: `STUB_TREE_FILE` (no `area`, no `starts`) or `IMPROVED_TREE_FILE`
 * (`src/decision-tree/tree.json`, the small fixture tree).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDecisionTree } from "../decision-tree/index.js";
import { loadTree, type DecisionTree } from "./tree.js";

export const STUB_TREE_FILE = fileURLToPath(new URL("./stub-tree.json", import.meta.url));
/** The small fixture tree (id fixture): opt-in, because it drops discovery, quote fields, messages and objections. */
export const IMPROVED_TREE_FILE = fileURLToPath(new URL("../decision-tree/tree.json", import.meta.url));
export const FULL_TREE_FILE = fileURLToPath(new URL("../decision-tree/full-tree.json", import.meta.url));
export const ACTIVE_TREE_FILE = FULL_TREE_FILE;

/** The improved shape has per-direction `starts`; the stub has a single `start` only. */
function isImprovedShape(raw: unknown): boolean {
  const r = raw as Record<string, unknown> | null;
  return typeof r === "object" && r !== null && typeof r.starts === "object" && r.starts !== null;
}

/**
 * Checks the improved tree with its own validator, then hands `loadTree` a
 * shape that keeps both entries, the interrupts and the repeat rule. The stub
 * needs no change.
 */
function adaptRawTree(raw: unknown): unknown {
  if (!isImprovedShape(raw)) return raw;
  const tree = validateDecisionTree(raw);
  return {
    id: tree.id,
    version: tree.version,
    start: tree.start,
    starts: tree.starts,
    dispositions: tree.dispositions.map(({ name, label, durable, meaning }) => ({ name, label, durable, meaning })),
    maxClarifications: tree.maxClarifications,
    escalation: tree.escalation,
    interrupts: tree.interrupts,
    repeatRule: tree.repeatRule,
    nodes: tree.nodes,
  };
}

export interface DecisionTreeChoice {
  id: string;
  label: string;
  /** One line on what the tree contains, shown beside the picker. */
  hint: string;
  file: string;
}

const KNOWN_TREES: DecisionTreeChoice[] = [
  { id: "full", label: "Full tree", hint: "The assembled full tree: discovery, quote fields, messages, objections and every ending.", file: FULL_TREE_FILE },
  { id: "stub", label: "Stub tree", hint: "A short tree with a single start and no discovery or objections.", file: STUB_TREE_FILE },
  { id: "fixture", label: "Fixture tree", hint: "The smallest tree: it drops discovery, quote fields, messages and objections.", file: IMPROVED_TREE_FILE },
];

export interface DecisionTreeListing {
  id: string;
  label: string;
  hint: string;
  nodeCount: number;
}

const CUSTOM_ID = "custom";
const cache = new Map<string, DecisionTree>();
/** The runtime choice; undefined means the boot choice (the environment variable, else the full tree). */
let selectedFile: string | undefined;

function activeFile(): string {
  return selectedFile ?? process.env.VOICE_HARNESS_DECISION_TREE ?? ACTIVE_TREE_FILE;
}

function loadFile(file: string): DecisionTree {
  let tree = cache.get(file);
  if (!tree) {
    tree = loadTree(adaptRawTree(JSON.parse(readFileSync(file, "utf8"))));
    cache.set(file, tree);
  }
  return tree;
}

/** The tree the next call will use. A call already running keeps the tree it started with. */
export function loadActiveTree(): DecisionTree {
  return loadFile(activeFile());
}

/** The id of the selected tree: a known id, or "custom" for an environment path that matches none. */
export function selectedDecisionTreeId(): string {
  return KNOWN_TREES.find((t) => t.file === activeFile())?.id ?? CUSTOM_ID;
}

export function listDecisionTrees(): DecisionTreeListing[] {
  const listing = KNOWN_TREES.map(({ id, label, hint, file }) => ({ id, label, hint, nodeCount: Object.keys(loadFile(file).nodes).length }));
  if (selectedDecisionTreeId() === CUSTOM_ID) {
    listing.push({ id: CUSTOM_ID, label: "Custom tree", hint: "A tree file named by VOICE_HARNESS_DECISION_TREE at boot.", nodeCount: Object.keys(loadActiveTree().nodes).length });
  }
  return listing;
}

/** The only tree a live call may use. Others exist for tests and tools. */
export const LIVE_DECISION_TREE_ID = "full";

/** The live choice: the full tree, plus the custom tree when the boot variable named one. */
export function listLiveDecisionTrees(): DecisionTreeListing[] {
  return listDecisionTrees().filter((t) => t.id === LIVE_DECISION_TREE_ID || t.id === CUSTOM_ID);
}

/** Chooses the tree for the next call; only the full tree is live, anything else throws `unknown_decision_tree`. */
export function selectDecisionTree(id: string): void {
  if (id !== LIVE_DECISION_TREE_ID && !(id === CUSTOM_ID && selectedDecisionTreeId() === CUSTOM_ID)) throw new Error("unknown_decision_tree");
  selectDecisionTreeForTest(id);
}

/** Test and tool path: selects any known tree (full, stub, fixture). Not reachable from the server. */
export function selectDecisionTreeForTest(id: string): void {
  if (id === CUSTOM_ID && selectedDecisionTreeId() === CUSTOM_ID) return;
  const choice = KNOWN_TREES.find((t) => t.id === id);
  if (!choice) throw new Error("unknown_decision_tree");
  selectedFile = choice.file;
}

export function resetActiveTree(): void {
  cache.clear();
  selectedFile = undefined;
}
