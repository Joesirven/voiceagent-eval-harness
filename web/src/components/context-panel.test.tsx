// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/setup";

const { bindLeadVoice } = vi.hoisted(() => ({ bindLeadVoice: vi.fn() }));
const idleCall = { live: false, paused: false };
vi.mock("../../../src/server/voice/voice-client.js", () => ({ bindLeadVoice, getCallAudio: () => idleCall, subscribeCallAudio: () => () => {}, getCallAudioLevel: () => 0, startBoundCall: vi.fn(), isRinging: () => false }));
// three.js and the microphone waveform need WebGL and a real microphone; they have their own state tests.
vi.mock("@/components/ui/orb", () => ({ Orb: () => null }));
vi.mock("@/components/ui/live-waveform", () => ({ LiveWaveform: () => <div data-testid="waveform" /> }));
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ start: "a", nodes: [{ id: "a", label: "A", edges: [] }], dispositions: [] }) })));

import { CallView } from "./CallView";
import { ingestFrame } from "@/lib/live";
import type { AppState } from "@/lib/types";

afterEach(cleanup);

const state = { modules: [], orchestrators: [], voicePaths: [], staleOutputDrops: [], decisionTrees: [], decisionModules: [], agencies: [], scenarios: [], leadStoreKind: "mock", selectedOrchestratorId: "", selectedVoicePathId: "", selectedStaleOutputDropId: "", selectedDecisionTreeId: "" } as AppState;

describe("lead view and settings button", () => {
  it("shows the lead in view over the transcript, asks for one when none is chosen, and puts the settings button beside Play and End", async () => {
    const { container } = render(<CallView state={state} inCall={false} onInCall={() => {}} settings={<button id="openSettings">Settings</button>} />);
    // No lead on the left and none in the call bar: the lead view says so instead of showing an empty record.
    expect(container.querySelector("#selectedLead")!.textContent).toContain("Pick a lead on the left or in the call bar.");
    expect(container.querySelector("#leadsPanel")).not.toBeNull();
    const toolbar = container.querySelector("#playTalk")!.parentElement!;
    expect(toolbar.querySelector("#playVoiceEnd")).not.toBeNull();
    expect(toolbar.querySelector("#openSettings")).not.toBeNull();

    // The agent's context is no longer a pane of its own: a context row shows in the transcript's reasoning, not above it.
    act(() => ingestFrame(JSON.stringify({ event: { seq: 1, recordSeq: 1, recordId: "r", callId: "c1", leadId: "lead-1", channel: "call", type: "tool_call", at: "2026-10-19T10:00:00.000Z", atMs: 0, data: { tool: "agent_context", inputs: {}, result: { text: "STANDING RULES\nLead: Jane" }, success: true } } })));
    expect(container.querySelector("#contextPanel")).toBeNull();
    expect(container.querySelector("#selectedLead")!.textContent).not.toContain("STANDING RULES");
  });

  it("hides the settings button during a call", () => {
    const { container } = render(<CallView state={state} inCall onInCall={() => {}} settings={<button id="openSettings">Settings</button>} />);
    expect(container.querySelector("#openSettings")).toBeNull();
  });
});
