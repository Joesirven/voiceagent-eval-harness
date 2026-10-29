/**
 * Scores one diarization result against one reference and prints aggregate numbers as JSON.
 *
 *   pnpm tsx scripts/score-diarization.ts RESULT.json REFERENCE.json [--collar 0.25]
 *
 * RESULT.json is a `DiarizationResult` (see `src/diarization/azure.ts` for converting an Azure response). REFERENCE.json is
 * `{ "segments": [...], "turns": [...] }`: `segments` (timed, optional) feed the
 * error rate, `turns` (speaker, text, tags) feed per-turn attribution. Tag turns
 * "spanish" and "overlap" to have those slices reported separately.
 *
 * Prints numbers only, never text from the reference, so the output can be pasted
 * into an aggregate report.
 */

import { readFileSync } from "node:fs";
import { parseDiarizationResult } from "../src/diarization/contract.js";
import { diarizationErrorRate, turnAttribution, type ReferenceTurn } from "../src/diarization/score.js";
import type { SpeakerSegment } from "../src/diarization/contract.js";

const [resultPath, referencePath, ...rest] = process.argv.slice(2);
if (!resultPath || !referencePath) {
  console.error("usage: score-diarization RESULT.json REFERENCE.json [--collar 0.25]");
  process.exit(2);
}
const collarIndex = rest.indexOf("--collar");
const collar = collarIndex >= 0 ? Number(rest[collarIndex + 1]) : 0.25;
if (!Number.isFinite(collar) || collar < 0) {
  console.error("--collar must be a non-negative number of seconds");
  process.exit(2);
}

const result = parseDiarizationResult(readFileSync(resultPath, "utf8"));
const reference = JSON.parse(readFileSync(referencePath, "utf8")) as { segments?: SpeakerSegment[]; turns?: ReferenceTurn[] };

const report: Record<string, unknown> = {
  engine: result.engine,
  audioSeconds: result.audioSeconds,
  runSeconds: result.runSeconds,
  realTimeFactor: result.audioSeconds ? result.runSeconds / result.audioSeconds : null,
  speakersFound: new Set(result.segments.map((s) => s.speaker)).size,
  overlapSeconds: result.overlaps.reduce((sum, o) => sum + (o.end - o.start), 0),
};
if (reference.segments?.length) {
  const withOverlap = diarizationErrorRate(reference.segments, result.segments, { collar });
  const withoutOverlap = diarizationErrorRate(reference.segments, result.segments, { collar, skipOverlap: true });
  report.collarSeconds = collar;
  report.diarizationErrorRate = withOverlap.der;
  report.diarizationErrorRateSkippingOverlap = withoutOverlap.der;
  report.errorSeconds = { missed: withOverlap.missed, falseAlarm: withOverlap.falseAlarm, confusion: withOverlap.confusion };
}
if (reference.turns?.length && result.words?.length) {
  const t = turnAttribution(reference.turns, result.words);
  report.turnAttribution = { scored: t.scored, unmatched: t.unmatched, correct: t.correct, accuracy: t.accuracy, byTag: t.byTag };
} else if (reference.turns?.length) {
  report.turnAttribution = "skipped: the result has no words (the engine returned no word text)";
}
console.log(JSON.stringify(report, null, 1));
