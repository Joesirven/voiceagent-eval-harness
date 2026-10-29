/**
 * Checks a decision tree before any call uses it. Returns every problem, not
 * the first, so one run of the validator test shows the whole list.
 */

import { ACTION_TYPES, AREAS, BUILT_IN_VARIABLES, COLLECTED_VALUES, QUOTE_FIELDS, type DecisionTree, type DecisionTreeData, type TreeAnswer, type TreeNode } from "./types.js";

/** More answers than this spreads the module's probability so thin the top answer rarely clears its bar. */
export const MAX_ANSWERS = 8;
/** Below this a typed answer is barely better than a coin (CRM's Jev backtest, docs/jev-sites.md). */
export const MIN_BAR = 0.6;
/** A durable ending takes the lead off the list; CRM asks Jev for 0.85 before a no. */
export const DURABLE_BAR = 0.85;
/** The inbound entry must recognize a lead returning the two unanswered calls by this answer name. */
export const CALLBACK_ANSWER = "returning_missed_calls";

/**
 * Abbreviations the context pack uses that must be spelled out in anything
 * the agent says or the tree explains (Dana's standing language rule).
 */
const ACRONYMS = ["GL", "COI", "COIs", "WC", "SDR", "DM", "CSLB", "FEIN", "TCPA", "DNC", "IRPM", "BOP", "LLC", "PR", "CI", "KB", "ASAP", "FYI", "ETA"];
const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join("|")})\\b`);
/** A spoken price, a saving or a percentage: the agent never states one. */
const PRICE_RE = /\$\s?\d|\b\d[\d,.]*\s?(dollars|bucks|percent|%)/i;
const ID_RE = /^[a-z]+(\.[a-z0-9_]+)+$/;

export class DecisionTreeError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid decision tree (${problems.length} problems): ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; ..." : ""}`);
  }
}

const isGated = (a: TreeAnswer) => Boolean(a.action || a.disposition);

/** Every problem with the tree, in plain words. Empty when the tree is sound. */
export function treeProblems(raw: unknown): string[] {
  const problems: string[] = [];
  const t = (raw ?? {}) as Partial<DecisionTreeData>;
  const nodes: TreeNode[] = Array.isArray(t.nodes) ? t.nodes : [];
  if (!nodes.length) return ["the tree has no nodes"];

  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    if (!n?.id || !ID_RE.test(n.id)) problems.push(`node id ${String(n?.id)} is not "area.short_name"`);
    else if (byId.has(n.id)) problems.push(`duplicate node ${n.id}`);
    else byId.set(n.id, n);
  }
  const dispositions = Array.isArray(t.dispositions) ? t.dispositions : [];
  const dispositionByName = new Map(dispositions.map((d) => [d.name, d]));
  for (const d of dispositions) {
    if (!d.label || !d.meaning) problems.push(`disposition ${d.name} needs a label and a meaning`);
    if (typeof d.durable !== "boolean") problems.push(`disposition ${d.name} must say whether it is durable`);
    if (!d.crmEquivalent) problems.push(`disposition ${d.name} needs crmEquivalent (a CRM disposition, or "none: why")`);
  }
  if (dispositionByName.size !== dispositions.length) problems.push("a disposition name is repeated");

  // Variables any line may fill: built-ins plus every extract target in the tree.
  const variables = new Set<string>(BUILT_IN_VARIABLES);
  const timeVariables = new Set<string>();
  const allAnswers: Array<{ where: string; a: TreeAnswer }> = [];
  for (const n of nodes) for (const a of n.decision?.answers ?? []) allAnswers.push({ where: `${n.id}.${a.answer}`, a });
  for (const a of t.interrupts?.answers ?? []) allAnswers.push({ where: `interrupts.${a.answer}`, a });
  for (const { a } of allAnswers) {
    if (a.extract?.as) {
      variables.add(a.extract.as);
      if (a.extract.with === "time") {
        variables.add(`${a.extract.as}Words`);
        timeVariables.add(a.extract.as);
      }
    }
  }

  const checkText = (where: string, text: string | undefined, spoken: boolean) => {
    if (!text) return;
    const acronym = ACRONYM_RE.exec(text);
    if (acronym) problems.push(`${where} uses the abbreviation "${acronym[1]}"; spell it out`);
    if (spoken && PRICE_RE.test(text)) problems.push(`${where} states a price, saving or percentage`);
    if (spoken && text.includes("—")) problems.push(`${where} uses an em-dash in a spoken line`);
    for (const m of text.matchAll(/\{(\w+)\}/g)) {
      if (!variables.has(m[1]!)) problems.push(`${where} uses {${m[1]}}, which nothing sets`);
    }
  };
  const needNode = (where: string, target: string | undefined) => {
    if (target !== undefined && !byId.has(target)) problems.push(`${where} points at missing node ${target}`);
  };
  const needDisposition = (where: string, name: string | undefined) => {
    if (name !== undefined && !dispositionByName.has(name)) problems.push(`${where} uses unknown disposition ${name}`);
  };

  const checkAnswer = (where: string, a: TreeAnswer) => {
    const bar = a.minConfidence;
    if (a.answer === "unclear") {
      if (bar !== 0) problems.push(`${where} must have minConfidence 0`);
      if (a.next || a.disposition || a.action || a.returnToOrigin) problems.push(`${where} must not route anywhere: it asks the clarifying line`);
      return;
    }
    if (a.returnToOrigin) {
      if (where.startsWith("interrupts.")) problems.push(`${where} uses returnToOrigin, which only node answers may use`);
      if (!a.next || a.disposition) problems.push(`${where} returns to where the call was and needs a next node to fall back on, and no disposition`);
    }
    if (!a.meaning?.trim()) problems.push(`${where} needs a meaning the decision module can read`);
    if (!(typeof bar === "number" && bar >= MIN_BAR && bar < 1)) problems.push(`${where} needs a minConfidence from ${MIN_BAR} up to but not including 1 (got ${String(bar)})`);
    if (a.resume) {
      if (!where.startsWith("interrupts.")) problems.push(`${where} uses resume, which only interrupts may use`);
      if (a.next || a.disposition || a.action) problems.push(`${where} resumes the current node, so it takes no next, disposition or action`);
      if (!a.say) problems.push(`${where} resumes the current node and needs a line to say first`);
    } else if (Boolean(a.next) === Boolean(a.disposition)) problems.push(`${where} needs exactly one of next or disposition`);
    needNode(`${where}.next`, a.next);
    if ((a.knownLeadNext || a.confirmedLeadNext) && (where.startsWith("interrupts.") || !a.next)) {
      problems.push(`${where} routes a known lead elsewhere, which only node answers with a next node may do`);
    }
    needNode(`${where}.knownLeadNext`, a.knownLeadNext);
    needNode(`${where}.confirmedLeadNext`, a.confirmedLeadNext);
    needDisposition(where, a.disposition);
    needNode(`${where}.onBlocked.next`, a.onBlocked?.next);
    if (a.action) {
      const act = a.action;
      if (!(ACTION_TYPES as readonly string[]).includes(act.type)) problems.push(`${where} has unknown action ${act.type}`);
      if (["save_quote_field", "save_details", "book"].includes(act.type) && !act.from) problems.push(`${where} ${act.type} needs a "from" variable`);
      if (act.from && !variables.has(act.from)) problems.push(`${where} reads {${act.from}}, which no extract sets`);
      if (act.type === "save_quote_field" && !(QUOTE_FIELDS as readonly string[]).includes(act.field ?? "")) problems.push(`${where} saves unknown quote field ${String(act.field)}`);
      if (act.type === "book" && !timeVariables.has(act.from ?? "")) problems.push(`${where} books from {${String(act.from)}}, which no time extract sets`);
      if (act.type === "send_text" && !act.body) problems.push(`${where} sends a text with no fixed body`);
      checkText(`${where}.action.body`, act.body, true);
    }
    if (isGated(a)) {
      if (!a.onBlocked?.say) problems.push(`${where} is judge-gated and needs onBlocked.say`);
      const j = a.judge;
      if (!j) problems.push(`${where} is judge-gated and needs a judge (code rules and a fast decision-module question)`);
      else {
        if (!j.codeRules?.length) problems.push(`${where}.judge needs at least one code rule`);
        if (!j.question?.trim()) problems.push(`${where}.judge needs a question`);
        if (!(j.minConfidence >= MIN_BAR && j.minConfidence < 1)) problems.push(`${where}.judge.minConfidence must be from ${MIN_BAR} up to but not including 1`);
      }
      const d = a.disposition ? dispositionByName.get(a.disposition) : undefined;
      if (d?.durable) {
        if (bar < DURABLE_BAR) problems.push(`${where} ends durably (${d.name}) and needs minConfidence of at least ${DURABLE_BAR}`);
        if (j && j.minConfidence < DURABLE_BAR) problems.push(`${where}.judge ends durably (${d.name}) and needs a judge bar of at least ${DURABLE_BAR}`);
      }
    }
    if (a.extract && !["year", "time", "caller_line"].includes(a.extract.with)) problems.push(`${where} has unknown extract kind ${a.extract.with}`);
    checkText(`${where}.say`, a.say, true);
    checkText(`${where}.onBlocked.say`, a.onBlocked?.say, true);
    checkText(`${where}.meaning`, a.meaning, false);
    checkText(`${where}.judge.question`, a.judge?.question, false);
  };

  for (const n of byId.values()) {
    const where = n.id;
    if (!(AREAS as readonly string[]).includes(n.area)) problems.push(`${where} has unknown area ${String(n.area)}`);
    if (!n.label?.trim()) problems.push(`${where} needs a label`);
    if (!n.situation?.trim() || !n.agentGoal?.trim()) problems.push(`${where} needs a situation and an agent goal`);
    if (!Array.isArray(n.sources) || !n.sources.length) problems.push(`${where} needs at least one source`);
    for (const [i, l] of (n.agentLines ?? []).entries()) checkText(`${where}.agentLines[${i}]`, l.line, true);
    checkText(`${where}.clarify`, n.clarify, true);
    checkText(`${where}.situation`, n.situation, false);
    checkText(`${where}.agentGoal`, n.agentGoal, false);
    needNode(`${where}.next`, n.next);
    if (n.collects) {
      const c = n.collects;
      if (!Array.isArray(c.values) || !c.values.length) problems.push(`${where}.collects needs at least one value`);
      for (const v of c.values ?? []) if (!(COLLECTED_VALUES as readonly string[]).includes(v)) problems.push(`${where}.collects has unknown value ${String(v)}`);
      for (const [v, line] of Object.entries(c.lines ?? {})) {
        if (!(c.values ?? []).includes(v as never)) problems.push(`${where}.collects.lines.${v} is not one of the values it collects`);
        checkText(`${where}.collects.lines.${v}`, line, true);
      }
      if (!c.then) problems.push(`${where}.collects needs a node to move on to`);
      else if (c.then === n.id) problems.push(`${where}.collects moves on to itself`);
      needNode(`${where}.collects.then`, c.then);
      if (!n.decision) problems.push(`${where} collects caller details and needs a question`);
    }
    if (n.asks) {
      if (!Array.isArray(n.asks) || !n.asks.length) problems.push(`${where}.asks needs at least one value`);
      else for (const v of n.asks) if (!(COLLECTED_VALUES as readonly string[]).includes(v)) problems.push(`${where}.asks has unknown value ${String(v)}`);
      if (n.collects) problems.push(`${where} has both asks and collects; collects already says what the line asks for`);
    }
    if (n.escalation) {
      if (!n.escalation.say?.trim()) problems.push(`${where}.escalation needs a line to say`);
      needDisposition(`${where}.escalation`, n.escalation.disposition);
      if (dispositionByName.get(n.escalation.disposition)?.durable) problems.push(`${where}.escalation must end with a non-durable disposition`);
      checkText(`${where}.escalation.say`, n.escalation.say, true);
      if (!n.decision) problems.push(`${where} has an escalation and no question`);
    }
    if (n.area === "objection" && n.decision && !n.repeatKey) problems.push(`${where} is an objection and needs a repeatKey`);
    if (!n.decision) {
      if (!n.next) problems.push(`${where} has no question and no next node`);
      if (!n.agentLines?.length) problems.push(`${where} has no question and nothing to say`);
      continue;
    }
    if (n.next) problems.push(`${where} has a question and also a next node`);
    const answers = n.decision.answers ?? [];
    if (!n.decision.question?.trim()) problems.push(`${where} has no question`);
    if (!n.clarify?.trim()) problems.push(`${where} has a question and needs a clarifying line`);
    checkText(`${where}.question`, n.decision.question, false);
    const names = answers.map((a) => a.answer);
    if (new Set(names).size !== names.length) problems.push(`${where} repeats an answer`);
    if (!names.includes("unclear")) problems.push(`${where} needs an "unclear" answer`);
    if (names.length < 3) problems.push(`${where} needs at least two real answers besides "unclear"`);
    if (names.length > MAX_ANSWERS) problems.push(`${where} has ${names.length} answers; at most ${MAX_ANSWERS}, counting "unclear"`);
    for (const a of answers) checkAnswer(`${where}.${a.answer}`, a);
  }

  // Top level.
  const starts = t.starts;
  if (!starts?.inbound || !starts?.outbound) problems.push("starts needs an inbound and an outbound node");
  needNode("starts.inbound", starts?.inbound);
  needNode("starts.outbound", starts?.outbound);
  needNode("starts.knownLead", starts?.knownLead);
  const knownLead = starts?.knownLead ? byId.get(starts.knownLead) : undefined;
  if (knownLead && !knownLead.decision) problems.push(`the known-lead start ${knownLead.id} needs a question: it confirms who is on the line`);
  if (t.start !== starts?.inbound) problems.push("start must equal starts.inbound");
  const inbound = starts?.inbound ? byId.get(starts.inbound) : undefined;
  if (inbound && !inbound.decision?.answers.some((a) => a.answer === CALLBACK_ANSWER)) {
    problems.push(`the inbound entry ${inbound.id} needs a "${CALLBACK_ANSWER}" answer for a lead calling back after the two unanswered calls`);
  }
  if (!Number.isInteger(t.maxClarifications) || (t.maxClarifications ?? 0) < 1) problems.push("maxClarifications must be a whole number of at least 1");
  if (!t.escalation?.say) problems.push("escalation needs a line to say");
  needDisposition("escalation", t.escalation?.disposition);
  checkText("escalation.say", t.escalation?.say, true);
  if (!t.repeatRule?.say) problems.push("repeatRule needs a line to say");
  needDisposition("repeatRule", t.repeatRule?.disposition);
  if (t.repeatRule?.disposition && dispositionByName.get(t.repeatRule.disposition)?.durable) {
    problems.push("repeatRule must end with a non-durable disposition: a repeated brush-off is not a refusal in the caller's words");
  }
  checkText("repeatRule.say", t.repeatRule?.say, true);
  const interrupts = t.interrupts;
  if (!interrupts?.question || !interrupts.clarify) problems.push("interrupts needs a question and a clarifying line");
  else {
    const names = interrupts.answers.map((a) => a.answer);
    if (!names.includes("none")) problems.push('interrupts needs a "none" answer: no interruption, carry on with the node');
    if (!names.includes("unclear")) problems.push('interrupts needs an "unclear" answer');
    if (names.length > MAX_ANSWERS) problems.push(`interrupts has ${names.length} answers; at most ${MAX_ANSWERS}`);
    for (const a of interrupts.answers) {
      if (a.answer === "none") {
        if (a.next || a.disposition || a.action) problems.push("interrupts.none must not route anywhere");
        if (!(a.minConfidence >= 0 && a.minConfidence < 1)) problems.push("interrupts.none needs a minConfidence below 1");
        continue;
      }
      checkAnswer(`interrupts.${a.answer}`, a);
    }
  }

  // Reachability: from every start and every interrupt target.
  const reached = new Set<string>();
  const queue = [starts?.inbound, starts?.outbound, starts?.knownLead, ...(interrupts?.answers ?? []).flatMap((a) => [a.next, a.onBlocked?.next])].filter(
    (id): id is string => typeof id === "string" && byId.has(id),
  );
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    const n = byId.get(id)!;
    for (const to of [n.next, n.collects?.then, ...(n.decision?.answers ?? []).flatMap((a) => [a.next, a.knownLeadNext, a.confirmedLeadNext, a.onBlocked?.next])]) {
      if (to && byId.has(to) && !reached.has(to)) queue.push(to);
    }
  }
  for (const id of byId.keys()) if (!reached.has(id)) problems.push(`${id} cannot be reached from either start or an interrupt`);

  // Every node can still end: some path reaches an answer with a disposition.
  const canEnd = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of byId.values()) {
      if (canEnd.has(n.id)) continue;
      const ends =
        (n.next && canEnd.has(n.next)) ||
        (n.collects?.then && canEnd.has(n.collects.then)) ||
        (n.decision?.answers ?? []).some((a) => a.disposition || (a.next && canEnd.has(a.next)));
      if (ends) {
        canEnd.add(n.id);
        grew = true;
      }
    }
  }
  for (const id of byId.keys()) if (!canEnd.has(id)) problems.push(`${id} has no path to an ending`);

  // Every disposition is used somewhere.
  const used = new Set<string>([t.escalation?.disposition, t.repeatRule?.disposition, ...nodes.map((n) => n.escalation?.disposition)].filter((x): x is string => Boolean(x)));
  for (const { a } of allAnswers) if (a.disposition) used.add(a.disposition);
  for (const d of dispositions) if (!used.has(d.name)) problems.push(`disposition ${d.name} is never used`);

  return problems;
}

/** The tree, checked and indexed. Throws `DecisionTreeError` listing every problem. */
export function validateDecisionTree(raw: unknown): DecisionTree {
  const problems = treeProblems(raw);
  if (problems.length) throw new DecisionTreeError(problems);
  const data = raw as DecisionTreeData;
  return { ...data, byId: new Map(data.nodes.map((n) => [n.id, n])) };
}
