/**
 * Turns the responses of the two Azure transcription paths into `DiarizationResult`.
 *
 * Both response shapes below are written from Microsoft's documentation and have
 * NOT yet been checked against a live response: no Azure speech resource or
 * diarization deployment has been called. Check them against the first real
 * response before trusting a score.
 *
 *  · Azure AI Speech, fast transcription (`diarization: { enabled: true, maxSpeakers: 2 }`):
 *    `phrases[]` with `speaker` (a number), `offsetMilliseconds`, `durationMilliseconds`,
 *    `text`, `locale` and `words[]`.
 *  · Azure OpenAI `gpt-4o-transcribe-diarize` with the diarized JSON response format:
 *    `segments[]` with `speaker` (a label), `start`, `end` (seconds) and `text`.
 */

import type { DiarizationResult, SpeakerSegment, SpokenWord } from "./contract.js";

type SpeechWord = { text?: string; offsetMilliseconds?: number; durationMilliseconds?: number };
type SpeechPhrase = {
  speaker?: number | string;
  offsetMilliseconds?: number;
  durationMilliseconds?: number;
  text?: string;
  locale?: string;
  words?: SpeechWord[];
};

function overlapsOf(segments: SpeakerSegment[]): { start: number; end: number }[] {
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const found: { start: number; end: number }[] = [];
  ordered.forEach((a, i) => {
    for (const b of ordered.slice(i + 1)) {
      if (b.start >= a.end) break;
      if (a.speaker !== b.speaker) found.push({ start: b.start, end: Math.min(a.end, b.end) });
    }
  });
  return found;
}

export function fromAzureSpeechFastTranscription(
  response: { phrases?: SpeechPhrase[] },
  meta: { engine: string; audioSeconds: number; runSeconds: number },
): DiarizationResult {
  const segments: SpeakerSegment[] = [];
  const words: SpokenWord[] = [];
  for (const phrase of response.phrases ?? []) {
    if (phrase.speaker === undefined || phrase.offsetMilliseconds === undefined || phrase.durationMilliseconds === undefined) {
      // A response with phrases but no speakers means diarization was off or the shape differs; fail loudly.
      throw new Error("an Azure Speech phrase has no speaker or times: diarization was not enabled, or the response shape differs from the documented one");
    }
    const speaker = `speaker_${phrase.speaker}`;
    const start = phrase.offsetMilliseconds / 1000;
    segments.push({ start, end: start + phrase.durationMilliseconds / 1000, speaker });
    for (const w of phrase.words ?? []) {
      if (w.text === undefined || w.offsetMilliseconds === undefined) continue;
      const ws = w.offsetMilliseconds / 1000;
      words.push({
        start: ws,
        end: ws + (w.durationMilliseconds ?? 0) / 1000,
        speaker,
        text: w.text,
        ...(phrase.locale ? { language: phrase.locale } : {}),
      });
    }
  }
  return { ...meta, segments, words, overlaps: overlapsOf(segments) };
}

export function fromAzureOpenAiDiarized(
  response: { segments?: { speaker?: string; start?: number; end?: number; text?: string }[] },
  meta: { engine: string; audioSeconds: number; runSeconds: number },
): DiarizationResult {
  const segments: SpeakerSegment[] = [];
  const words: SpokenWord[] = [];
  for (const s of response.segments ?? []) {
    if (!s.speaker || s.start === undefined || s.end === undefined) continue;
    segments.push({ start: s.start, end: s.end, speaker: s.speaker });
    // Segment level only: the whole segment text is one entry, which is enough for text-anchored scoring.
    if (s.text) words.push({ start: s.start, end: s.end, speaker: s.speaker, text: s.text });
  }
  return { ...meta, segments, words, overlaps: overlapsOf(segments) };
}
