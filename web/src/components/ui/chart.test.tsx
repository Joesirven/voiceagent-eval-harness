// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartStyle } from "./chart";

afterEach(cleanup);

describe("chart colour variables", () => {
  it("writes the variables as plain text in a style element, for the light and the dark theme", () => {
    const { container } = render(<ChartStyle id="chart-1" config={{ latency: { color: "#1f7c74" }, other: { theme: { light: "#111", dark: "#eee" } } }} />);
    const style = container.querySelector("style")!;
    expect(style.childNodes).toHaveLength(1);
    expect(style.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(style.textContent).toContain("[data-chart=chart-1]");
    expect(style.textContent).toContain("--color-latency: #1f7c74;");
    expect(style.textContent).toContain("--color-other: #111;");
    expect(style.textContent).toContain("--color-other: #eee;");
  });
  it("renders nothing when no series has a colour", () => {
    const { container } = render(<ChartStyle id="chart-2" config={{ a: { label: "A" } }} />);
    expect(container.querySelector("style")).toBeNull();
  });
});
