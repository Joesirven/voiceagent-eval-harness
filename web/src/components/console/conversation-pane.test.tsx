// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import "../../test/setup";
import { derive, sampleCall } from "../../test/trace-fixtures";
import { ConversationPane } from "./ConversationPane";

// The browser scrolls elements; jsdom does not implement element scrolling.
Element.prototype.scrollTo ??= () => {};

afterEach(cleanup);

function pane(sorted = sampleCall()) {
  const { groups, judged, sum } = derive(sorted);
  return render(<ConversationPane sorted={sorted} groups={groups} judged={judged} sum={sum} plain={() => undefined} replaying={false} />);
}

describe("console conversation pane", () => {
  it("shows the transcript with reasoning rows, and caller words as text", () => {
    const { container } = pane();
    expect(screen.getByText("Hello, this is the agent.")).toBeTruthy();
    expect(screen.getByText("<b>I want a quote</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelectorAll("[data-slot='reasoning-row']").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("allowed speak");
    expect(container.textContent).not.toContain("agent_context");
  });

  it("shows an empty state before any call", () => {
    pane([]);
    expect(screen.getByText(/No call yet/)).toBeTruthy();
  });

  it("offers the three tabs and shows the simulated caption in the metrics tab", async () => {
    const user = userEvent.setup();
    const { container } = pane();
    expect(screen.getByRole("tab", { name: "Conversation" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(screen.getByRole("tab", { name: "Performance" })).toBeTruthy();
    expect(container.querySelector("[data-slot='simulated-caption']")).toBeTruthy();
    expect(container.textContent).toContain("Decision tree (simulated)");
  });

  it("shows the current state in the Now tab", async () => {
    const user = userEvent.setup();
    const { container } = pane();
    await user.click(screen.getByRole("tab", { name: "Now" }));
    expect(container.textContent).toContain("Judge scoreboard");
  });
});
