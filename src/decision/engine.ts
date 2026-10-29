/**
 * The decision-tree engine for one call. Each caller line runs one step: the
 * decision module answers the current node's typed question; a low-confidence
 * or "unclear" answer routes to the clarifying line; a confident answer may
 * carry a judge-gated action and moves to the next node.
 *
 * Order inside a step, which never changes: a request to stop is honored first
 * and the tree is not consulted; only then does the tree run. The harness runs
 * every compliance check before the dialog exists and puts the disclosure first.
 */

import { callOpening, outboundDisclosureFirst, type CallOpening } from "../compliance/disclosures.js";
import { detectStopRequest, STOP_REPLY } from "../compliance/stop.js";
import { createInCallState, type InCallState } from "../memory/context.js";
import { guardedAction, type GateContext } from "../judge/gate.js";
import type { JudgeAction, JudgePayload, JudgeRequest } from "../judge/types.js";
import type { TranscriptTurn } from "../provider/interface.js";
import type { AgentLineContext, GuardedAgentLine } from "../harness/agent-line-guard.js";
import { emitTrace } from "../trace/events.js";
import type { DecisionRecorder } from "../trace/extensions.js";
import type { ActionPort } from "./actions.js";
import { extractCallerDetails, extractTime, extractYear, type CallerDetail } from "./extract.js";
import type { DecisionModuleRegistry } from "./registry.js";
import { knownLeadStart, startFor, type CollectedValue, type DecisionTree, type TreeAnswer, type TreeNode } from "./tree.js";
import type { DecisionRequest, LeadFacts } from "./types.js";
import type { Clock } from "../types/clock.js";

export interface TreeDialogDeps {
  tree: DecisionTree;
  decisions: DecisionModuleRegistry;
  gate: GateContext;
  actions: ActionPort;
  recorder: DecisionRecorder;
  direction: "inbound" | "outbound";
  firstName: string;
  timeZone: string;
  clock: Clock;
  /**
   * Optional: runs on every agent line before it is committed. Leaves the opening
   * disclosure alone. Missing means no guard.
   */
  guardLine?: (text: string, ctx: Pick<AgentLineContext, "direction" | "nodeId" | "turnIndex" | "isDisclosure">) => GuardedAgentLine;
  /** Outbound attempts to this lead that went unanswered, for recognizing a callback. */
  missedCalls?: number;
  /** What the lead record says (name, business), passed to the decision modules for comparison. */
  lead?: LeadFacts;
  /**
   * The opening the harness fixed for this call. Missing means the plain one
   * (`callOpening()`). With a confirmation question (a known lead) the call
   * starts at the tree's known-lead start, when the tree has one.
   */
  opening?: CallOpening;
}

export interface StepResult {
  reply: string;
  ended: boolean;
}

const MAX_CARRY = 2;
/** How many side trips deep the call remembers where to come back to. */
const MAX_ORIGINS = 4;

/** Thrown inside a step when the session ended during a wait; `step` turns it into an empty ended result. */
const STOPPED = Symbol("dialog_stopped");

/** A line asking for caller details, waiting for the caller's reply. */
interface PendingAsk {
  nodeId: string;
  values: CollectedValue[];
  /** True for the node's own line asking for every value together; false for the line asking for the one still missing. */
  together: boolean;
}

/** The node id the interrupt check is recorded under. */
export const INTERRUPTS_NODE_ID = "interrupts";

/** Only a finite number from 0 to 1 that reaches the bar counts; anything else is not confident. */
function confidentEnough(confidence: unknown, min: number): boolean {
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 && confidence >= min;
}

/** The meaning of each answer that has one; the model sees these, the keyword modules ignore them. */
function meaningsOf(answers: Array<{ answer: string; meaning?: string }>): Record<string, string> | undefined {
  const entries = answers.filter((a) => a.meaning?.trim()).map((a) => [a.answer, a.meaning!.trim()] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

/** The first half of a line, for the streaming "partial" event. */
function partOf(text: string): string {
  const words = text.split(/\s+/);
  return words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(" ");
}

let intendedLineMode = false;
/**
 * While on, a dialog built next records its agent lines as the reasoning
 * trace's "intended line" instead of as spoken transcript lines, because a
 * live voice model says its own words and the transcript must show those.
 */
export function setIntendedLineMode(on: boolean): void {
  intendedLineMode = on;
}

export class TreeDialog {
  private readonly intendedOnly = intendedLineMode;
  readonly inCall: InCallState = createInCallState();
  readonly transcript: TranscriptTurn[] = [];
  disposition: string | null = null;
  private current: string;
  private ended = false;
  private turnIndex = 0;
  private readonly vars: Record<string, string>;
  private readonly clarifyCounts = new Map<string, number>();
  private readonly completed: JudgeAction[] = [];
  private readonly objections = new Map<string, number>();
  private stopped = false;
  /** The nodes side trips left, newest last; an answer with returnToOrigin goes back to the newest. */
  private readonly origins: string[] = [];
  private pendingAsk: PendingAsk | null = null;
  /** Caller details asked for together, by the joined value names, once the caller has replied. */
  private readonly askedTogether = new Set<string>();
  /** Caller details asked for on their own, once the caller has replied. */
  private readonly askedAlone = new Set<CollectedValue>();
  /** The caller details each agent reply asked for, oldest first; a bare answer counts for the last two. */
  private readonly recentAsks: CollectedValue[][] = [];
  private replyAsks: CollectedValue[] = [];
  private readonly opening: CallOpening;
  /** The node the call starts at: the known-lead confirmation for a known lead, else the direction's entry. */
  private readonly entryId: string;
  private readonly knownLead: boolean;
  /** The known lead said yes at the known-lead start; a no there (a new speaker) clears it. */
  private leadConfirmed = false;

  constructor(private readonly deps: TreeDialogDeps) {
    this.opening = deps.opening ?? callOpening();
    const known = this.opening.confirm ? knownLeadStart(deps.tree) : undefined;
    this.knownLead = known !== undefined;
    this.entryId = known ?? startFor(deps.tree, deps.direction);
    this.current = this.entryId;
    this.vars = { firstName: deps.firstName };
  }

  get isEnded(): boolean {
    return this.ended || this.stopped;
  }

  /**
   * Marks an agent line as not said: the caller never heard it (cut off by
   * barge-in, or a decided line that reached the voice model too late). The
   * line stays in the transcript with `spoken: false`, so the decision models
   * (`buildState`) and the judges leave it out. `turnIndex` picks the line
   * (-1 is the opening disclosure); without it, the latest agent line. Returns
   * false when there is no such line. Emits an `agent_line_not_said` tool
   * trace when called inside the call's trace context.
   */
  markLineNotSaid(turnIndex?: number): boolean {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const turn = this.transcript[i]!;
      if (turn.role !== "agent" || (turnIndex !== undefined && turn.turnIndex !== turnIndex)) continue;
      turn.spoken = false;
      emitTrace("tool_call", { tool: "agent_line_not_said", inputs: { turnIndex: turn.turnIndex }, result: { text: turn.text }, success: true, durationMs: 0 });
      return true;
    }
    return false;
  }

  /**
   * Stops the dialog because the session ended (hang-up, closed socket).
   * Safe to call more than once, at any time. Afterwards `step` returns
   * `{ reply: "", ended: true }` without hearing the line, and a step already
   * waiting on a decision module or the judge, once its wait returns, says
   * nothing, enters no node, records no decision and runs no action. Never
   * throws.
   */
  stop(reason = "session_ended"): void {
    if (this.stopped) return;
    this.stopped = true;
    emitTrace("tool_call", { tool: "dialog_stopped", inputs: { reason, nodeId: this.current }, result: {}, success: true, durationMs: 0 });
  }

  /** Called after every wait inside a step: a stopped dialog does nothing more. */
  private checkStopped(): void {
    if (this.stopped) throw STOPPED;
  }

  /**
   * The call's disclosure, word for word, as the harness fixed it. For a known
   * lead, and on an outbound call, the entry node's line follows it on the same
   * turn (the confirmation question); an inbound caller nobody knows hears the
   * disclosure alone. Then waits at the first question.
   */
  async open(): Promise<string> {
    const entry = this.deps.tree.nodes[this.entryId]!;
    this.enter(entry);
    const line = this.knownLead || this.deps.direction === "outbound" ? fill(this.baseLine(entry), this.vars) : "";
    const disclosure = this.opening.disclosure.join(" ");
    // An entry line that already opens with the disclosure, word for word, is not given it twice.
    const opening = outboundDisclosureFirst(line, this.opening.disclosure) ? line : [disclosure, ...(line ? [line] : [])].join(" ");
    this.say(opening, -1);
    this.advanceThroughSpeakNodes();
    return opening;
  }

  async step(callerText: string): Promise<StepResult> {
    if (this.stopped) return { reply: "", ended: true };
    if (this.ended) throw new Error("call_ended");
    try {
      return await this.runStep(callerText);
    } catch (err) {
      if (err === STOPPED) return { reply: "", ended: true };
      throw err;
    }
  }

  private async runStep(callerText: string): Promise<StepResult> {
    this.hear(callerText);
    const stop = detectStopRequest(callerText);
    if (stop) {
      emitTrace("disposition", { value: "do_not_contact", nodeId: this.current });
      this.disposition = "do_not_contact";
      return this.finish(STOP_REPLY);
    }
    const node = this.deps.tree.nodes[this.current]!;
    // Before the interrupt check, so a name given in the same breath as a complaint is kept.
    this.collect(callerText);
    const interrupted = await this.checkInterrupt(node, callerText);
    if (!interrupted) this.answerPendingAsk();
    const parts = interrupted ?? (await this.decideAt(node, callerText, 0));
    const reply = parts.join(" ").trim();
    return this.finish(reply);
  }

  private finish(reply: string): StepResult {
    if (this.disposition) this.ended = true;
    this.say(reply, this.turnIndex);
    this.recentAsks.push(this.replyAsks);
    this.replyAsks = [];
    return { reply, ended: this.ended };
  }

  private here(): TreeNode {
    return this.deps.tree.nodes[this.current]!;
  }

  private context(): NonNullable<DecisionRequest["context"]> {
    return { missedCalls: this.deps.missedCalls ?? 0, ...(this.deps.lead ? { lead: this.deps.lead } : {}) };
  }

  /** Takes the caller's name and business from their words; a bare answer counts for a detail the last two agent lines asked for. */
  private collect(text: string): void {
    const awaiting = [...new Set(this.recentAsks.slice(-2).flat())];
    const known = { callerName: this.vars.callerName, businessName: this.vars.businessName };
    const found = extractCallerDetails(text, { awaiting, known });
    for (const key of ["callerName", "businessName"] as const satisfies readonly CallerDetail[]) {
      const value = found[key];
      if (!value) continue;
      // A shorter form of a value already heard ("Pat" after "Pat Lee") keeps the fuller one.
      if (this.vars[key]?.toLowerCase().includes(value.toLowerCase())) continue;
      this.vars[key] = value;
    }
  }

  /** The caller has replied to the line asking for details at this node, so that line is not asked again. */
  private answerPendingAsk(): void {
    const ask = this.pendingAsk;
    this.pendingAsk = null;
    if (!ask || ask.nodeId !== this.current) return;
    if (ask.together) this.askedTogether.add(ask.values.join("+"));
    else for (const v of ask.values) this.askedAlone.add(v);
  }

  /**
   * What a node that collects details asks now: its own line while every
   * value is missing and that line has not been answered, the line for the
   * one value still missing once, or nothing.
   */
  private collectingAsk(node: TreeNode): { line: string; values: CollectedValue[]; together: boolean } | null {
    const collects = node.collects;
    if (!collects) return null;
    const missing = collects.values.filter((v) => !this.vars[v]);
    if (!missing.length) return null;
    if (missing.length === collects.values.length) {
      if (this.askedTogether.has(collects.values.join("+"))) return null;
      return { line: this.baseLine(node), values: missing, together: true };
    }
    const only = missing.length === 1 ? missing[0]! : null;
    const line = only ? collects.lines?.[only] : undefined;
    if (!only || !line || this.askedAlone.has(only)) return null;
    return { line, values: [only], together: false };
  }

  private knowsAny(node: TreeNode): boolean {
    return (node.collects?.values ?? []).some((v) => Boolean(this.vars[v]));
  }

  /** While the node here collects details and has nothing left to ask, move on to its next node. */
  private settle(): void {
    for (let hops = 0; hops < 4; hops++) {
      const node = this.here();
      if (!node.collects || this.collectingAsk(node)) return;
      this.enter(this.deps.tree.nodes[node.collects.then]!);
      this.advanceThroughSpeakNodes();
    }
  }

  /** At a node that collects details, after the caller gave some of them: ask for what is missing, or move on. */
  private askForMissing(node: TreeNode): string[] {
    if (this.current !== node.id) this.enter(node);
    this.settle();
    return [this.lineOf(this.here())];
  }

  /** The interrupt check judges only the caller's latest line, with the agent line heard just before it as context. */
  private interruptWindow(): TranscriptTurn[] {
    const t = this.transcript;
    let i = t.length - 1;
    while (i >= 0 && t[i]!.role !== "caller") i--;
    if (i < 0) return [];
    for (let j = i - 1; j >= 0; j--) {
      const turn = t[j]!;
      if (turn.role === "agent" && turn.spoken !== false) return [turn, t[i]!];
    }
    return [t[i]!];
  }

  private hear(text: string): void {
    const turn: TranscriptTurn = { role: "caller", text, turnIndex: this.turnIndex, spoken: true };
    emitTrace("transcript_partial", { role: "caller", text: partOf(text), turnIndex: turn.turnIndex });
    this.transcript.push(turn);
    emitTrace("transcript_final", { role: "caller", text, turnIndex: turn.turnIndex });
    this.turnIndex += 1;
  }

  private say(raw: string, index: number): void {
    let text = raw;
    if (this.deps.guardLine) {
      // The opening disclosure (index -1) is the harness's own and is never rewritten.
      const isDisclosure = index < 0;
      const out = this.deps.guardLine(raw, { direction: this.deps.direction, nodeId: this.current, turnIndex: index, isDisclosure });
      if (!isDisclosure && out.verdict !== "unchanged") {
        text = out.text;
        emitTrace("compliance_check", { check: "agent_line_guard", passed: true, reason: null, verdict: out.verdict, rule: out.rule ?? null, detail: out.reason ?? null });
      }
    }
    const turn: TranscriptTurn = { role: "agent", text, turnIndex: index, spoken: true };
    if (this.intendedOnly) {
      emitTrace("tool_call", { tool: "intended_agent_line", inputs: { turnIndex: index }, result: { text }, success: true, durationMs: 0 });
      this.transcript.push(turn);
      if (index >= 0) this.turnIndex += 1;
      return;
    }
    emitTrace("transcript_partial", { role: "agent", text: partOf(text), turnIndex: index });
    this.transcript.push(turn);
    emitTrace("transcript_final", { role: "agent", text, turnIndex: index });
    if (index >= 0) this.turnIndex += 1;
  }

  private enter(node: TreeNode): void {
    this.current = node.id;
    emitTrace("node_enter", { nodeId: node.id, label: node.label }, node.flowStep ? { flowStep: node.flowStep } : {});
  }

  /** A node with no question moves straight on, entering each node it passes. */
  private advanceThroughSpeakNodes(): void {
    let node = this.deps.tree.nodes[this.current]!;
    while (!node.decision && node.next) {
      node = this.deps.tree.nodes[node.next]!;
      this.enter(node);
    }
  }

  private baseLine(node: TreeNode): string {
    return this.lineEntry(node)?.line ?? "";
  }

  /** The node's line for this call: once the known lead has confirmed, a line marked for them comes first. */
  private lineEntry(node: TreeNode): NonNullable<TreeNode["agentLines"]>[number] | undefined {
    const lines = (node.agentLines ?? []).filter((l) => !l.direction || l.direction === this.deps.direction);
    return (this.leadConfirmed ? lines.find((l) => l.confirmedLead) : undefined) ?? lines.find((l) => !l.confirmedLead);
  }

  /** The line said for a node; at a node that collects details, only what is still missing is asked. */
  private lineOf(node: TreeNode): string {
    let line = this.baseLine(node);
    this.pendingAsk = null;
    const ask = this.collectingAsk(node);
    if (ask) {
      line = ask.line;
      this.pendingAsk = { nodeId: node.id, values: ask.values, together: ask.together };
      this.replyAsks.push(...ask.values);
    } else if (!node.collects && node.asks && !this.lineEntry(node)?.confirmedLead) {
      // A line that asks for a detail without collecting it ("Who am I speaking with?"): a bare reply still counts.
      this.replyAsks.push(...node.asks.filter((v) => !this.vars[v]));
    }
    if (node.promise && line.includes(node.promise)) this.inCall.promised = node.promise;
    return fill(line, this.vars);
  }

  private extract(spec: NonNullable<TreeAnswer["extract"]>, text: string): boolean {
    if (spec.with === "year") {
      const year = extractYear(text);
      if (year) this.vars[spec.as] = year;
      return year !== null;
    }
    if (spec.with === "time") {
      const time = extractTime(text, this.deps.clock.now(), this.deps.timeZone);
      if (time) {
        this.vars[spec.as] = time.iso;
        this.vars[`${spec.as}Words`] = time.words;
      }
      return time !== null;
    }
    this.vars[spec.as] = text.trim();
    return text.trim().length > 0;
  }

  /** One decision at one node; returns what the agent says. */
  private async decideAt(node: TreeNode, callerText: string, carried: number, root?: TreeNode): Promise<string[]> {
    const { tree, decisions } = this.deps;
    // A node with no question cannot take a caller line: bring in a person rather than fail.
    if (!node.decision) return this.escalate(node);
    const question = node.decision;
    const answerNames = question.answers.map((a) => a.answer);
    const cues = Object.fromEntries(question.answers.filter((a) => a.cues).map((a) => [a.answer, a.cues!]));
    const { module, result } = await decisions.ask({
      nodeId: node.id,
      question: question.question,
      answers: answerNames,
      transcript: this.transcript,
      cues,
      answerCriteria: meaningsOf(question.answers),
      context: this.context(),
    });
    this.checkStopped();
    const chosen = question.answers.find((a) => a.answer === result.answer)!;
    let routed: "proceed" | "clarify" = result.answer === "unclear" || !confidentEnough(result.confidence, chosen.minConfidence) ? "clarify" : "proceed";
    let reason = result.reason;
    if (routed === "proceed" && chosen.extract && !this.extract(chosen.extract, callerText)) {
      routed = "clarify";
      reason += "; nothing usable was found in the caller's words";
    }
    this.emitDecision(node, question.question, answerNames, result, reason, chosen, routed, module?.id ?? "none", module?.getConfig().latencyMs ?? 0);

    // A carried question that finds nothing is not a failed answer: the agent just asks it.
    // Where the caller gave part of what was asked, the agent asks for the rest instead.
    if (routed === "clarify" && carried > 0) return root?.collects && this.knowsAny(root) ? this.askForMissing(root) : [this.lineOf(node)];
    if (routed === "clarify") return node.collects && this.knowsAny(node) ? this.askForMissing(node) : this.clarify(node);
    this.clarifyCounts.set(node.id, 0);
    if (node.flowStep === "discovery" && !this.inCall.callerWanted) this.inCall.callerWanted = callerText;
    return this.proceed(node, chosen, callerText, carried, root);
  }

  private emitDecision(
    node: TreeNode,
    question: string,
    answers: string[],
    result: { answer: string; confidence: number; scores?: Array<{ answer: string; confidence: number }> },
    reason: string,
    chosen: TreeAnswer,
    routed: "proceed" | "clarify",
    moduleId: string,
    latencyMs: number,
  ): void {
    const step = node.flowStep ?? "discovery";
    const record = {
      step: node.id,
      noticed: reason,
      chose: routed === "proceed" ? result.answer : "ask again",
      ruleOrPlaybookItem: `${this.deps.tree.id}:${node.id}:${chosen.answer}`,
    };
    this.deps.recorder.record(step, record);
    emitTrace(
      "decision",
      {
        nodeId: node.id,
        question,
        answers,
        answer: result.answer,
        confidence: result.confidence,
        reason,
        module: moduleId,
        // This engine is the decision model router; the Pipecat routers record their own decisions.
        router: "decision_model",
        minConfidence: chosen.minConfidence,
        routed,
        latencyMs,
        ...(result.scores ? { scores: result.scores } : {}),
      },
      { flowStep: step, decision: record },
    );
  }

  private async clarify(node: TreeNode): Promise<string[]> {
    const { tree } = this.deps;
    const count = (this.clarifyCounts.get(node.id) ?? 0) + 1;
    this.clarifyCounts.set(node.id, count);
    if (count < tree.maxClarifications) return [fill(node.clarify ?? "", this.vars)];
    return this.escalate(node);
  }

  /** Brings in a person, through the same judge gate. */
  private async escalate(node: TreeNode): Promise<string[]> {
    const { tree } = this.deps;
    const count = this.clarifyCounts.get(node.id) ?? tree.maxClarifications;
    // Every step of the escalation tells the judge why, so its verdict shows the clarifying lines were used up.
    const unclear = { reason: "repeated_unclear", clarifyCount: count, maxClarifications: tree.maxClarifications };
    if (node.escalation) {
      // This node never hands the caller to a person: it ends through the judge gate with its own disposition.
      const closed = await this.endWith(node, node.escalation.disposition, unclear);
      return [fill(closed ? node.escalation.say : (node.clarify ?? ""), this.vars)];
    }
    const done = await this.act("transfer", node, unclear, () => this.deps.actions.transfer("repeated_unclear"));
    if (!done) return [fill(node.clarify ?? "", this.vars)];
    const ended = await this.endWith(node, tree.escalation.disposition, unclear);
    return ended ? [tree.escalation.say] : [fill(node.clarify ?? "", this.vars)];
  }

  private async proceed(node: TreeNode, chosen: TreeAnswer, callerText: string, carried: number, root?: TreeNode): Promise<string[]> {
    const blocked = (): string[] => {
      const onBlocked = chosen.onBlocked;
      if (onBlocked?.next) this.enter(this.deps.tree.nodes[onBlocked.next]!);
      return [fill(onBlocked?.say ?? "I am not able to do that, so let me check what you need.", this.vars)];
    };

    if (chosen.action) {
      const ok = await this.runAction(node, chosen.action, callerText);
      if (!ok) return blocked();
      if (chosen.action.type === "save_quote_field") this.inCall.callerWanted ||= callerText;
    }
    if (chosen.disposition) {
      if (!(await this.endWith(node, chosen.disposition))) return blocked();
      return [fill(chosen.say ?? "", this.vars)];
    }

    // Moving on from a node that collects details waits for the one detail still missing, asked once.
    if (node.collects && chosen.next === node.collects.then && this.collectingAsk(node)) return this.askForMissing(node);
    // At the known-lead start, only a yes confirms the lead.
    if (this.knownLead && node.id === this.entryId) this.leadConfirmed = chosen.answer === "yes";
    // A known lead is confirmed, never asked who they are: the tree names where such a call goes instead.
    let nextId = (this.leadConfirmed && chosen.confirmedLeadNext) || (this.knownLead && chosen.knownLeadNext) || chosen.next!;
    let returnedTo: string | undefined;
    if (chosen.returnToOrigin) {
      returnedTo = this.origins.pop();
      if (returnedTo) nextId = returnedTo;
    }
    this.enter(this.deps.tree.nodes[nextId]!);
    this.advanceThroughSpeakNodes();
    this.settle();
    const landed = this.deps.tree.nodes[this.current]!;
    const repeated = await this.checkRepeat(landed, callerText);
    if (repeated) return repeated;
    if (chosen.carry && carried < MAX_CARRY && landed.decision && landed.id !== node.id) {
      return this.decideAt(landed, callerText, carried + 1, root ?? node);
    }
    // Back at the node a side trip left, its own line was already said: ask only for a detail still
    // missing, or else go through its clarifying line, which counts toward bringing in a person.
    if (landed.id === returnedTo && !chosen.say && landed.decision && !this.collectingAsk(landed)) return this.clarify(landed);
    return [chosen.say ?? this.lineOf(landed)].map((t) => fill(t, this.vars));
  }

  /**
   * Asked before the node's own question on every caller line. "none", "unclear"
   * or a low-confidence answer carries on with the node, which then asks its own
   * question (and its own clarifying line). A confident interrupt is taken like
   * any answer, so its action and ending are judge-gated; a resuming one says
   * its line, then lets the node's question take the same caller line. Only
   * the caller's latest line is judged, with the agent line before it as
   * context; node questions keep the whole conversation.
   */
  private async checkInterrupt(node: TreeNode, callerText: string): Promise<string[] | null> {
    const interrupts = this.deps.tree.interrupts;
    if (!interrupts || !node.decision) return null;
    const answerNames = interrupts.answers.map((a) => a.answer);
    const { module, result } = await this.deps.decisions.ask({
      nodeId: INTERRUPTS_NODE_ID,
      question: interrupts.question,
      answers: answerNames,
      transcript: this.interruptWindow(),
      cues: Object.fromEntries(interrupts.answers.filter((a) => a.cues).map((a) => [a.answer, a.cues!])),
      answerCriteria: meaningsOf(interrupts.answers),
      context: this.context(),
    });
    this.checkStopped();
    // Only an interruption is worth a trace row; a "none" on every line would drown the real decisions.
    if (!module || result.answer === "none" || result.answer === "unclear") return null;
    const chosen = interrupts.answers.find((a) => a.answer === result.answer)!;
    const routed = confidentEnough(result.confidence, chosen.minConfidence) ? "proceed" : "clarify";
    this.emitDecision(
      { id: INTERRUPTS_NODE_ID, label: "Interrupt check", flowStep: node.flowStep } as TreeNode,
      interrupts.question,
      answerNames,
      result,
      result.reason,
      chosen,
      routed,
      module.id,
      module.getConfig().latencyMs,
    );
    if (routed === "clarify") return null;
    // Already at the node this interrupt leads to: let the node's own question take the line.
    if (chosen.next === node.id) return null;
    if (chosen.resume) {
      // The node's question still runs on the same line, so an answer given alongside is kept.
      // Run as a carried question, an unclear answer asks the node's line again, not "did not catch that".
      const said = fill(chosen.say ?? "", this.vars);
      this.settle();
      const here = this.here();
      const rest = (here.decision ? await this.decideAt(here, callerText, 1, here) : [this.lineOf(here)]).filter(Boolean);
      // Still at a node with no line of its own: its clarifying line asks the question.
      if (!rest.length && this.current === here.id) rest.push(fill(here.clarify ?? "", this.vars));
      return [said, ...rest].filter(Boolean);
    }
    const parts = await this.proceed(node, chosen, callerText, MAX_CARRY);
    // A side trip: remember the node it left, so an answer with returnToOrigin can come back to it.
    if (this.current !== node.id && !this.disposition) {
      if (this.origins.at(-1) !== node.id) this.origins.push(node.id);
      if (this.origins.length > MAX_ORIGINS) this.origins.shift();
    }
    return parts;
  }

  /** The second time the same objection class comes up, the call ends politely with a disposition and a handoff note. */
  private async checkRepeat(landed: TreeNode, callerText: string): Promise<string[] | null> {
    const rule = this.deps.tree.repeatRule;
    if (!rule || !landed.repeatKey) return null;
    const count = (this.objections.get(landed.repeatKey) ?? 0) + 1;
    this.objections.set(landed.repeatKey, count);
    if (count < 2) return null;
    if (!(await this.endWith(landed, rule.disposition))) return null;
    // The note says what the caller wanted (their own words) and what the agent said, so the harness can file it.
    this.inCall.callerWanted = callerText;
    this.inCall.promised = rule.say;
    return [rule.say];
  }

  private async runAction(node: TreeNode, spec: NonNullable<TreeAnswer["action"]>, callerText: string): Promise<boolean> {
    const callerTurns = this.transcript.filter((t) => t.role === "caller").map((t) => t.text);
    const value = spec.from ? this.vars[spec.from] ?? "" : "";
    switch (spec.type) {
      case "transfer":
        return this.act("transfer", node, { reason: spec.reason ?? "caller_requested" }, () => this.deps.actions.transfer(spec.reason ?? "caller_requested"));
      case "save_quote_field":
        return this.act("save_quote_field", node, { field: spec.field, value, evidenceSpan: callerText }, () =>
          this.deps.actions.saveQuoteField(spec.field!, value, callerText, callerTurns),
        );
      case "save_details":
        return this.act("save_details", node, { kind: spec.kind, body: value }, () => this.deps.actions.saveDetails(spec.kind ?? "message", value));
      case "book":
        return this.act("book", node, { slotIso: value, slotWords: this.vars[`${spec.from}Words`] }, () => this.deps.actions.book(value));
      case "send_text":
        return this.act("send_text", node, { body: spec.body }, () => this.deps.actions.sendText(spec.body ?? ""));
    }
  }

  private async endWith(node: TreeNode, disposition: string, why: JudgePayload = {}): Promise<boolean> {
    const durable = this.deps.tree.dispositions.find((d) => d.name === disposition)?.durable ?? false;
    const ok = await this.act("end_with_disposition", node, { ...why, disposition, durable }, () => this.deps.actions.endWithDisposition(disposition, durable));
    if (!ok) return false;
    this.disposition = disposition;
    emitTrace("disposition", { value: disposition, nodeId: node.id });
    return true;
  }

  /** Every destructive action goes through the judge gate here, and only here. */
  private async act(action: JudgeAction, node: TreeNode, payload: JudgePayload, run: () => Promise<boolean>): Promise<boolean> {
    const request: JudgeRequest = {
      action,
      nodeId: node.id,
      direction: this.deps.direction,
      transcript: [...this.transcript],
      completed: [...this.completed],
      payload,
      now: this.deps.clock.now(),
      expectedDisclosure: [...this.opening.disclosure],
    };
    // The judge is awaited first; a session that ended meanwhile runs no action.
    const outcome = await guardedAction(this.deps.gate, request, () => (this.stopped ? Promise.resolve(false) : run()));
    this.checkStopped();
    if (!outcome.allowed || !outcome.value) return false;
    this.completed.push(action);
    return true;
  }
}
