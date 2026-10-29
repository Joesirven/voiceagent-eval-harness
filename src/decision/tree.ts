/**
 * The decision tree: nodes that each hold a typed question with closed answers,
 * a minimum confidence per answer, an edge per answer, judge-gated actions and
 * dispositions. Loaded from JSON and checked once at load, so a bad tree fails
 * before any call rather than during one.
 *
 * The field names follow the training archive's tree fragments (`nodes[]` with
 * `id`, `agentLines[]`, `decision.question`, `decision.answers[]` with `answer`,
 * `next`, `disposition`, `minConfidence`; `dispositions[]` with `name`,
 * `durable`). Fields the archive does not have yet (`action`, `extract`,
 * `carry`, `say`, `onBlocked`) are optional additions.
 */

import type { CallFlowStep } from "../trace/extensions.js";

export interface TreeDisposition {
  name: string;
  /** Shown in plain language, for example "Do not call". */
  label: string;
  /** A durable ending takes the lead off the list; the judge wants explicit caller words. */
  durable: boolean;
  meaning?: string;
}

export type TreeActionType = "transfer" | "save_details" | "save_quote_field" | "book" | "send_text";

export interface TreeAction {
  type: TreeActionType;
  /** save_quote_field: the field name. */
  field?: string;
  /** save_details: the kind of detail ("message"). */
  kind?: string;
  /** transfer: why. */
  reason?: string;
  /** send_text: the fixed text. */
  body?: string;
  /** The variable holding the value (set by an earlier `extract`). */
  from?: string;
}

export interface TreeAnswer {
  answer: string;
  meaning?: string;
  /** The node entered when this answer is taken with enough confidence. */
  next?: string | null;
  /** The disposition the call ends with, if this answer ends it. */
  disposition?: string | null;
  minConfidence: number;
  /** Judge-gated action carried out before moving on. */
  action?: TreeAction;
  /** What the agent says, in place of the next node's own line. */
  say?: string;
  /** Run the next node's question on this same caller line, so one line is not asked twice. */
  carry?: boolean;
  /** Pull a value out of the caller's words; if nothing is found the answer routes to the clarifying line. */
  extract?: { as: string; with: "year" | "time" | "caller_line" };
  /** Said (and optional next node) when the judge refuses the action. */
  onBlocked?: { say: string; next?: string };
  /** Extra keyword cues for the mock decision modules. */
  cues?: string[];
  /** Interrupts only: say `say`, then ask the current node's question again. No next, no disposition. */
  resume?: boolean;
  /** Node answers only: go back to the node the last interrupt left, when there is one; otherwise to `next`. */
  returnToOrigin?: boolean;
  /** Node answers only: on a call that started at `starts.knownLead`, the node entered instead of `next` (a new speaker is confirmed, never asked who they are). */
  knownLeadNext?: string;
  /** Node answers only: once the known lead has said yes at `starts.knownLead`, the node entered instead of `next`. */
  confirmedLeadNext?: string;
}

/** Caller details the engine takes from the caller's words (src/decision/extract.ts). */
export type CollectedValue = "callerName" | "businessName";

export interface TreeNode {
  id: string;
  label: string;
  flowStep?: CallFlowStep;
  /**
   * What the agent says on entering. `direction` limits a line to one kind of
   * call. A line marked `confirmedLead` is said only once the known lead has
   * said yes at `starts.knownLead`, in place of the node's other lines.
   */
  agentLines?: Array<{ line: string; direction?: "inbound" | "outbound"; confirmedLead?: boolean }>;
  /** Present on a node that waits for the caller. */
  decision?: { question: string; answers: TreeAnswer[] };
  /** The clarifying line, for low confidence or "unclear". */
  clarify?: string;
  /**
   * The caller details this node's line asks for. None is asked for twice: with
   * one missing the agent says `lines[value]`, and with nothing left to ask the
   * call moves on to `then`.
   */
  collects?: { values: CollectedValue[]; lines?: Partial<Record<CollectedValue, string>>; then: string };
  /** For a node without `collects`: the caller details its line asks for, so a bare reply ("Pat Lee.") is kept. */
  asks?: CollectedValue[];
  /** Ends the call with this non-durable disposition when still unclear after the clarifying lines, instead of the tree's transfer to a person. */
  escalation?: { say: string; disposition: string };
  /** A node with no question moves straight on to `next`. */
  next?: string;
  /** A phrase in this node's line that counts as a promise in the handoff note. */
  promise?: string;
  /** Objection class. The second time the same class comes up in a call, the repeat rule ends the call. */
  repeatKey?: string;
}

/** Asked of every caller line before the current node's question, after the harness's own stop check. */
export interface TreeInterrupts {
  question: string;
  clarify: string;
  answers: TreeAnswer[];
}

export interface DecisionTree {
  id: string;
  version: string;
  start: string;
  dispositions: TreeDisposition[];
  /** Clarifying lines in a row at one node before a person is brought in. */
  maxClarifications: number;
  escalation: { say: string; disposition: string };
  /**
   * Separate entries for the two kinds of call. Absent means `start` serves
   * both. `knownLead`, when present, is where a call to or from a known lead
   * starts, in either direction: the question confirming the lead is on the line.
   */
  starts?: { inbound: string; outbound: string; knownLead?: string };
  interrupts?: TreeInterrupts;
  /** The same objection class twice ends the call politely with this line and a non-durable disposition. */
  repeatRule?: { say: string; disposition: string };
  nodes: Record<string, TreeNode>;
}

/** The node a call with a known lead starts at, when the tree has one. */
export function knownLeadStart(tree: DecisionTree): string | undefined {
  return tree.starts?.knownLead;
}

/** The node a call of this direction starts at. */
export function startFor(tree: DecisionTree, direction: "inbound" | "outbound"): string {
  return tree.starts?.[direction] ?? tree.start;
}

export class TreeValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid_decision_tree: ${problems.join("; ")}`);
  }
}

const ACTION_TYPES = new Set<string>(["transfer", "save_details", "save_quote_field", "book", "send_text"]);

/** Checks and normalizes a tree from JSON. Throws `TreeValidationError` listing every problem. */
export function loadTree(raw: unknown): DecisionTree {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, any>;
  const list: TreeNode[] = Array.isArray(r.nodes) ? r.nodes : Object.values(r.nodes ?? {});
  const nodes: Record<string, TreeNode> = {};
  for (const n of list) {
    if (!n?.id || typeof n.id !== "string") problems.push("a node has no id");
    else if (nodes[n.id]) problems.push(`duplicate node ${n.id}`);
    else nodes[n.id] = n;
  }
  const dispositions: TreeDisposition[] = Array.isArray(r.dispositions)
    ? r.dispositions.map((d: any) => ({ name: d.name, label: d.label ?? d.name, durable: d.durable === true, meaning: d.meaning }))
    : [];
  const dispositionNames = new Set(dispositions.map((d) => d.name));
  const maxClarifications = Number.isInteger(r.maxClarifications) ? r.maxClarifications : 2;
  const escalation = r.escalation ?? { say: "", disposition: "" };

  if (!nodes[r.start]) problems.push(`start node ${String(r.start)} does not exist`);
  if (maxClarifications < 1) problems.push("maxClarifications must be at least 1");
  if (!dispositionNames.has(escalation.disposition)) problems.push("escalation disposition is not in the disposition list");
  if (!escalation.say) problems.push("escalation needs a line to say");

  const starts = r.starts as DecisionTree["starts"];
  if (starts) {
    if (!nodes[starts.inbound]) problems.push(`inbound start ${String(starts.inbound)} does not exist`);
    if (!nodes[starts.outbound]) problems.push(`outbound start ${String(starts.outbound)} does not exist`);
    if (starts.knownLead !== undefined && !nodes[starts.knownLead]) problems.push(`known-lead start ${String(starts.knownLead)} does not exist`);
  }
  const repeatRule = r.repeatRule as DecisionTree["repeatRule"];
  if (repeatRule) {
    if (!repeatRule.say) problems.push("repeatRule needs a line to say");
    if (!dispositionNames.has(repeatRule.disposition)) problems.push("repeatRule disposition is not in the disposition list");
    else if (dispositions.find((d) => d.name === repeatRule.disposition)?.durable) {
      problems.push("repeatRule must end with a non-durable disposition");
    }
  }
  const interrupts = r.interrupts as DecisionTree["interrupts"];
  if (interrupts) {
    const names = interrupts.answers?.map((a) => a.answer) ?? [];
    if (!interrupts.question?.trim()) problems.push("interrupts needs a question");
    for (const required of ["none", "unclear"]) if (!names.includes(required)) problems.push(`interrupts needs a "${required}" answer`);
    for (const a of interrupts.answers ?? []) {
      const where = `interrupts.${a.answer}`;
      if (!(typeof a.minConfidence === "number" && a.minConfidence >= 0 && a.minConfidence <= 1)) problems.push(`${where} needs a minConfidence between 0 and 1`);
      if (a.answer === "none" || a.answer === "unclear") continue;
      if (a.resume && (a.next || a.disposition || a.action)) problems.push(`${where} resumes, so it cannot also route or act`);
      if (a.returnToOrigin) problems.push(`${where} uses returnToOrigin, which only node answers may use`);
      if (!a.resume && !a.next && !a.disposition) problems.push(`${where} goes nowhere`);
      if (a.next && !nodes[a.next]) problems.push(`${where}.next points at missing node ${a.next}`);
      if (a.onBlocked?.next && !nodes[a.onBlocked.next]) problems.push(`${where}.onBlocked.next points at missing node ${a.onBlocked.next}`);
      if (a.disposition && !dispositionNames.has(a.disposition)) problems.push(`${where} uses unknown disposition ${a.disposition}`);
      if ((a.action || a.disposition) && !a.onBlocked) problems.push(`${where} is judge-gated and needs onBlocked`);
    }
  }

  const needNode = (where: string, target: unknown) => {
    if (typeof target === "string" && !nodes[target]) problems.push(`${where} points at missing node ${target}`);
  };
  for (const node of Object.values(nodes)) {
    if (node.next) needNode(`${node.id}.next`, node.next);
    if (node.collects) {
      if (!node.decision) problems.push(`${node.id} collects caller details and needs a question`);
      if (!node.collects.then || node.collects.then === node.id) problems.push(`${node.id}.collects needs another node to move on to`);
      needNode(`${node.id}.collects.then`, node.collects.then);
      for (const v of node.collects.values ?? []) if (v !== "callerName" && v !== "businessName") problems.push(`${node.id}.collects has unknown value ${String(v)}`);
    }
    for (const v of node.asks ?? []) if (v !== "callerName" && v !== "businessName") problems.push(`${node.id}.asks has unknown value ${String(v)}`);
    const decision = node.decision;
    if (!decision) continue;
    if (!decision.question?.trim()) problems.push(`${node.id} has no question`);
    if (!node.clarify) problems.push(`${node.id} has a question but no clarifying line`);
    const names = decision.answers.map((a) => a.answer);
    if (new Set(names).size !== names.length) problems.push(`${node.id} repeats an answer`);
    if (!names.includes("unclear")) problems.push(`${node.id} has no "unclear" answer`);
    for (const a of decision.answers) {
      const where = `${node.id}.${a.answer}`;
      if (!(typeof a.minConfidence === "number" && a.minConfidence >= 0 && a.minConfidence <= 1)) {
        problems.push(`${where} needs a minConfidence between 0 and 1`);
      }
      if (a.answer === "unclear") continue;
      if (a.returnToOrigin && !a.next) problems.push(`${where} returns to where the call was and needs a next node to fall back on`);
      needNode(`${where}.next`, a.next);
      needNode(`${where}.knownLeadNext`, a.knownLeadNext);
      needNode(`${where}.confirmedLeadNext`, a.confirmedLeadNext);
      needNode(`${where}.onBlocked.next`, a.onBlocked?.next);
      if (a.disposition && !dispositionNames.has(a.disposition)) problems.push(`${where} uses unknown disposition ${a.disposition}`);
      if (a.action && !ACTION_TYPES.has(a.action.type)) problems.push(`${where} has unknown action ${a.action.type}`);
      if (a.action && (a.action.type === "save_quote_field" || a.action.type === "save_details" || a.action.type === "book") && !a.action.from) {
        problems.push(`${where} action needs a "from" variable`);
      }
      if (a.action?.type === "save_quote_field" && !a.action.field) problems.push(`${where} action needs a field`);
      if ((a.action || a.disposition) && !a.onBlocked) problems.push(`${where} is judge-gated and needs onBlocked`);
      if (!a.next && !a.disposition) problems.push(`${where} goes nowhere: no next node and no disposition`);
    }
  }
  if (problems.length) throw new TreeValidationError(problems);
  return {
    id: String(r.id ?? "tree"),
    version: String(r.version ?? "0"),
    start: r.start,
    dispositions,
    maxClarifications,
    escalation,
    ...(starts ? { starts } : {}),
    ...(interrupts ? { interrupts } : {}),
    ...(repeatRule ? { repeatRule } : {}),
    nodes,
  };
}

/** The shape the `/api/tree` route serves (agreed with the views, and the same as their `TreeJson`). */
export interface TreeView {
  start: string;
  dispositions: string[];
  nodes: Array<{
    id: string;
    label: string;
    question?: string;
    /** The lowest bar among this node's real answers. */
    minConfidence?: number;
    /** Set on an end node: the disposition the call ends with. */
    disposition?: string;
    /** `to` is a node id; an "unclear" answer has no target (it asks the clarifying line and stays). */
    edges: Array<{ answer: string; to: string | null }>;
    /** Minimum confidence required to take each answer. */
    bars?: Record<string, number>;
  }>;
}

const endNodeId = (disposition: string) => `end_${disposition}`;

/** Questions become nodes; each ending becomes its own end node, so the picture shows where calls finish. */
export function toTreeView(tree: DecisionTree): TreeView {
  const used = new Set<string>();
  const nodes: TreeView["nodes"] = Object.values(tree.nodes).map((node) => {
    const answers = node.decision?.answers ?? [];
    const real = answers.filter((a) => a.answer !== "unclear");
    for (const a of real) if (a.disposition) used.add(a.disposition);
    return {
      id: node.id,
      label: node.label,
      ...(node.decision ? { question: node.decision.question } : {}),
      ...(real.length ? { minConfidence: Math.min(...real.map((a) => a.minConfidence)) } : {}),
      ...(answers.length ? { bars: Object.fromEntries(answers.map((a) => [a.answer, a.minConfidence])) } : {}),
      edges: [
        ...(node.next ? [{ answer: "next", to: node.next }] : []),
        ...answers.map((a) => ({
          answer: a.answer,
          to: a.answer === "unclear" ? null : a.disposition ? endNodeId(a.disposition) : (a.next ?? null),
        })),
      ],
    };
  });
  for (const name of used) {
    const label = tree.dispositions.find((d) => d.name === name)?.label ?? name;
    nodes.push({ id: endNodeId(name), label: `End: ${label}`, disposition: name, edges: [] });
  }
  return { start: tree.start, dispositions: tree.dispositions.map((d) => d.name), nodes };
}
