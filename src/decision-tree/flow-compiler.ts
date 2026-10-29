/**
 * Compiles the decision tree into a Pipecat Flows configuration, so the tree
 * can drive the cascaded Deepgram voice path through Pipecat Flows.
 *
 * Two steps, kept apart so another output format can be added later:
 * `compileTreeToFlow` builds a plain intermediate structure (nodes, functions,
 * branch cases, endings and a report), and `toFlowYaml` writes it as one YAML
 * `FlowConfig` that `FlowConfig.from_yaml` loads with no base directory and the
 * Pipecat Flows visual editor opens.
 *
 * The schema forbids extra keys on nodes, functions, branches and messages,
 * and forbids a description on any function that runs code. So every decision
 * is a direct function whose description and answer list live in a Python
 * handler generated from the same tree (`src/orchestration-modules/pipecat/tree_flow.py`),
 * and tree data with no place in the schema rides in custom actions (the only
 * entries that allow extra keys) or in YAML comments. docs/decision-tree-flow.md
 * explains the mapping.
 *
 * Live words always (Dana, 2026-10-20): the agent never speaks a tree line
 * verbatim. Every tree line (a node's agent line, an answer's say line, a
 * refusal line, an ending's line, the clarifying line) reaches the language
 * model as guidance in the node's task message, to say in its own words, so the
 * flow has no `tts_say` action. The one fixed text is the opening compliance
 * disclosure, which the harness speaks itself before the start node.
 */

import { inboundOpeningScript, outboundDisclosure } from "../compliance/disclosures.js";
import { UNCLEAR_CRITERION } from "./loader.js";
import type { DecisionTree, TreeAnswer, TreeNode } from "./types.js";

/** Tool names the language model sees. Azure rejects anything else, dots included. */
export const FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** The one global function: the tree's interrupt check, offered at every node. */
export const INTERRUPT_FUNCTION = "interrupt";
/** Appended to a judge-gated answer's name for the case taken when the judge refuses. */
export const BLOCKED_SUFFIX = "__blocked";
/** The result field every decision function's branch reads. */
export const ANSWER_FIELD = "answer";
/** A follow-up node, reached only through its parent's "other" answer. */
export const MORE_RE = /_more\d+$/;
/** The interrupt's "carry on" answer, same words as `toChoiceQuestion`. */
export const NO_INTERRUPT_CRITERION = "The caller is not doing any of the other things: carry on with the current step.";
/** Custom action types the compiled flow uses. A runtime must register a handler for each before entering a node. */
export const CUSTOM_ACTION_TYPES = ["crm_tree", "crm_node", "crm_answers", "crm_gates", "crm_disposition"] as const;
/** How a tree line reaches the language model: same words as the decision model path in sidecar_deepgram.py (run_turn). */
export const GUIDANCE_LEAD = "Say this in your own natural words, keeping its meaning:";
/** One tree line as guidance. Placeholders such as {firstName} stay single-brace; the runtime fills them. */
export const guidanceFor = (line: string) => `${GUIDANCE_LEAD} "${line}"`;
/**
 * What the opening disclosure covers, whatever its wording: the tree's own lines
 * word the disclosure differently from the harness (the inbound greeting line says
 * "may be recorded for quality and training"), so exact words alone cannot tell
 * the model which sentences to drop. Same words in tree_flow.py.
 */
export const DISCLOSURE_LEAVE_OUT = "leave out every sentence that says you are an artificial intelligence assistant or that the call is recorded, however it is worded";
/**
 * On both start nodes and their copies: the harness has already spoken the
 * compliance disclosure word for word. The instruction quotes those words
 * (src/compliance/disclosures.ts) and says that each part of the tree node
 * asking for the disclosure is already satisfied.
 */
export const disclosureDone = (words: string) =>
  [
    `The harness has already said the opening compliance disclosure in full, word for word, just before this step: "${words}"`,
    "So every part of this step about the disclosure is already done: the goal's part about saying the disclosures, the disclosure sentences in any line below, and any never-say item about what comes before the disclosure sentences (everything you say now comes after them).",
    `Do not say the disclosure again, or any part of it, in any words: ${DISCLOSURE_LEAVE_OUT}. Carry on with the rest of this step's goal in your own natural words.`,
  ].join(" ");
/** After a start node's guidance line. */
export const DISCLOSURE_IN_LINE = `The harness has already said the disclosure sentences in that line: ${DISCLOSURE_LEAVE_OUT}, and say the rest.`;
/** The exact disclosure words the harness speaks before each start node. A port that speaks other words must recompile. */
export const disclosureWords = (tree: DecisionTree) => ({
  inbound: inboundOpeningScript(),
  outbound: outboundDisclosure(tree.byId.get(tree.starts.outbound)?.agentLines?.find((l) => l.direction === "outbound")?.line),
});

/**
 * On the outbound start, when it has an outbound line: the harness's outbound
 * opening is the disclosure followed by that line (src/decision/engine.ts,
 * `open`), so the line's question has already been asked.
 */
export const outboundOpeningAsked = (line: string) =>
  `On this outbound call the harness's opening also carried this step's own line, which asks this step's question: "${line}" Do not say it again, or any part of it. Say nothing now: wait for the caller's reply, then decide on it.`;

/**
 * First in every ending's task message. Pipecat offers the global interrupt
 * function at every node, endings too, and the end frame is already queued: a
 * function call here would take the turn and the closing words would be lost.
 */
export const ENDING_NO_FUNCTION = `Do not call any function at this step, not ${INTERRUPT_FUNCTION} and not any other, whatever the caller said last: only speak.`;

export const functionNameFor = (treeId: string) => `decide_${treeId.replace(/[^a-zA-Z0-9]/g, "_")}`;
/** The tree node a follow-up node folds into. */
export const foldRoot = (treeId: string) => treeId.replace(MORE_RE, "");

export class FlowCompileError extends Error {}

// ---------------------------------------------------------------- intermediate structure

/** A pre or post action. The only built-in type used is `end_conversation`; the rest are custom data actions. */
export interface FlowAction {
  type: string;
  [key: string]: unknown;
}

export interface BranchCase {
  /** The answer name the handler returns, or `<answer>__blocked` when the judge refuses. */
  answer: string;
  target: string;
  /** Trailing YAML comment. */
  comment?: string;
}

export interface CompiledFunction {
  name: string;
  field: typeof ANSWER_FIELD;
  cases: BranchCase[];
}

/** Where a flow node comes from. The tests read this rather than parse names. */
export type NodeOrigin =
  | { kind: "tree"; treeId: string }
  /** A copy of `treeId` whose guidance line is an answer's `say` (`via`) or its `onBlocked.say` (`blocked`). */
  | { kind: "via" | "blocked"; treeId: string; from: string; answer: string }
  | { kind: "ending"; disposition: string };

export interface CompiledNode {
  key: string;
  origin: NodeOrigin;
  /** YAML comment lines above the node. */
  comments: string[];
  /** The tree line the language model says in its own words on entering the node, if any. Not set on the outbound start whose line the harness says. */
  guidance?: string;
  roleMessage?: string;
  taskMessages: Array<{ role: "developer"; content: string }>;
  functions: CompiledFunction[];
  preActions: FlowAction[];
  postActions: FlowAction[];
  respondImmediately: boolean;
}

/** What the Python side needs to build one direct function. */
export interface HandlerDefinition {
  name: string;
  /** The tree node that asks it (the fold root), or "interrupts". */
  treeId: string;
  /** Every answer the language model may return, in order. The enum on the `answer` parameter. Never a blocked case. */
  answers: string[];
  /** The docstring: the question, every answer with its meaning, and a Google style Args section. */
  doc: string;
}

export interface CompileReport {
  starts: { inbound: string; outbound: string };
  counts: {
    treeNodes: number;
    emittedTreeNodes: number;
    foldedNodes: number;
    flowNodes: number;
    decisionFunctions: number;
    functionEntries: number;
    /** Cases per decision function, counted once. */
    branchCases: number;
    /** Cases written in the YAML, copies included. */
    branchCasesInYaml: number;
    blockedCases: number;
    endings: number;
    sayCopies: number;
    blockedCopies: number;
    judgeGatedAnswers: number;
    maxToolsAtOneNode: number;
  };
  /** Folded follow-up node to its root. */
  folded: Record<string, string>;
  /** Tree fields carried as data in custom actions, and who must enforce them. */
  carried: Array<{ field: string; where: string; enforce: string }>;
  /** Tree fields the flow does not carry, and why. */
  lost: Array<{ field: string; why: string }>;
  /** Where the output departs from the letter of the mapping, and why. */
  departures: string[];
}

export interface CompiledFlow {
  treeId: string;
  treeVersion: string;
  initialNode: string;
  starts: { inbound: string; outbound: string };
  nodes: CompiledNode[];
  globalFunctions: CompiledFunction[];
  handlers: HandlerDefinition[];
  report: CompileReport;
}

// ---------------------------------------------------------------- folding

interface FoldedAnswer {
  a: TreeAnswer;
  /** The tree node the answer was written on: the root or one of its follow-ups. */
  from: string;
}

interface FoldedDecision {
  node: TreeNode;
  question: string;
  answers: FoldedAnswer[];
  /** Follow-up nodes folded in, in chain order. */
  folded: TreeNode[];
}

const isMoreLink = (a: TreeAnswer) => a.answer === "other" && typeof a.next === "string" && MORE_RE.test(a.next);

/**
 * Each emitted tree node's decision, with its "_more" follow-ups folded in: the
 * follow-ups' answers join the root's, every "other" link is dropped and each
 * follow-up's "unclear" goes (the root keeps its own).
 */
export function foldDecisions(tree: DecisionTree): Map<string, FoldedDecision> {
  const out = new Map<string, FoldedDecision>();
  const foldedInto = new Map<string, string>();
  // A follow-up may only be entered through the chain's "other" link.
  const links = new Set<string>();
  for (const n of tree.nodes) for (const a of n.decision?.answers ?? []) if (isMoreLink(a)) links.add(`${n.id}>${a.next}`);
  const refs: Array<[string, string | undefined]> = [
    ["starts.inbound", tree.starts.inbound],
    ["starts.outbound", tree.starts.outbound],
    ...tree.interrupts.answers.flatMap((a): Array<[string, string | undefined]> => [[`interrupts.${a.answer}`, a.next], [`interrupts.${a.answer}.onBlocked`, a.onBlocked?.next]]),
  ];
  for (const n of tree.nodes) {
    refs.push([`${n.id}.next`, n.next]);
    for (const a of n.decision?.answers ?? []) {
      if (!isMoreLink(a)) refs.push([`${n.id}.${a.answer}`, a.next]);
      refs.push([`${n.id}.${a.answer}.onBlocked`, a.onBlocked?.next]);
    }
  }
  for (const [where, to] of refs) if (to && MORE_RE.test(to)) throw new FlowCompileError(`${where} enters follow-up node ${to} other than through an "other" answer`);

  for (const n of tree.nodes) {
    if (MORE_RE.test(n.id)) continue;
    if (!n.decision) throw new FlowCompileError(`${n.id} asks no question; every node the flow emits needs one`);
    const answers: FoldedAnswer[] = [];
    const folded: TreeNode[] = [];
    let cur: TreeNode = n;
    for (;;) {
      const link = cur.decision!.answers.find(isMoreLink);
      for (const a of cur.decision!.answers) {
        if (a === link || (cur !== n && a.answer === "unclear")) continue;
        answers.push({ a, from: cur.id });
      }
      if (!link) break;
      const next = tree.byId.get(link.next!);
      if (!next?.decision) throw new FlowCompileError(`${cur.id}.other points at ${link.next}, which asks no question`);
      if (foldRoot(next.id) !== n.id) throw new FlowCompileError(`${cur.id}.other points at ${next.id}, which is not a follow-up of ${n.id}`);
      if (foldedInto.has(next.id)) throw new FlowCompileError(`follow-up ${next.id} is folded twice`);
      foldedInto.set(next.id, n.id);
      folded.push(next);
      cur = next;
    }
    const seen = new Map<string, string>();
    for (const { a, from } of answers) {
      const first = seen.get(a.answer);
      if (first !== undefined) throw new FlowCompileError(`folding into ${n.id}: answer ${a.answer} from ${from} collides with the one from ${first}`);
      seen.set(a.answer, from);
    }
    out.set(n.id, { node: n, question: n.decision.question, answers, folded });
  }
  for (const n of tree.nodes) if (MORE_RE.test(n.id) && !foldedInto.has(n.id)) throw new FlowCompileError(`follow-up ${n.id} is never reached through an "other" answer`);
  return out;
}

// ---------------------------------------------------------------- handlers

const meaningOf = (a: TreeAnswer, interrupt: boolean) =>
  a.answer === "unclear" ? UNCLEAR_CRITERION : interrupt && a.answer === "none" ? NO_INTERRUPT_CRITERION : (a.meaning ?? a.answer).replace(/\s+/g, " ").trim();

/**
 * The docstring of one decision function. Pipecat takes everything above
 * "Args:" as the tool's description, so the answer list sits there; the Python
 * side builds the same text from the tree, and the tests compare the two.
 */
export function handlerDoc(question: string, answers: readonly TreeAnswer[], interrupt: boolean): string {
  return [
    question.replace(/\s+/g, " ").trim(),
    "",
    "Call this with the one answer that fits the caller's last line. The answers:",
    ...answers.map((a) => `- ${a.answer}: ${meaningOf(a, interrupt)}`),
    "",
    "Args:",
    "    answer: The name of the one answer that fits, exactly as listed above.",
  ].join("\n");
}

// ---------------------------------------------------------------- compiling

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

interface Copy {
  key: string;
  base: string;
  /** The answer's say line or its onBlocked.say: the copy's guidance line. */
  say: string;
  from: string;
  answer: string;
  kind: "via" | "blocked";
}

interface Ending {
  key: string;
  disposition: string;
  say?: string;
  sources: string[];
}

/** The tree as a Pipecat Flows configuration, in the intermediate shape. Throws `FlowCompileError`. */
export function compileTreeToFlow(tree: DecisionTree): CompiledFlow {
  const decisions = foldDecisions(tree);
  const dispositions = new Map(tree.dispositions.map((d) => [d.name, d]));
  const taken = new Set<string>(tree.nodes.map((n) => n.id));
  const claim = (key: string, what: string) => {
    if (taken.has(key)) throw new FlowCompileError(`${what} would be named ${key}, which is already a node`);
    taken.add(key);
  };

  // Endings: one per distinct (say, disposition) pair, first come first named.
  const endings = new Map<string, Ending>();
  const endingFor = (disposition: string, say: string | undefined, source: string): string => {
    const id = `${disposition}\u0000${say ?? ""}`;
    let e = endings.get(id);
    if (!e) {
      const n = [...endings.values()].filter((x) => x.disposition === disposition).length;
      const key = n === 0 ? `end.${disposition}` : `end.${disposition}.${n + 1}`;
      claim(key, `the ending ${disposition}`);
      e = { key, disposition, say, sources: [] };
      endings.set(id, e);
    }
    if (!e.sources.includes(source)) e.sources.push(source);
    return e.key;
  };

  // Copies: a node entered with another guidance line than its own, one per edge.
  const copies = new Map<string, Copy>();
  const copyOf = (kind: "via" | "blocked", base: string, say: string, from: string, answer: string): string => {
    const id = `${kind}\u0000${from}\u0000${answer}`;
    const existing = copies.get(id);
    if (existing) return existing.key;
    const key = `${base}.${kind}.${answer}`;
    claim(key, `the ${kind} copy of ${base} for ${from}.${answer}`);
    copies.set(id, { key, base, say, from, answer, kind });
    return key;
  };

  const caseComment = (a: TreeAnswer) =>
    [`minimum confidence ${a.minConfidence}`, a.judge ? `judge-gated (minimum ${a.judge.minConfidence})` : "", a.action ? `action ${a.action.type}` : "", a.say && a.next ? "says its own line first" : ""]
      .filter(Boolean)
      .join(", ");

  /** Branch cases for one decision's answers. `source` is the node a blocked answer with no onBlocked.next stays on. */
  const casesFor = (answers: readonly FoldedAnswer[], source: string | undefined): BranchCase[] => {
    const cases: BranchCase[] = [];
    for (const { a, from } of answers) {
      if (a.answer === "unclear" || a.answer === "none" || a.resume) continue;
      const where = `${from}.${a.answer}`;
      let target: string;
      if (a.disposition) {
        if (!dispositions.has(a.disposition)) throw new FlowCompileError(`${where} uses unknown disposition ${a.disposition}`);
        target = endingFor(a.disposition, a.say, where);
      } else if (a.next) {
        target = a.say ? copyOf("via", a.next, a.say, from, a.answer) : a.next;
      } else throw new FlowCompileError(`${where} has neither next nor disposition`);
      cases.push({ answer: a.answer, target, comment: caseComment(a) });
      if (a.judge || a.action) {
        const base = a.onBlocked?.next ?? source;
        if (!base) throw new FlowCompileError(`${where} is judge-gated with no onBlocked.next and no node to stay on`);
        if (!a.onBlocked?.say) throw new FlowCompileError(`${where} is judge-gated and has no onBlocked.say`);
        cases.push({ answer: `${a.answer}${BLOCKED_SUFFIX}`, target: copyOf("blocked", base, a.onBlocked.say, from, a.answer), comment: "taken when the judge refuses" });
      }
    }
    return cases;
  };

  // Decision functions and handler definitions.
  const handlers: HandlerDefinition[] = [];
  const functionOf = new Map<string, CompiledFunction>();
  const nameOwner = new Map<string, string>([[INTERRUPT_FUNCTION, "interrupts"]]);
  for (const [id, d] of decisions) {
    const name = functionNameFor(id);
    if (!FUNCTION_NAME_RE.test(name)) throw new FlowCompileError(`${id} gives the function name ${name}, which the language model API rejects`);
    const owner = nameOwner.get(name);
    if (owner) throw new FlowCompileError(`${id} and ${owner} both give the function name ${name}`);
    nameOwner.set(name, id);
    functionOf.set(id, { name, field: ANSWER_FIELD, cases: casesFor(d.answers, id) });
    handlers.push({ name, treeId: id, answers: d.answers.map((x) => x.a.answer), doc: handlerDoc(d.question, d.answers.map((x) => x.a), false) });
  }
  const interruptAnswers = tree.interrupts.answers.map((a) => ({ a, from: "interrupts" }));
  const interrupt: CompiledFunction = { name: INTERRUPT_FUNCTION, field: ANSWER_FIELD, cases: casesFor(interruptAnswers, undefined) };
  handlers.push({ name: INTERRUPT_FUNCTION, treeId: "interrupts", answers: tree.interrupts.answers.map((a) => a.answer), doc: handlerDoc(tree.interrupts.question, tree.interrupts.answers, true) });

  // Endings the runtime enters itself: the escalations and the repeat rule.
  endingFor(tree.escalation.disposition, tree.escalation.say, "escalation");
  endingFor(tree.repeatRule.disposition, tree.repeatRule.say, "repeatRule");
  for (const n of tree.nodes) if (n.escalation) endingFor(n.escalation.disposition, n.escalation.say, `${n.id}.escalation`);

  const disclosures = disclosureWords(tree);
  const treeData: FlowAction = {
    type: "crm_tree",
    id: tree.id,
    version: tree.version,
    starts: tree.starts,
    disclosure: disclosures,
    maxClarifications: tree.maxClarifications,
    escalation: { ...tree.escalation, node: endingFor(tree.escalation.disposition, tree.escalation.say, "escalation") },
    repeatRule: { ...tree.repeatRule, node: endingFor(tree.repeatRule.disposition, tree.repeatRule.say, "repeatRule") },
    interrupts: {
      function: INTERRUPT_FUNCTION,
      question: tree.interrupts.question,
      clarify: tree.interrupts.clarify,
      answers: tree.interrupts.answers.map((a) => ({ answer: a.answer, minConfidence: a.minConfidence, ...(a.say ? { say: a.say } : {}), ...(a.resume ? { resume: true } : {}) })),
    },
  };
  const roleMessage = [
    "You are the voice agent on a business insurance call. The conversation moves through steps; each step's instructions say what is going on, what you are trying to get done and the question you are deciding.",
    `On every caller line, first ask yourself whether the caller is interrupting (${oneLine(tree.interrupts.question)}). If so, call ${INTERRUPT_FUNCTION} with the answer that fits, unless that answer leads to the step you are on. Otherwise call the step's decision function with the answer that fits the caller's last line.`,
    "Call exactly one function per caller line, except when the step says the call is ending: then call no function at all, not even interrupt, and only speak the closing words. Never make up a price, a quote or a promise. Keep every reply short and spoken.",
  ].join("\n");

  type Guidance = { line: string; source: string; direction?: string };
  const buildNode = (key: string, origin: NodeOrigin, d: FoldedDecision, guidance: Guidance | undefined): CompiledNode => {
    const n = d.node;
    const fn = functionOf.get(n.id)!;
    const gates = d.answers.filter(({ a }) => a.judge || a.action);
    const start = key === tree.starts.inbound ? "inbound" : key === tree.starts.outbound ? "outbound" : undefined;
    // A start node's copies are past the disclosure too, and their goal still names it.
    const afterDisclosure = n.id === tree.starts.inbound || n.id === tree.starts.outbound;
    const spokenDisclosure = n.id === tree.starts.inbound ? disclosures.inbound : disclosures.outbound;
    // The outbound start itself (not a copy) whose line the harness's opening already said: it waits for the caller.
    const askedByHarness = origin.kind === "tree" && key === tree.starts.outbound ? n.agentLines?.find((l) => l.direction === "outbound")?.line : undefined;
    const lines = [
      `Step: ${n.label} (${n.id}, area ${n.area}).`,
      `Situation: ${oneLine(n.situation)}`,
      `Your goal: ${oneLine(n.agentGoal)}`,
      ...(afterDisclosure ? [disclosureDone(spokenDisclosure)] : []),
      askedByHarness
        ? outboundOpeningAsked(askedByHarness)
        : guidance
        ? `Open this step now. ${guidanceFor(guidance.line)}${afterDisclosure ? ` ${DISCLOSURE_IN_LINE}` : ""} Then wait for the caller's reply.`
        : "Open this step in one or two short sentences that serve the goal, then wait for the caller's reply.",
      `The question you decide on the caller's reply: ${oneLine(d.question)}`,
      `Call ${fn.name} with the answer that fits. When no answer clearly fits or the words are not clear, call it with "unclear" and ask again in your own natural words, keeping the meaning of: "${n.clarify ?? ""}"`,
    ];
    // The tree engine ignores an interrupt that leads to the node it is on, so the node's own question takes the line.
    for (const a of tree.interrupts.answers) {
      if (a.next === n.id) lines.push(`Do not call ${INTERRUPT_FUNCTION} with "${a.answer}" here: it leads to this step. Decide with ${fn.name} instead.`);
    }
    if (n.neverSay?.length) lines.push("Never say:", ...n.neverSay.map((s) => `- ${oneLine(s)}`));
    const answerData = d.answers
      .filter(({ a }) => a.answer !== "unclear")
      .map(({ a, from }) => ({
        answer: a.answer,
        minConfidence: a.minConfidence,
        ...(from !== n.id ? { from } : {}),
        ...(a.carry ? { carry: true } : {}),
        ...(a.extract ? { extract: a.extract } : {}),
        ...(a.say ? { say: a.say } : {}),
      }));
    const pre: FlowAction[] = [];
    if (key === tree.starts.inbound || key === tree.starts.outbound) pre.push(treeData);
    pre.push({
      type: "crm_node",
      treeNode: n.id,
      label: n.label,
      area: n.area,
      ...(n.flowStep ? { flowStep: n.flowStep } : {}),
      ...(origin.kind === "via" || origin.kind === "blocked" ? { copy: origin.kind, enteredFrom: `${origin.from}.${origin.answer}` } : {}),
      ...(start ? { start } : {}),
      ...(afterDisclosure ? { disclosureSaidByHarness: true } : {}),
      ...(guidance ? { guidance: { text: guidance.line, source: guidance.source, ...(guidance.direction ? { direction: guidance.direction } : {}), ...(askedByHarness ? { saidByHarness: true } : {}) } } : {}),
      clarify: n.clarify,
      ...(n.repeatKey ? { repeatKey: n.repeatKey } : {}),
      ...(n.escalation ? { escalation: { ...n.escalation, node: endingFor(n.escalation.disposition, n.escalation.say, `${n.id}.escalation`) } } : {}),
      ...(n.promise ? { promise: n.promise } : {}),
      ...(d.folded.length ? { folded: d.folded.map((f) => ({ id: f.id, question: f.decision!.question, clarify: f.clarify, ...(f.agentLines?.length ? { lines: f.agentLines.map((l) => l.line) } : {}) })) } : {}),
    });
    pre.push({ type: "crm_answers", function: fn.name, answers: answerData });
    if (gates.length) {
      pre.push({
        type: "crm_gates",
        function: fn.name,
        gates: gates.map(({ a, from }) => ({
          answer: a.answer,
          blockedCase: `${a.answer}${BLOCKED_SUFFIX}`,
          ...(from !== n.id ? { from } : {}),
          ...(a.judge ? { judge: a.judge } : {}),
          ...(a.action ? { action: a.action } : {}),
          ...(a.disposition ? { disposition: a.disposition } : {}),
          onBlocked: a.onBlocked,
        })),
      });
    }
    const comments = [`${n.label} (area ${n.area})`];
    if (origin.kind === "via") comments.push(`Copy of ${n.id}, entered from ${origin.from}.${origin.answer}, whose line is the guidance in place of this node's.`);
    if (origin.kind === "blocked") comments.push(`Copy of ${n.id}, entered when the judge refuses ${origin.from}.${origin.answer}; the refusal line is the guidance in place of this node's.`);
    if (start) {
      comments.push(
        askedByHarness
          ? `The ${start} start: the harness's opening is the compliance disclosure followed by this node's line, so the language model waits for the caller's reply.`
          : `The ${start} start: the harness speaks the compliance disclosure before this node, and the language model carries on after it at once.`,
      );
    }
    if (d.folded.length) comments.push(`Folds in ${d.folded.map((f) => f.id).join(", ")}.`);
    return {
      key,
      origin,
      comments,
      ...(start ? { roleMessage } : {}),
      ...(guidance && !askedByHarness ? { guidance: guidance.line } : {}),
      taskMessages: [{ role: "developer", content: lines.join("\n") }],
      functions: [fn],
      preActions: pre,
      postActions: [],
      // Every step opens in the model's own words on entry, the inbound start too:
      // the inbound disclosure asks nothing, so waiting would leave the caller in
      // silence. The outbound start waits when the harness's opening already asked its question.
      respondImmediately: !askedByHarness,
    };
  };

  const agentLineOf = (n: TreeNode): Guidance | undefined => {
    // A line said only to a confirmed known lead is the engine's variant; the flow carries the ordinary line.
    const lines = (n.agentLines ?? []).filter((l) => !(l as { confirmedLead?: boolean }).confirmedLead);
    if (lines.length > 1) throw new FlowCompileError(`${n.id} has ${lines.length} lines; the flow carries one guidance line per node`);
    return lines[0] ? { line: lines[0].line, source: "agentLines", ...(lines[0].direction ? { direction: lines[0].direction } : {}) } : undefined;
  };

  const nodes: CompiledNode[] = [];
  for (const [id, d] of decisions) nodes.push(buildNode(id, { kind: "tree", treeId: id }, d, agentLineOf(d.node)));
  for (const c of copies.values()) {
    const d = decisions.get(c.base);
    if (!d) throw new FlowCompileError(`${c.from}.${c.answer} copies ${c.base}, which the flow does not emit`);
    nodes.push(buildNode(c.key, { kind: c.kind, treeId: c.base, from: c.from, answer: c.answer }, d, { line: c.say, source: `${c.from}.${c.answer}.${c.kind === "via" ? "say" : "onBlocked.say"}` }));
  }
  for (const e of endings.values()) {
    const d = dispositions.get(e.disposition)!;
    nodes.push({
      key: e.key,
      origin: { kind: "ending", disposition: e.disposition },
      comments: [`Ending: ${d.label} (${d.durable ? "durable" : "not durable"})`, `Entered from ${e.sources.join(", ")}.`],
      ...(e.say ? { guidance: e.say } : {}),
      taskMessages: [
        {
          role: "developer",
          content: [
            ENDING_NO_FUNCTION,
            `The call is ending (${d.label}: ${oneLine(d.meaning)}).`,
            e.say ? `Close the call now. ${guidanceFor(e.say)}` : "Close the call now with one short goodbye in your own natural words.",
            "Say nothing after it: the call ends when you finish speaking.",
          ].join("\n"),
        },
      ],
      functions: [],
      preActions: [{ type: "crm_disposition", disposition: e.disposition, durable: d.durable, ...(e.say ? { guidance: e.say } : {}) }],
      // A post action on a respond_immediately node runs as soon as the node is
      // set, but its end frame queues behind the model's reply in the pipeline,
      // so the reply is spoken first (docs/decision-tree-flow.md, "Endings: what
      // Pipecat does with the post action").
      postActions: [{ type: "end_conversation" }],
      respondImmediately: true,
    });
  }

  const functionEntries = nodes.reduce((s, n) => s + n.functions.length, 0);
  // Per decision function, once each: copies repeat their base's cases.
  const allCases = [...functionOf.values(), interrupt].flatMap((f) => f.cases);
  const casesInYaml = [...nodes.flatMap((n) => n.functions), interrupt].reduce((s, f) => s + f.cases.length, 0);
  const judgeGated = [...decisions.values()].flatMap((d) => d.answers).filter(({ a }) => a.judge).length + tree.interrupts.answers.filter((a) => a.judge).length;
  const folded: Record<string, string> = {};
  for (const [id, d] of decisions) for (const f of d.folded) folded[f.id] = id;

  const report: CompileReport = {
    starts: tree.starts,
    counts: {
      treeNodes: tree.nodes.length,
      emittedTreeNodes: decisions.size,
      foldedNodes: Object.keys(folded).length,
      flowNodes: nodes.length,
      decisionFunctions: handlers.length,
      functionEntries,
      branchCases: allCases.length,
      branchCasesInYaml: casesInYaml,
      blockedCases: allCases.filter((c) => c.answer.endsWith(BLOCKED_SUFFIX)).length,
      endings: endings.size,
      sayCopies: [...copies.values()].filter((c) => c.kind === "via").length,
      blockedCopies: [...copies.values()].filter((c) => c.kind === "blocked").length,
      judgeGatedAnswers: judgeGated,
      maxToolsAtOneNode: Math.max(...nodes.map((n) => n.functions.length)) + 1,
    },
    folded,
    carried: [
      { field: "minConfidence (per answer)", where: "crm_answers.answers[].minConfidence, and a comment on each case", enforce: "the runtime, before it returns an answer from a handler" },
      { field: "judge (codeRules, question, minConfidence) and action", where: "crm_gates.gates[]", enforce: "the generated handler, which asks the harness judge and returns <answer>__blocked on a refusal (step 3; the handler returns the answer unchanged for now)" },
      { field: "onBlocked.say and onBlocked.next", where: "the <answer>__blocked case and its copy node (onBlocked.say is the copy's guidance line), also crm_gates.gates[].onBlocked", enforce: "the flow itself once the handler returns the blocked case" },
      { field: "carry and extract", where: "crm_answers.answers[]", enforce: "the runtime: extract fills the variables the lines use, carry asks the next node's question of the same caller line" },
      { field: "say on an answer with next", where: "the <target>.via.<answer> copy node's guidance line (task message and crm_node.guidance), also crm_answers.answers[].say", enforce: "the flow itself; the language model says it in its own words" },
      { field: "agentLines, ending say lines, escalation and repeat rule say lines", where: "each node's task message as guidance, crm_node.guidance and crm_disposition.guidance", enforce: "the language model says each in its own words on entering the node; nothing is spoken verbatim" },
      { field: "clarify", where: "each node's task message (to say in its own words after \"unclear\") and crm_node.clarify", enforce: "the language model" },
      { field: "maxClarifications and tree escalation", where: "crm_tree on both start nodes; the escalation ending node", enforce: "the runtime: count clarifying lines at one node, then enter the escalation ending" },
      { field: "node escalation", where: "crm_node.escalation, with the ending node to enter", enforce: "the runtime, in place of the tree escalation on that node" },
      { field: "repeatRule and repeatKey", where: "crm_tree.repeatRule (with its ending node) and crm_node.repeatKey", enforce: "the runtime: the second time a repeatKey is entered in one call, enter the repeat rule ending" },
      { field: "identity of copies", where: "crm_node.treeNode and crm_node.copy", enforce: "the runtime counts clarifications and repeat keys by treeNode, not by flow node key, and does not count entering a blocked copy as the objection coming up again" },
      { field: "interrupt minimum confidences and clarify", where: "crm_tree.interrupts", enforce: "the runtime" },
      {
        field: "resume on an interrupt answer, and its say line",
        where: "crm_tree.interrupts.answers[] (resume and say); the answer has no branch case, so the flow stays on the current node",
        enforce: "the generated interrupt handler returns the say line and tells the language model to say it in its own words, keeping its meaning, then ask the current step's question again",
      },
      {
        field: "an interrupt that leads to the current node",
        where: "the interrupt's branch case target, a line in each target node's task message, and the role message",
        enforce: "the generated interrupt handler ignores an interrupt whose target is the tree node the call is on (by crm_node.treeNode of the current flow node, copies included): its result's answer is none, which has no case, so the flow stays and the language model is told to call the step's own decision function",
      },
      { field: "agentLines direction", where: "crm_node.guidance.direction (entry.outbound only) and crm_node.start", enforce: "the runtime: the outbound start is entered only on an outbound call" },
      { field: "the opening disclosure", where: "not in the flow: the harness speaks it word for word before the start node; both start nodes' task messages say it is done, and crm_node.disclosureSaidByHarness marks them", enforce: "the runtime speaks it before it initializes the flow, and checks the spoken words" },
      { field: "the outbound start's line", where: "crm_node.guidance with saidByHarness on the outbound start, and its task message", enforce: "the runtime: on an outbound call the harness's opening is the disclosure followed by this line, so the node waits for the caller (respond_immediately false)" },
      { field: "{firstName} and {slotWords} placeholders", where: "kept single-brace in task messages and the guidance data", enforce: "the runtime fills them; Pipecat's own {{ key }} filling would raise on a missing key" },
      { field: "disposition and durable", where: "crm_disposition on each ending", enforce: "the runtime records it when the ending is entered" },
      { field: "folded follow-up questions, clarifying lines and lines", where: "crm_node.folded", enforce: "nothing; kept for reference" },
      { field: "label, area, flowStep, promise", where: "crm_node and YAML comments", enforce: "nothing; for the trace and the handoff note" },
    ],
    lost: [
      { field: "the \"other\" answers that link a node to its follow-ups (and their carry)", why: "the follow-up answers join the parent's decision, so there is no second question to carry the line into" },
      { field: "follow-up nodes' own lines and clarifying lines as spoken lines", why: "the follow-ups are not entered any more; kept as data in crm_node.folded" },
      { field: "cues", why: "keyword cues serve only the keyword mock decision modules" },
      { field: "handoffTriggers, sources, closesGaps, crmEquivalent, dispositions' crmEquivalent", why: "documentation fields no runtime reads" },
    ],
    departures: [
      "No tree line is spoken verbatim: each is guidance in the node's task message for the language model to say in its own words, and the flow has no tts_say action. The tree engine speaks the lines as written.",
      "The inbound start responds at once after the harness's disclosure, where the tree engine waits for the caller: the inbound disclosure asks nothing, and the step's goal (name the agency, ask one open question) is still to do, so waiting would leave the caller in silence. The harness's own prompt setup opens an inbound call in the same two turns. The outbound start waits for the caller, as the tree engine does, when the harness's outbound opening already carries its line and question.",
      "A judge-gated answer's blocked case enters a copy of onBlocked.next (or of the source node) whose guidance line is onBlocked.say, which is what the tree engine does; re-entering the source node itself would bring back its own line instead of the refusal line.",
      "The escalation and repeat rule endings are emitted although no case enters them, so the runtime has a node to move to.",
    ],
  };

  return { treeId: tree.id, treeVersion: tree.version, initialNode: tree.starts.inbound, starts: tree.starts, nodes, globalFunctions: [interrupt], handlers, report };
}

// ---------------------------------------------------------------- YAML

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

/** A YAML double-quoted scalar. JSON's string escapes are all valid YAML escapes. */
const q = (s: string) => JSON.stringify(s);
const scalar = (v: Json): string => (typeof v === "string" ? q(v) : v === null ? "null" : String(v));
const isScalar = (v: Json) => v === null || typeof v !== "object";
const comment = (text: string) => `# ${oneLine(text)}`;

/** Block YAML for a JSON value at `indent`, keys double-quoted (a bare yes or no would load as a boolean). */
function block(v: Json, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (isScalar(item)) return [`${pad}- ${scalar(item)}`];
      if (Array.isArray(item) ? !item.length : !Object.keys(item as object).length) return [`${pad}- ${Array.isArray(item) ? "[]" : "{}"}`];
      const lines = block(item, indent + 2);
      lines[0] = `${pad}- ${lines[0]!.trimStart()}`;
      return lines;
    });
  }
  const out: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, Json>)) {
    if (val === undefined) continue;
    if (isScalar(val)) out.push(`${pad}${q(k)}: ${scalar(val)}`);
    else if (Array.isArray(val) ? !val.length : !Object.keys(val).length) out.push(`${pad}${q(k)}: ${Array.isArray(val) ? "[]" : "{}"}`);
    else out.push(`${pad}${q(k)}:`, ...block(val, indent + 2));
  }
  return out;
}

function functionLines(f: CompiledFunction, indent: number): string[] {
  const pad = " ".repeat(indent);
  return [
    `${pad}- "name": ${q(f.name)}`,
    `${pad}  "transition_to":`,
    `${pad}    "field": ${q(f.field)}`,
    `${pad}    "cases":`,
    ...f.cases.map((c) => `${pad}      ${q(c.answer)}: ${q(c.target)}${c.comment ? `  ${comment(c.comment)}` : ""}`),
  ];
}

/** The compiled flow as one YAML `FlowConfig`. Deterministic: same tree in, same bytes out. */
export function toFlowYaml(compiled: CompiledFlow): string {
  const r = compiled.report;
  const out = [
    comment(`Generated by pnpm tree:flow from the decision tree ${compiled.treeId} version ${compiled.treeVersion}. Do not edit by hand.`),
    comment(`Inbound start: ${compiled.starts.inbound} (the initial node). Outbound start: ${compiled.starts.outbound}.`),
    comment(`${r.counts.treeNodes} tree nodes, ${r.counts.foldedNodes} folded follow-ups, ${r.counts.flowNodes} flow nodes, ${r.counts.endings} endings, ${r.counts.sayCopies} say copies, ${r.counts.blockedCopies} blocked copies.`),
    comment(`Custom action types the runtime must register: ${CUSTOM_ACTION_TYPES.join(", ")}.`),
    comment("Live words always: every tree line is guidance in a task message for the language model to say in its own words; no line is spoken as written."),
    comment("The harness speaks the compliance disclosure word for word before the start node; the start nodes do not repeat it."),
    comment("Placeholders such as {firstName} are single-brace on purpose: the runtime fills them."),
    "",
    `"initial_node": ${q(compiled.initialNode)}`,
    "",
    `"global_functions":`,
    ...compiled.globalFunctions.flatMap((f) => functionLines(f, 2)),
    "",
    `"nodes":`,
  ];
  for (const n of compiled.nodes) {
    out.push("");
    for (const c of n.comments) out.push(`  ${comment(c)}`);
    out.push(`  ${q(n.key)}:`);
    if (n.roleMessage !== undefined) out.push(`    "role_message": ${q(n.roleMessage)}`);
    out.push(`    "task_messages":`, ...block(n.taskMessages, 6));
    if (n.functions.length) out.push(`    "functions":`, ...n.functions.flatMap((f) => functionLines(f, 6)));
    if (n.preActions.length) out.push(`    "pre_actions":`, ...block(n.preActions as Json, 6));
    if (n.postActions.length) out.push(`    "post_actions":`, ...block(n.postActions as Json, 6));
    out.push(`    "respond_immediately": ${n.respondImmediately}`);
  }
  return `${out.join("\n")}\n`;
}
