/**
 * Turn-level pairwise judging. Cut a real call just before a producer turn, ask
 * the agent for its one reply, and ask a pairwise judge which of the two
 * replies is the better next line. The judge sees "first" and "second", never
 * whose reply is whose, and runs twice with the order swapped so a judge that
 * simply favors a position cannot win or lose the comparison for the agent.
 */

import type {
  PastCall,
  PastCallSource,
  PairwiseJudge,
  PairwisePick,
  PastTurn,
  ReplyAgent,
  TurnJudgement,
  TurnVerdict,
} from "./types.js";

export interface SelectOptions {
  /** The producer turn needs at least this many turns before it. Default 2. */
  minPriorTurns?: number;
  /** The producer turn needs at least this many words, so "okay" and "mm-hmm" are skipped. Default 4. */
  minWords?: number;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Indexes of producer turns worth judging: they directly follow a lead turn,
 * have enough history and enough words. When the call carries `cleanTurns`,
 * both the producer turn and the lead turn before it must be listed there.
 */
export function selectProducerTurns(call: PastCall, options: SelectOptions = {}): number[] {
  const minPriorTurns = options.minPriorTurns ?? 2;
  const minWords = options.minWords ?? 4;
  const clean = call.cleanTurns ? new Set(call.cleanTurns) : null;
  const picked: number[] = [];
  call.turns.forEach((turn, index) => {
    if (turn.speaker !== "producer" || index < Math.max(minPriorTurns, 1)) return;
    if (call.turns[index - 1]!.speaker !== "lead") return;
    if (wordCount(turn.text) < minWords) return;
    if (clean && !(clean.has(index) && clean.has(index - 1))) return;
    picked.push(index);
  });
  return picked;
}

/** The four mappings from the design note. Agent shown first, then producer shown first. */
export function verdictFor(picks: [PairwisePick, PairwisePick]): TurnVerdict {
  const [agentFirst, producerFirst] = picks;
  if (agentFirst === "first" && producerFirst === "second") return "better";
  if (agentFirst === "second" && producerFirst === "first") return "worse";
  if (agentFirst === "same" && producerFirst === "same") return "same";
  return "inconsistent";
}

export async function judgeTurn(input: {
  call: PastCall;
  turnIndex: number;
  agent: ReplyAgent;
  judge: PairwiseJudge;
}): Promise<TurnJudgement> {
  const { call, turnIndex, agent, judge } = input;
  const target = call.turns[turnIndex];
  if (!target || target.speaker !== "producer" || turnIndex < 1) throw new Error("turn_judge_bad_turn_index");
  const history = (): PastTurn[] => call.turns.slice(0, turnIndex).map((turn) => ({ ...turn }));

  const producerReply = target.text;
  const agentReply = await agent.reply(history());
  // Each ask gets its own copy of the history so no judge can change what the next one reads.
  const agentFirst = await judge.compare({ history: history(), first: agentReply, second: producerReply });
  const producerFirst = await judge.compare({ history: history(), first: producerReply, second: agentReply });
  const picks: [PairwisePick, PairwisePick] = [agentFirst, producerFirst];
  return { callId: call.callId, turnIndex, agentReply, producerReply, picks, verdict: verdictFor(picks) };
}

export interface TurnJudgingSummary {
  /** Judgements made, counting inconsistent ones. */
  total: number;
  better: number;
  worse: number;
  same: number;
  inconsistent: number;
  /** better + worse + same: the verdicts that count. */
  consistent: number;
  /** better / consistent. Null when no verdict was consistent, since a rate over nothing is not a rate. */
  winRate: number | null;
  /** The denominator written out, so the number never travels without it. */
  winRateDenominator: string;
}

export function summarize(judgements: readonly TurnJudgement[]): TurnJudgingSummary {
  const count = (verdict: TurnVerdict) => judgements.filter((j) => j.verdict === verdict).length;
  const better = count("better");
  const worse = count("worse");
  const same = count("same");
  const consistent = better + worse + same;
  return {
    total: judgements.length,
    better,
    worse,
    same,
    inconsistent: count("inconsistent"),
    consistent,
    winRate: consistent === 0 ? null : better / consistent,
    winRateDenominator: `${consistent} consistent verdicts (better + worse + same); inconsistent verdicts excluded`,
  };
}

export interface TurnFailure {
  callId: string;
  turnIndex: number | null;
  /** A short code, never error text. */
  code: string;
}

export interface TurnJudgingResult {
  judgements: TurnJudgement[];
  summary: TurnJudgingSummary;
  /** Calls asked for, calls found, and calls that had at least one turn worth judging. */
  calls: { requested: number; found: number; judged: number };
  failures: TurnFailure[];
}

function errorCode(err: unknown, fallback: string): string {
  return err instanceof Error && /^[a-z0-9_:]+$/.test(err.message) ? err.message : fallback;
}

export async function runTurnJudging(input: {
  source: PastCallSource;
  callIds: readonly string[];
  agent: ReplyAgent;
  judge: PairwiseJudge;
  select?: SelectOptions;
  /** Judge at most this many turns per call, earliest first. Default: all of them. */
  maxTurnsPerCall?: number;
  /** Called after each judgement, for progress counts and incremental output. */
  onJudgement?: (judgement: TurnJudgement) => void;
}): Promise<TurnJudgingResult> {
  const judgements: TurnJudgement[] = [];
  const failures: TurnFailure[] = [];
  let found = 0;
  let judged = 0;
  for (const callId of input.callIds) {
    let call: PastCall | null;
    try {
      call = await input.source.getCall(callId);
    } catch (err) {
      failures.push({ callId, turnIndex: null, code: errorCode(err, "past_call_read_failed") });
      continue;
    }
    if (!call) continue;
    found += 1;
    const indexes = selectProducerTurns(call, input.select).slice(0, input.maxTurnsPerCall);
    if (indexes.length > 0) judged += 1;
    for (const turnIndex of indexes) {
      try {
        const judgement = await judgeTurn({ call, turnIndex, agent: input.agent, judge: input.judge });
        judgements.push(judgement);
        input.onJudgement?.(judgement);
      } catch (err) {
        failures.push({ callId, turnIndex, code: errorCode(err, "turn_judge_failed") });
      }
    }
  }
  return {
    judgements,
    summary: summarize(judgements),
    calls: { requested: input.callIds.length, found, judged },
    failures,
  };
}
