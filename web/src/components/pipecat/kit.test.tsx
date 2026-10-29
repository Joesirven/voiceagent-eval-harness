// @vitest-environment jsdom
import type { ConversationMessage } from "@pipecat-ai/client-react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import "../../test/setup";
import { ConversationView } from "./conversation";
import { MetricsView } from "./metrics/metrics";

// The browser scrolls elements; jsdom does not implement element scrolling.
Element.prototype.scrollTo ??= () => {};

afterEach(cleanup);

describe("copied Pipecat user interface kit files", () => {
  it("renders the tabbed metrics view with an empty series list", () => {
    render(<MetricsView series={[]} />);
    expect(screen.getByRole("tab", { name: "Performance" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Usage" })).toBeTruthy();
  });

  it("renders a latency tile with the processor, the seconds converted to milliseconds, and a spelled-out title", () => {
    const series = [{ category: "ttfb" as const, processor: "speech-voice", latest: 0.12, points: [{ time: 1, value: 0.1 }, { time: 2, value: 0.12 }] }];
    const { container } = render(<MetricsView series={series} />);
    expect(container.querySelector("[data-slot='metric-label']")?.textContent).toBe("Time to first byte · speech-voice");
    expect(container.querySelector("[data-slot='metric-value']")?.textContent).toBe("120ms");
    expect(container.querySelector("[data-slot='metrics-chart']")?.textContent).toContain("Time to first byte (ms)");
  });

  it("opens a function-call row to show its arguments and result as text", async () => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const message: ConversationMessage = {
      role: "function_call", final: true, createdAt, parts: [],
      functionCall: { function_name: "decision", tool_call_id: "t1", args: { nodeId: "<i>n1</i>" }, result: { summary: "Chose the quote branch" }, status: "completed" },
    };
    const { container } = render(<ConversationView messages={[message]} />);
    expect(container.querySelector("pre")).toBeNull();
    await userEvent.setup().click(screen.getByText("(decision)"));
    const shown = Array.from(container.querySelectorAll("pre")).map((p) => p.textContent).join("\n");
    expect(shown).toContain('"nodeId": "<i>n1</i>"');
    expect(shown).toContain("Chose the quote branch");
    expect(container.querySelector("i")).toBeNull();
  });

  it("renders the conversation view with one message", () => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const message: ConversationMessage = {
      role: "user",
      parts: [{ text: "Hello there", final: true, createdAt }],
      createdAt,
    };
    render(<ConversationView messages={[message]} />);
    expect(screen.getByText("Hello there")).toBeTruthy();
  });
});
