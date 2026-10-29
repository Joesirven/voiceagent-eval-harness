// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test/setup";

const tree = { start: "a", nodes: [{ id: "a", label: "Greeting", question: "Who is calling?", edges: [] }], dispositions: [] };
vi.stubGlobal("fetch", vi.fn(async (path: string) => ({
  ok: true,
  json: async () => (path === "/api/tree" ? tree : path === "/api/records" ? [] : {}),
})));

import { JudgesPane } from "./JudgesPane";
import { MetricsPane } from "./MetricsPane";
import { ObjectivesPane } from "./ObjectivesPane";
import { ingestFrame } from "@/lib/live";
import { useCallView } from "@/lib/use-call-view";
import type { VoiceErrorRecord } from "@/lib/types";

afterEach(cleanup);

function WithModel({ pane, errors = [] }: { pane: "metrics" | "objectives" | "judges"; errors?: VoiceErrorRecord[] }) {
  const model = useCallView();
  if (pane === "metrics") return <MetricsPane model={model} />;
  if (pane === "objectives") return <ObjectivesPane model={model} />;
  return <JudgesPane model={model} errors={errors} />;
}

const base = { leadId: "lead-1", channel: "call", at: "2026-10-19T10:00:00.000Z" } as const;
// Each call is its own record, and the sequence doubles as the record sequence, so no frame overwrites another in the shared live view.
const frame = (seq: number, callId: string, type: string, atMs: number, data: Record<string, unknown>, plain = "") =>
  JSON.stringify({ event: { ...base, seq, recordSeq: seq, recordId: callId, callId, type, atMs, data }, plain });

const click = (el: HTMLElement) => { fireEvent.mouseDown(el, { button: 0 }); fireEvent.click(el); };

describe("metrics pane", () => {
  it("shows empty tiles, then the reply timing, a tool call and an interim response, and switches to watch mode", async () => {
    const { container } = render(<WithModel pane="metrics" />);
    expect(container.textContent).toContain("Running metrics");
    expect(container.textContent).toContain("no tool calls yet");
    act(() => {
      ingestFrame(frame(1001, "metrics-call", "transcript_final", 0, { role: "caller", text: "I want a quote", turnIndex: 0 }));
      ingestFrame(frame(1002, "metrics-call", "tool_call", 1400, { tool: "reply_timing", inputs: { source: "azure_gpt_live", decisionMs: 500, callerFinalToCreateMs: 600, createToFirstAudioMs: 800, callerFinalToFirstAudioMs: 1400 }, result: null, success: true, durationMs: 1400 }));
      ingestFrame(frame(1003, "metrics-call", "tool_call", 4000, { tool: "thinker_tool_call", inputs: { name: "write_quote_field", callId: "c1" }, result: null, success: true, durationMs: 900 }));
      ingestFrame(frame(1004, "metrics-call", "transcript_final", 4200, { role: "agent", text: "Got it, one moment.", turnIndex: 1 }));
    });
    expect(container.querySelector('[data-testid="metric-latency"]')!.textContent).toContain("1,400");
    expect(container.querySelector('[data-testid="metric-response"]')!.textContent).toContain("800");
    expect(container.querySelector('[data-testid="metric-tools"]')!.textContent).toContain("900");
    expect(container.querySelector('[data-testid="metric-interim"]')!.textContent).toContain("Got it, one moment.");
    expect(container.querySelector("#toolCalls")!.textContent).toContain("write_quote_field");
    expect(container.querySelector('[data-testid="metric-decision"]')!.textContent).toContain("500");

    click(container.querySelector("#watchToggle") as HTMLElement);
    expect(container.querySelector("#watchReplay")).not.toBeNull();
    expect(container.querySelector('[data-testid="metric-tiles"]')).toBeNull();
    click(container.querySelector("#watchToggle") as HTMLElement);
    expect(container.querySelector("#watchReplay")).toBeNull();
  });
});

describe("objectives pane", () => {
  it("shows the stage strip, the objectives the judge checked off, and the fields still needed", async () => {
    (globalThis.fetch as any).mockImplementation(async (path: string) => ({
      ok: true,
      // The pane asks for the lead of the call in view (lead-1 on every frame here).
      json: async () => path.startsWith("/api/lead-context")
        ? { text: "", json: { confirmed: true, checklist: [{ field: "x_date", label: "Renewal date", status: "known", basis: "record", held: false }, { field: "payroll", label: "Payroll", status: "still_needed", held: false }] } }
        : path === "/api/tree" ? tree : path === "/api/records" ? [] : {},
    }));
    const { container } = render(<WithModel pane="objectives" />);
    expect(container.textContent).toContain("Not judged yet");
    expect(container.textContent).toContain("The stage appears once the call enters the tree.");
    act(() => {
      ingestFrame(frame(2001, "objectives-call", "node_enter", 0, { nodeId: "discovery.start", label: "Start" }));
      ingestFrame(frame(2002, "objectives-call", "transcript_final", 100, { role: "caller", text: "Yes this is Renata", turnIndex: 0 }));
      ingestFrame(frame(2003, "objectives-call", "tool_call", 2000, {
        tool: "objective_check",
        inputs: { stage: "discovery", trigger: "line", asked: 7, modelId: "azure-decision", modelKind: "real", objectives: [
          { id: "disclosure", label: "AI disclosure given", step: "disclosure", status: "done", confidence: 0.9 },
          { id: "identity", label: "Right person confirmed", step: "recognize_lead", status: "done", confidence: 0.8 },
          { id: "purpose", label: "Reason for the call stated", step: "discovery", status: "unclear", confidence: 0.4 },
          { id: "coverage", label: "Current coverage learned", step: "discovery", status: "open", confidence: 0.7 },
        ] },
        result: null, success: true, durationMs: 1500,
      }));
    });
    const strip = container.querySelector("#stageStrip")!;
    expect(strip.querySelector('[data-step="discovery"]')!.getAttribute("data-state")).toBe("current");
    expect(strip.querySelector('[data-step="disclosure"]')!.getAttribute("data-state")).toBe("past");
    expect(strip.querySelector('[data-step="booking"]')!.getAttribute("data-state")).toBe("upcoming");
    expect(container.querySelector("#stageNote")!.textContent).toContain("Discovery · Start");
    expect(container.querySelector('[data-objective="disclosure"]')!.getAttribute("data-status")).toBe("done");
    expect(container.querySelector('[data-objective="purpose"]')!.getAttribute("data-status")).toBe("unclear");
    expect(container.querySelector('[data-objective="coverage"]')!.getAttribute("data-status")).toBe("open");
    expect(container.textContent).toContain("2 of 4 done");
    expect(container.querySelector("#objectivesNote")!.textContent).toContain("Judged by azure-decision at 2.0s, 7 asked");
    await waitFor(() => expect(container.querySelector("#stillNeeded")).not.toBeNull());
    expect(container.querySelector("#stillNeeded")!.textContent).toContain("Payroll");
    expect(container.querySelector("#knownFields")!.textContent).toContain("Renewal date");
  });

  it("says when no decision model is configured", () => {
    const { container } = render(<WithModel pane="objectives" />);
    act(() => {
      ingestFrame(frame(2101, "objectives-call-2", "transcript_final", 100, { role: "caller", text: "hello", turnIndex: 0 }));
      ingestFrame(frame(2102, "objectives-call-2", "tool_call", 1300, { tool: "objective_check", inputs: { stage: null, trigger: "line", asked: 0, modelId: "none", modelKind: "none", objectives: [] }, result: null, success: false, reason: "no_decision_model", durationMs: 0 }));
    });
    expect(container.querySelector("#objectivesNote")!.textContent).toContain("No decision model is configured");
    expect(container.querySelectorAll("#objectivesList li").length).toBe(7);
  });
});

describe("judges pane", () => {
  const error: VoiceErrorRecord = { id: 1, code: "x", title: "Microphone blocked", detail: "No access.", fix: "Allow the microphone.", severity: "error", canContinue: false, blocksNewCalls: true, path: "direct", at: "2026-10-19T10:00:00.000Z" };

  it("lists trace events with their plain sentence, and the errors", async () => {
    render(<WithModel pane="judges" errors={[error]} />);
    act(() => ingestFrame(JSON.stringify({ event: { seq: 5001, recordSeq: 1, recordId: "r", callId: "pane-call", leadId: "lead-1", channel: "call", type: "transcript_final", at: "2026-10-19T10:00:00.000Z", atMs: 0, data: { role: "caller", text: "hello", turnIndex: 1 } }, plain: "The caller said hello." })));
    click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByLabelText("Trace events").textContent).toContain("The caller said hello.");
    click(screen.getByRole("tab", { name: /Errors/ }));
    expect(screen.getByText("Microphone blocked")).toBeTruthy();
    expect(screen.getByText("Allow the microphone.")).toBeTruthy();
  });
});
