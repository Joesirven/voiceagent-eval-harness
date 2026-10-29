/**
 * Loads the decision tree and projects it into the two shapes other parts of
 * the harness read: the tree engine's own type, and the live view's
 * `TreeJson`. Swapping the engine to this tree is one line in the engine's
 * `tree-source.ts`: `adaptRawTree = (raw) => toEngineTree(validateDecisionTree(raw), "inbound")`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DecisionTree, TreeAnswer, TreeNode } from "./types.js";
import { validateDecisionTree } from "./validate.js";

export const TREE_FILE = fileURLToPath(new URL("./tree.json", import.meta.url));

let cached: DecisionTree | undefined;

/** The validated tree from `tree.json` (or another file). Throws `DecisionTreeError` on a broken tree. */
export function loadDecisionTree(file: string = TREE_FILE): DecisionTree {
  if (file !== TREE_FILE) return validateDecisionTree(JSON.parse(readFileSync(file, "utf8")));
  cached ??= validateDecisionTree(JSON.parse(readFileSync(file, "utf8")));
  return cached;
}

export function resetDecisionTreeCache(): void {
  cached = undefined;
}

/**
 * The tree engine's tree type, mirrored here because the engine branch has not
 * merged yet. Structurally the same as `DecisionTree` in `src/decision/tree.ts`
 * there; extra fields on nodes and answers are kept, and the engine ignores them.
 */
export interface EngineTree {
  id: string;
  version: string;
  start: string;
  dispositions: Array<{ name: string; label: string; durable: boolean; meaning?: string }>;
  maxClarifications: number;
  escalation: { say: string; disposition: string };
  nodes: Record<string, TreeNode>;
  /** Not read by the engine yet: asked before each node's question. */
  interrupts: DecisionTree["interrupts"];
  /** Not read by the engine yet: ends the call the second time an objection class comes up. */
  repeatRule: DecisionTree["repeatRule"];
}

/** The engine's tree for one direction of call: the start is the inbound or outbound entry. */
export function toEngineTree(tree: DecisionTree, direction: "inbound" | "outbound" = "inbound"): EngineTree {
  return {
    id: tree.id,
    version: tree.version,
    start: tree.starts[direction],
    dispositions: tree.dispositions.map(({ name, label, durable, meaning }) => ({ name, label, durable, meaning })),
    maxClarifications: tree.maxClarifications,
    escalation: tree.escalation,
    nodes: Object.fromEntries(tree.nodes.map((n) => [n.id, n])),
    interrupts: tree.interrupts,
    repeatRule: tree.repeatRule,
  };
}

/**
 * The live view's tree shape (`TreeJson` in the views' live-view-core), kept
 * here so this module carries no import from the harness and moves as one
 * directory. The test checks it against the views' `layoutTree`.
 */
export interface TreeJson {
  start: string;
  dispositions: string[];
  nodes: Array<{ id: string; label: string; question?: string; minConfidence?: number; disposition?: string; edges: Array<{ answer: string; to: string | null }> }>;
}

/** The live view's node, with the extra fields the projection carries. */
export type LiveTreeNode = TreeJson["nodes"][number] & {
  area?: string;
  /** True on the node that stands for the interrupt check asked before every node. */
  interrupt?: boolean;
  edges: Array<TreeJson["nodes"][number]["edges"][number] & { minConfidence?: number; judgeGated?: boolean }>;
};
export type LiveTreeJson = Omit<TreeJson, "nodes"> & { nodes: LiveTreeNode[] };

export const INTERRUPTS_NODE_ID = "interrupts";
const endNodeId = (disposition: string) => `end_${disposition}`;

function edgesOf(answers: readonly TreeAnswer[], used: Set<string>): LiveTreeNode["edges"] {
  return answers.map((a) => {
    if (a.disposition) used.add(a.disposition);
    return {
      answer: a.answer,
      to: a.answer === "unclear" || a.answer === "none" ? null : a.disposition ? endNodeId(a.disposition) : (a.next ?? null),
      ...(a.answer === "unclear" || a.answer === "none" ? {} : { minConfidence: a.minConfidence }),
      ...(a.action || a.disposition ? { judgeGated: true } : {}),
    };
  });
}

/**
 * The live view's `TreeJson`: one node per tree node, one end node per
 * disposition used, and one node for the interrupt check. Same conventions as
 * the engine's `toTreeView`, so either can feed `/api/tree`.
 */
export function toLiveTreeJson(tree: DecisionTree): LiveTreeJson {
  const used = new Set<string>([tree.escalation.disposition, tree.repeatRule.disposition]);
  const nodes: LiveTreeNode[] = tree.nodes.map((n) => {
    const answers = n.decision?.answers ?? [];
    const real = answers.filter((a) => a.answer !== "unclear");
    return {
      id: n.id,
      label: n.label,
      area: n.area,
      ...(n.decision ? { question: n.decision.question } : {}),
      ...(real.length ? { minConfidence: Math.min(...real.map((a) => a.minConfidence)) } : {}),
      edges: [...(n.next ? [{ answer: "next", to: n.next }] : []), ...edgesOf(answers, used)],
    };
  });
  nodes.push({
    id: INTERRUPTS_NODE_ID,
    label: "Before every node: interrupts",
    area: "safety",
    interrupt: true,
    question: tree.interrupts.question,
    edges: edgesOf(tree.interrupts.answers, used),
  });
  for (const d of tree.dispositions) {
    if (used.has(d.name)) nodes.push({ id: endNodeId(d.name), label: `End: ${d.label}`, disposition: d.name, edges: [] });
  }
  return { start: tree.start, dispositions: tree.dispositions.map((d) => d.name), nodes };
}

/**
 * A node's question as a typed choice question: the shape the shared Azure AI
 * Foundry client's `decide()` takes (`{ type: "choice", instructions, criteria }`).
 * Defined here rather than imported so the module stays free of the client.
 */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** A judge's question as a typed true or false question (`decide()`'s "noul" shape). */
export interface TrueFalseQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export const UNCLEAR_CRITERION = "None of the other answers clearly fits, or the caller's words are not clear enough to tell.";
const NO_INTERRUPT_CRITERION = "The caller is not doing any of the other things: carry on with the current step.";

/** The question a decision module answers at this node, or at the interrupt check when given `tree.interrupts`. */
export function toChoiceQuestion(source: TreeNode | DecisionTree["interrupts"]): ChoiceQuestion {
  const decision = "answers" in source ? source : source.decision;
  if (!decision) throw new Error(`node ${(source as TreeNode).id} asks no question`);
  const criteria: Record<string, string> = {};
  for (const a of decision.answers) {
    criteria[a.answer] = a.answer === "unclear" ? UNCLEAR_CRITERION : a.answer === "none" ? NO_INTERRUPT_CRITERION : (a.meaning ?? a.answer);
  }
  return { type: "choice", instructions: decision.question, criteria };
}

/** The live judge's fast question before a gated answer runs. True allows. */
export function toJudgeQuestion(answer: TreeAnswer): TrueFalseQuestion {
  if (!answer.judge) throw new Error(`answer ${answer.answer} is not judge-gated`);
  return {
    type: "noul",
    instructions: answer.judge.question,
    criteria: { true: "Yes: the caller's own words support doing this now.", false: "No, or not clearly: do not do it." },
  };
}
