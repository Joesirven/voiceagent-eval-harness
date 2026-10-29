// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/setup";
import { SettingsSheet } from "./SettingsSheet";
import type { AppState } from "@/lib/types";

// The voice, model, barge-in and decision settings moved to the call setup dialog; their tests are in call-setup.test.tsx.
vi.mock("sonner", () => ({ toast: { error: vi.fn() }, Toaster: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const state: AppState = {
  modules: [{ id: "azure-gpt-live", label: "Azure gpt-live", modelChoices: ["gpt-live-1"], voiceChoices: ["verse"], config: { model: "gpt-live-1", voice: "verse", latency: { firstResponseMs: 0, endpointingMs: 0 } } }],
  orchestrators: [{ id: "direct", label: "Direct Azure (own infrastructure)", available: true }, { id: "pipecat", label: "Pipecat → Azure gpt-live", available: true }],
  selectedOrchestratorId: "pipecat",
  voicePaths: [{ id: "azure_gpt_live", label: "Azure gpt-live (default)", available: true }],
  selectedVoicePathId: "azure_gpt_live",
  staleOutputDrops: [{ id: "one_gap", label: "One gap: up to 0.9 seconds" }],
  selectedStaleOutputDropId: "one_gap",
  decisionTrees: [{ id: "full", label: "Full tree", nodeCount: 109 }],
  selectedDecisionTreeId: "full",
  decisionModules: [{ id: "azure-decision", label: "azure-decision", kind: "model", available: true, selected: true }],
  agencies: [{ id: "agency-demo", aiCallingEnabled: true }],
  scenarios: [],
  leadStoreKind: "mock",
};

/** A fetch stub that answers every request with the state and records it. */
const stubFetch = () => {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(state), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
};
const posted = (fn: ReturnType<typeof stubFetch>, url: string) => fn.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse((init as RequestInit).body as string));
const open = (s: AppState = state) => { render(<SettingsSheet state={s} refresh={async () => {}} />); fireEvent.click(screen.getByRole("button", { name: /Settings/ })); };

describe("settings panel", () => {
  it("holds only the environment and one AI calling switch per agency", () => {
    const fetchMock = stubFetch();
    open({ ...state, agencies: [{ id: "agency-demo", aiCallingEnabled: true }, { id: "agency-two", aiCallingEnabled: false }] });
    expect(document.getElementById("flag-agency-demo")).not.toBeNull();
    expect(document.getElementById("flag-agency-two")).not.toBeNull();
    expect(document.body.textContent).toContain("On: the AI answers new calls.");
    expect(document.body.textContent).toContain("Off: calls get normal answering.");
    expect(document.body.textContent).toContain("The public default uses fictional leads.");
    // What answers a call is chosen in the call setup dialog, so the sheet has none of it and loads no voice options.
    for (const id of ["stackVoicePath", "stackStaleDrop", "stackDecisionModule", "stackDecisionTree"]) expect(document.getElementById(id), id).toBeNull();
    for (const label of ["Orchestrator", "Voice path", "Live voice model", "After a barge-in", "Decision module"]) expect(document.querySelector(`[aria-label="${label}"]`), label).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/voice/options")).toBe(false);
  });

  it("sends where a settings change came from", () => {
    const fetchMock = stubFetch();
    open();
    fireEvent.click(document.getElementById("flag-agency-demo")!);
    expect(posted(fetchMock, "/api/flag")).toEqual([{ agencyId: "agency-demo", enabled: false, source: "settings-sheet" }]);
  });
});
