import { describe, expect, it } from "vitest";
import { sampleCall } from "../test/trace-fixtures";
import { hasSimulatedSeries, isSimulatedDecisionModule, traceToMetricSeries } from "./metrics-adapter";

describe("metrics adapter", () => {
  it("marks built-in module times as simulated, in seconds", () => {
    const series = traceToMetricSeries(sampleCall());
    const tree = series.find((s) => s.processor === "Decision tree (simulated)")!;
    expect(tree.category).toBe("processing");
    expect(tree.points.map((p) => p.value)).toEqual([0.1, 0.12]);
    expect(tree.latest).toBe(0.12);
    const judge = series.find((s) => s.processor === "Live judge (simulated)")!;
    expect(judge.latest).toBe(0.25);
    expect(hasSimulatedSeries(series)).toBe(true);
  });

  it("marks model-backed times as measured", () => {
    const series = traceToMetricSeries(sampleCall({ decisionModule: "openai-decisions", judgeKind: "real" }));
    expect(series.map((s) => s.processor)).toEqual(["Decision tree (measured)", "Live judge (measured)"]);
    expect(hasSimulatedSeries(series)).toBe(false);
  });

  it("recognises simulated module identifiers", () => {
    expect(isSimulatedDecisionModule("jev-mock")).toBe(true);
    expect(isSimulatedDecisionModule("azure-decision-mock")).toBe(true);
    expect(isSimulatedDecisionModule("keyword-no-credential")).toBe(true);
    expect(isSimulatedDecisionModule("openai-decisions")).toBe(false);
  });

  it("counts agent characters only on the Deepgram path, as a running total", () => {
    expect(traceToMetricSeries(sampleCall({ provider: "azure" })).some((s) => s.category === "characters")).toBe(false);
    const series = traceToMetricSeries(sampleCall({ provider: "deepgram" }));
    const chars = series.find((s) => s.category === "characters")!;
    const first = "Hello, this is the agent.".length;
    expect(chars.points.map((p) => p.value)).toEqual([first, first + "Great, let us start a quote.".length]);
  });

  it("emits no token or time to first audio series", () => {
    const series = traceToMetricSeries(sampleCall({ provider: "deepgram" }));
    expect(series.every((s) => s.category === "processing" || s.category === "characters")).toBe(true);
  });

  it("returns nothing for an empty call", () => {
    expect(traceToMetricSeries([])).toEqual([]);
  });
});
