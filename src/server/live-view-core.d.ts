import type { TraceEvent } from "../trace/events.js";

export interface View { events: Map<string, TraceEvent>; }
export type SortedEvent = TraceEvent & { ms: number };
export interface Line { key: string; role: string; text: string; final: boolean; ms: number; seq: number; endMs: number; }
export interface Row { event: SortedEvent; kind: string; bad: boolean; text: string; }
export interface Group { line: Line | null; rows: Row[]; }
export interface TreeEdge { answer: string; to: string | null; }
export interface TreeNode {
  id: string;
  label: string;
  question?: string;
  minConfidence?: number;
  disposition?: string;
  edges: TreeEdge[];
  bars?: Record<string, number>;
}
export interface StageBranch {
  answer: string;
  destination: string;
  minConfidence: number | null;
  modelConfidence: number | null;
  taken: boolean;
  clarify: boolean;
}
export interface StageView {
  nodeId: string | null;
  label: string | null;
  question: string | null;
  module: string | null;
  branches: StageBranch[];
  path: Array<{ nodeId: string; label: string; ms: number }>;
}
export interface TreeJson { start: string; nodes: TreeNode[]; dispositions: string[]; }
export interface Summary {
  nodeId: string | null;
  disposition: string | null;
  decision: Record<string, any> | null;
  agentSaid: Line | null;
  verdicts: Array<Record<string, any>>;
  score: Record<string, any> | null;
  ended: boolean;
}

export function createView(): View;
export function ingest(view: View, event: TraceEvent): boolean;
export function callIdsOf(view: View): string[];
export function latestCallId(view: View): string | null;
export function eventsFor(events: Iterable<TraceEvent>, callId?: string | null): SortedEvent[];
export function buildTranscript(sorted: SortedEvent[]): Line[];
export function describeRow(e: TraceEvent): { kind: string; bad: boolean; text: string };
export function align(sorted: SortedEvent[]): Group[];
export function summarize(sorted: SortedEvent[], recordJudge?: Record<string, any> | null): Summary;
export function layoutTree(tree: TreeJson): { placed: Array<{ node: TreeNode; col: number; row: number }>; columns: number; rows: number };
export function findTreeNode(tree: TreeJson, nodeId: string | null | undefined): TreeNode | null;
export function edgeDestination(tree: TreeJson, edge: TreeEdge): string;
export function buildStage(tree: TreeJson, sorted: SortedEvent[], summary: Summary): StageView;
export interface JudgeRow {
  key: string;
  ms: number;
  action: string;
  allowed: boolean;
  reasonCode: string;
  confidence: number | null;
  answer: string | null;
  blockThreshold: number | null;
  failureReason: string | null;
  latencyMs: number | null;
  /** How many times the decision model was asked; null when no model was asked. */
  attemptCount: number | null;
  /** Each attempt: number, outcome code ("answered", "timeout", "error", ...) and latency. */
  attempts: Array<{ n: number; outcome: string; latencyMs: number }>;
  modelId: string | null;
  modelKind: string | null;
  passed: number;
  checked: number;
}
export function judgeRows(sorted: SortedEvent[]): JudgeRow[];
export function attemptsText(row: Pick<JudgeRow, "attempts">): string;
export function judgeLine(row: JudgeRow): string;
