// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup";

const { bindLeadVoice, startBoundCall } = vi.hoisted(() => ({ bindLeadVoice: vi.fn(), startBoundCall: vi.fn() }));
vi.mock("../../../src/server/voice/voice-client.js", () => ({ bindLeadVoice, startBoundCall, isRinging: () => false }));

import { CallSetupDialog } from "./CallSetupDialog";
import { LiveVoiceCard } from "./LiveVoiceCard";
import type { AppState } from "@/lib/types";

beforeEach(() => { bindLeadVoice.mockClear(); startBoundCall.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Enough state for the closed call setup dialog; the dialog itself is tested in call-setup.test.tsx.
const state = {
  modules: [], orchestrators: [{ id: "direct", label: "Direct", available: true }], selectedOrchestratorId: "direct", voicePaths: [], selectedVoicePathId: "",
  staleOutputDrops: [], selectedStaleOutputDropId: "", decisionTrees: [], selectedDecisionTreeId: "", decisionModules: [], agencies: [], scenarios: [], leadStoreKind: "mock",
} as unknown as AppState;
const withSetup = (inCall = false) => <LiveVoiceCard inCall={inCall} onCall={() => {}} setup={<CallSetupDialog state={state} refresh={async () => {}} disabled={inCall} />} />;

describe("live voice call controls", () => {
  it("keeps every element id the microphone client binds to, with a Play and an End button", () => {
    const { container } = render(<LiveVoiceCard inCall={false} onCall={() => {}} />);
    for (const id of ["playLead", "playDir", "playTalk", "playPause", "playVoiceEnd", "playGap", "playVoiceStatus", "playClock", "playMicHint"]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
    expect(screen.getByRole("button", { name: /^Play/ }).id).toBe("playTalk");
    const end = screen.getByRole("button", { name: /End the call/ }) as HTMLButtonElement;
    expect(end.id).toBe("playVoiceEnd");
    expect(end.disabled).toBe(true);
    expect(bindLeadVoice).toHaveBeenCalledTimes(1);
    expect(bindLeadVoice.mock.calls[0]![0]).toMatchObject({ lead: "playLead", dir: "playDir", startMic: "playTalk", hang: "playVoiceEnd", micHint: "playMicHint" });
  });

  it("has no typed role-play controls and says what Play does in one sentence (its hover text)", () => {
    const { container } = render(<LiveVoiceCard inCall={false} onCall={() => {}} />);
    for (const id of ["playStart", "playText", "playSay", "playHang"]) expect(container.querySelector(`#${id}`), id).toBeNull();
    expect(container.querySelector("#playTalk")!.getAttribute("title")).toBe("A live voice call through the selected orchestrator, with the decision tree and judge behind it.");
  });

  it("hides the lead and direction choices once a call has started", () => {
    const { container, rerender } = render(<LiveVoiceCard inCall={false} onCall={() => {}} />);
    const setup = container.querySelector("#callSetup")!;
    expect(setup.className).not.toContain("hidden");
    rerender(<LiveVoiceCard inCall onCall={() => {}} />);
    expect(container.querySelector("#callSetup")!.className).toContain("hidden");
    expect(within(container).getByRole("button", { name: /End the call/ })).toBeTruthy();
  });
  it("with the call setup, Play opens the setup dialog and the start button stays bound but hidden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orchestrators: [], sources: [] }), { status: 200 })));
    const { container } = render(withSetup());
    // Role queries skip what is hidden from assistive technology, so the only Play button is the setup one.
    expect(screen.getAllByRole("button", { name: /^Play/ }).map((b) => b.id)).toEqual(["playSetup"]);
    const talk = container.querySelector("#playTalk")!;
    expect(talk.className).toContain("hidden");
    expect(talk.getAttribute("aria-hidden")).toBe("true");
    expect(talk.getAttribute("tabindex")).toBe("-1");
    expect(talk.getAttribute("aria-label")).toBe("Start the call now");
    expect(bindLeadVoice).toHaveBeenCalledTimes(1);
    expect(bindLeadVoice.mock.calls[0]![0]).toMatchObject({ startMic: "playTalk", hang: "playVoiceEnd" });
    fireEvent.click(screen.getByRole("button", { name: /^Play/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    expect(screen.getByRole("dialog").textContent).toContain("Start a call");
    expect(startBoundCall).not.toHaveBeenCalled();
  });

  it("with the call setup, Play is disabled during a call", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orchestrators: [], sources: [] }), { status: 200 })));
    const { container } = render(withSetup(true));
    expect((container.querySelector("#playSetup") as HTMLButtonElement).disabled).toBe(true);
  });
});
