/**
 * The objectives judge: in the background, after each spoken line of a call,
 * it asks the decision model which of the call's objectives are done, and
 * writes the answer to the trace as one `objective_check` tool row. The
 * console's objectives pane reads the latest row. Nothing here is on the
 * reply path: the speaking model never waits for it, and no tool call carries
 * it.
 *
 * Cost control: one batch per settle window per call (lines that arrive while
 * a batch runs are folded into the next one), an objective judged done stays
 * done and is not asked again, and each ask is bounded by a timeout. The
 * conversation goes to the model as the judge sends it; the model's reasons
 * never reach the trace.
 */

import type { FlowStep } from "../decision-tree/types.js";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../decision-models/types.js";
import type { TranscriptTurn } from "../provider/interface.js";
import type { TraceEvent, TraceEventInput } from "../trace/events.js";
import { CALL_OBJECTIVES, inferFlowStep, OBJECTIVE_ANSWERS, OBJECTIVE_RULE, type ObjectiveDefinition, type ObjectiveStatus } from "./objective-definitions.js";

export const OBJECTIVE_CHECK_TOOL = "objective_check";
export const DEFAULT_SETTLE_MS = 1200;
export const DEFAULT_ASK_TIMEOUT_MS = 6000;
/** A "done" answer below this confidence is reported as unclear, not as done. */
export const DONE_MIN_CONFIDENCE = 0.6;

const LINE_TYPES = new Set(["transcript_final", "turn"]);

export interface ObjectiveResult {
  id: string;
  label: string;
  step: FlowStep;
  status: ObjectiveStatus;
  /** The model's confidence for the latest answer, when it answered. */
  confidence: number | null;
}

export interface ObjectivesJudgeOptions {
  /** The decision model, or a source for it; null means no model is configured and the judge only reports that once per call. */
  model: DecisionModel | null | (() => DecisionModel | null);
  subscribe: (listener: (event: TraceEvent) => void) => () => void;
  history: () => TraceEvent[];
  emit: (input: TraceEventInput) => void;
  objectives?: readonly ObjectiveDefinition[];
  settleMs?: number;
  askTimeoutMs?: number;
  clock?: () => number;
  /** For tests: a timer that fires the settle callback; default setTimeout (unref'd). */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

interface CallState {
  ctx: Pick<TraceEventInput, "leadId" | "leadLabel" | "recordId" | "channel" | "direction" | "callId">;
  results: Map<string, ObjectiveResult>;
  cancelTimer: (() => void) | undefined;
  running: boolean;
  pending: boolean;
  ended: boolean;
  reportedNoModel: boolean;
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

/** The spoken lines of one call, oldest first, as the decision model takes them. */
export function callTranscript(history: TraceEvent[], callId: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const e of history) {
    if (e.callId !== callId || !LINE_TYPES.has(e.type) || e.data.spoken === false) continue;
    const role = e.data.role;
    if (role !== "caller" && role !== "agent") continue;
    const text = typeof e.data.text === "string" ? e.data.text.trim() : "";
    if (!text) continue;
    const turnIndex = typeof e.data.turnIndex === "number" ? e.data.turnIndex : turns.length;
    turns.push({ role, text, turnIndex, spoken: true });
  }
  return turns;
}

/** The call's current flow step from its newest node_enter, read from the node when the event carries none. */
export function callStage(history: TraceEvent[], callId: string): FlowStep | null {
  let fromTree: FlowStep | null = null;
  let opened = false;
  let nodeAfterOpen = false;
  let latestCheck: TraceEvent | null = null;
  for (const e of history) {
    if (e.callId !== callId) continue;
    if (e.type === "node_enter") {
      const step = (e.flowStep as FlowStep | undefined) ?? inferFlowStep(typeof e.data.nodeId === "string" ? e.data.nodeId : null);
      if (step) fromTree = step;
      if (opened) nodeAfterOpen = true;
    } else if (e.type === "tool_call" && e.data.tool === "voice_session_open") opened = true;
    else if (e.type === "tool_call" && e.data.tool === "objective_check") latestCheck = e;
  }
  // With the decision tree off the tree stops after its first node: the first objective not yet done says where the call is.
  if (opened && !nodeAfterOpen && latestCheck) {
    const list = ((latestCheck.data.inputs as { objectives?: Array<{ step?: string; status?: string }> } | undefined)?.objectives ?? []);
    const open = list.find((o) => o.status !== "done") ?? list[list.length - 1];
    if (open && typeof open.step === "string") return open.step as FlowStep;
  }
  return fromTree;
}

export function statusOf(outcome: DecisionModelOutcome): { status: ObjectiveStatus; confidence: number | null } {
  if (!outcome.ok) return { status: "unclear", confidence: null };
  const confidence = Number.isFinite(outcome.confidence) ? outcome.confidence : null;
  if (outcome.answer === "done") return { status: confidence !== null && confidence >= DONE_MIN_CONFIDENCE ? "done" : "unclear", confidence };
  if (outcome.answer === "not_yet") return { status: "open", confidence };
  return { status: "unclear", confidence };
}

export class ObjectivesJudge {
  private readonly calls = new Map<string, CallState>();
  private readonly objectives: readonly ObjectiveDefinition[];
  private readonly settleMs: number;
  private readonly askTimeoutMs: number;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly o: ObjectivesJudgeOptions) {
    this.objectives = o.objectives ?? CALL_OBJECTIVES;
    this.settleMs = o.settleMs ?? DEFAULT_SETTLE_MS;
    this.askTimeoutMs = o.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.clock = o.clock ?? (() => Date.now());
    this.setTimer = o.setTimer ?? defaultTimer;
  }

  /** Starts listening to the trace. Returns the stop function. */
  install(): () => void {
    this.unsubscribe?.();
    this.unsubscribe = this.o.subscribe((event) => this.onEvent(event));
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const call of this.calls.values()) call.cancelTimer?.();
    this.calls.clear();
  }

  /** The latest results for a call, for tests and the status line. */
  resultsFor(callId: string): ObjectiveResult[] {
    return [...(this.calls.get(callId)?.results.values() ?? [])];
  }

  private model(): DecisionModel | null {
    return typeof this.o.model === "function" ? this.o.model() : this.o.model;
  }

  private onEvent(event: TraceEvent): void {
    if (event.channel !== "call" || !event.callId) return;
    // The judge's own rows never trigger it.
    if (event.type === "tool_call" && event.data.tool === OBJECTIVE_CHECK_TOOL) return;
    const isLine = LINE_TYPES.has(event.type) && (event.data.role === "caller" || event.data.role === "agent") && event.data.spoken !== false;
    const isEnd = event.type === "call_outcome";
    if (!isLine && !isEnd) return;
    let call = this.calls.get(event.callId);
    if (!call) {
      call = {
        ctx: { leadId: event.leadId, leadLabel: event.leadLabel, recordId: event.recordId, channel: event.channel, direction: event.direction, callId: event.callId },
        results: new Map(),
        cancelTimer: undefined,
        running: false,
        pending: false,
        ended: false,
        reportedNoModel: false,
      };
      this.calls.set(event.callId, call);
    }
    if (isEnd) call.ended = true;
    this.schedule(event.callId, call, isEnd ? 0 : this.settleMs);
  }

  private schedule(callId: string, call: CallState, delayMs: number): void {
    if (call.running) {
      call.pending = true;
      return;
    }
    call.cancelTimer?.();
    call.cancelTimer = this.setTimer(() => {
      call.cancelTimer = undefined;
      void this.run(callId, call);
    }, delayMs);
  }

  private async run(callId: string, call: CallState): Promise<void> {
    call.running = true;
    call.pending = false;
    const began = this.clock();
    try {
      const history = this.o.history();
      const transcript = callTranscript(history, callId);
      const stage = callStage(history, callId);
      const model = this.model();
      // Nothing to judge before the caller has spoken: the greeting alone settles no objective.
      const askable = transcript.some((t) => t.role === "caller") ? this.objectives.filter((obj) => call.results.get(obj.id)?.status !== "done") : [];
      if (!model) {
        if (!call.reportedNoModel) {
          call.reportedNoModel = true;
          this.emitRow(call, { stage, trigger: call.ended ? "call_end" : "line", asked: 0, modelId: "none", modelKind: "none", objectives: this.rows(call) }, false, this.clock() - began, "no_decision_model");
        }
        return;
      }
      if (askable.length === 0 && !call.ended) return;
      const outcomes = await Promise.all(askable.map((obj) => this.ask(model, obj, transcript)));
      askable.forEach((obj, i) => {
        const { status, confidence } = statusOf(outcomes[i]);
        call.results.set(obj.id, { id: obj.id, label: obj.label, step: obj.step, status, confidence });
      });
      this.emitRow(call, { stage, trigger: call.ended ? "call_end" : "line", asked: askable.length, modelId: model.id, modelKind: model.kind, objectives: this.rows(call) }, true, this.clock() - began);
    } catch {
      this.emitRow(call, { stage: null, trigger: "line", asked: 0, modelId: this.model()?.id ?? "none", modelKind: this.model()?.kind ?? "none", objectives: this.rows(call) }, false, this.clock() - began, "objective_check_failed");
    } finally {
      call.running = false;
      if (call.ended && !call.pending) this.calls.delete(callId);
      else if (call.pending) this.schedule(callId, call, this.settleMs);
    }
  }

  /** Every objective in definition order: judged ones with their status, the rest open. */
  private rows(call: CallState): ObjectiveResult[] {
    return this.objectives.map((obj) => call.results.get(obj.id) ?? { id: obj.id, label: obj.label, step: obj.step, status: "open" as const, confidence: null });
  }

  private async ask(model: DecisionModel, obj: ObjectiveDefinition, transcript: TranscriptTurn[]): Promise<DecisionModelOutcome> {
    const request: DecisionModelRequest = {
      nodeId: `objective.${obj.id}`,
      question: obj.question,
      answers: [...OBJECTIVE_ANSWERS],
      transcript,
      answerCriteria: obj.criteria,
      instructions: OBJECTIVE_RULE,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DecisionModelOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: "timeout", latencyMs: this.askTimeoutMs, modelId: model.id, code: "deadline" }), this.askTimeoutMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([model.decide(request, { timeoutMs: this.askTimeoutMs }), late]);
      // A reply outside the closed list is unreadable, not a vote.
      if (outcome.ok && !(OBJECTIVE_ANSWERS as readonly string[]).includes(outcome.answer)) {
        return { ok: false, reason: "invalid_answer", latencyMs: outcome.latencyMs, modelId: outcome.modelId };
      }
      return outcome;
    } catch {
      return { ok: false, reason: "error", latencyMs: 0, modelId: model.id, code: "threw" };
    } finally {
      clearTimeout(timer);
    }
  }

  private emitRow(call: CallState, inputs: Record<string, unknown>, success: boolean, durationMs: number, reason?: string): void {
    this.o.emit({
      type: "tool_call",
      ...call.ctx,
      data: { tool: OBJECTIVE_CHECK_TOOL, inputs, result: null, success, durationMs: Math.max(0, Math.round(durationMs)), ...(reason ? { reason } : {}) },
    });
  }
}
