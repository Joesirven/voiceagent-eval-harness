// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../test/setup";
import * as core from "../../../src/server/live-view-core.js";
import { JudgeBody } from "./JudgeDialog";
import { Transcript } from "./Transcript";

afterEach(cleanup);

let seq = 0;
const ev = (type: string, atMs: number, data: Record<string, unknown>) =>
  ({ seq: (seq += 1), recordSeq: seq, recordId: "rec-1", at: "2026-10-19T10:00:00.000Z", atMs, type, leadId: "lead-1", callId: "call-1", channel: "call", data }) as any;

describe("combined transcript and reasoning column", () => {
  it("shows each line followed by its own reasoning rows, as text only", () => {
    const events = [
      ev("transcript_final", 100, { role: "caller", text: "<b>I want a quote</b>", turnIndex: 1 }),
      ev("decision", 150, { answer: "quote", confidence: 0.9, minConfidence: 0.6, module: "m", reason: "r", routed: "proceed" }),
      ev("transcript_final", 400, { role: "agent", text: "Sure.", turnIndex: 2 }),
    ];
    const sorted = core.eventsFor(events, "call-1");
    const { container } = render(
      <Transcript sorted={sorted} groups={core.align(sorted)} judge={core.judgeRows(sorted)} plain={() => undefined} score={null} />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>I want a quote</b>");
    const text = container.textContent!;
    expect(text.indexOf("I want a quote")).toBeLessThan(text.indexOf("Reasoning"));
    expect(text.indexOf("Reasoning")).toBeLessThan(text.indexOf("Sure."));
    // Each step is a Trace line; opening one reveals its developer detail.
    expect(text).toContain("Reasoning · 1 step");
    const trigger = container.querySelector('[title="Developer detail"]') as HTMLElement;
    fireEvent.click(trigger);
    expect(screen.getAllByText(/Developer detail/).length).toBeGreaterThan(0);
  });

  it("shows an empty state before any call", () => {
    render(<Transcript sorted={[]} groups={[]} judge={[]} plain={() => undefined} score={null} />);
    expect(screen.getByText("No call yet")).toBeTruthy();
  });
});

describe("judge rows", () => {
  it("shows the verdict, confidence against the threshold and every attempt", () => {
    const sorted = core.eventsFor([
      ev("decision", 10, { kind: "live_judge", action: "book", modelId: "azure", modelKind: "real", answer: "allow", confidence: 0.9, blockThreshold: 0.7, latencyMs: 1500, attemptCount: 2, attempts: [{ n: 1, outcome: "timeout", latencyMs: 3000 }, { n: 2, outcome: "answered", latencyMs: 1500 }] }),
      ev("judge_verdict", 11, { action: "book", allowed: true, reason: "ok", scores: [] }),
    ], "call-1");
    const { container } = render(<JudgeBody rows={core.judgeRows(sorted)} sum={core.summarize(sorted)} />);
    expect(container.textContent).toContain("allowed");
    expect(container.textContent).toContain("90%");
    expect(container.textContent).toContain("70%");
    expect(container.textContent).toContain("2: 1 timeout 3000ms, 2 answered 1500ms");
  });
});
