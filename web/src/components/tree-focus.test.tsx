// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TreeFocus } from "./TreeFocus";

afterEach(cleanup);

const node = (id: string, label: string, edges: Array<[string, string | null]> = [], extra: object = {}) => ({ id, label, edges: edges.map(([answer, to]) => ({ answer, to })), ...extra });
const tree = {
  start: "open.greeting", dispositions: ["hung_up"],
  nodes: [
    node("open.greeting", "Greeting", [["asks_for_a_person", "open.identity_gate"], ["other", "open.greeting_more"]], { question: "Did the caller confirm who they are?" }),
    node("open.greeting_more", "Greeting (further answer)", [["yes", "open.identity_gate"]]),
    node("open.identity_gate", "Identity gate", [["hangs_up", "end.hung_up"]]),
    node("end.hung_up", "Hung up", [], { disposition: "hung_up" }),
  ],
} as any;

describe("decision tree next steps", () => {
  it("shows the current step, its question and the next steps in plain words, with no ids", () => {
    const { container } = render(<TreeFocus tree={tree} currentId="open.greeting_more" path={["Greeting"]} takenAnswer={null} />);
    const text = container.textContent!;
    expect(text).toContain("Greeting");
    expect(text).toContain("Did the caller confirm who they are?");
    expect(text).toContain("If they say asks for a person then Identity gate");
    expect(text).toContain("end: hung up");
    expect(text).not.toMatch(/open\.|end\.|_more|further answer/);
  });

  it("starts at the first step before any call", () => {
    const { container } = render(<TreeFocus tree={tree} currentId={null} path={[]} takenAnswer={null} />);
    expect(container.textContent).toContain("Starts with");
  });
});
