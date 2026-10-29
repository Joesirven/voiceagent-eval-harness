/**
 * The JSON a diarization run returns for one audio file, whichever engine made it.
 *
 * `azure.ts` produces this shape from the two Azure responses; the scorer in `score.ts` reads it.
 * Times are seconds from the start of the audio file.
 */

export type SpeakerSegment = { start: number; end: number; speaker: string };

export type SpokenWord = { start: number; end: number; speaker: string; text: string; language?: string };

export type DiarizationResult = {
  /** Which engine and model made this, for example "azure-ai-speech-fast-transcription". */
  engine: string;
  audioSeconds: number;
  /** Seconds the run took on the wall clock, so cost and speed can be compared. */
  runSeconds: number;
  segments: SpeakerSegment[];
  /** Present only when the run also transcribed. */
  words?: SpokenWord[];
  /** Stretches where two speakers talk at once, taken from the segments. */
  overlaps: { start: number; end: number }[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSegment(raw: unknown, index: number): SpeakerSegment {
  const r = raw as Partial<SpeakerSegment> | null;
  if (!r || !isFiniteNumber(r.start) || !isFiniteNumber(r.end) || typeof r.speaker !== "string" || r.speaker === "") {
    throw new Error(`segment ${index} is malformed`);
  }
  if (r.start < 0 || r.end < r.start) throw new Error(`segment ${index} has an impossible time range`);
  return { start: r.start, end: r.end, speaker: r.speaker };
}

/** Parses and checks a result. Throws with the first problem found; never returns a partial result. */
export function parseDiarizationResult(json: string): DiarizationResult {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw.engine !== "string" || raw.engine === "") throw new Error("engine is missing");
  if (!isFiniteNumber(raw.audioSeconds) || raw.audioSeconds < 0) throw new Error("audioSeconds is missing");
  if (!isFiniteNumber(raw.runSeconds) || raw.runSeconds < 0) throw new Error("runSeconds is missing");
  if (!Array.isArray(raw.segments)) throw new Error("segments is missing");
  const segments = raw.segments.map(parseSegment);
  const words = Array.isArray(raw.words)
    ? raw.words.map((w, i): SpokenWord => {
        const base = parseSegment(w, i);
        const text = (w as { text?: unknown }).text;
        if (typeof text !== "string") throw new Error(`word ${i} has no text`);
        const language = (w as { language?: unknown }).language;
        return { ...base, text, ...(typeof language === "string" ? { language } : {}) };
      })
    : undefined;
  const overlaps = Array.isArray(raw.overlaps)
    ? raw.overlaps.map((o, i) => {
        const s = parseSegment({ ...(o as object), speaker: "overlap" }, i);
        return { start: s.start, end: s.end };
      })
    : [];
  return {
    engine: raw.engine,
    audioSeconds: raw.audioSeconds,
    runSeconds: raw.runSeconds,
    segments,
    ...(words ? { words } : {}),
    overlaps,
  };
}
