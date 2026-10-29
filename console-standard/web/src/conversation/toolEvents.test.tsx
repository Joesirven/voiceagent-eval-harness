// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveToolCard } from "./Tool";
import { applyFlowEvent, resetToolCalls } from "./toolEvents";

afterEach(() => { cleanup(); resetToolCalls(); });

const start = { type: "flow", event: "tool", id: "c1", name: "save_quote_field", args: { field: "full_time_employees", value: 12 }, source: "simulated" };

describe("flow tool cards from a fake event stream", () => {
  it("places a card once, shows running, then done with the result", () => {
    expect(applyFlowEvent(start)).toBe("c1");
    render(<LiveToolCard id="c1" />);
    expect(screen.getByText("save_quote_field")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Running");
    expect(screen.getByText(/full_time_employees/)).toBeTruthy();
    act(() => { expect(applyFlowEvent({ type: "flow", event: "tool_result", id: "c1", name: "save_quote_field", ok: true, result: { saved: true } })).toBeUndefined(); });
    expect(screen.getByRole("status").textContent).toContain("Done");
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText(/"saved": true/)).toBeTruthy();
  });

  it("shows failed with the error, and ignores other messages", () => {
    applyFlowEvent({ ...start, id: "c2", name: "transfer_to_producer", args: {} });
    render(<LiveToolCard id="c2" />);
    act(() => { applyFlowEvent({ type: "flow", event: "tool_result", id: "c2", ok: false, result: "No producer is available." }); });
    expect(screen.getByRole("status").textContent).toContain("Failed");
    expect(screen.getByText("Error")).toBeTruthy();
    expect(applyFlowEvent({ type: "configuration", text: "x" })).toBeUndefined();
    expect(applyFlowEvent({ type: "flow", event: "node", name: "greet" })).toBeUndefined();
  });

  it("a repeated start event does not place a second card", () => {
    expect(applyFlowEvent(start)).toBe("c1");
    expect(applyFlowEvent(start)).toBeUndefined();
  });
});
