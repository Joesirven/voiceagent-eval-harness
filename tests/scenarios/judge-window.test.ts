import { describe, expect, it } from "vitest";
import { judgeLine, judgeRows, type SortedEvent } from "../../src/server/live-view-core.js";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): SortedEvent =>
  ({ seq: (seq += 1), recordId: "rec-1", recordSeq: seq, ms: seq * 100, type, data }) as unknown as SortedEvent;

describe("judge rows for the control page", () => {
  it("turns an allowed live verdict into a row with the model, answer, confidence, block threshold and latency", () => {
    const rows = judgeRows([
      ev("decision", { kind: "live_judge", action: "book", modelId: "jev-mock", modelKind: "mock", answer: "allow", confidence: 0.93, blockThreshold: 0.7, latencyMs: 210 }),
      ev("judge_verdict", {
        action: "book", allowed: true, reason: "the decision model agreed",
        evidence: "caller words that must not be copied",
        scores: [{ criterion: "a", score: 1, note: "" }, { criterion: "b", score: 1, note: "" }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "book", allowed: true, answer: "allow", confidence: 0.93, blockThreshold: 0.7, latencyMs: 210, modelId: "jev-mock", passed: 2, checked: 2 });
    expect(judgeLine(rows[0])).toBe("allowed book · 2/2 checks · model said allow · 93% · 210ms");
    expect(JSON.stringify(rows)).not.toContain("must not be copied");
  });

  it("shows the attempt count and each attempt's outcome code and latency", () => {
    const rows = judgeRows([
      ev("decision", {
        kind: "live_judge", action: "book", modelId: "azure", modelKind: "real", answer: "allow", confidence: 0.9, blockThreshold: 0.7, latencyMs: 1500,
        attemptCount: 2, attempts: [{ n: 1, outcome: "timeout", latencyMs: 3000 }, { n: 2, outcome: "answered", latencyMs: 1500 }],
      }),
      ev("judge_verdict", { action: "book", allowed: true, reason: "ok", scores: [] }),
    ]);
    expect(rows[0]).toMatchObject({ attemptCount: 2, attempts: [{ n: 1, outcome: "timeout", latencyMs: 3000 }, { n: 2, outcome: "answered", latencyMs: 1500 }] });
    expect(judgeLine(rows[0])).toContain("2 attempts (1 timeout 3000ms, 2 answered 1500ms)");
  });

  it("turns a refused rule-only verdict into a row with no model figures", () => {
    const rows = judgeRows([
      ev("judge_verdict", {
        action: "save_quote_field", allowed: false, reason: "no figure in the caller's words",
        scores: [{ criterion: "a", score: 0, note: "" }, { criterion: "b", score: 1, note: "" }],
      }),
    ]);
    expect(rows[0]).toMatchObject({ allowed: false, confidence: null, latencyMs: null, modelId: null, passed: 1, checked: 2 });
    expect(judgeLine(rows[0])).toBe("REFUSED save_quote_field · 1/2 checks");
  });

  it("pairs each verdict with the decision for its own action, and gives no rows for a call with no verdicts", () => {
    const rows = judgeRows([
      ev("decision", { kind: "live_judge", action: "transfer", confidence: 0.9, latencyMs: 50 }),
      ev("decision", { kind: "live_judge", action: "book", confidence: 0.5, latencyMs: 70 }),
      ev("judge_verdict", { action: "book", allowed: false, reason: "r", scores: [] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ confidence: 0.5, latencyMs: 70, checked: 0 });
    expect(judgeRows([ev("node_enter", { nodeId: "start" }), ev("call_outcome", { status: "ai_handled" })])).toEqual([]);
  });
});
