/** The real tree, bundled at build time by the /tree-designs page. Rebuild it (`pnpm build:designs`) after the tree changes. */
import fullTree from "../../src/decision-tree/full-tree.json";
import type { LabTree } from "./stories/walk.js";

export const TREE = fullTree as unknown as LabTree;
