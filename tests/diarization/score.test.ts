import { describe, expect, it } from "vitest";
import { parseDiarizationResult } from "../../src/diarization/contract.js";
import { diarizationErrorRate, turnAttribution } from "../../src/diarization/score.js";

const reference = [
  { start: 0, end: 10, speaker: "agent" },
  { start: 10, end: 20, speaker: "prospect" },
];

describe("diarizationErrorRate", () => {
  it("is zero for a perfect hypothesis whatever the speaker names are", () => {
    const hyp = [
      { start: 0, end: 10, speaker: "SPEAKER_01" },
      { start: 10, end: 20, speaker: "SPEAKER_00" },
    ];
    const r = diarizationErrorRate(reference, hyp, { collar: 0 });
    expect(r.der).toBe(0);
    expect(r.mapping).toEqual({ SPEAKER_01: "agent", SPEAKER_00: "prospect" });
  });

  it("counts a swapped second half as confusion", () => {
    const hyp = [
      { start: 0, end: 15, speaker: "a" },
      { start: 15, end: 20, speaker: "b" },
    ];
    const r = diarizationErrorRate(reference, hyp, { collar: 0 });
    expect(r.confusion).toBeCloseTo(5, 1);
    expect(r.der).toBeCloseTo(0.25, 2);
  });

  it("forgives a boundary that is late by less than half the collar, and not by more", () => {
    const hyp = [
      { start: 0, end: 10.2, speaker: "a" },
      { start: 10.2, end: 20, speaker: "b" },
    ];
    expect(diarizationErrorRate(reference, hyp, { collar: 0.5 }).der).toBe(0);
    expect(diarizationErrorRate(reference, hyp, { collar: 0.2 }).der).toBeGreaterThan(0);
  });

  it("counts missed speech and false alarms", () => {
    const hyp = [{ start: 0, end: 5, speaker: "a" }, { start: 12, end: 20, speaker: "b" }, { start: 20, end: 25, speaker: "b" }];
    const r = diarizationErrorRate(reference, hyp, { collar: 0 });
    expect(r.missed).toBeCloseTo(7, 1);
    expect(r.falseAlarm).toBeCloseTo(5, 1);
  });

  it("can leave reference overlap out", () => {
    const refOverlap = [...reference, { start: 8, end: 12, speaker: "prospect" }];
    const hyp = [{ start: 0, end: 20, speaker: "a" }];
    const withOverlap = diarizationErrorRate(refOverlap, hyp, { collar: 0 });
    const without = diarizationErrorRate(refOverlap, hyp, { collar: 0, skipOverlap: true });
    expect(without.referenceSpeech).toBeLessThan(withOverlap.referenceSpeech);
  });
});

describe("turnAttribution", () => {
  const turns = [
    { speaker: "agent", text: "Hola, buenos días. ¿Hablo con el dueño?" , tags: ["spanish"] },
    { speaker: "prospect", text: "Sí, soy yo. ¿Quién llama?", tags: ["spanish"] },
    { speaker: "agent", text: "I am calling about your workers compensation renewal" },
  ];
  const words = (speaker: string, text: string) =>
    text.split(" ").map((w, i) => ({ start: i, end: i + 1, speaker, text: w }));

  it("scores per turn after mapping, ignoring accents, case and punctuation", () => {
    const hyp = [
      ...words("S1", "hola buenos dias hablo con el dueno"),
      ...words("S0", "si soy yo quien llama"),
      ...words("S1", "i am calling about your workers compensation renewal"),
    ];
    const r = turnAttribution(turns, hyp);
    expect(r.accuracy).toBe(1);
    expect(r.mapping).toEqual({ S1: "agent", S0: "prospect" });
    expect(r.byTag.spanish).toEqual({ scored: 2, correct: 2, accuracy: 1 });
  });

  it("reports a turn with too little matched text as unmatched rather than wrong", () => {
    const hyp = words("S1", "hola buenos dias hablo con el dueno");
    const r = turnAttribution(turns, hyp);
    expect(r.scored).toBe(1);
    expect(r.unmatched).toBe(2);
  });

  it("counts a turn given to the wrong speaker as wrong", () => {
    const hyp = [
      ...words("S1", "hola buenos dias hablo con el dueno"),
      ...words("S0", "si soy yo quien llama"),
      ...words("S0", "i am calling about your workers compensation renewal"),
    ];
    const r = turnAttribution(turns, hyp);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBeCloseTo(2 / 3, 5);
  });
});

describe("parseDiarizationResult", () => {
  const ok = { engine: "x", audioSeconds: 3, runSeconds: 1, segments: [{ start: 0, end: 1, speaker: "A" }] };

  it("accepts a well-formed result and defaults overlaps", () => {
    expect(parseDiarizationResult(JSON.stringify(ok)).overlaps).toEqual([]);
  });

  it("rejects a segment that ends before it starts", () => {
    const bad = { ...ok, segments: [{ start: 2, end: 1, speaker: "A" }] };
    expect(() => parseDiarizationResult(JSON.stringify(bad))).toThrow(/impossible/);
  });

  it("rejects a result with no engine", () => {
    expect(() => parseDiarizationResult(JSON.stringify({ ...ok, engine: "" }))).toThrow(/engine/);
  });
});
