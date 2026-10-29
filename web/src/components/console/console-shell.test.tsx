// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { VoiceAgentConsole } from "./VoiceAgentConsole";
import type { AppState } from "@/lib/types";
import type { CallViewModel } from "@/lib/use-call-view";

// The model has the same shape the real call view hook returns, with the replay data switchable per test.
const model = vi.hoisted(() => ({ replayData: null as unknown }));
vi.mock("./MediaPane", () => ({ MediaPane: ({ controls }: any) => <section><h2>Media</h2>{controls}</section> }));
vi.mock("./ConversationPane", () => ({ ConversationPane: ({ replaying }: any) => <section><h2>Conversation pane</h2><span>{replaying ? "replaying" : "live"}</span></section> }));
vi.mock("./MetricsPane", () => ({ MetricsPane: () => <section><h2>Running metrics</h2></section> }));
vi.mock("./ObjectivesPane", () => ({ ObjectivesPane: () => <section><h2>Call stage and objectives</h2></section> }));
vi.mock("./JudgesPane", () => ({ JudgesPane: () => <section><h2>Judges pane</h2></section> }));
vi.mock("@/lib/use-call-view", () => ({
  useCallView: (): CallViewModel => ({
    sorted: [], groups: [], sum: {}, judged: [], visited: new Set(), stage: null, taken: null, tree: null,
    context: null, pinned: null, setPinned: vi.fn(), callIds: [],
    replay: {
      data: model.replayData, step: 0, records: null, recordId: "",
      load: vi.fn(), start: vi.fn(), stop: vi.fn(), stepBack: vi.fn(), stepNext: vi.fn(), stepAll: vi.fn(),
    },
  } as unknown as CallViewModel),
}));
vi.mock("@/components/LiveVoiceCard", () => ({ LiveVoiceCard: ({ settings, inCall }: any) => <div>Call controls{!inCall && settings}</div> }));
vi.mock("@/components/SettingsSheet", () => ({ SettingsSheet: () => <button>Settings gear</button> }));
// The call setup dialog brings in the microphone client, which needs browser audio; it has its own tests.
vi.mock("@/components/CallSetupDialog", () => ({ CallSetupDialog: () => null }));

const state = { voiceErrors: [], azureStatus: { ok: true }, decisionModuleStatus: { available: true } } as unknown as AppState;
const refresh = async () => {};

function mockWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? width >= Number(min[1]) : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false };
  });
}

beforeEach(() => { localStorage.clear(); model.replayData = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("console shell", () => {
  it("shows every pane title and no bottom tabs at 1280 pixels wide", () => {
    mockWidth(1280);
    render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    for (const title of ["Media", "Conversation pane", "Running metrics", "Call stage and objectives", "Judges pane"]) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("Settings gear")).toBeTruthy();
  });

  it("lays the panes out in groups with their own identifiers, apart from the Call tab's", () => {
    mockWidth(1280);
    const { container } = render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    for (const id of ["console-outer", "console-main", "console-right-column", "console-metrics", "console-objectives", "console-bottom"]) expect(container.querySelector(`[id="${id}"]`), id).toBeTruthy();
    for (const id of ["console-tree", "console-context", "console-left-column"]) expect(container.querySelector(`[id="${id}"]`), id).toBeNull();
    for (const id of ["call-outer", "call-top"]) expect(container.querySelector(`[id="${id}"]`), id).toBeNull();
  });

  it("does not repeat the connection badge or the errors button that the app header shows", () => {
    mockWidth(1280);
    const { container } = render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    expect(container.querySelector("[aria-live='polite']")).toBeNull();
    expect(screen.queryByRole("button", { name: /errors/i })).toBeNull();
    expect(screen.getByRole("button", { name: /judges and trace/ })).toBeTruthy();
  });

  it("passes the replay flag to the conversation pane: live without replay data, replaying with it", () => {
    mockWidth(1280);
    const { rerender } = render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    expect(screen.getByText("live")).toBeTruthy();
    model.replayData = { events: [] };
    rerender(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    expect(screen.getByText("replaying")).toBeTruthy();
  });

  it("collapses and restores the bottom judges pane from the strip button", () => {
    mockWidth(1280);
    render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    const button = screen.getByRole("button", { name: "Hide judges and trace" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Show judges and trace" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show judges and trace" }));
    expect(screen.getByRole("button", { name: "Hide judges and trace" })).toBeTruthy();
  });

  it("shows five bottom tab triggers at 390 pixels wide and keeps every pane mounted", () => {
    mockWidth(390);
    render(<VoiceAgentConsole state={state} refresh={refresh} inCall={false} onInCall={() => {}} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Call", "Conversation", "Metrics", "Objectives", "Judges"]);
    for (const title of ["Media", "Conversation pane", "Running metrics", "Call stage and objectives", "Judges pane"]) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText("Running metrics").closest("[data-state]")?.getAttribute("data-state")).toBe("inactive");
    expect(screen.getByText("Call stage and objectives").closest("[data-state]")?.getAttribute("data-state")).toBe("inactive");
  });

  it("hides the settings button during a call", () => {
    mockWidth(1280);
    render(<VoiceAgentConsole state={state} refresh={refresh} inCall onInCall={() => {}} />);
    expect(screen.queryByText("Settings gear")).toBeNull();
  });
});
