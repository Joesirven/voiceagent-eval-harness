/**
 * Scoring for speaker diarization on two-speaker calls.
 *
 * Two metrics, because the available reference supports different things:
 *
 *  1. `diarizationErrorRate`: time-based, with a collar, for a reference that
 *     carries real start and end times (a hand-checked clip).
 *  2. `turnAttribution`: text-anchored. The live dialer transcript rows carry a
 *     speaker label and text but no start or end time, so time-based scoring is
 *     not valid against them. Instead each reference turn is matched to the
 *     hypothesis words by text, and the speaker the hypothesis gave those words
 *     is compared with the reference label, after the best one-to-one mapping
 *     between the two speaker naming schemes.
 *
 * The reference is track labels plus spot-checks, not a human listening.
 */

import type { SpeakerSegment, SpokenWord } from "./contract.js";

const FRAME = 0.01; // seconds

/** Options for the diarization error rate. */
export type DerOptions = {
  /**
   * Total width in seconds of the forgiveness window centred on every reference
   * segment boundary (half on each side), the convention of pyannote.metrics.
   */
  collar: number;
  /** When true, frames where the reference has two or more speakers are left out. */
  skipOverlap?: boolean;
};

/** Result of the diarization error rate: (missed + false alarm + confusion) over reference speech. */
export type DerResult = {
  /** (missed + false alarm + confusion) / reference speech, 0 when there is no reference speech. */
  der: number;
  missed: number;
  falseAlarm: number;
  confusion: number;
  referenceSpeech: number;
  /** Hypothesis speaker name to reference speaker name, the mapping that minimised confusion. */
  mapping: Record<string, string>;
};

function labelsAt(segments: SpeakerSegment[], frames: number): Set<string>[] {
  const out: Set<string>[] = Array.from({ length: frames }, () => new Set<string>());
  for (const s of segments) {
    const from = Math.max(0, Math.round(s.start / FRAME));
    const to = Math.min(frames, Math.round(s.end / FRAME));
    for (let i = from; i < to; i++) out[i].add(s.speaker);
  }
  return out;
}

/**
 * Best one-to-one mapping of hypothesis names onto reference names, found by
 * trying every partial assignment. Fine for two speakers; not for many.
 */
function bestMapping(
  refNames: string[],
  hypNames: string[],
  score: (mapping: Record<string, string>) => number,
): Record<string, string> {
  let best: Record<string, string> = {};
  let bestScore = -Infinity;
  const walk = (i: number, used: Set<string>, mapping: Record<string, string>): void => {
    if (i === hypNames.length) {
      const s = score(mapping);
      if (s > bestScore) {
        bestScore = s;
        best = { ...mapping };
      }
      return;
    }
    walk(i + 1, used, mapping);
    for (const r of refNames) {
      if (used.has(r)) continue;
      used.add(r);
      mapping[hypNames[i]] = r;
      walk(i + 1, used, mapping);
      delete mapping[hypNames[i]];
      used.delete(r);
    }
  };
  walk(0, new Set(), {});
  return best;
}

export function diarizationErrorRate(
  reference: SpeakerSegment[],
  hypothesis: SpeakerSegment[],
  options: DerOptions,
): DerResult {
  const end = Math.max(0, ...reference.map((s) => s.end), ...hypothesis.map((s) => s.end));
  const frames = Math.ceil(end / FRAME);
  const ref = labelsAt(reference, frames);
  const hyp = labelsAt(hypothesis, frames);

  const ignored = new Array<boolean>(frames).fill(false);
  const half = options.collar / 2;
  if (half > 0) {
    for (const s of reference) {
      for (const boundary of [s.start, s.end]) {
        const from = Math.max(0, Math.round((boundary - half) / FRAME));
        const to = Math.min(frames, Math.round((boundary + half) / FRAME));
        for (let i = from; i < to; i++) ignored[i] = true;
      }
    }
  }
  if (options.skipOverlap) ref.forEach((set, i) => (set.size > 1 ? (ignored[i] = true) : undefined));

  const refNames = [...new Set(reference.map((s) => s.speaker))];
  const hypNames = [...new Set(hypothesis.map((s) => s.speaker))];

  // Co-occurrence seconds, used to choose the mapping that agrees most.
  const agree = (mapping: Record<string, string>): number => {
    let total = 0;
    for (let i = 0; i < frames; i++) {
      if (ignored[i]) continue;
      for (const h of hyp[i]) if (mapping[h] && ref[i].has(mapping[h])) total++;
    }
    return total;
  };
  const mapping = bestMapping(refNames, hypNames, agree);

  let missed = 0;
  let falseAlarm = 0;
  let confusion = 0;
  let referenceSpeech = 0;
  for (let i = 0; i < frames; i++) {
    if (ignored[i]) continue;
    const nRef = ref[i].size;
    const nHyp = hyp[i].size;
    referenceSpeech += nRef;
    const correct = [...hyp[i]].filter((h) => mapping[h] && ref[i].has(mapping[h])).length;
    missed += Math.max(0, nRef - nHyp);
    falseAlarm += Math.max(0, nHyp - nRef);
    confusion += Math.min(nRef, nHyp) - correct;
  }
  const f = (n: number) => n * FRAME;
  return {
    der: referenceSpeech === 0 ? 0 : (missed + falseAlarm + confusion) / referenceSpeech,
    missed: f(missed),
    falseAlarm: f(falseAlarm),
    confusion: f(confusion),
    referenceSpeech: f(referenceSpeech),
    mapping,
  };
}

// ── Text-anchored turn attribution ───────────────────────────────────────────

export type ReferenceTurn = {
  speaker: string;
  text: string;
  /** Free tags used to report slices separately, for example "spanish" or "overlap". */
  tags?: string[];
};

export type TurnAttribution = {
  /** Turns whose words were found in the hypothesis. */
  scored: number;
  /** Turns with too little matched text to judge. Reported, never counted as right or wrong. */
  unmatched: number;
  correct: number;
  accuracy: number | null;
  /** The same figures, per tag. */
  byTag: Record<string, { scored: number; correct: number; accuracy: number | null }>;
  mapping: Record<string, string>;
};

export function normaliseToken(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function tokens(text: string): string[] {
  return text.split(/\s+/).map(normaliseToken).filter(Boolean);
}

/**
 * Longest-common-subsequence alignment of reference tokens to hypothesis tokens.
 * Returns, for each reference token index, the matched hypothesis index or -1.
 */
function alignTokens(ref: string[], hyp: string[]): number[] {
  const n = ref.length;
  const m = hyp.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ref[i] === hyp[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ref[i] === hyp[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * Scores speaker attribution per turn.
 *
 * `minMatched` is the share of a turn's tokens that must be found in the
 * hypothesis for the turn to be judged at all; below it the turn is `unmatched`.
 */
export function turnAttribution(
  reference: ReferenceTurn[],
  hypothesisWords: SpokenWord[],
  options: { minMatched?: number } = {},
): TurnAttribution {
  const minMatched = options.minMatched ?? 0.5;
  const hypTokens: string[] = [];
  const hypSpeakers: string[] = [];
  for (const w of hypothesisWords) {
    for (const t of tokens(w.text)) {
      hypTokens.push(t);
      hypSpeakers.push(w.speaker);
    }
  }
  const refTokens: string[] = [];
  const owner: number[] = [];
  reference.forEach((turn, idx) => {
    for (const t of tokens(turn.text)) {
      refTokens.push(t);
      owner.push(idx);
    }
  });
  const aligned = alignTokens(refTokens, hypTokens);

  const votes: Map<string, number>[] = reference.map(() => new Map());
  const matched = new Array<number>(reference.length).fill(0);
  const total = new Array<number>(reference.length).fill(0);
  aligned.forEach((hypIndex, k) => {
    const turn = owner[k];
    total[turn]++;
    if (hypIndex < 0) return;
    matched[turn]++;
    const speaker = hypSpeakers[hypIndex];
    votes[turn].set(speaker, (votes[turn].get(speaker) ?? 0) + 1);
  });

  const judged = reference
    .map((turn, idx) => ({ turn, idx }))
    .filter(({ idx }) => total[idx] > 0 && matched[idx] / total[idx] >= minMatched);
  const winner = (idx: number): string | null => {
    let best: string | null = null;
    let bestVotes = 0;
    for (const [speaker, n] of votes[idx]) {
      if (n > bestVotes) {
        best = speaker;
        bestVotes = n;
      }
    }
    return best;
  };

  const refNames = [...new Set(reference.map((t) => t.speaker))];
  const hypNames = [...new Set(hypSpeakers)];
  const mapping = bestMapping(refNames, hypNames, (candidate) =>
    judged.filter(({ turn, idx }) => {
      const w = winner(idx);
      return w !== null && candidate[w] === turn.speaker;
    }).length,
  );

  const byTag: TurnAttribution["byTag"] = {};
  let correct = 0;
  for (const { turn, idx } of judged) {
    const w = winner(idx);
    const ok = w !== null && mapping[w] === turn.speaker;
    if (ok) correct++;
    for (const tag of turn.tags ?? []) {
      const entry = (byTag[tag] ??= { scored: 0, correct: 0, accuracy: null });
      entry.scored++;
      if (ok) entry.correct++;
    }
  }
  for (const entry of Object.values(byTag)) entry.accuracy = entry.scored ? entry.correct / entry.scored : null;
  return {
    scored: judged.length,
    unmatched: reference.length - judged.length,
    correct,
    accuracy: judged.length ? correct / judged.length : null,
    byTag,
    mapping,
  };
}
