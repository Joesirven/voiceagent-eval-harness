// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test/setup";
import { VoiceAgentConsole } from "./VoiceAgentConsole";
import type { AppState } from "@/lib/types";

// The real call controls card and call setup dialog are used here, with the voice client replaced, to prove the controls survive a layout change.
const bind = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/server/voice/voice-client.js", () => ({ bindLeadVoice: bind, startBoundCall: vi.fn(), isRinging: () => false }));
vi.mock("./MediaPane", () => ({ MediaPane: ({ controls }: any) => <section><h2>Media</h2>{controls}</section> }));
vi.mock("./ConversationPane", () => ({ ConversationPane: () => null }));
vi.mock("./MetricsPane", () => ({ MetricsPane: () => null }));
vi.mock("./ObjectivesPane", () => ({ ObjectivesPane: () => null }));
vi.mock("./JudgesPane", () => ({ JudgesPane: () => null }));
vi.mock("@/lib/use-call-view", () => ({
  useCallView: () => ({ sorted: [], groups: [], sum: {}, judged: [], context: null, setPinned: vi.fn(), replay: { data: null, stop: vi.fn() } }),
}));
vi.mock("@/components/SettingsSheet", () => ({ SettingsSheet: () => null }));

// The closed call setup dialog reads the modules, decision trees and decision modules.
const state = { voiceErrors: [], azureStatus: { ok: true }, decisionModuleStatus: { available: true }, modules: [], decisionTrees: [], decisionModules: [], orchestrators: [] } as unknown as AppState;

let width = 1280;
const listeners = new Set<() => void>();
function installMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      get matches() { return min ? width >= Number(min[1]) : false; },
      media: query, onchange: null, dispatchEvent: () => false, addListener() {}, removeListener() {},
      addEventListener: (_: string, cb: () => void) => { listeners.add(cb); },
      removeEventListener: (_: string, cb: () => void) => { listeners.delete(cb); },
    };
  });
}

// The call setup dialog loads the voice options when it mounts, even while closed.
beforeEach(() => {
  localStorage.clear(); bind.mockClear(); width = 1280; installMatchMedia();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orchestrators: [], sources: [] }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); listeners.clear(); });

describe("console call controls across the width breakpoint", () => {
  it("keeps the same buttons mounted and bound once when the window crosses 1024 pixels", () => {
    render(<VoiceAgentConsole state={state} refresh={async () => {}} inCall onInCall={() => {}} />);
    // The visible Play opens the call setup dialog; the hidden button is the one the microphone client starts the call from.
    const play = screen.getByLabelText(/^Play: set up and start a live voice call/);
    const talk = screen.getByLabelText("Start the call now");
    const end = screen.getByLabelText("End the call");
    expect(play.id).toBe("playSetup");
    expect(talk.id).toBe("playTalk");
    expect(bind).toHaveBeenCalledTimes(1);
    expect(document.contains(talk)).toBe(true);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    width = 390;
    act(() => { listeners.forEach((cb) => cb()); });
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    // The same card at both widths: Play opens the dialog and the hidden talk button keeps its label.
    expect(screen.getByLabelText(/^Play: set up and start a live voice call/)).toBe(play);
    expect(screen.getByLabelText("Start the call now")).toBe(talk);
    expect(screen.getByLabelText("End the call")).toBe(end);
    expect(document.contains(talk)).toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);

    width = 1280;
    act(() => { listeners.forEach((cb) => cb()); });
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByLabelText(/^Play: set up and start a live voice call/)).toBe(play);
    expect(screen.getByLabelText("Start the call now")).toBe(talk);
    expect(screen.getByLabelText("End the call")).toBe(end);
    expect(document.contains(end)).toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("has the call controls in the document when the voice client binds, so it can find them by identifier", () => {
    let foundAtBind: boolean | null = null;
    bind.mockImplementation(() => { foundAtBind = Boolean(document.getElementById("playTalk") && document.getElementById("playVoiceEnd") && document.getElementById("playSetup")); });
    render(<VoiceAgentConsole state={state} refresh={async () => {}} inCall={false} onInCall={() => {}} />);
    expect(foundAtBind).toBe(true);
  });
});
