/**
 * The Fable analysis. Fable (claude-fable-5-1), offline, answers the same
 * closed questions the live judge and the decision models answered during
 * calls. From the two sets of answers this module builds, per model:
 *   - a confusion table (model answer by Fable answer; a model that failed to
 *     answer is its own row),
 *   - the disagreements, as a worksheet for judging by hand,
 *   - recommended confidence bars per answer.
 *
 * Agreement is not evidence of who is better; only the disagreements, judged by
 * hand, settle that. Bars are computed against the adjudicated truth:
 *   - the hand verdict for a case, when it has one (it outranks everything);
 *   - otherwise the shared answer, where model and Fable agree;
 *   - otherwise the case is left out of the bars, and counted as waiting.
 *
 * Every past-call word that goes to Fable is redacted first. Tests never reach
 * the network: the labeler is an interface and `MockFableLabeler` fills it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../../decision-models/redact.js";
import type { DecisionModel, DecisionModelOutcome } from "../../decision-models/types.js";
import type { TranscriptTurn } from "../../provider/interface.js";
import { errorCode, type TraceEvent } from "../../trace/events.js";
import type { HarnessRecord } from "../../trace/records.js";
import type { JudgeAction } from "../../judge/types.js";
import { liveQuestionFor } from "../live-questions.js";
import { FABLE_MODEL, type ClaudeJsonClient } from "./claude.js";

/* ------------------------------------------------------------------- cases */

export type ModelAnswer = { answer: string; confidence: number } | { failed: string };

export interface DecisionCase {
  /** `<record id>#<event number in the record>`. */
  caseId: string;
  origin: "live_judge" | "tree_decision";
  nodeId: string;
  /** The judged action, for a live judge case. */
  action?: string;
  question: string;
  /** The closed list, always including "unclear". */
  answers: string[];
  /** What each answer means, when the question has criteria. */
  answerCriteria?: Record<string, string>;
  /** The conversation up to the decision, as the model saw it. */
  transcript: TranscriptTurn[];
  /** By model id. */
  modelAnswers: Record<string, ModelAnswer>;
}

function isFailed(answer: ModelAnswer): answer is { failed: string } {
  return "failed" in answer;
}

const JUDGE_ACTION_NAMES: readonly string[] = ["transfer", "save_details", "save_quote_field", "book", "send_text", "end_with_disposition"];

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A short code only (never raw error text) when the event names why the model gave no answer. */
function failureCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(value) ? value : "error";
}

/** The model's recorded answer, or its recorded failure. */
function recordedAnswer(data: Record<string, unknown>): ModelAnswer | undefined {
  if (data.ok === false || data.answer === null) return { failed: failureCode(data.failureReason) };
  if (typeof data.answer === "string" && typeof data.confidence === "number") {
    return { answer: data.answer, confidence: data.confidence };
  }
  return undefined;
}

/**
 * Rebuilds decision cases from stored call records: every `decision` event plus
 * the spoken transcript up to that event. A tree decision carries its own
 * question; a live judge event carries the action, and the question is rebuilt
 * with the live judge's question builder, so it is the question the model saw.
 */
export function casesFromRecords(records: readonly HarnessRecord[]): DecisionCase[] {
  const cases: DecisionCase[] = [];
  for (const record of records) {
    if (record.kind !== "call") continue;
    const transcript: TranscriptTurn[] = [];
    for (const event of record.events) {
      if (event.type === "transcript_final") {
        transcript.push({
          role: event.data.role as TranscriptTurn["role"],
          text: String(event.data.text),
          turnIndex: Number(event.data.turnIndex),
          spoken: event.data.spoken !== false,
        });
        continue;
      }
      if (event.type !== "decision") continue;
      const built = caseFromEvent(record.recordId, event, transcript);
      if (built) cases.push(built);
    }
  }
  return cases;
}

function caseFromEvent(recordId: string, event: TraceEvent, transcript: TranscriptTurn[]): DecisionCase | undefined {
  const d = event.data;
  const caseId = `${recordId}#${event.recordSeq}`;
  const nodeId = asText(d.nodeId);
  const answer = recordedAnswer(d);
  if (d.kind === "live_judge") {
    const action = asText(d.action);
    const modelId = asText(d.modelId);
    // "none": no decision model was configured, so nothing was asked; the case is still worth asking others.
    if (!modelId || (!answer && modelId !== "none")) return undefined;
    // The question comes from the live judge's own builder; an action it does not know falls back to its name.
    const known = JUDGE_ACTION_NAMES.includes(action);
    const q = known ? liveQuestionFor(action as JudgeAction, {}) : undefined;
    return {
      caseId,
      origin: "live_judge",
      nodeId,
      action,
      question: q?.question ?? `Should the agent carry out ${action} now?`,
      answers: q?.answers ?? ["allow", "block", "unclear"],
      ...(q ? { answerCriteria: q.criteria } : {}),
      transcript: [...transcript],
      modelAnswers: modelId === "none" || !answer ? {} : { [modelId]: answer },
    };
  }
  if (typeof d.question === "string" && Array.isArray(d.answers)) {
    const moduleId = asText(d.module, "none");
    return {
      caseId,
      origin: "tree_decision",
      nodeId,
      question: d.question,
      answers: d.answers.map(String),
      transcript: [...transcript],
      modelAnswers: answer ? { [moduleId]: answer } : {},
    };
  }
  return undefined;
}

/* --------------------------------------------------------- bounded workers */

/** Runs `work` over every item with at most `limit` in flight at once. Results keep the item order. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** TypeSafe rate-limits past about two requests in flight. */
export const DEFAULT_CONCURRENCY = 2;

export interface RunOptions {
  /** Requests in flight at once, across all models. Default 2. */
  concurrency?: number;
}

function toModelAnswer(outcome: DecisionModelOutcome): ModelAnswer {
  return outcome.ok ? { answer: outcome.answer, confidence: outcome.confidence } : { failed: outcome.code ?? outcome.reason };
}

/**
 * Asks every model the same question for every case, at most two requests in
 * flight. Returns new cases; an answer already on a case for the same model id
 * is replaced by the new one.
 */
export async function runModelsOnCases(
  cases: readonly DecisionCase[],
  models: readonly DecisionModel[],
  options: RunOptions = {},
): Promise<DecisionCase[]> {
  const out = cases.map((c) => ({ ...c, modelAnswers: { ...c.modelAnswers } }));
  const jobs = out.flatMap((c) => models.map((model) => ({ c, model })));
  await pool(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ c, model }) => {
    try {
      const outcome = await model.decide({
        nodeId: c.nodeId,
        question: c.question,
        answers: c.answers,
        transcript: c.transcript,
        ...(c.answerCriteria ? { answerCriteria: c.answerCriteria } : {}),
      });
      c.modelAnswers[model.id] = toModelAnswer(outcome);
    } catch (err) {
      // A model should not throw; if one does, the case records a failure and the run goes on.
      c.modelAnswers[model.id] = { failed: errorCode(err) };
    }
  });
  return out;
}

/* ------------------------------------------------------------------ Fable */

export interface FableLabel {
  answer: string;
  /** One sentence. Built from a redacted conversation. */
  why: string;
}

export interface FableLabeler {
  readonly id: string;
  /** Throws an error whose message is a short code when it cannot label. */
  label(c: DecisionCase): Promise<FableLabel>;
}

/** The conversation as plain lines, redacted. Unspoken and system turns are left out. */
export function renderConversation(transcript: readonly TranscriptTurn[]): string {
  const lines = transcript
    .filter((t) => t.role !== "system" && t.spoken !== false)
    .map((t) => `${t.role === "caller" ? "Caller" : "Agent"}: ${redactText(t.text).replace(/\s+/g, " ").trim()}`)
    .filter((line) => !/:\s*$/.test(line));
  return lines.length > 0 ? lines.join("\n") : "(nothing has been said yet)";
}

const FABLE_SYSTEM = [
  "You label one decision from a phone call between an insurance agency's automated assistant (Agent) and a small business owner (Caller).",
  "You are given a closed question and its list of answers. Pick the one answer that is right, judging only from the conversation you are shown.",
  "Only the Caller's words count as the Caller's answer. What the Agent says does not count as the Caller agreeing to it.",
  "Choose unclear when the conversation does not settle the question. Do not choose unclear to avoid a hard call.",
  "Personal details in the conversation are masked. Do not try to guess them, and do not repeat any in your reason.",
  "Give a reason in one short sentence.",
].join("\n");

export interface ClaudeFableLabelerOptions {
  client: ClaudeJsonClient;
  /** Default claude-fable-5-1. */
  model?: string;
  /** Default high. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export class ClaudeFableLabeler implements FableLabeler {
  readonly id: string;
  private readonly client: ClaudeJsonClient;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeFableLabelerOptions["effort"]>;

  constructor(options: ClaudeFableLabelerOptions) {
    this.client = options.client;
    this.model = options.model ?? FABLE_MODEL;
    this.effort = options.effort ?? "high";
    this.id = `fable:${this.model}`;
  }

  /** The prompt for one case. The models' own answers are never shown, so Fable is not anchored on them. */
  buildPrompt(c: DecisionCase): string {
    const answers = c.answers.map((a) => `- ${a}${c.answerCriteria?.[a] ? `: ${c.answerCriteria[a]}` : ""}`).join("\n");
    return [`Question: ${c.question}`, `Answers:\n${answers}`, `Conversation so far:\n${renderConversation(c.transcript)}`].join("\n\n");
  }

  async label(c: DecisionCase): Promise<FableLabel> {
    const raw = await this.client.askJson<{ answer?: unknown; why?: unknown }>({
      model: this.model,
      system: FABLE_SYSTEM,
      user: this.buildPrompt(c),
      schema: {
        type: "object",
        properties: { answer: { type: "string", enum: c.answers }, why: { type: "string" } },
        required: ["answer", "why"],
        additionalProperties: false,
      },
      effort: this.effort,
      maxTokens: 4000,
      // The Gateway documents no zero data retention for Fable on any provider.
      ...(this.model === FABLE_MODEL ? { zeroDataRetention: false } : {}),
    });
    if (typeof raw.answer !== "string" || !c.answers.includes(raw.answer)) throw new Error("fable_invalid_answer");
    return { answer: raw.answer, why: typeof raw.why === "string" ? raw.why.replace(/\s+/g, " ").trim() : "" };
  }
}

/** Deterministic labeler for tests. Pass answers by case id, or a function; the default picks the first answer that is not "unclear". */
export class MockFableLabeler implements FableLabeler {
  readonly id = "fable-mock";
  /** Every case id asked, in order. */
  readonly asked: string[] = [];

  constructor(private readonly choose: Record<string, string> | ((c: DecisionCase) => string) = {}) {}

  async label(c: DecisionCase): Promise<FableLabel> {
    this.asked.push(c.caseId);
    const answer =
      typeof this.choose === "function"
        ? this.choose(c)
        : (this.choose[c.caseId] ?? c.answers.find((a) => a !== "unclear") ?? "unclear");
    return { answer, why: "mock label" };
  }
}

export interface LabelRun {
  labels: Record<string, FableLabel>;
  /** Case id to a short code, for a case Fable could not label. */
  failures: Record<string, string>;
}

/** Labels every case, at most `concurrency` at once. A case that fails is listed and left unlabelled. */
export async function labelCases(cases: readonly DecisionCase[], labeler: FableLabeler, options: RunOptions = {}): Promise<LabelRun> {
  const run: LabelRun = { labels: {}, failures: {} };
  await pool(cases, options.concurrency ?? DEFAULT_CONCURRENCY, async (c) => {
    try {
      const label = await labeler.label(c);
      if (c.answers.includes(label.answer)) run.labels[c.caseId] = label;
      else run.failures[c.caseId] = "fable_invalid_answer";
    } catch (err) {
      run.failures[c.caseId] = errorCode(err);
    }
  });
  return run;
}

/* ---------------------------------------------------------------- analysis */

export type HandVerdicts = Record<string, string>;

export const FAILED_ROW = "(failed)";

export interface ConfusionTable {
  /** Model answers, then "(failed)" when any model call failed. */
  rows: string[];
  /** Fable answers. */
  columns: string[];
  /** `counts[row][column]` */
  counts: Record<string, Record<string, number>>;
}

export interface Disagreement {
  caseId: string;
  modelAnswer: string;
  modelConfidence: number;
  fableAnswer: string;
  why: string;
  /** The hand verdict, when it has been filled in. */
  handVerdict?: string;
}

export interface BarRecommendation {
  /** What the bar applies to: `live_judge:<action>` or `tree:<node id>`. */
  group: string;
  answer: string;
  /** The precision this answer must reach. */
  target: number;
  /** Cases where the model gave this answer (a failure is not an answer). */
  answered: number;
  /** Of those, cases whose adjudicated truth is known. */
  withTruth: number;
  /** The lowest bar on the grid that reaches the target with enough support; null when none does. */
  bar: number | null;
  /** At the recommended bar: cases above it, and how many of them were right. */
  supportAtBar: number | null;
  correctAtBar: number | null;
  /** Without a bar: the best precision seen on the grid (with enough support), its bar and support. */
  best: { bar: number; support: number; correct: number } | null;
  note: string;
}

export interface ModelAnalysis {
  modelId: string;
  /** Cases this model has an entry for and Fable labelled. */
  compared: number;
  /** Of those, the model gave no answer. */
  failures: number;
  /** Of those, the model answered and the answers match. */
  agreements: number;
  disagreements: Disagreement[];
  /** Disagreements with no valid hand verdict yet. */
  waitingForHandVerdict: number;
  confusion: ConfusionTable;
  bars: BarRecommendation[];
}

export interface FableAnalysis {
  models: ModelAnalysis[];
  casesTotal: number;
  /** Cases Fable labelled. */
  casesLabelled: number;
  /** Distinct cases with at least one disagreement still waiting for a hand verdict. */
  waitingCases: number;
  /** Hand verdicts given that were not one of the case's answers, and so were ignored. */
  invalidHandVerdicts: number;
  minSupport: number;
  durableTarget: number;
  otherTarget: number;
}

export interface AnalyzeOptions {
  /** Cases above a bar needed before the bar can be recommended. Default 5. */
  minSupport?: number;
  /** Target precision for durable answers. Default 0.95. */
  durableTarget?: number;
  /** Target precision for the rest. Default 0.9. */
  otherTarget?: number;
  /** Which answers are durable. The default: "allow" on book, transfer or a lasting ending, and "not_interested" or "do_not_call" in the tree. */
  isDurable?: (c: DecisionCase, answer: string) => boolean;
}

const LIVE_DURABLE_ACTIONS = new Set(["book", "transfer", "end_with_disposition"]);
const TREE_DURABLE_ANSWERS = new Set(["not_interested", "do_not_call"]);

/** The live judge event does not record whether an ending is lasting, so every ending's "allow" is held to the durable target. */
export function defaultIsDurable(c: DecisionCase, answer: string): boolean {
  if (c.origin === "live_judge") return answer === "allow" && LIVE_DURABLE_ACTIONS.has(c.action ?? "");
  return TREE_DURABLE_ANSWERS.has(answer);
}

function barGroup(c: DecisionCase): string {
  return c.origin === "live_judge" ? `live_judge:${c.action ?? "unknown"}` : `tree:${c.nodeId}`;
}

const GRID = Array.from({ length: 50 }, (_, i) => (50 + i) / 100);
const EPSILON = 1e-9;

function confusionOf(pairs: Array<{ row: string; column: string }>): ConfusionTable {
  const rows = new Set<string>();
  const columns = new Set<string>();
  for (const p of pairs) {
    rows.add(p.row);
    columns.add(p.column);
  }
  const sortedRows = [...rows].filter((r) => r !== FAILED_ROW).sort();
  if (rows.has(FAILED_ROW)) sortedRows.push(FAILED_ROW);
  const sortedColumns = [...columns].sort();
  const counts: Record<string, Record<string, number>> = {};
  for (const r of sortedRows) counts[r] = Object.fromEntries(sortedColumns.map((c) => [c, 0]));
  for (const p of pairs) counts[p.row]![p.column]! += 1;
  return { rows: sortedRows, columns: sortedColumns, counts };
}

interface BarItem {
  confidence: number;
  correct: boolean;
}

function recommendBars(
  entries: Array<{ c: DecisionCase; answer: string; confidence: number; truth: string | undefined }>,
  options: Required<Pick<AnalyzeOptions, "minSupport" | "durableTarget" | "otherTarget">> & { isDurable: NonNullable<AnalyzeOptions["isDurable"]> },
): BarRecommendation[] {
  const byKey = new Map<string, { group: string; answer: string; sample: DecisionCase; answered: number; items: BarItem[] }>();
  for (const e of entries) {
    const group = barGroup(e.c);
    const key = `${group}\u0000${e.answer}`;
    const slot = byKey.get(key) ?? { group, answer: e.answer, sample: e.c, answered: 0, items: [] };
    slot.answered += 1;
    if (e.truth !== undefined) slot.items.push({ confidence: e.confidence, correct: e.truth === e.answer });
    byKey.set(key, slot);
  }
  const out: BarRecommendation[] = [];
  for (const slot of [...byKey.values()].sort((a, b) => a.group.localeCompare(b.group) || a.answer.localeCompare(b.answer))) {
    const target = options.isDurable(slot.sample, slot.answer) ? options.durableTarget : options.otherTarget;
    let bar: BarRecommendation["bar"] = null;
    let supportAtBar: number | null = null;
    let correctAtBar: number | null = null;
    let best: BarRecommendation["best"] = null;
    for (const candidate of GRID) {
      const above = slot.items.filter((i) => i.confidence + EPSILON >= candidate);
      if (above.length < options.minSupport) continue;
      const correct = above.filter((i) => i.correct).length;
      const precision = correct / above.length;
      if (!best || precision > best.correct / best.support + EPSILON) best = { bar: candidate, support: above.length, correct };
      if (bar === null && precision + EPSILON >= target) {
        bar = candidate;
        supportAtBar = above.length;
        correctAtBar = correct;
      }
    }
    let note: string;
    if (bar !== null) {
      note = `${correctAtBar} of ${supportAtBar} answers at or above ${bar.toFixed(2)} were right, target ${target}`;
    } else if (best) {
      note = `no bar reaches the target ${target}; best was ${best.correct} of ${best.support} right at or above ${best.bar.toFixed(2)}`;
    } else {
      note = `no bar reaches the target ${target}; fewer than ${options.minSupport} answers with a known truth (${slot.items.length} known of ${slot.answered} given)`;
    }
    out.push({
      group: slot.group,
      answer: slot.answer,
      target,
      answered: slot.answered,
      withTruth: slot.items.length,
      bar,
      supportAtBar,
      correctAtBar,
      best: bar === null ? best : null,
      note,
    });
  }
  return out;
}

/**
 * Compares every model's answers with Fable's. `handVerdicts` maps a case id to
 * the right answer, judged by hand; a blank or unknown verdict counts as not
 * given. A failed model call appears in the confusion table and nowhere else.
 */
export function analyze(
  cases: readonly DecisionCase[],
  labels: Record<string, FableLabel>,
  handVerdicts: HandVerdicts = {},
  options: AnalyzeOptions = {},
): FableAnalysis {
  const minSupport = options.minSupport ?? 5;
  const durableTarget = options.durableTarget ?? 0.95;
  const otherTarget = options.otherTarget ?? 0.9;
  const isDurable = options.isDurable ?? defaultIsDurable;

  const verdictFor = (c: DecisionCase): string | undefined => {
    const v = handVerdicts[c.caseId]?.trim();
    return v && c.answers.includes(v) ? v : undefined;
  };
  const invalidHandVerdicts = cases.filter((c) => {
    const v = handVerdicts[c.caseId]?.trim();
    return Boolean(v) && !c.answers.includes(v!);
  }).length;

  const modelIds = [...new Set(cases.flatMap((c) => Object.keys(c.modelAnswers)))].sort();
  const waiting = new Set<string>();
  const models: ModelAnalysis[] = modelIds.map((modelId) => {
    const pairs: Array<{ row: string; column: string }> = [];
    const disagreements: Disagreement[] = [];
    const barEntries: Array<{ c: DecisionCase; answer: string; confidence: number; truth: string | undefined }> = [];
    let failures = 0;
    let agreements = 0;
    let waitingForHandVerdict = 0;
    let compared = 0;
    for (const c of cases) {
      const given = c.modelAnswers[modelId];
      const label = labels[c.caseId];
      if (!given || !label) continue;
      compared += 1;
      if (isFailed(given)) {
        failures += 1;
        pairs.push({ row: FAILED_ROW, column: label.answer });
        continue;
      }
      pairs.push({ row: given.answer, column: label.answer });
      const hand = verdictFor(c);
      const agreed = given.answer === label.answer;
      if (agreed) agreements += 1;
      else {
        disagreements.push({
          caseId: c.caseId,
          modelAnswer: given.answer,
          modelConfidence: given.confidence,
          fableAnswer: label.answer,
          why: label.why,
          ...(hand ? { handVerdict: hand } : {}),
        });
        if (!hand) {
          waitingForHandVerdict += 1;
          waiting.add(c.caseId);
        }
      }
      barEntries.push({ c, answer: given.answer, confidence: given.confidence, truth: hand ?? (agreed ? label.answer : undefined) });
    }
    return {
      modelId,
      compared,
      failures,
      agreements,
      disagreements,
      waitingForHandVerdict,
      confusion: confusionOf(pairs),
      bars: recommendBars(barEntries, { minSupport, durableTarget, otherTarget, isDurable }),
    };
  });

  return {
    models,
    casesTotal: cases.length,
    casesLabelled: cases.filter((c) => labels[c.caseId]).length,
    waitingCases: waiting.size,
    invalidHandVerdicts,
    minSupport,
    durableTarget,
    otherTarget,
  };
}

/* ------------------------------------------------------------------ report */

function tableMarkdown(table: ConfusionTable): string[] {
  if (table.rows.length === 0) return ["(no comparisons)"];
  return [
    `| model answer \\ Fable answer | ${table.columns.join(" | ")} |`,
    `|---|${table.columns.map(() => "---").join("|")}|`,
    ...table.rows.map((r) => `| ${r} | ${table.columns.map((c) => table.counts[r]![c]).join(" | ")} |`),
  ];
}

/** The analysis as markdown. Counts always come with what they are out of. */
export function renderReport(result: FableAnalysis): string {
  const lines = [
    "# Fable analysis",
    "",
    `Cases: ${result.casesTotal}. Labelled by Fable: ${result.casesLabelled} of ${result.casesTotal}.`,
    `Disagreements still waiting for a hand verdict: ${result.waitingCases} cases. Until they are judged those cases are left out of the bars.`,
    ...(result.invalidHandVerdicts > 0 ? [`Hand verdicts ignored because they are not one of the case's answers: ${result.invalidHandVerdicts}.`] : []),
    `Bars: lowest bar from 0.50 to 0.99 (step 0.01) where precision reaches ${result.durableTarget} for durable answers or ${result.otherTarget} for the rest, with at least ${result.minSupport} cases above the bar.`,
    "Agreement is not evidence of who is better. Only the disagreements, judged by hand, settle that.",
  ];
  for (const m of result.models) {
    lines.push("", `## ${m.modelId}`, "");
    lines.push(
      `Compared on ${m.compared} cases: agreed on ${m.agreements} of ${m.compared - m.failures} answered, ${m.disagreements.length} disagreements (${m.waitingForHandVerdict} waiting for a hand verdict), ${m.failures} calls gave no answer.`,
      "",
      ...tableMarkdown(m.confusion),
      "",
      "Recommended bars:",
      "",
    );
    if (m.bars.length === 0) lines.push("(no answers to set a bar for)");
    else {
      lines.push("| where | answer | bar | answers given | with a known truth | note |", "|---|---|---|---|---|---|");
      for (const b of m.bars) {
        lines.push(`| ${b.group} | ${b.answer} | ${b.bar === null ? "none" : b.bar.toFixed(2)} | ${b.answered} | ${b.withTruth} | ${b.note} |`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/* --------------------------------------------------------------- worksheet */

export interface WorksheetEntry {
  case_id: string;
  question: string;
  answers: string[];
  /** The last six spoken turns, redacted. */
  transcript_excerpt: Array<{ role: string; text: string }>;
  /** The models that disagreed with Fable on this case. */
  models: Array<{ model_id: string; answer: string; confidence: number }>;
  fable: { answer: string; why: string };
  /** Fill in with the right answer, one of `answers`. Left empty until judged. */
  hand_verdict: string;
}

const EXCERPT_TURNS = 6;

/** One entry per case with a disagreement. Pass `handVerdicts` to carry earlier verdicts into a regenerated worksheet. */
export function buildWorksheet(
  cases: readonly DecisionCase[],
  labels: Record<string, FableLabel>,
  result: FableAnalysis,
  handVerdicts: HandVerdicts = {},
): WorksheetEntry[] {
  const byCase = new Map<string, WorksheetEntry["models"]>();
  for (const m of result.models) {
    for (const d of m.disagreements) {
      const list = byCase.get(d.caseId) ?? [];
      list.push({ model_id: m.modelId, answer: d.modelAnswer, confidence: d.modelConfidence });
      byCase.set(d.caseId, list);
    }
  }
  const entries: WorksheetEntry[] = [];
  for (const c of cases) {
    const models = byCase.get(c.caseId);
    const label = labels[c.caseId];
    if (!models || !label) continue;
    const spoken = c.transcript.filter((t) => t.role !== "system" && t.spoken !== false);
    entries.push({
      case_id: c.caseId,
      question: c.question,
      answers: c.answers,
      transcript_excerpt: spoken.slice(-EXCERPT_TURNS).map((t) => ({ role: t.role, text: redactText(t.text).replace(/\s+/g, " ").trim() })),
      models,
      fable: { answer: label.answer, why: label.why },
      hand_verdict: handVerdicts[c.caseId] ?? "",
    });
  }
  return entries;
}

function worksheetMarkdown(entries: readonly WorksheetEntry[]): string {
  const lines = [
    "# Disagreements to judge by hand",
    "",
    `${entries.length} cases. For each, decide which answer is right and write it in the \`hand_verdict\` field of \`worksheet.json\` (one of the listed answers). Leave it empty to skip the case.`,
  ];
  for (const e of entries) {
    lines.push("", `## ${e.case_id}`, "", `Question: ${e.question}`, `Answers: ${e.answers.join(", ")}`, "", "Last turns:");
    for (const t of e.transcript_excerpt) lines.push(`- ${t.role === "caller" ? "Caller" : "Agent"}: ${t.text}`);
    lines.push("");
    for (const m of e.models) lines.push(`- ${m.model_id} said **${m.answer}** (confidence ${m.confidence.toFixed(2)})`);
    lines.push(`- Fable said **${e.fable.answer}**: ${e.fable.why}`, "", `hand_verdict: ${e.hand_verdict}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes `worksheet.md` and `worksheet.json` into `dir`, and returns their paths. */
export function writeWorksheet(dir: string, entries: readonly WorksheetEntry[]): { markdown: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const markdown = join(dir, "worksheet.md");
  const json = join(dir, "worksheet.json");
  writeFileSync(markdown, worksheetMarkdown(entries));
  writeFileSync(json, `${JSON.stringify({ entries }, null, 2)}\n`);
  return { markdown, json };
}

/** Reads the filled-in worksheet (its text, or the parsed value): case id to hand verdict, blanks left out. */
export function readHandVerdicts(json: unknown): HandVerdicts {
  let parsed = json;
  if (typeof json === "string") {
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("hand_verdicts_not_json");
    }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) throw new Error("hand_verdicts_not_a_worksheet");
  const verdicts: HandVerdicts = {};
  for (const item of list as Array<Record<string, unknown>>) {
    const id = item?.case_id;
    const verdict = item?.hand_verdict;
    if (typeof id === "string" && typeof verdict === "string" && verdict.trim()) verdicts[id] = verdict.trim();
  }
  return verdicts;
}
