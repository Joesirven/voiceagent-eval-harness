/**
 * The post-call score: once a call has ended, the finished transcript and
 * trace are read, a few plain criteria are scored from what actually
 * happened, and the decision model is asked one closed question about the
 * whole call. The result is one `judge_score` row the console's bottom panel
 * shows. Nothing runs during the call, and no model reason reaches the trace.
 *
 * The disclosure is read from the agent's own first words (does it say it is
 * an AI assistant), never from the live judge's rule that misfired.
 */

import { ASSISTANT_WORDS } from "../config.js";
import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../decision-models/types.js";
import type { TraceEvent, TraceEventInput } from "../trace/events.js";
import { callTranscript } from "./objectives.js";

export const DEFAULT_SETTLE_MS = 2000;
export const DEFAULT_ASK_TIMEOUT_MS = 8000;
export const GRADES = ["strong", "fair", "weak", "unclear"] as const;
export type Grade = (typeof GRADES)[number];
const GRADE_SCORE: Record<Grade, number | null> = { strong: 90, fair: 65, weak: 35, unclear: null };

export interface ScoreCriterion {
  criterion: string;
  /** 0 to 100. */
  score: number;
  note: string;
}

export interface PostCallScore {
  judgedAt: string;
  score: number;
  grade: Grade | "rules_only";
  modelId: string | null;
  criteria: ScoreCriterion[];
}

export interface PostCallScorerOptions {
  model: DecisionModel | null | (() => DecisionModel | null);
  subscribe: (listener: (event: TraceEvent) => void) => () => void;
  history: () => TraceEvent[];
  emit: (input: TraceEventInput) => void;
  settleMs?: number;
  askTimeoutMs?: number;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** The rule-based criteria from the call's own rows. Exported for the tests and the score's own notes. */
export function ruleCriteria(history: TraceEvent[], callId: string): ScoreCriterion[] {
  const mine = history.filter((e) => e.callId === callId);
  const transcript = callTranscript(history, callId);
  const agentLines = transcript.filter((t) => t.role === "agent");
  const callerLines = transcript.filter((t) => t.role === "caller");
  const tools = mine.filter((e) => e.type === "tool_call");
  const out: ScoreCriterion[] = [];

  // Disclosure: the agent's first words say it is an AI assistant, in any phrasing that carries those words.
  const first = agentLines[0]?.text ?? "";
  const said = new RegExp(ASSISTANT_WORDS.replace(/\s+/g, "\\s+"), "i").test(first) || /\b(an?|the) (artificial intelligence|automated|virtual) assistant\b/i.test(first);
  out.push({ criterion: "Said it is an AI assistant up front", score: said ? 100 : agentLines.length ? 0 : 50, note: said ? "The first agent line says so." : agentLines.length ? "The first agent line does not say it." : "The agent said nothing." });

  // Quote facts: fields saved from the caller's words, and what the last objective check saw.
  const saved = tools.filter((e) => e.data.tool === "write_quote_field" && e.data.success !== false).map((e) => String((e.data.inputs as { field?: unknown } | null)?.field ?? "a field"));
  const lastCheck = [...mine].reverse().find((e) => e.type === "tool_call" && e.data.tool === "objective_check");
  const objectives = Array.isArray((lastCheck?.data.inputs as { objectives?: unknown } | null)?.objectives) ? ((lastCheck!.data.inputs as { objectives: Array<{ id: string; status: string }> }).objectives) : [];
  const done = new Set(objectives.filter((o) => o.status === "done").map((o) => o.id));
  const factsScore = saved.length >= 3 ? 100 : saved.length === 2 ? 75 : saved.length === 1 ? 50 : done.has("quote_details") || done.has("coverage") ? 60 : 0;
  out.push({ criterion: "Got the quote facts the call needed", score: factsScore, note: saved.length ? `Saved ${saved.length}: ${[...new Set(saved)].join(", ")}.` : done.has("coverage") || done.has("quote_details") ? "The caller gave facts, but none was saved to the record." : "No quote fact was saved." });

  // Next step: the caller's plain yes to a quote by text, a booking, a message or a handoff.
  const nextTools = tools.filter((e) => e.data.success !== false && ["send_text", "book_producer", "book_callback", "save_message", "transfer_to_human"].includes(String(e.data.tool)));
  const disposition = [...mine].reverse().find((e) => e.type === "disposition")?.data.value;
  const nextStep = done.has("next_step") || nextTools.length > 0 || ["booked", "callback", "message_taken", "handed_off"].includes(String(disposition));
  out.push({ criterion: "Got a yes to a next step", score: nextStep ? 100 : 0, note: nextStep ? `${nextTools.length ? nextTools.map((e) => String(e.data.tool)).join(", ") : disposition ? `ended as ${disposition}` : "the caller agreed"}.` : "No quote by text, booking, message or handoff was agreed." });

  // Short turns: agent lines of at most 35 words.
  const short = agentLines.filter((t) => words(t.text) <= 35).length;
  const avg = agentLines.length ? Math.round(agentLines.reduce((n, t) => n + words(t.text), 0) / agentLines.length) : 0;
  out.push({ criterion: "Kept its turns short", score: agentLines.length ? pct(short, agentLines.length) : 50, note: agentLines.length ? `${short} of ${agentLines.length} agent lines were 35 words or fewer; ${avg} words on average.` : "No agent lines." });

  // Objections: objection nodes entered, and whether the caller kept talking afterwards.
  const objectionAt = mine.filter((e) => e.type === "node_enter" && String(e.data.nodeId ?? "").startsWith("objection.")).map((e) => e.atMs);
  const stayed = objectionAt.filter((at) => callerLines.some((_, i) => (mine.find((e) => e.type === "transcript_final" && e.data.role === "caller" && e.data.turnIndex === callerLines[i].turnIndex)?.atMs ?? 0) > at)).length;
  out.push({ criterion: "Handled objections", score: objectionAt.length ? pct(stayed, objectionAt.length) : 100, note: objectionAt.length ? `${objectionAt.length} objection${objectionAt.length === 1 ? "" : "s"}; the caller stayed on after ${stayed}.` : "No objection came up." });

  // Accuracy: lines the agent spoke that diverged from what the decision module intended, and clarifying turns.
  const diverged = tools.filter((e) => e.data.tool === "spoken_vs_intended" && (e.data.inputs as { diverged?: unknown } | null)?.diverged === true).length;
  const clarified = mine.filter((e) => e.type === "decision" && e.data.routed === "clarify").length;
  out.push({ criterion: "No misheard or made-up facts", score: clamp(100 - diverged * 25 - clarified * 10), note: diverged || clarified ? `${diverged} line${diverged === 1 ? "" : "s"} strayed from the intended meaning; ${clarified} clarifying turn${clarified === 1 ? "" : "s"}.` : "Nothing strayed and nothing needed clarifying." });

  // Waits: the caller-stop-to-first-audio times.
  const waits = tools.filter((e) => /reply_timing$/.test(String(e.data.tool))).map((e) => num((e.data.inputs as { callerFinalToFirstAudioMs?: unknown } | null)?.callerFinalToFirstAudioMs)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  out.push({ criterion: "Answered without long waits", score: median === null ? 50 : clamp(100 - Math.max(0, median - 1000) / 25), note: median === null ? "No reply timing was recorded." : `Median wait ${median} ms over ${waits.length} repl${waits.length === 1 ? "y" : "ies"}; longest ${waits[waits.length - 1]} ms.` });
  return out;
}

export class PostCallScorer {
  private unsubscribe: (() => void) | undefined;
  private readonly pending = new Map<string, () => void>();
  private readonly scored = new Set<string>();
  private readonly settleMs: number;
  private readonly askTimeoutMs: number;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly o: PostCallScorerOptions) {
    this.settleMs = o.settleMs ?? DEFAULT_SETTLE_MS;
    this.askTimeoutMs = o.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.clock = o.clock ?? (() => Date.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); });
  }

  install(): () => void {
    this.unsubscribe?.();
    this.unsubscribe = this.o.subscribe((event) => {
      if (event.channel !== "call" || !event.callId || event.type !== "call_outcome" || this.scored.has(event.callId)) return;
      const ctx: Pick<TraceEventInput, "leadId" | "leadLabel" | "recordId" | "channel" | "direction" | "callId"> = { leadId: event.leadId, leadLabel: event.leadLabel, recordId: event.recordId, channel: event.channel, direction: event.direction, callId: event.callId };
      this.pending.get(event.callId)?.();
      this.pending.set(event.callId, this.setTimer(() => { this.pending.delete(event.callId!); void this.score(event.callId!, ctx); }, this.settleMs));
    });
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const cancel of this.pending.values()) cancel();
    this.pending.clear();
  }

  private model(): DecisionModel | null {
    return typeof this.o.model === "function" ? this.o.model() : this.o.model;
  }

  async score(callId: string, ctx: Pick<TraceEventInput, "leadId" | "leadLabel" | "recordId" | "channel" | "direction" | "callId">): Promise<PostCallScore | null> {
    if (this.scored.has(callId)) return null;
    this.scored.add(callId);
    const history = this.o.history();
    const transcript = callTranscript(history, callId);
    // A call with no caller line is nothing to score: a failed start, or a hang-up on the opening.
    if (!transcript.some((t) => t.role === "caller")) return null;
    const criteria = ruleCriteria(history, callId);
    const rules = Math.round(criteria.reduce((n, c) => n + c.score, 0) / criteria.length);
    const model = this.model();
    let grade: PostCallScore["grade"] = "rules_only";
    let modelId: string | null = null;
    if (model) {
      const outcome = await this.ask(model, transcript);
      modelId = model.id;
      if (outcome.ok && (GRADES as readonly string[]).includes(outcome.answer)) grade = outcome.answer as Grade;
      else grade = "unclear";
    }
    const modelScore = grade === "rules_only" ? null : GRADE_SCORE[grade];
    const score = modelScore === null ? rules : Math.round((rules + modelScore) / 2);
    const result: PostCallScore = { judgedAt: new Date(this.clock()).toISOString(), score, grade, modelId, criteria };
    this.o.emit({ type: "judge_score", ...ctx, data: { ...result } });
    return result;
  }

  private async ask(model: DecisionModel, transcript: DecisionModelRequest["transcript"]): Promise<DecisionModelOutcome> {
    const request: DecisionModelRequest = {
      nodeId: "post_call.overall",
      question: "Taking the whole call, how well did the agent serve the agency and the caller?",
      answers: [...GRADES],
      transcript,
      answerCriteria: {
        strong: "the agent learned what the call needed, kept its turns short and clear, and the caller plainly agreed to a next step (a quote by text, a time, a message, or a transfer)",
        fair: "the agent got part of what the call needed, or the caller stayed engaged but no next step was agreed",
        weak: "the caller got little from the call, the agent lost them, repeated itself, or talked past what they said",
        unclear: "the conversation is too short or too garbled to tell",
      },
      instructions: "Judge only what was said. Only the caller's words count for an agreement. Do not penalise the agent for being an AI assistant.",
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DecisionModelOutcome>((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: "timeout", latencyMs: this.askTimeoutMs, modelId: model.id, code: "deadline" }), this.askTimeoutMs); timer.unref(); });
    try {
      return await Promise.race([model.decide(request, { timeoutMs: this.askTimeoutMs }), late]);
    } catch {
      return { ok: false, reason: "error", latencyMs: 0, modelId: model.id, code: "threw" };
    } finally {
      clearTimeout(timer);
    }
  }
}
