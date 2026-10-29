// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DecisionMap } from "./DecisionMap";
import { applyDecisionEvent, emptyDecisionState } from "./state";
afterEach(cleanup);
const map = { type: "flow", event: "map", nodes: [
  { id: "greet", branches: [{ label: "confirm_identity", target: "collect" }, { label: "wrong_person", target: "end" }] },
  { id: "collect", branches: [{ label: "save_field" }] },
  { id: "end", branches: [] },
] };
it("waits for actual events and does not mark possible routes visited", () => {
  const state = applyDecisionEvent(emptyDecisionState, map);
  expect(state.current).toBeUndefined();
  expect(state.visited).toEqual([]);
  render(<DecisionMap state={state} />);
  expect(screen.getByText("Waiting for flow events")).toBeTruthy();
  expect(screen.queryByLabelText("Observed agent path")).toBeNull();
});
it("inspects without changing the agent state and can follow the next reported node", () => {
  const state = applyDecisionEvent(applyDecisionEvent(emptyDecisionState, map), { type: "flow", event: "node_enter", node: "greet" });
  const { rerender } = render(<DecisionMap state={state} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect collect" }));
  expect(screen.getByText("Stays at this step")).toBeTruthy();
  expect(state.current).toBe("greet");
  fireEvent.click(screen.getByRole("button", { name: "Follow agent" }));
  rerender(<DecisionMap state={applyDecisionEvent(state, { type: "flow", event: "node_enter", node: "end" })} />);
  expect(screen.getByText("No further routes in this flow")).toBeTruthy();
});
it("resets visits for a new flow and rejects malformed events", () => {
  const state = applyDecisionEvent(emptyDecisionState, { type: "flow", event: "node_enter", node: "old" });
  expect(applyDecisionEvent(state, map).visited).toEqual([]);
  expect(applyDecisionEvent(state, { type: "flow", event: "map", nodes: [null] })).toBe(state);
  expect(applyDecisionEvent(state, { type: "other", event: "node_enter", node: "bad" })).toBe(state);
});
it("reports missing metadata and permits cycles in observed history", () => {
  let state = applyDecisionEvent(emptyDecisionState, map);
  for (const node of ["greet", "collect", "greet", "unknown"]) state = applyDecisionEvent(state, { type: "flow", event: "node_enter", node });
  expect(state.visited).toEqual(["greet", "collect", "greet", "unknown"]);
  render(<DecisionMap state={state} />);
  expect(screen.getByText("The agent reported a node, but its flow map is unavailable.")).toBeTruthy();
});
