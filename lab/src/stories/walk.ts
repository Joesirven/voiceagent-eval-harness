/**
 * Tree to scenes. An example call is a list of turns (which node the call is
 * at, what the caller said, which answer the tree took, and why in a few
 * words). `buildWalk` checks every turn against the real tree and turns it into
 * steps the animation can play: say this, the caller replies, it means this,
 * so the call heads there. A recorded call from the harness becomes the same
 * shape through `walkFromRecord`.
 */
import { AREA_WORDS, answerWords, areaOf, endingWords, nodeWords, type AreaKey } from "./plain-words.js";

/** The parts of the real tree these helpers read (a subset of `src/decision-tree/types.ts`). */
export interface LabTreeAnswer {
  answer: string;
  meaning?: string;
  next?: string;
  disposition?: string;
  say?: string;
  action?: { type: string };
}
export interface LabTreeNode {
  id: string;
  label: string;
  clarify?: string;
  agentGoal?: string;
  agentLines?: Array<{ line: string; direction?: "inbound" | "outbound" }>;
  decision?: { question: string; answers: LabTreeAnswer[] };
  next?: string;
}
export interface LabTree {
  starts: { inbound: string; outbound: string };
  dispositions: Array<{ name: string; label: string }>;
  nodes: LabTreeNode[];
}

export interface ExampleTurn {
  /** The node the call is at when the caller speaks. */
  at: string;
  /** What the caller said, short. */
  caller: string;
  /** The answer the tree takes for that line. */
  answer: string;
  /** Why, in a few words a salesperson needs. */
  why: string;
}

export interface ExampleCall {
  id: string;
  title: string;
  /** One line under the title. */
  summary: string;
  direction: "inbound" | "outbound";
  firstName: string;
  /** Fills `{slotWords}` in the tree's lines. */
  slotWords?: string;
  turns: ExampleTurn[];
  /** The disposition the last answer must end with. */
  ending: string;
}

/** One answer a node offers, in plain words, with where it leads. */
export interface Choice {
  answer: string;
  words: string;
  /** The first sentence of the tree's meaning, if any. */
  meaning?: string;
  /** The next node id, or the ending name when `ends` is set. */
  to?: string;
  ends?: boolean;
  /** The outcome this answer makes happen on the spot (a booking, a transfer), before the call is filed. */
  commits?: string;
}

export interface Step {
  nodeId: string;
  /** Plain name of where the call is. */
  where: string;
  area: AreaKey;
  areaWords: string;
  /** What to say now. Empty when the node has no line (a silent routing step). */
  say: string;
  /** True when `say` is the node's goal, not a scripted line. */
  sayIsGoal: boolean;
  caller?: string;
  /** The answer taken (its name in the tree). */
  answer?: string;
  /** Plain words for the answer taken. */
  meaning?: string;
  /** Every real answer at this node, with the follow-up ("_more") nodes folded in and "unclear" left out. */
  choices: Choice[];
  /** The node's clarifying line, for "if you did not catch it". */
  clarify?: string;
  why?: string;
  /** Plain name of the next stop, or the ending. */
  headingTo?: string;
  /** Set on the last step: the call ends here. */
  ending?: { name: string; words: string; closing?: string };
}

export interface Walk {
  id: string;
  title: string;
  summary: string;
  steps: Step[];
  /** Area keys in the order the call touched them. */
  areasTouched: AreaKey[];
}

function fill(line: string, vars: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

function lineOf(node: LabTreeNode, direction: "inbound" | "outbound"): string {
  return node.agentLines?.find((l) => !l.direction || l.direction === direction)?.line ?? "";
}

export function indexTree(tree: LabTree): Map<string, LabTreeNode> {
  return new Map(tree.nodes.map((n) => [n.id, n]));
}

/** A follow-up node ("open.greeting_more2") only holds more answers for its parent; the helpers show it as part of the parent. */
export const isFollowUp = (nodeId: string) => /_more\d+$/.test(nodeId);
export const parentOf = (nodeId: string) => nodeId.replace(/_more\d+$/, "");

const firstSentence = (text?: string) => text?.split(/(?<=[.!?])\s/)[0];

/** The real answers at a node, with its follow-up nodes folded in and "unclear" and "other" left out. */
export function choicesAt(byId: Map<string, LabTreeNode>, nodeId: string): Choice[] {
  const out: Choice[] = [];
  let node = byId.get(nodeId);
  while (node) {
    let more: LabTreeNode | undefined;
    for (const a of node.decision?.answers ?? []) {
      if (a.answer === "unclear") continue;
      if (a.answer === "other" && a.next && isFollowUp(a.next)) {
        more = byId.get(a.next);
        continue;
      }
      out.push({
        answer: a.answer,
        words: answerWords(a.answer),
        ...(a.meaning ? { meaning: firstSentence(a.meaning) } : {}),
        ...(a.disposition ? { to: a.disposition, ends: true } : a.next ? { to: a.next } : {}),
        ...(a.action?.type === "book" ? { commits: "booked" } : a.action?.type === "transfer" ? { commits: "handed_off" } : {}),
      });
    }
    node = more;
  }
  return out;
}

function stepFor(byId: Map<string, LabTreeNode>, node: LabTreeNode, say: string, sayIsGoal: boolean): Step {
  const area = areaOf(node.id);
  return {
    nodeId: node.id,
    where: nodeWords(node.id, node.label),
    area,
    areaWords: AREA_WORDS[area],
    say,
    sayIsGoal,
    choices: choicesAt(byId, node.id),
    ...(node.clarify ? { clarify: node.clarify } : {}),
  };
}

/** Builds the steps for one example call, refusing any turn the real tree does not have. */
export function buildWalk(tree: LabTree, example: ExampleCall): Walk {
  const byId = indexTree(tree);
  const vars = { firstName: example.firstName, slotWords: example.slotWords ?? "that time" };
  const steps: Step[] = [];
  let current = tree.starts[example.direction];
  let pendingSay: string | undefined;
  /** Set while a turn at a follow-up node is being folded into its parent's step. */
  let folded: { step: Step; caller: string } | undefined;
  for (const [i, turn] of example.turns.entries()) {
    const node = byId.get(current);
    if (!node) throw new Error(`${example.id}: turn ${i + 1} is at "${current}", which is not in the tree`);
    if (turn.at !== current) throw new Error(`${example.id}: turn ${i + 1} says it is at "${turn.at}" but the tree is at "${current}"`);
    const answer = node.decision?.answers.find((a) => a.answer === turn.answer);
    if (!answer) throw new Error(`${example.id}: node "${current}" has no answer "${turn.answer}"`);
    let step: Step;
    if (folded) {
      step = folded.step;
      step.caller = [folded.caller, turn.caller].filter(Boolean).join(" ");
      folded = undefined;
    } else {
      const own = lineOf(node, example.direction);
      const say = pendingSay ?? own;
      step = stepFor(byId, node, fill(say || node.agentGoal || "", vars), !say);
      step.caller = turn.caller;
    }
    if (turn.answer === "other" && answer.next && isFollowUp(answer.next)) {
      // The caller's line is read against the parent's second list: one step on screen, not two.
      folded = { step, caller: step.caller ?? "" };
      current = answer.next;
      continue;
    }
    step.answer = turn.answer;
    step.meaning = answerWords(turn.answer);
    step.why = turn.why;
    if (answer.disposition) {
      if (i !== example.turns.length - 1) throw new Error(`${example.id}: turn ${i + 1} ends the call but more turns follow`);
      if (answer.disposition !== example.ending) throw new Error(`${example.id}: ends with "${answer.disposition}", not "${example.ending}"`);
      const label = tree.dispositions.find((d) => d.name === answer.disposition)?.label;
      step.ending = { name: answer.disposition, words: endingWords(answer.disposition, label), ...(answer.say ? { closing: fill(answer.say, vars) } : {}) };
      step.headingTo = step.ending.words;
      steps.push(step);
      current = "";
      break;
    }
    if (!answer.next) throw new Error(`${example.id}: answer "${turn.answer}" at "${current}" goes nowhere`);
    const nextNode = byId.get(answer.next);
    if (!nextNode) throw new Error(`${example.id}: "${answer.next}" is not in the tree`);
    step.headingTo = nodeWords(nextNode.id, nextNode.label);
    steps.push(step);
    pendingSay = answer.say;
    current = answer.next;
  }
  if (folded) throw new Error(`${example.id}: the call stops on a follow-up list at "${current}" without an answer`);
  if (current) throw new Error(`${example.id}: the call stops at "${current}" without an ending`);
  return { id: example.id, title: example.title, summary: example.summary, steps, areasTouched: touched(steps) };
}

function touched(steps: Step[]): AreaKey[] {
  const seen: AreaKey[] = [];
  for (const s of steps) if (!seen.includes(s.area)) seen.push(s.area);
  return seen;
}

/** The parts of a harness record the replay reads (a subset of `src/trace/records.ts`). */
export interface LabRecord {
  recordId: string;
  leadId?: string;
  direction?: "inbound" | "outbound";
  openedAt?: string;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

/**
 * A recorded call over the tree: each `node_enter` starts a step, the agent's
 * spoken lines in it are what was said, the caller's lines are the reply, the
 * last `decision` names the answer, and a `disposition` ends it. Node ids the
 * tree does not know (older recordings) keep the label the record carries.
 */
export function walkFromRecord(tree: LabTree, record: LabRecord): Walk {
  const byId = indexTree(tree);
  const steps: Step[] = [];
  let step: Step | undefined;
  const open = (nodeId: string, label: string) => {
    const node = byId.get(nodeId);
    const area = areaOf(nodeId);
    step = {
      nodeId,
      where: nodeWords(nodeId, node?.label ?? label),
      area,
      areaWords: AREA_WORDS[area],
      say: "",
      sayIsGoal: false,
      choices: choicesAt(byId, nodeId),
      ...(node?.clarify ? { clarify: node.clarify } : {}),
    };
    steps.push(step);
  };
  const append = (text: string, field: "say" | "caller") => {
    if (!step) open("call", "Call");
    const s = step!;
    s[field] = [s[field], text].filter(Boolean).join(" ");
  };
  for (const e of record.events) {
    const d = e.data;
    if (e.type === "node_enter" && typeof d.nodeId === "string") {
      if (step && isFollowUp(d.nodeId) && parentOf(d.nodeId) === step.nodeId) continue; // the parent's second list: same step
      if (step) step.headingTo = nodeWords(d.nodeId, typeof d.label === "string" ? d.label : undefined);
      open(d.nodeId, typeof d.label === "string" ? d.label : d.nodeId);
    } else if ((e.type === "transcript_final" || e.type === "turn") && typeof d.text === "string") {
      if (d.role === "agent" && d.spoken !== false) append(d.text, "say");
      else if (d.role === "caller") append(d.text, "caller");
    } else if (e.type === "decision" && typeof d.answer === "string" && step) {
      if (d.answer === "other" || d.answer === "unclear") continue; // a second list or a clarifying question, not a move
      step.answer = d.answer;
      step.meaning = answerWords(d.answer);
      if (typeof d.confidence === "number") step.why = `The decision model was ${Math.round(d.confidence * 100)} percent sure.`;
    } else if (e.type === "disposition" && typeof d.value === "string" && step) {
      const label = tree.dispositions.find((x) => x.name === d.value)?.label;
      step.ending = { name: d.value, words: endingWords(d.value, label) };
      step.headingTo = step.ending.words;
    }
  }
  if (step && !step.ending && !step.headingTo) step.headingTo = "The recording ends here";
  // The lead's name stays out of the steps on purpose.
  const when = record.openedAt ? new Date(record.openedAt).toLocaleString() : "";
  return {
    id: `record:${record.recordId}`,
    title: `Recorded call ${record.recordId}`,
    summary: [when, record.direction ? `${record.direction} call` : "", "read-only replay of the harness record"].filter(Boolean).join(", "),
    steps,
    areasTouched: touched(steps),
  };
}

/**
 * Frames per second and how long each part of a step lasts, for playing a walk step by step.
 * The animated lab page that used them was removed; today only tests/lab/walk.test.ts calls them.
 */
export const FPS = 30;
export const INTRO_FRAMES = 60;
export const STEP_FRAMES = 150;
export const ENDING_FRAMES = 120;

export function stepStartFrame(index: number): number {
  return INTRO_FRAMES + index * STEP_FRAMES;
}

export function walkDurationInFrames(walk: Walk): number {
  return INTRO_FRAMES + Math.max(1, walk.steps.length) * STEP_FRAMES + ENDING_FRAMES;
}

/** Which step is on screen at a frame (-1 during the intro). */
export function stepAtFrame(walk: Walk, frame: number): number {
  if (frame < INTRO_FRAMES) return -1;
  return Math.min(walk.steps.length - 1, Math.floor((frame - INTRO_FRAMES) / STEP_FRAMES));
}
