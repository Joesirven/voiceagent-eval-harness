import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_SUFFIX,
  DISCLOSURE_IN_LINE,
  DISCLOSURE_LEAVE_OUT,
  disclosureDone,
  disclosureWords,
  ENDING_NO_FUNCTION,
  FlowCompileError,
  FUNCTION_NAME_RE,
  INTERRUPT_FUNCTION,
  MORE_RE,
  outboundOpeningAsked,
  compileTreeToFlow,
  foldRoot,
  functionNameFor,
  GUIDANCE_LEAD,
  guidanceFor,
  toFlowYaml,
  type CompiledFlow,
  type CompiledFunction,
  type CompiledNode,
} from "../../src/decision-tree/flow-compiler.js";
import { MAX_ANSWERS, validateDecisionTree, type DecisionTree, type DecisionTreeData, type TreeAnswer } from "../../src/decision-tree/index.js";
import { inboundOpeningScript, OUTBOUND_DISCLOSURE, outboundDisclosure, outboundOpeningScript } from "../../src/compliance/disclosures.js";
import { minimalTree } from "./fixture.js";

const TREE_FILE = fileURLToPath(new URL("../../src/decision-tree/full-tree.json", import.meta.url));
const FLOW_FILE = fileURLToPath(new URL("../../src/decision-tree/full-tree.flow.yaml", import.meta.url));
const CHECK_SCRIPT = fileURLToPath(new URL("../../scripts/check_tree_flow.py", import.meta.url));
const CALL_SCRIPT = fileURLToPath(new URL("../../scripts/call_tree_flow_tool.py", import.meta.url));

// Every expected count below comes from the loaded tree, so the tests hold when the tree changes.
const rawTree = JSON.parse(readFileSync(TREE_FILE, "utf8")) as DecisionTreeData;
const realTree = validateDecisionTree(structuredClone(rawTree));
const realCompiled = compileTreeToFlow(realTree);

/**
 * A changed copy of the full tree, never written back: resume set on an
 * interrupt answer, one answer added to a node (with a line and a next node,
 * so it also makes a new copy) that keeps the resumed answer's old target
 * reachable, as the validator requires, and another interrupt answer pointed
 * at a new target.
 */
function changedTree() {
  const t = structuredClone(rawTree);
  const emitted = t.nodes.filter((n) => !MORE_RE.test(n.id) && n.decision);
  const startIds = new Set([t.starts.inbound, t.starts.outbound]);
  const targets = new Set(t.interrupts.answers.flatMap((a) => (a.next ? [a.next] : [])));
  const enteredByNodes = new Set(t.nodes.flatMap((n) => [n.next, ...n.decision!.answers.flatMap((a) => [a.next, a.onBlocked?.next])]));
  const resumed = t.interrupts.answers.find((a) => a.answer === "asks_to_stop")!;
  const addedNext = resumed.next!;
  resumed.resume = true;
  resumed.say ??= "A resume line the flow compiler test adds.";
  delete resumed.next;
  delete resumed.onBlocked;
  const grown = emitted.find((n) => n.id !== addedNext && !startIds.has(n.id) && !targets.has(n.id) && n.decision!.answers.length < MAX_ANSWERS && !n.decision!.answers.some(isMoreLink))!;
  const added: TreeAnswer = { answer: "flow_test_added_answer", meaning: "An answer the flow compiler test adds.", minConfidence: 0.7, next: addedNext, say: "A line the flow compiler test adds." };
  grown.decision!.answers.push(added);
  // The old target must stay reachable without the interrupt.
  const moved = t.interrupts.answers.find((a) => a.answer === "asks_for_person")!;
  const oldTarget = moved.next!;
  const newTarget = emitted.find((n) => !targets.has(n.id) && n.id !== grown.id && !startIds.has(n.id))!.id;
  moved.next = newTarget;
  return { data: t, tree: validateDecisionTree(structuredClone(t)), grown: grown.id, added, resumed: resumed.answer, resumeSay: resumed.say, moved: moved.answer, oldTarget, newTarget };
}
const changed = changedTree();
const changedCompiled = compileTreeToFlow(changed.tree);

const fnOf = (n: CompiledNode) => n.functions[0]!;
const caseOf = (f: CompiledFunction, answer: string) => f.cases.find((c) => c.answer === answer);
/** The tree line a node gives the language model as guidance, if any. */
const lineOf = (n: CompiledNode) => n.guidance;
const taskOf = (n: CompiledNode) => n.taskMessages[0]!.content;
const nodeData = (n: CompiledNode) => n.preActions.find((a) => a.type === "crm_node")!;
function isMoreLink(a: TreeAnswer) {
  return a.answer === "other" && MORE_RE.test(a.next ?? "");
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const isGated = (a: TreeAnswer) => Boolean(a.judge || a.action);
/** The outbound start's own outbound line, which the harness's outbound opening says after the disclosure (src/decision/engine.ts, open). */
const harnessSaidLine = (tree: DecisionTree) => tree.byId.get(tree.starts.outbound)!.agentLines?.find((l) => l.direction === "outbound")?.line;
/** Interrupt answers that branch somewhere: not none, not unclear, not resume. */
const routedInterrupts = (tree: DecisionTree) => tree.interrupts.answers.filter((a) => a.answer !== "none" && a.answer !== "unclear" && !a.resume);

/** Every flow node key the node's own functions lead to. */
const targetsOf = (n: CompiledNode) => n.functions.flatMap((f) => f.cases.map((c) => c.target));

/** A via or blocked copy differs from its base only in the guidance line and in crm_node's copy, enteredFrom and guidance. */
function expectOnlyGuidanceDiffers(copy: CompiledNode, base: CompiledNode) {
  const swap = (n: CompiledNode) => {
    const lines = taskOf(n).split("\n");
    return lines.map((l) => (n.guidance && l.includes(guidanceFor(n.guidance)) ? l.replace(guidanceFor(n.guidance), "<guidance>") : l)).join("\n");
  };
  const baseTask = base.guidance ? swap(base) : taskOf(base).replace("Open this step in one or two short sentences that serve the goal, then wait for the caller's reply.", "Open this step now. <guidance> Then wait for the caller's reply.");
  // A copy of the outbound start is entered after the opening turn. It uses
  // ordinary guidance instead of the start node's instruction to wait.
  if (nodeData(base).start !== "outbound") expect(swap(copy), copy.key).toBe(baseTask);
  const strip = (n: CompiledNode) => {
    const { copy: _c, enteredFrom: _e, guidance: _g, start: _s, ...rest } = nodeData(n);
    return rest;
  };
  expect(strip(copy), copy.key).toEqual(strip(base));
  expect(copy.preActions.filter((a) => a.type !== "crm_node")).toEqual(base.preActions.filter((a) => a.type !== "crm_node" && a.type !== "crm_tree"));
  expect(copy.postActions).toEqual(base.postActions);
  if (nodeData(base).start !== "outbound") expect(copy.respondImmediately).toBe(base.respondImmediately);
}

describe.each([
  ["the full tree", realTree, realCompiled],
  ["a changed copy of the full tree", changed.tree, changedCompiled],
])("compiling %s to a Pipecat flow", (_label, tree: DecisionTree, compiled: CompiledFlow) => {
  const byKey = new Map(compiled.nodes.map((n) => [n.key, n]));
  const treeNodeFor = (id: string) => byKey.get(foldRoot(id))!;
  const followUps = tree.nodes.filter((n) => MORE_RE.test(n.id));
  const emittedCount = tree.nodes.length - followUps.length;
  const nodeAnswers = tree.nodes.flatMap((n) => n.decision!.answers);
  const interruptFn = () => compiled.globalFunctions.find((f) => f.name === INTERRUPT_FUNCTION)!;

  it("represents every tree node: as a flow node, or folded into its root", () => {
    const emitted = compiled.nodes.filter((n) => n.origin.kind === "tree").map((n) => (n.origin as { treeId: string }).treeId);
    const folded = Object.keys(compiled.report.folded);
    expect(emitted.length + folded.length).toBe(tree.nodes.length);
    expect(new Set([...emitted, ...folded])).toEqual(new Set(tree.nodes.map((n) => n.id)));
    for (const id of folded) {
      expect(MORE_RE.test(id)).toBe(true);
      expect(byKey.has(id)).toBe(false);
      expect(compiled.report.folded[id]).toBe(foldRoot(id));
      expect(emitted).toContain(foldRoot(id));
    }
    expect(compiled.report.counts).toMatchObject({ treeNodes: tree.nodes.length, emittedTreeNodes: emittedCount, foldedNodes: followUps.length });
  });

  it("gives every answer a branch case, except unclear, none, resume and the folded other links", () => {
    let total = 0;
    let cased = 0;
    let none = 0;
    for (const n of tree.nodes) {
      const fn = fnOf(treeNodeFor(n.id));
      for (const a of n.decision!.answers) {
        total += 1;
        if (a.answer === "unclear" || isMoreLink(a)) {
          none += 1;
          expect(caseOf(fn, a.answer), `${n.id}.${a.answer}`).toBeUndefined();
        } else {
          cased += 1;
          expect(caseOf(fn, a.answer), `${n.id}.${a.answer}`).toBeDefined();
          // A plain next answer enters its own target; this loop walks the follow-up nodes too, so folded answers keep their next.
          if (a.next && !a.say && !a.disposition) expect(caseOf(fn, a.answer)!.target, `${n.id}.${a.answer}`).toBe(a.next);
        }
      }
    }
    for (const a of tree.interrupts.answers) {
      total += 1;
      if (a.answer === "none" || a.answer === "unclear" || a.resume) {
        none += 1;
        expect(caseOf(interruptFn(), a.answer), a.answer).toBeUndefined();
      } else {
        cased += 1;
        if (!a.say && !a.disposition) expect(caseOf(interruptFn(), a.answer)?.target, a.answer).toBe(a.next);
        else expect(caseOf(interruptFn(), a.answer), a.answer).toBeDefined();
      }
    }
    expect(total).toBe(nodeAnswers.length + tree.interrupts.answers.length);
    expect(cased + none).toBe(total);
    const unclears = nodeAnswers.filter((a) => a.answer === "unclear").length;
    const links = nodeAnswers.filter(isMoreLink).length;
    const quietInterrupts = tree.interrupts.answers.length - routedInterrupts(tree).length;
    expect(none).toBe(unclears + links + quietInterrupts);
    // One case per answer that routes, plus one blocked case per judge-gated or action answer.
    const blocked = [...nodeAnswers, ...routedInterrupts(tree)].filter(isGated).length;
    expect(compiled.report.counts.branchCases).toBe(cased + blocked);
  });

  it("points every transition at a node that exists", () => {
    const targets = [...compiled.nodes.flatMap(targetsOf), ...compiled.globalFunctions.flatMap((f) => f.cases.map((c) => c.target))];
    for (const t of targets) expect(byKey.has(t), t).toBe(true);
    expect(byKey.has(compiled.initialNode)).toBe(true);
    expect(compiled.initialNode).toBe(tree.starts.inbound);
    expect(byKey.has(tree.starts.outbound)).toBe(true);
    expect(compiled.report.starts).toEqual(tree.starts);
  });

  it("leaves nothing unreachable that the tree could reach", () => {
    const treeReached = new Set<string>();
    const queue = [tree.starts.inbound, tree.starts.outbound, ...tree.interrupts.answers.flatMap((a) => [a.next, a.onBlocked?.next])].filter((x): x is string => Boolean(x));
    while (queue.length) {
      const id = queue.pop()!;
      if (treeReached.has(id)) continue;
      treeReached.add(id);
      const n = tree.byId.get(id)!;
      for (const to of [n.next, ...(n.decision?.answers ?? []).flatMap((a) => [a.next, a.onBlocked?.next])]) if (to && !treeReached.has(to)) queue.push(to);
    }
    const flowReached = new Set<string>();
    const fq = [compiled.initialNode, tree.starts.outbound, ...compiled.globalFunctions.flatMap((f) => f.cases.map((c) => c.target))];
    while (fq.length) {
      const key = fq.pop()!;
      if (flowReached.has(key)) continue;
      flowReached.add(key);
      for (const to of targetsOf(byKey.get(key)!)) if (!flowReached.has(to)) fq.push(to);
    }
    const mappedTree = new Set([...treeReached].map(foldRoot));
    const mappedFlow = new Set([...flowReached].map((k) => byKey.get(k)!.origin).flatMap((o) => (o.kind === "ending" ? [] : [o.treeId])));
    expect(mappedFlow).toEqual(mappedTree);
    // An unreached tree node's flow node is one the tree cannot reach either, or one entered only through copies saying another line first;
    // an unreached copy comes from a tree node the tree cannot reach; an unreached ending is one only the runtime enters (checked below).
    const reachedOrigins = [...flowReached].map((k) => byKey.get(k)!.origin);
    const runtimeEndings = new Set([tree.escalation, tree.repeatRule, ...tree.nodes.flatMap((n) => (n.escalation ? [n.escalation] : []))].map((e) => `${e.disposition}|${e.say}`));
    for (const n of compiled.nodes.filter((x) => !flowReached.has(x.key))) {
      const o = n.origin;
      if (o.kind === "tree") {
        expect(!mappedTree.has(o.treeId) || reachedOrigins.some((r) => r.kind === "via" && r.treeId === o.treeId), n.key).toBe(true);
        continue;
      }
      if (o.kind !== "ending") {
        expect(mappedTree.has(foldRoot(o.from)), n.key).toBe(false);
        continue;
      }
      const disposition = n.preActions.find((a) => a.type === "crm_disposition")!.disposition as string;
      const leadsHere = (a: TreeAnswer) => a.disposition === disposition && (a.say ?? "") === (lineOf(n) ?? "");
      const reachable = tree.nodes.filter((x) => mappedTree.has(foldRoot(x.id)));
      expect([...reachable.flatMap((x) => x.decision!.answers), ...routedInterrupts(tree)].some(leadsHere), n.key).toBe(false);
      // Otherwise only the runtime enters it, or only tree nodes the tree cannot reach lead to it.
      expect(runtimeEndings.has(`${disposition}|${lineOf(n)}`) || nodeAnswers.some(leadsHere), n.key).toBe(true);
    }
  });

  it("names every tool the way the language model API accepts, uniquely per node and apart from the globals", () => {
    const globals = new Set(compiled.globalFunctions.map((f) => f.name));
    expect([...globals]).toEqual([INTERRUPT_FUNCTION]);
    for (const n of compiled.nodes) {
      const names = n.functions.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(FUNCTION_NAME_RE);
        expect(globals.has(name)).toBe(false);
      }
    }
    // One handler per decision: distinct tree nodes never share a name.
    const owners = new Map<string, string>();
    for (const n of compiled.nodes) {
      if (n.origin.kind === "ending") continue;
      const prev = owners.get(fnOf(n).name);
      if (prev) expect(prev).toBe(n.origin.treeId);
      owners.set(fnOf(n).name, n.origin.treeId);
    }
    expect(owners.size).toBe(emittedCount);
    expect(compiled.handlers).toHaveLength(emittedCount + 1);
    // A structural limit, not a count: the node's decision function plus the global interrupt.
    expect(compiled.report.counts.maxToolsAtOneNode).toBe(2);
  });

  it("gives each answer with say and next a copy of its target that says the answer's line", () => {
    const edges = tree.nodes.flatMap((n) => n.decision!.answers.filter((a) => a.say && a.next).map((a) => ({ n, a })));
    const interruptEdges = routedInterrupts(tree).filter((a) => a.say && a.next);
    for (const { n, a } of edges) {
      const target = caseOf(fnOf(treeNodeFor(n.id)), a.answer)!.target;
      const copy = byKey.get(target)!;
      expect(copy.origin).toEqual({ kind: "via", treeId: a.next, from: n.id, answer: a.answer });
      expect(target).toBe(`${a.next}.via.${a.answer}`);
      expect(lineOf(copy)).toBe(a.say);
      expect(taskOf(copy)).toContain(guidanceFor(a.say!));
      expect(copy.respondImmediately).toBe(true);
      // Behaves as the target: the same function and the same cases.
      expect(copy.functions).toEqual(byKey.get(a.next!)!.functions);
      // The target is still entered without the say line from elsewhere.
      expect(lineOf(byKey.get(a.next!)!)).toBe(tree.byId.get(a.next!)!.agentLines?.[0]?.line);
      expectOnlyGuidanceDiffers(copy, byKey.get(a.next!)!);
    }
    for (const a of interruptEdges) expect(caseOf(interruptFn(), a.answer)!.target).toBe(`${a.next}.via.${a.answer}`);
    expect(compiled.report.counts.sayCopies).toBe(edges.length + interruptEdges.length);
  });

  it("ends the call at one ending node per distinct say and disposition pair", () => {
    const pairs = new Set<string>();
    for (const a of [...nodeAnswers, ...tree.interrupts.answers]) if (a.disposition) pairs.add(`${a.disposition}|${a.say ?? ""}`);
    for (const e of [tree.escalation, tree.repeatRule, ...tree.nodes.flatMap((n) => (n.escalation ? [n.escalation] : []))]) pairs.add(`${e.disposition}|${e.say}`);
    const endings = compiled.nodes.filter((n) => n.origin.kind === "ending");
    expect(endings).toHaveLength(pairs.size);
    expect(compiled.report.counts.endings).toBe(pairs.size);
    for (const e of endings) {
      // The model closes in its own words on entry; the end runs as a post action, after the bot's turn.
      expect(e.preActions.map((a) => a.type)).toEqual(["crm_disposition"]);
      expect(e.postActions).toEqual([{ type: "end_conversation" }]);
      expect(e.functions).toEqual([]);
      expect(e.respondImmediately).toBe(true);
      // The no-function line comes first: the global interrupt is still offered here, and a call would take the closing turn.
      expect(taskOf(e).startsWith(ENDING_NO_FUNCTION), e.key).toBe(true);
      const disposition = e.preActions[0]!.disposition as string;
      expect(pairs.has(`${disposition}|${lineOf(e) ?? ""}`), e.key).toBe(true);
      if (lineOf(e)) {
        expect(taskOf(e), e.key).toContain(guidanceFor(lineOf(e)!));
        expect(e.preActions[0]!.guidance).toBe(lineOf(e));
      }
      expect(e.key.startsWith(`end.${disposition}`)).toBe(true);
    }
    // Each answer with a disposition reaches the ending with its own line.
    for (const n of tree.nodes) for (const a of n.decision!.answers) {
      if (!a.disposition) continue;
      const e = byKey.get(caseOf(fnOf(treeNodeFor(n.id)), a.answer)!.target)!;
      expect(e.preActions[0]!.disposition).toBe(a.disposition);
      expect(lineOf(e)).toBe(a.say);
    }
    // The escalation and repeat rule lines are guidance in the endings the runtime enters.
    const data = byKey.get(tree.starts.inbound)!.preActions.find((a) => a.type === "crm_tree")!;
    for (const [rule, node] of [
      [tree.escalation, (data.escalation as { node: string }).node],
      [tree.repeatRule, (data.repeatRule as { node: string }).node],
      ...tree.nodes.flatMap((n) => (n.escalation ? [[n.escalation, (nodeData(byKey.get(n.id)!).escalation as { node: string }).node] as const] : [])),
    ] as const) {
      expect(taskOf(byKey.get(node)!), node).toContain(guidanceFor(rule.say));
      expect(byKey.get(node)!.preActions[0]!.disposition).toBe(rule.disposition);
    }
  });

  it("gives every judge-gated answer a blocked case and carries its judge and action as data", () => {
    for (const n of tree.nodes) for (const a of n.decision!.answers) {
      if (!isGated(a)) continue;
      const node = treeNodeFor(n.id);
      const blocked = caseOf(fnOf(node), `${a.answer}${BLOCKED_SUFFIX}`)!;
      expect(blocked, `${n.id}.${a.answer}`).toBeDefined();
      const copy = byKey.get(blocked.target)!;
      expect(copy.origin).toEqual({ kind: "blocked", treeId: a.onBlocked?.next ?? foldRoot(n.id), from: n.id, answer: a.answer });
      expect(lineOf(copy)).toBe(a.onBlocked!.say);
      expect(taskOf(copy)).toContain(guidanceFor(a.onBlocked!.say));
      expect(copy.respondImmediately).toBe(true);
      expect(copy.functions).toEqual(byKey.get(a.onBlocked?.next ?? foldRoot(n.id))!.functions);
      expectOnlyGuidanceDiffers(copy, byKey.get(a.onBlocked?.next ?? foldRoot(n.id))!);
      const gates = node.preActions.find((x) => x.type === "crm_gates")!.gates as Array<Record<string, unknown>>;
      const gate = gates.find((g) => g.answer === a.answer)!;
      expect(gate.judge).toEqual(a.judge);
      expect(gate.action).toEqual(a.action);
      expect(gate.onBlocked).toEqual(a.onBlocked);
      expect(gate.blockedCase).toBe(`${a.answer}${BLOCKED_SUFFIX}`);
    }
    const judged = [...nodeAnswers, ...tree.interrupts.answers].filter((a) => a.judge).length;
    expect(compiled.report.counts.judgeGatedAnswers).toBe(judged);
    expect(compiled.report.counts.blockedCases).toBe([...nodeAnswers, ...routedInterrupts(tree)].filter(isGated).length);
    // The blocked cases never reach the language model's enum.
    for (const h of compiled.handlers) expect(h.answers.some((x) => x.endsWith(BLOCKED_SUFFIX))).toBe(false);
  });

  it("tells each node's task message its situation, goal, question, clarifying line and never-say list, and the starts the role", () => {
    for (const fn of compiled.nodes) {
      if (fn.origin.kind === "ending") continue;
      const n = tree.byId.get(fn.origin.treeId)!;
      const content = fn.taskMessages[0]!.content;
      expect(fn.taskMessages).toHaveLength(1);
      expect(content, fn.key).toContain(oneLine(n.situation));
      expect(content, fn.key).toContain(oneLine(n.agentGoal));
      expect(content, fn.key).toContain(oneLine(n.decision!.question));
      expect(content, fn.key).toContain(`call it with "unclear" and ask again in your own natural words, keeping the meaning of: "${n.clarify ?? ""}"`);
      for (const s of n.neverSay ?? []) expect(content, fn.key).toContain(`- ${oneLine(s)}`);
    }
    const starts = new Set([tree.starts.inbound, tree.starts.outbound]);
    for (const n of compiled.nodes) {
      if (starts.has(n.key)) {
        expect(n.roleMessage, n.key).toMatch(new RegExp(`call ${INTERRUPT_FUNCTION} with the answer that fits, unless`));
        // The role's one-function rule does not cover endings, where the task says to call none.
        expect(n.roleMessage, n.key).toContain("except when the step says the call is ending: then call no function at all, not even interrupt");
      }
      else expect(n.roleMessage, n.key).toBeUndefined();
    }
  });

  it("tells each interrupt target, copies included, not to interrupt to itself", () => {
    // The tree engine skips an interrupt that leads to the node it is on; the generated interrupt handler does the same.
    const pairs = tree.interrupts.answers.filter((a) => a.next).map((a) => [a.answer, a.next!] as const);
    const warned = new Set<string>();
    const line = `Do not call ${INTERRUPT_FUNCTION} with`;
    for (const n of compiled.nodes) {
      if (n.origin.kind === "ending") continue;
      const treeId = n.origin.treeId;
      const own = pairs.filter(([, next]) => next === treeId);
      if (!own.length) {
        expect(n.taskMessages[0]!.content, n.key).not.toContain(line);
        continue;
      }
      for (const [answer, next] of own) {
        expect(n.taskMessages[0]!.content, n.key).toContain(`${line} "${answer}" here: it leads to this step. Decide with ${fnOf(n).name} instead.`);
        warned.add(answer);
        // The flow still branches there; only the handler can tell it is the current node.
        expect(caseOf(interruptFn(), answer)!.target).toBe(tree.interrupts.answers.find((a) => a.answer === answer)!.say ? `${next}.via.${answer}` : next);
      }
    }
    expect(warned).toEqual(new Set(pairs.map(([answer]) => answer)));
    expect(compiled.report.carried.some((c) => c.field === "an interrupt that leads to the current node" && /crm_node\.treeNode/.test(c.enforce))).toBe(true);
  });

  it("speaks no tree line as written: every line is guidance in its node's task message, with single-brace placeholders", () => {
    const yaml = toFlowYaml(compiled);
    // Live words always: no text to speech action anywhere, for any line.
    for (const n of compiled.nodes) for (const a of [...n.preActions, ...n.postActions]) expect(a.type, n.key).not.toBe("tts_say");
    expect(yaml).not.toContain("tts_say");
    // Every node opens in the model's own words on entry, except the outbound start whose question the harness's opening asked.
    for (const n of compiled.nodes) expect(n.respondImmediately, n.key).toBe(!(n.key === tree.starts.outbound && harnessSaidLine(tree)));
    expect(yaml).not.toContain("{{");
    const placeholders = new Set(tree.nodes.flatMap((n) => (n.agentLines ?? []).flatMap((l) => [...l.line.matchAll(/\{\w+\}/g)].map((m) => m[0]))));
    for (const p of placeholders) expect(yaml).toContain(p);
    for (const n of tree.nodes) {
      if (MORE_RE.test(n.id)) continue;
      const flow = byKey.get(n.id)!;
      const line = n.agentLines?.[0];
      if (n.id === tree.starts.outbound && harnessSaidLine(tree)) {
        // Said by the harness, not by the model: no guidance to speak, the line rides as data and in the wait instruction.
        expect(lineOf(flow)).toBeUndefined();
        expect(taskOf(flow)).toContain(outboundOpeningAsked(harnessSaidLine(tree)!));
        expect(taskOf(flow)).not.toContain(GUIDANCE_LEAD);
        expect(nodeData(flow).guidance).toEqual({ text: line!.line, source: "agentLines", direction: "outbound", saidByHarness: true });
        continue;
      }
      expect(lineOf(flow)).toBe(line?.line);
      if (line) {
        expect(taskOf(flow), n.id).toContain(guidanceFor(line.line));
        expect(nodeData(flow).guidance).toEqual({ text: line.line, source: "agentLines", ...(line.direction ? { direction: line.direction } : {}) });
      } else {
        expect(taskOf(flow), n.id).not.toContain(GUIDANCE_LEAD);
        expect(nodeData(flow).guidance).toBeUndefined();
      }
    }
    // No line in the YAML is a word for word instruction any more.
    expect(yaml).not.toMatch(/word for word: /);
  });

  it("puts every tree line, as guidance, in the task message of the node the line is said on", () => {
    // Lines left out on purpose: a line said only to a confirmed known lead (the engine's variant), a folded follow-up's own lines and clarifying line (the follow-up is never entered;
    // kept in crm_node.folded), a resume answer's line (it has no node: the interrupt handler's result carries it), and
    // the outbound start's outbound line (the harness's outbound opening says it; checked in the next test).
    const expected: Array<{ line: string; node: string; what: string }> = [];
    for (const n of tree.nodes) {
      if (!MORE_RE.test(n.id)) for (const l of n.agentLines ?? []) if (!l.confirmedLead && !(n.id === tree.starts.outbound && l.line === harnessSaidLine(tree))) expected.push({ line: l.line, node: n.id, what: `${n.id}.agentLines` });
      const fn = fnOf(treeNodeFor(n.id));
      for (const a of n.decision!.answers) {
        if (a.say && !a.resume && (a.next || a.disposition) && !isMoreLink(a)) expected.push({ line: a.say, node: caseOf(fn, a.answer)!.target, what: `${n.id}.${a.answer}.say` });
        if (a.onBlocked?.say) expected.push({ line: a.onBlocked.say, node: caseOf(fn, `${a.answer}${BLOCKED_SUFFIX}`)!.target, what: `${n.id}.${a.answer}.onBlocked.say` });
      }
      if (n.escalation) expected.push({ line: n.escalation.say, node: (nodeData(treeNodeFor(n.id)).escalation as { node: string }).node, what: `${n.id}.escalation.say` });
    }
    for (const a of routedInterrupts(tree)) {
      if (a.say) expected.push({ line: a.say, node: caseOf(interruptFn(), a.answer)!.target, what: `interrupts.${a.answer}.say` });
      if (a.onBlocked?.say) expected.push({ line: a.onBlocked.say, node: caseOf(interruptFn(), `${a.answer}${BLOCKED_SUFFIX}`)!.target, what: `interrupts.${a.answer}.onBlocked.say` });
    }
    const data = byKey.get(tree.starts.inbound)!.preActions.find((a) => a.type === "crm_tree")!;
    expected.push({ line: tree.escalation.say, node: (data.escalation as { node: string }).node, what: "escalation.say" });
    expected.push({ line: tree.repeatRule.say, node: (data.repeatRule as { node: string }).node, what: "repeatRule.say" });
    for (const e of expected) {
      const node = byKey.get(e.node)!;
      expect(node, e.what).toBeDefined();
      expect(taskOf(node), e.what).toContain(guidanceFor(e.line));
      expect(lineOf(node), e.what).toBe(e.line);
    }
    // Nothing else: every node with a guidance line is one of the above.
    const withGuidance = compiled.nodes.filter((n) => n.guidance).map((n) => n.key);
    expect(new Set(withGuidance)).toEqual(new Set(expected.map((e) => e.node)));
    for (const n of compiled.nodes) if (!n.guidance) expect(taskOf(n), n.key).not.toContain(GUIDANCE_LEAD);
  });

  it("tells both start nodes, and their copies, that the harness has already said the disclosure; the inbound start opens at once, the outbound start waits when the harness asked its question", () => {
    const startIds = new Set([tree.starts.inbound, tree.starts.outbound]);
    const words = disclosureWords(tree);
    // The words the flow quotes are the ones the harness speaks first (src/decision/engine.ts, open).
    expect(words.inbound).toBe(inboundOpeningScript());
    expect(outboundOpeningScript(harnessSaidLine(tree)).startsWith(words.outbound)).toBe(true);
    expect(words.outbound).toBe(outboundDisclosure(harnessSaidLine(tree)));
    for (const start of startIds) expect(byKey.get(start)!.preActions.find((a) => a.type === "crm_tree")!.disclosure, start).toEqual(words);
    for (const n of compiled.nodes) {
      if (n.origin.kind === "ending") {
        expect(taskOf(n)).not.toContain("compliance disclosure");
        continue;
      }
      const afterDisclosure = startIds.has(n.origin.treeId);
      const done = disclosureDone(n.origin.treeId === tree.starts.inbound ? words.inbound : words.outbound);
      expect(taskOf(n).includes(done), n.key).toBe(afterDisclosure);
      expect(taskOf(n).includes(DISCLOSURE_LEAVE_OUT), n.key).toBe(afterDisclosure);
      // The exact words already spoken, and each part of the tree node that asks for the disclosure named as done:
      // the goal, the disclosure sentences in the guidance line, and the never-say item about what comes before them.
      if (afterDisclosure) {
        for (const part of [
          "already said the opening compliance disclosure in full, word for word, just before this step",
          "the goal's part about saying the disclosures",
          "the disclosure sentences in any line below",
          "any never-say item about what comes before the disclosure sentences",
          "Do not say the disclosure again",
          "Carry on with the rest of this step's goal in your own natural words.",
        ])
          expect(taskOf(n), n.key).toContain(part);
      }
      expect(nodeData(n).disclosureSaidByHarness, n.key).toBe(afterDisclosure ? true : undefined);
      // Right after the guidance line, not one generic sentence elsewhere.
      if (afterDisclosure && n.guidance) expect(taskOf(n), n.key).toContain(`${guidanceFor(n.guidance)} ${DISCLOSURE_IN_LINE}`);
    }
    // The inbound start's line words the disclosure differently from the harness, so the rule names what to drop, not the words.
    const greeting = byKey.get(tree.starts.inbound)!;
    expect(taskOf(greeting)).toContain(`"${inboundOpeningScript()}"`);
    expect(DISCLOSURE_LEAVE_OUT).toMatch(/artificial intelligence assistant.*recorded.*however it is worded/);
    // The known-lead start (starts.knownLead) is not compiled yet: the flow compiler thread adds it.
    for (const [direction, id] of Object.entries(tree.starts).filter(([d]) => d !== "knownLead")) {
      const start = byKey.get(id)!;
      expect(nodeData(start).start).toBe(direction);
      // The inbound disclosure asks nothing, so the inbound start speaks at once after it. The outbound opening is the
      // disclosure followed by the outbound start's line, which asks its question, so that node waits for the caller.
      const asked = direction === "outbound" ? harnessSaidLine(tree) : undefined;
      expect(start.respondImmediately, id).toBe(!asked);
      // The instruction comes before the guidance line or the wait instruction.
      const next = asked ? outboundOpeningAsked(asked) : start.guidance ? GUIDANCE_LEAD : "Open this step";
      expect(taskOf(start).indexOf(DISCLOSURE_LEAVE_OUT)).toBeLessThan(taskOf(start).indexOf(next));
    }
    // Without an outbound line, the outbound opening is the disclosure alone, so the outbound start opens at once too.
    const bare = structuredClone(rawTree);
    for (const n of bare.nodes) if (n.id === bare.starts.outbound) n.agentLines = (n.agentLines ?? []).filter((l) => l.direction !== "outbound");
    const bareStart = compileTreeToFlow(validateDecisionTree(bare)).nodes.find((n) => n.key === bare.starts.outbound)!;
    expect(bareStart.respondImmediately).toBe(true);
    expect(taskOf(bareStart)).toContain(disclosureDone(OUTBOUND_DISCLOSURE));
    expect(compiled.report.departures.join("\n")).toMatch(/inbound start responds at once/);
    expect(compiled.report.departures.join("\n")).toMatch(/outbound start waits for the caller/);
  });

  it("is self-contained: no includes, no repository paths, no anchors, aliases or tags", () => {
    const body = toFlowYaml(compiled).split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const line of body) {
      expect(line).not.toMatch(/(^|[:\-]\s+)[&*!]/);
      expect(line).not.toMatch(/\b(src|scripts|tests|docs)\/|\.\.\/|\.(ya?ml|json|py|ts)"/);
    }
    // Comments too: nothing a reader would follow to a file in this repository.
    expect(toFlowYaml(compiled)).not.toMatch(/\b(src|scripts)\//);
  });

  it("carries escalation, repeat key, minimum confidence, resume and the tree's own rules as data", () => {
    for (const n of tree.nodes) {
      if (MORE_RE.test(n.id)) continue;
      const flow = byKey.get(n.id)!;
      const meta = flow.preActions.find((a) => a.type === "crm_node")!;
      expect(meta.treeNode).toBe(n.id);
      expect(meta.repeatKey).toBe(n.repeatKey);
      if (n.escalation) expect(meta.escalation).toMatchObject(n.escalation);
    }
    // Every answer the root decides, follow-ups included, with the tree's own values.
    for (const n of tree.nodes) {
      const answers = treeNodeFor(n.id).preActions.find((a) => a.type === "crm_answers")!.answers as Array<Record<string, unknown>>;
      for (const a of n.decision!.answers) {
        if (a.answer === "unclear" || isMoreLink(a)) continue;
        const data = answers.find((x) => x.answer === a.answer)!;
        expect(data, `${n.id}.${a.answer}`).toBeDefined();
        expect(data.minConfidence, `${n.id}.${a.answer}`).toBe(a.minConfidence);
        expect(data.carry, `${n.id}.${a.answer}`).toBe(a.carry ? true : undefined);
        expect(data.extract, `${n.id}.${a.answer}`).toEqual(a.extract);
        expect(data.from, `${n.id}.${a.answer}`).toBe(MORE_RE.test(n.id) ? n.id : undefined);
      }
    }
    for (const [id, d] of [...byKey].filter(([, x]) => x.origin.kind === "tree")) {
      const answers = d.preActions.find((a) => a.type === "crm_answers")!.answers as unknown[];
      const own = [id, ...Object.keys(compiled.report.folded).filter((f) => foldRoot(f) === id)];
      const expected = own.flatMap((x) => tree.byId.get(x)!.decision!.answers).filter((a) => a.answer !== "unclear" && !isMoreLink(a));
      expect(answers, id).toHaveLength(expected.length);
    }
    for (const start of [tree.starts.inbound, tree.starts.outbound]) {
      const data = byKey.get(start)!.preActions.find((a) => a.type === "crm_tree")!;
      expect(data.maxClarifications).toBe(tree.maxClarifications);
      expect(byKey.has((data.escalation as { node: string }).node)).toBe(true);
      expect(byKey.has((data.repeatRule as { node: string }).node)).toBe(true);
      // Each resume answer's line rides with it.
      const interrupts = (data.interrupts as { answers: Array<Record<string, unknown>> }).answers;
      for (const a of tree.interrupts.answers) {
        const carried = interrupts.find((x) => x.answer === a.answer)!;
        expect(carried.resume, a.answer).toBe(a.resume ? true : undefined);
        expect(carried.say, a.answer).toBe(a.say);
      }
    }
    const carried = compiled.report.carried.map((c) => c.field).join("\n");
    for (const field of ["escalation", "repeatRule", "repeatKey", "maxClarifications", "carry", "extract", "minConfidence", "resume", "an interrupt that leads to the current node"]) expect(carried).toContain(field);
    const lost = compiled.report.lost.map((c) => c.field).join("\n");
    for (const field of ["other", "cues", "handoffTriggers", "sources", "closesGaps", "crmEquivalent"]) expect(lost).toContain(field);
  });

  it("is deterministic", () => {
    expect(toFlowYaml(compileTreeToFlow(tree))).toBe(toFlowYaml(compiled));
  });
});

describe("the committed flow", () => {
  it("matches the committed full-tree.flow.yaml byte for byte", () => {
    expect(readFileSync(FLOW_FILE, "utf8")).toBe(toFlowYaml(realCompiled));
  });
});

describe("the changed copy of the full tree", () => {
  const byKey = new Map(changedCompiled.nodes.map((n) => [n.key, n]));
  const interrupt = changedCompiled.globalFunctions[0]!;

  it("compiles each change: the added answer, the resume answer and the moved interrupt target", () => {
    expect(JSON.parse(readFileSync(TREE_FILE, "utf8"))).toEqual(rawTree);
    const grownFn = byKey.get(changed.grown)!.functions[0]!;
    expect(caseOf(grownFn, changed.added.answer)!.target).toBe(`${changed.added.next}.via.${changed.added.answer}`);
    expect(changedCompiled.report.counts.sayCopies).toBe(realCompiled.report.counts.sayCopies + 1);
    expect(changedCompiled.report.counts.branchCases).toBe(realCompiled.report.counts.branchCases + 1 - 1 - (isGated(realTree.interrupts.answers.find((a) => a.answer === changed.resumed)!) ? 1 : 0));
    // Resume: no case, so the flow stays; the answer is still offered to the language model.
    expect(caseOf(interrupt, changed.resumed)).toBeUndefined();
    expect(changedCompiled.handlers.find((h) => h.name === INTERRUPT_FUNCTION)!.answers).toContain(changed.resumed);
    expect(caseOf(interrupt, changed.moved)!.target).toBe(changed.newTarget);
    expect(byKey.get(changed.newTarget)!.taskMessages[0]!.content).toContain(`Do not call ${INTERRUPT_FUNCTION} with "${changed.moved}" here`);
    expect(byKey.get(changed.oldTarget)!.taskMessages[0]!.content).not.toContain(`"${changed.moved}" here`);
  });
});

describe("folding follow-up nodes", () => {
  function withFollowUp(answers: TreeAnswer[]): DecisionTree {
    const t: DecisionTreeData = minimalTree();
    const root = t.nodes.find((n) => n.id === "entry.inbound")!;
    root.decision!.answers.push({ answer: "other", meaning: "Something else.", minConfidence: 0.6, next: "entry.inbound_more2", carry: true });
    t.nodes.push({ ...root, id: "entry.inbound_more2", label: "More", decision: { question: "Which of these?", answers: [{ answer: "unclear", minConfidence: 0 }, ...answers] } });
    return { ...t, byId: new Map(t.nodes.map((n) => [n.id, n])) };
  }

  it("joins the follow-up's answers to the root and drops the other link", () => {
    const c = compileTreeToFlow(withFollowUp([{ answer: "wrong_number", meaning: "Wrong number.", minConfidence: 0.7, next: "booking.offer" }]));
    const root = c.nodes.find((n) => n.key === "entry.inbound")!;
    expect(root.functions[0]!.cases.map((x) => x.answer)).toContain("wrong_number");
    expect(root.functions[0]!.cases.map((x) => x.answer)).not.toContain("other");
    expect(c.nodes.some((n) => n.key === "entry.inbound_more2")).toBe(false);
    expect(c.handlers.find((h) => h.treeId === "entry.inbound")!.answers.filter((a) => a === "unclear")).toHaveLength(1);
  });

  it("fails when a folded answer name collides", () => {
    expect(() => compileTreeToFlow(withFollowUp([{ answer: "returning_missed_calls", meaning: "Again.", minConfidence: 0.7, next: "booking.offer" }]))).toThrow(FlowCompileError);
  });

  it("fails when a follow-up is entered other than through an other answer", () => {
    const t = withFollowUp([{ answer: "wrong_number", meaning: "Wrong number.", minConfidence: 0.7, next: "booking.offer" }]);
    t.interrupts.answers.find((a) => a.answer === "asks_for_person")!.next = "entry.inbound_more2";
    expect(() => compileTreeToFlow(t)).toThrow(/other than through/);
  });
});

const pythonPath = process.env.CRM_PIPECAT_PYTHON?.trim();
describe.skipIf(!pythonPath)("the compiled flow in the pinned Pipecat", () => {
  const dir = mkdtempSync(join(tmpdir(), "tree-flow-"));
  const changedTreeFile = join(dir, "changed-tree.json");
  const changedFlowFile = join(dir, "changed.flow.yaml");
  writeFileSync(changedTreeFile, JSON.stringify(changed.data));
  writeFileSync(changedFlowFile, toFlowYaml(changedCompiled));
  const run = (flowFile = FLOW_FILE) => spawnSync(pythonPath!, ["-I", CHECK_SCRIPT, flowFile, TREE_FILE], { encoding: "utf8", timeout: 60_000 });

  interface Probe {
    node: string;
    function: string;
    answer: string;
  }
  interface Called extends Probe {
    result: Record<string, string>;
    next: string | null;
  }
  const callTools = (flowFile: string, treeFile: string, probes: Probe[]): Called[] => {
    const file = join(dir, `probes-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(probes));
    return JSON.parse(execFileSync(pythonPath!, ["-I", CALL_SCRIPT, flowFile, treeFile, file], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] })) as Called[];
  };

  it.each([
    ["the full tree", FLOW_FILE, TREE_FILE, realCompiled],
    ["the changed copy", changedFlowFile, changedTreeFile, changedCompiled],
  ])("loads %s with FlowConfig.from_yaml, builds a Flow, and puts the answer enum on every decision function", (_label, flowFile, treeFile, compiled) => {
    const out = execFileSync(pythonPath!, ["-I", CHECK_SCRIPT, flowFile, treeFile], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    const summary = JSON.parse(out) as {
      nodeCount: number;
      initialNode: string;
      maxToolsAtOneNode: number;
      handlers: CompiledFlow["handlers"];
      caseKeys: Record<string, string[]>;
      tools: Record<string, { description: string; parameters: { properties: Record<string, { type?: string; enum?: string[] }>; required: string[] } }>;
      schemaValidation: { ran: boolean; why?: string; errors?: string[]; keyCheckErrors: string[] };
      schemasMissingEnum: string[];
      schemaCount: number;
    };
    expect(summary.schemasMissingEnum).toEqual([]);
    expect(summary.schemaCount).toBe(compiled.report.counts.functionEntries + 1);
    expect(summary.nodeCount).toBe(compiled.nodes.length);
    expect(summary.initialNode).toBe(compiled.initialNode);
    expect(summary.maxToolsAtOneNode).toBe(compiled.report.counts.maxToolsAtOneNode);
    // The Python handlers are built from the tree with the same rules as the compiler.
    expect(summary.handlers).toEqual(compiled.handlers);
    for (const h of compiled.handlers) {
      const tool = summary.tools[h.name]!;
      expect(tool, h.name).toBeDefined();
      expect(tool.parameters.properties.answer).toMatchObject({ type: "string", enum: h.answers });
      expect(tool.parameters.required).toContain("answer");
      expect(tool.description).toBe(h.doc.split("\n\nArgs:")[0]);
    }
    // Case keys load as the answer names, never as YAML booleans (a bare yes or no).
    const fns = new Map<string, CompiledFunction>();
    for (const f of [...compiled.globalFunctions, ...compiled.nodes.flatMap((n) => n.functions)]) if (!fns.has(f.name)) fns.set(f.name, f);
    for (const [name, f] of fns) expect(summary.caseKeys[name], name).toEqual(f.cases.map((c) => c.answer).sort());
    expect(summary.schemaValidation.keyCheckErrors).toEqual([]);
    if (summary.schemaValidation.ran) expect(summary.schemaValidation.errors).toEqual([]);
    else {
      expect(summary.schemaValidation.why).toMatch(/jsonschema/);
      // Only the key check ran: no types, no enums. Say so, and fail when asked to.
      console.warn(`full schema validation of the compiled flow did not run: ${summary.schemaValidation.why} (${pythonPath}); only required and extra keys were checked`);
      expect(process.env.CRM_REQUIRE_SCHEMA_VALIDATION?.trim() || "", "CRM_REQUIRE_SCHEMA_VALIDATION is set but jsonschema is missing").toBe("");
    }
  }, 90_000);

  it("ignores an interrupt that leads to the tree node the call is on, copies included, and nowhere else", () => {
    const interrupt = realCompiled.globalFunctions[0]!;
    const pairs = realTree.interrupts.answers.filter((a) => a.next).map((a) => [a.answer, a.next!] as const);
    const probes: Probe[] = [];
    for (const [answer, target] of pairs) {
      // The target itself and every copy of it.
      for (const n of realCompiled.nodes) if (n.origin.kind !== "ending" && n.origin.treeId === target) probes.push({ node: n.key, function: INTERRUPT_FUNCTION, answer });
    }
    const copies = probes.filter((p) => p.node.includes(".via.") || p.node.includes(".blocked."));
    expect(copies.length, "the full tree has a copy of an interrupt target to probe").toBeGreaterThan(0);
    // Elsewhere the same interrupt still moves the call.
    const elsewhere = realCompiled.nodes.find((n) => n.origin.kind === "tree" && !pairs.some(([, t]) => t === (n.origin as { treeId: string }).treeId))!;
    const moving = pairs.map(([answer]) => ({ node: elsewhere.key, function: INTERRUPT_FUNCTION, answer }));
    // At a target, the node's own decision still moves the call.
    const target = realCompiled.nodes.find((n) => n.key === pairs[0]![1])!;
    const own = { node: target.key, function: fnOf(target).name, answer: fnOf(target).cases[0]!.answer };
    const out = callTools(FLOW_FILE, TREE_FILE, [...probes, ...moving, own]);
    const caseKeys = new Set(interrupt.cases.map((c) => c.answer));
    for (const r of out.slice(0, probes.length)) {
      const here = realCompiled.nodes.find((n) => n.key === r.node)!.origin as { treeId: string };
      expect(r.next, `${r.node} ${r.answer}`).toBeNull();
      expect(caseKeys.has(r.result.answer!), r.result.answer).toBe(false);
      expect(r.result.ignoredInterrupt).toBe(r.answer);
      expect(r.result.instruction).toContain(`call ${functionNameFor(here.treeId)} now`);
    }
    for (const r of out.slice(probes.length, probes.length + moving.length)) {
      expect(r.next, `${r.node} ${r.answer}`).toBe(caseOf(interrupt, r.answer)!.target);
      expect(r.result).toEqual({ answer: r.answer });
    }
    expect(out.at(-1)!.next).toBe(fnOf(target).cases[0]!.target);
  }, 90_000);

  it("stays on the current node after a resume answer and tells the language model to say its line, then ask the step's question again", () => {
    const start = changedCompiled.nodes.find((n) => n.key === changed.tree.starts.inbound)!;
    const copy = changedCompiled.nodes.find((n) => n.origin.kind === "via" || n.origin.kind === "blocked")!;
    const outboundStart = changedCompiled.nodes.find((n) => n.key === changed.tree.starts.outbound)!;
    const resumedAt = [start, outboundStart, copy];
    const probes: Probe[] = resumedAt.map((n) => ({ node: n.key, function: INTERRUPT_FUNCTION, answer: changed.resumed }));
    // The moved target is now the one an interrupt to itself is ignored at.
    probes.push({ node: changed.newTarget, function: INTERRUPT_FUNCTION, answer: changed.moved });
    const out = callTools(changedFlowFile, changedTreeFile, probes);
    for (const r of out.slice(0, resumedAt.length)) {
      const base = changed.tree.byId.get((changedCompiled.nodes.find((n) => n.key === r.node)!.origin as { treeId: string }).treeId)!;
      expect(r.next, r.node).toBeNull();
      expect(r.result.answer).toBe(changed.resumed);
      expect(r.result.say).toBe(changed.resumeSay);
      expect(r.result.instruction).toContain(`${GUIDANCE_LEAD} "${changed.resumeSay}"`);
      expect(r.result.instruction).not.toContain("word for word");
      const atStart = base.id === changed.tree.starts.inbound || base.id === changed.tree.starts.outbound;
      expect(r.result.instruction.includes("do not say it again"), r.node).toBe(atStart);
      // At a start node: the exact words already spoken, and which sentences of the line to ask again to leave out.
      expect(r.result.instruction.includes(DISCLOSURE_LEAVE_OUT), r.node).toBe(atStart);
      if (atStart) expect(r.result.instruction, r.node).toContain(`"${base.id === changed.tree.starts.inbound ? inboundOpeningScript() : outboundDisclosure(harnessSaidLine(changed.tree))}"`);
      // The base node's own fixed line, or its clarifying line, as the engine asks again; never the copy's line.
      expect(r.result.instruction).toContain(base.agentLines?.[0]?.line || base.clarify!);
      expect(r.result.instruction).toContain(oneLine(base.decision!.question));
    }
    expect(out[resumedAt.length]!.next).toBeNull();
    expect(out[resumedAt.length]!.result.ignoredInterrupt).toBe(changed.moved);
  }, 90_000);

  it("ignores every interrupt at an ending, whose end frame is already queued", () => {
    const interrupt = realCompiled.globalFunctions[0]!;
    const endings = realCompiled.nodes.filter((n) => n.origin.kind === "ending");
    const routed = interrupt.cases.map((c) => c.answer).filter((a) => !a.endsWith(BLOCKED_SUFFIX));
    const probes: Probe[] = endings.flatMap((e) => routed.map((answer) => ({ node: e.key, function: INTERRUPT_FUNCTION, answer })));
    const out = callTools(FLOW_FILE, TREE_FILE, probes);
    const caseKeys = new Set(interrupt.cases.map((c) => c.answer));
    for (const r of out) {
      expect(r.next, `${r.node} ${r.answer}`).toBeNull();
      expect(caseKeys.has(r.result.answer!), r.result.answer).toBe(false);
      expect(r.result.ignoredInterrupt).toBe(r.answer);
      expect(r.result.instruction).toMatch(/call is ending.*only speak the closing words/);
    }
  }, 90_000);

  it("refuses a flow with a missing target, a missing global target, a missing default or a function with no handler", () => {
    const yaml = readFileSync(FLOW_FILE, "utf8");
    const q = JSON.stringify;
    const firstNodeFn = realCompiled.nodes.find((n) => n.functions.length)!.functions[0]!;
    const nodeCase = `${q(firstNodeFn.cases[0]!.answer)}: ${q(firstNodeFn.cases[0]!.target)}`;
    expect(yaml).toContain(nodeCase);
    const missing = join(dir, "missing.yaml");
    writeFileSync(missing, yaml.replace(nodeCase, `${q(firstNodeFn.cases[0]!.answer)}: "open.nowhere"`));
    const a = run(missing);
    expect(a.status).toBe(1);
    expect(JSON.parse(a.stdout).refused.join("\n")).toMatch(/missing node 'open.nowhere'/);
    const unhandled = join(dir, "unhandled.yaml");
    const nameLine = `- "name": ${q(firstNodeFn.name)}`;
    expect(yaml).toContain(nameLine);
    writeFileSync(unhandled, yaml.replace(nameLine, `- "name": "decide_nothing"`));
    const b = run(unhandled);
    expect(b.status).toBe(1);
    expect(JSON.parse(b.stdout).refused.join("\n")).toMatch(/'decide_nothing' has no handler/);
    const start = join(dir, "start.yaml");
    const initial = `"initial_node": ${q(realCompiled.initialNode)}`;
    expect(yaml).toContain(initial);
    writeFileSync(start, yaml.replace(initial, `"initial_node": "open.nowhere"`));
    const c = run(start);
    expect(c.status).toBe(1);
    expect(JSON.parse(c.stdout).refused.join("\n")).toMatch(/initial_node 'open.nowhere' is not a node/);
    const globalTarget = join(dir, "global.yaml");
    const globalCase = realCompiled.globalFunctions[0]!.cases[0]!;
    // The global functions come first in the file, so the first match is the interrupt's own case.
    const globalLine = `${q(globalCase.answer)}: ${q(globalCase.target)}`;
    expect(yaml.indexOf(globalLine)).toBeLessThan(yaml.indexOf(`"nodes":`));
    writeFileSync(globalTarget, yaml.replace(globalLine, `${q(globalCase.answer)}: "open.nowhere"`));
    const d = run(globalTarget);
    expect(d.status).toBe(1);
    expect(JSON.parse(d.stdout).refused.join("\n")).toMatch(/global_functions function 'interrupt' points at missing node 'open.nowhere'/);
    const fallback = join(dir, "default.yaml");
    const branch = `      ${nameLine}\n        "transition_to":\n          "field": "answer"\n`;
    expect(yaml).toContain(branch);
    writeFileSync(fallback, yaml.replace(branch, `${branch}          "default": "open.nowhere"\n`));
    const e = run(fallback);
    expect(e.status).toBe(1);
    expect(JSON.parse(e.stdout).refused.join("\n")).toMatch(new RegExp(`'${firstNodeFn.name}' points at missing node 'open.nowhere'`));
  }, 90_000);
});
