import { describe, expect, it } from "vitest";
import { fromAzureOpenAiDiarized, fromAzureSpeechFastTranscription } from "../../src/diarization/azure.js";
import { turnAttribution } from "../../src/diarization/score.js";

const meta = { engine: "test", audioSeconds: 10, runSeconds: 2 };

describe("fromAzureSpeechFastTranscription", () => {
  const response = {
    phrases: [
      { speaker: 1, offsetMilliseconds: 0, durationMilliseconds: 2000, locale: "en-US", text: "hello there",
        words: [{ text: "hello", offsetMilliseconds: 0, durationMilliseconds: 500 }, { text: "there", offsetMilliseconds: 600, durationMilliseconds: 500 }] },
      { speaker: 2, offsetMilliseconds: 1500, durationMilliseconds: 2000, locale: "es-MX", text: "hola",
        words: [{ text: "hola", offsetMilliseconds: 1600, durationMilliseconds: 400 }] },
    ],
  };

  it("converts milliseconds to seconds, names speakers, keeps language and finds overlap", () => {
    const r = fromAzureSpeechFastTranscription(response, meta);
    expect(r.segments).toEqual([
      { start: 0, end: 2, speaker: "speaker_1" },
      { start: 1.5, end: 3.5, speaker: "speaker_2" },
    ]);
    expect(r.words?.map((w) => w.language)).toEqual(["en-US", "en-US", "es-MX"]);
    expect(r.overlaps).toEqual([{ start: 1.5, end: 2 }]);
  });

  it("feeds the attribution scorer", () => {
    const r = fromAzureSpeechFastTranscription(response, meta);
    const t = turnAttribution([{ speaker: "agent", text: "hello there" }, { speaker: "prospect", text: "hola" }], r.words ?? []);
    expect(t.accuracy).toBe(1);
  });
});

describe("fromAzureSpeechFastTranscription with no speakers", () => {
  it("throws rather than returning an empty result", () => {
    expect(() => fromAzureSpeechFastTranscription({ phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 10, text: "x" }] }, meta)).toThrow(/diarization/);
  });
});

describe("fromAzureOpenAiDiarized", () => {
  it("skips segments with no speaker or times", () => {
    const r = fromAzureOpenAiDiarized({ segments: [{ speaker: "A", start: 0, end: 1, text: "hi" }, { start: 1, end: 2, text: "x" }] }, meta);
    expect(r.segments).toHaveLength(1);
    expect(r.words?.[0].text).toBe("hi");
  });
});
