// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup";
import type { AppState, ModelOption, VoiceOptions } from "@/lib/types";

// jsdom has no pointer events; the select menu reads the pointer type to tell a mouse pick from a touch.
(window as any).PointerEvent ??= class extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
};
const voiceClient = vi.hoisted(() => ({ startBoundCall: vi.fn(), isRinging: vi.fn(() => false), bindLeadVoice: vi.fn() }));
vi.mock("../../../src/server/voice/voice-client.js", () => voiceClient);
vi.mock("sonner", () => ({ toast: { error: vi.fn() }, Toaster: () => null }));

import { CallSetupDialog, type WarmupResult } from "./CallSetupDialog";

beforeEach(() => { voiceClient.startBoundCall.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const now = "2026-10-19T00:00:00.000Z";
const live: ModelOption = { id: "gpt-live-1", label: "gpt-live-1", role: "speech_to_speech", provider: "azure", voices: ["verse", "alloy"] };
const fakeOptions: VoiceOptions = {
  orchestrators: [
    { id: "direct", label: "Direct Azure", voicePaths: [{ id: "azure_gpt_live", label: "Azure live", slots: [{ role: "speech_to_speech", models: [live], defaultId: "gpt-live-1" }] }] },
    { id: "pipecat", label: "Pipecat", voicePaths: [
      { id: "azure_gpt_live", label: "Azure live", slots: [{ role: "speech_to_speech", models: [live], defaultId: "gpt-live-1" }] },
      { id: "deepgram", label: "Deepgram", slots: [
        { role: "speech_to_text", models: [{ id: "nova-3", label: "nova-3", role: "speech_to_text", provider: "deepgram" }] },
        { role: "reply", models: [{ id: "gpt-5-mini", label: "gpt-5-mini", role: "reply", provider: "azure" }] },
        { role: "text_to_speech", models: [{ id: "aura-2", label: "aura-2", role: "text_to_speech", provider: "deepgram", voices: ["thalia"] }] },
      ] },
    ] },
  ],
  sources: [{ provider: "azure", ok: true, checkedAt: now }, { provider: "deepgram", ok: true, checkedAt: now }],
};

const state: AppState = {
  modules: [{ id: "azure-gpt-live", label: "Azure gpt-live", modelChoices: ["gpt-live-1"], voiceChoices: ["verse"], config: { model: "gpt-live-1", voice: "verse", latency: { firstResponseMs: 0, endpointingMs: 0 } } }],
  orchestrators: [{ id: "direct", label: "Direct Azure (own infrastructure)", available: true }, { id: "pipecat", label: "Pipecat → Azure gpt-live", available: true }],
  selectedOrchestratorId: "pipecat",
  voicePaths: [{ id: "azure_gpt_live", label: "Azure gpt-live (default)", available: true }, { id: "deepgram", label: "Deepgram", available: false, unavailableReason: "No Deepgram key." }],
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

/** GET /api/setups/agent, as the Agent step reads it. */
const agentSettings = {
  promptSetups: [{ id: "lab", label: "Lab voice agent prompt" }, { id: "default", label: "Default prompt" }],
  promptSetupId: "lab", leadContextGate: "off", thinker: { enabled: false, toolCount: 0 }, talkWriteBack: true, writeBack: true, preset: "lab",
};

/** GET /api/setups/agent-context, as the Agent stage's editor reads it. */
const agentContext = { leadId: "lead-7", leadLabel: "Jane", direction: "outbound", setupId: "lab", standingRules: "## Safety floor\n- Never state a price.", override: null, leadBlock: "Lead: Jane Doe", nextCallText: "## Safety floor\n- Never state a price.", maxChars: 60_000 };

/**
 * A fetch stub that answers by address and records every request: the voice options (or a failing status), the agent
 * settings, any given answer, and the state for everything else.
 */
const routedFetch = (options: VoiceOptions | { status: number }, answers: Record<string, () => Response> = {}, served: AppState = state) => {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    if (answers[url]) return answers[url]!();
    if (url === "/api/voice/options") return "status" in options ? new Response("{}", { status: options.status }) : new Response(JSON.stringify(options), { status: 200 });
    if (url === "/api/setups/agent") return new Response(JSON.stringify(agentSettings), { status: 200 });
    // The Agent stage's context editor reads the standing rules for the call bar's lead and direction.
    if (url.startsWith("/api/setups/agent-context")) return new Response(JSON.stringify(agentContext), { status: 200 });
    return new Response(JSON.stringify(served), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};
type FetchMock = ReturnType<typeof routedFetch>;
const posted = (fn: FetchMock, url: string) => fn.mock.calls.filter(([u, init]) => u === url && init?.method === "POST").map(([, init]) => JSON.parse((init as RequestInit).body as string));
const field = (label: string) => document.querySelector(`[aria-label="${label}"]`);
const chooseItem = (trigger: Element, name: string) => {
  fireEvent.keyDown(trigger, { key: "Enter" });
  const item = screen.getAllByRole("option").find((o) => o.textContent?.startsWith(name))!;
  fireEvent.pointerDown(item, { pointerType: "mouse" });
  fireEvent.pointerUp(item, { pointerType: "mouse" }); // a mouse pick; the keyboard pick is the Enter key on the item
};
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The call bar's lead and direction, which the dialog reads when it opens, beside the dialog itself. */
function CallBar({ children }: { children: React.ReactNode }) {
  return (
    <>
      <select id="playLead" aria-label="Lead" defaultValue="lead-7">
        <option value="lead-1">Ann Lee</option>
        <option value="lead-7">Jane Doe</option>
      </select>
      <input type="hidden" id="playDir" value="outbound" readOnly />
      {children}
    </>
  );
}

/** A page that keeps the state the way the app does: refresh puts the server's answer in place. */
function StatefulPage({ initial, onRefresh }: { initial: AppState; onRefresh?: (s?: AppState) => void }) {
  const [s, setS] = useState(initial);
  return <CallBar><CallSetupDialog state={s} refresh={async (next) => { onRefresh?.(next); if (next) setS(next); }} /></CallBar>;
}

const render_ = (s: AppState = state, refresh: (s?: AppState) => Promise<void> = async () => {}) => render(<CallBar><CallSetupDialog state={s} refresh={refresh} /></CallBar>);
// The open dialog hides the rest of the page from assistive technology, so the Play button is found by its id.
const openDialog = () => fireEvent.click(document.getElementById("playSetup")!);
const radio = (id: string) => document.getElementById(`setupOrchestrator-${id}`)!;
const goButton = () => document.getElementById("callGo") as HTMLButtonElement;
/** Renders the dialog, opens it from Play and chooses the orchestrator the state already holds (no post). */
const openOn = async (s: AppState = state, refresh?: (s?: AppState) => Promise<void>) => {
  render_(s, refresh);
  openDialog();
  await waitFor(() => expect(radio(s.selectedOrchestratorId)).not.toBeNull());
  fireEvent.click(radio(s.selectedOrchestratorId));
};
const openAdvanced = () => fireEvent.click(document.getElementById("setupAdvanced")!);

describe("call setup dialog", () => {
  it("opens from Play with only the orchestrator step: nothing below it and Go disabled until one is chosen", async () => {
    routedFetch(fakeOptions);
    render_();
    expect(screen.getByRole("button", { name: /^Play/ }).id).toBe("playSetup");
    expect(screen.queryByRole("dialog")).toBeNull();
    openDialog();
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    const radios = screen.getAllByRole("radio");
    // The server's orchestrators plus the local Pipecat Flows engine, which is this dialog's own choice.
    expect(radios.map((r) => r.id)).toEqual(["setupOrchestrator-direct", "setupOrchestrator-pipecat", "setupOrchestrator-pipecat_local"]);
    // None is chosen when the dialog opens, even though the server has Pipecat selected.
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    await settle();
    for (const id of ["stackVoicePath", "stackSlot-speech_to_speech", "agentSettings", "setupAdvanced", "stackStaleDrop", "stackDecisionModule"]) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(goButton().disabled).toBe(true);
    expect((document.getElementById("setupNext") as HTMLButtonElement).disabled).toBe(true);
    // Choosing an engine moves to the Voice stage: the cards leave, the voice fields arrive, Go comes on.
    fireEvent.click(radio("pipecat"));
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(document.getElementById("setupStepper")!.textContent).toContain("Pipecat");
    await waitFor(() => expect(goButton().disabled).toBe(false));
  });

  it("says which lead and direction the call is for, as chosen in the call bar", async () => {
    routedFetch(fakeOptions);
    render_();
    openDialog();
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    expect(screen.getByRole("dialog").textContent).toContain("Jane Doe · outbound");
    expect(document.getElementById("setupFindLead")).not.toBeNull();
  });

  it("choosing an orchestrator posts /api/orchestration/select only when it differs from the server's", async () => {
    const fetchMock = routedFetch(fakeOptions, { "/api/orchestration/select": () => new Response(JSON.stringify({ ...state, selectedOrchestratorId: "direct" }), { status: 200 }) });
    render(<StatefulPage initial={state} />);
    openDialog();
    await waitFor(() => expect(radio("pipecat")).not.toBeNull());
    fireEvent.click(radio("pipecat"));
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    await settle();
    expect(posted(fetchMock, "/api/orchestration/select")).toHaveLength(0);
    // Back to the engine stage, then the other orchestrator: one post.
    fireEvent.click(document.getElementById("setupBack")!);
    await waitFor(() => expect(radio("direct")).not.toBeNull());
    fireEvent.click(radio("direct"));
    await waitFor(() => expect(posted(fetchMock, "/api/orchestration/select")).toHaveLength(1));
    expect(posted(fetchMock, "/api/orchestration/select")[0]).toEqual({ orchestratorId: "direct", source: "call-setup" });
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    fireEvent.click(document.getElementById("setupBack")!);
    await waitFor(() => expect(radio("direct").getAttribute("aria-checked")).toBe("true"));
    // The server now holds Direct, so choosing it again sends nothing.
    fireEvent.click(radio("direct"));
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    await settle();
    expect(posted(fetchMock, "/api/orchestration/select")).toHaveLength(1);
    expect(goButton().disabled).toBe(false);
  });

  it("a refused orchestrator switch shows a toast, rereads the state and leaves no orchestrator chosen", async () => {
    const { toast } = await import("sonner");
    const refreshed = vi.fn();
    const fetchMock = routedFetch(fakeOptions, { "/api/orchestration/select": () => new Response(JSON.stringify({ error: "deepgram_needs_pipecat", ...state }), { status: 409 }) });
    render(<StatefulPage initial={state} onRefresh={refreshed} />);
    openDialog();
    await waitFor(() => expect(radio("direct")).not.toBeNull());
    fireEvent.click(radio("direct"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("deepgram_needs_pipecat"));
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/state")).toBe(true);
    expect(refreshed).toHaveBeenCalledWith(state);
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(3));
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(field("Voice path")).toBeNull();
    expect(goButton().disabled).toBe(true);
  });

  it("keeps Go disabled when the server's voice path is not offered by the chosen orchestrator", async () => {
    routedFetch(fakeOptions);
    await openOn({ ...state, selectedOrchestratorId: "direct", selectedVoicePathId: "deepgram" });
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    await settle();
    expect(goButton().disabled).toBe(true);
    expect(document.getElementById("agentSettings")).toBeNull();
    expect(document.getElementById("setupAdvanced")).toBeNull();
  });

  it("Go warms up with the lead from the call bar, then closes the dialog and starts the call once with a ring", async () => {
    const result: WarmupResult = { ok: true, totalMs: 412, steps: [{ id: "voice_path", label: "Voice path", ok: true, ms: 1 }, { id: "lead", label: "Lead", ok: true, ms: 80 }] };
    const fetchMock = routedFetch(fakeOptions, { "/api/call/warmup": () => new Response(JSON.stringify(result), { status: 200 }) });
    await openOn();
    await waitFor(() => expect(goButton().disabled).toBe(false));
    fireEvent.click(goButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(fetchMock, "/api/call/warmup")).toEqual([{ leadId: "lead-7" }]);
    expect(voiceClient.startBoundCall).toHaveBeenCalledTimes(1);
    expect(voiceClient.startBoundCall).toHaveBeenCalledWith({ ring: true });
  });

  it("a warm-up that is not ok keeps the dialog open, lists the failing step and starts no call", async () => {
    const result: WarmupResult = { ok: false, totalMs: 1500, steps: [
      { id: "voice_path", label: "Voice path", ok: true, ms: 1 },
      { id: "azure", label: "Azure", ok: false, ms: 3, code: "azure_not_ready", detail: "Azure is marked as not working." },
      { id: "decision_model", label: "Decision model", ok: true, skipped: true, ms: 0 },
    ] };
    routedFetch(fakeOptions, { "/api/call/warmup": () => new Response(JSON.stringify(result), { status: 200 }) });
    await openOn();
    await waitFor(() => expect(goButton().disabled).toBe(false));
    fireEvent.click(goButton());
    const { toast } = await import("sonner");
    await waitFor(() => expect(document.getElementById("callWarmup")).not.toBeNull());
    expect(screen.getByRole("dialog")).not.toBeNull();
    // The failure is a toast with the failing steps; the footer keeps the one-line result, timings and reasons in its tooltip.
    expect(toast.error).toHaveBeenCalledWith("The call cannot start yet", expect.objectContaining({ description: "Azure: Azure is marked as not working." }));
    const line = document.getElementById("callWarmup")!;
    expect(line.textContent).toContain("Not ready: ✓ Voice path · ✗ Azure · – Decision model");
    expect(line.getAttribute("title")).toContain("Azure is marked as not working.");
    expect(line.getAttribute("title")).toContain("skipped");
    expect(voiceClient.startBoundCall).not.toHaveBeenCalled();
    expect(goButton().disabled).toBe(false);
  });

  it("a warm-up request that fails keeps the dialog open with the reason and starts no call", async () => {
    routedFetch(fakeOptions, { "/api/call/warmup": () => new Response(JSON.stringify({ error: "warmup_unavailable" }), { status: 500 }) });
    await openOn();
    await waitFor(() => expect(goButton().disabled).toBe(false));
    fireEvent.click(goButton());
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Warm-up failed: warmup_unavailable"));
    expect(voiceClient.startBoundCall).not.toHaveBeenCalled();
  });

  it("shows the Agent step once the voice path is known, read from GET /api/setups/agent", async () => {
    const fetchMock = routedFetch(fakeOptions);
    await openOn();
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    expect(document.getElementById("agentSettings")).toBeNull();
    await waitFor(() => expect((document.getElementById("setupNext") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.getElementById("setupNext")!);
    await waitFor(() => expect(document.getElementById("agentSettings")).not.toBeNull());
    // The Voice stage's fields are gone: one stage at a time.
    expect(field("Voice path")).toBeNull();
    expect(document.getElementById("setupNext")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Agent");
    // The standing rules the agent gets, editable, with the lead block folded under them.
    await waitFor(() => expect(document.getElementById("agentContextText")).not.toBeNull());
    expect((document.getElementById("agentContextText") as HTMLTextAreaElement).value).toContain("Never state a price.");
    expect(document.getElementById("agentContextStatus")!.textContent).toBe("from the lab prompt");
    expect(document.getElementById("agentSettings")!.textContent).toContain("Agent for the next call");
    expect(document.getElementById("agentPromptSetup")!.textContent).toBe("Lab voice agent prompt");
    expect(fetchMock.mock.calls.some(([u, init]) => u === "/api/setups/agent" && init?.method === undefined)).toBe(true);
  });

  it("keeps the advanced settings collapsed until opened", async () => {
    routedFetch(fakeOptions);
    await openOn();
    await waitFor(() => expect(document.getElementById("setupAdvanced")).not.toBeNull());
    expect(document.getElementById("setupAdvanced")!.getAttribute("aria-expanded")).toBe("false");
    for (const id of ["stackStaleDrop", "stackDecisionModule"]) expect(document.getElementById(id), id).toBeNull();
    openAdvanced();
    expect(document.getElementById("setupAdvanced")!.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["stackStaleDrop", "stackDecisionModule"]) expect(document.getElementById(id), id).not.toBeNull();
    // Tree steering left the dialog: no decision tree switch, no decision router, no tree line.
    for (const id of ["setupVoiceLiveDecisionTree", "setupDecisionRouter", "stackDecisionTree"]) expect(document.getElementById(id), id).toBeNull();
  });

  // Moved from the settings panel tests: the same fields, now reached by opening the dialog and choosing an orchestrator.

  it("groups every setting: the engine cards, then the voice fields with the rest under More", async () => {
    routedFetch(fakeOptions);
    render_();
    openDialog();
    await waitFor(() => expect(screen.getByRole("radiogroup", { name: "Orchestrator" })).not.toBeNull());
    fireEvent.click(radio(state.selectedOrchestratorId));
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    openAdvanced();
    for (const label of ["Voice path", "Live voice model", "After a barge-in", "Decision module"]) expect(field(label), label).not.toBeNull();
    expect(document.getElementById("stackDecisionModule")!.textContent).toBe("Azure gpt-5.6-luna");
    expect(document.body.textContent).toContain("The real model, about 2 seconds per decision.");
    expect(document.body.textContent).not.toMatch(/azure_gpt_live|azure-decision/);
  });

  it("reveals the steps in order: no models before the voice path", async () => {
    routedFetch(fakeOptions);
    await openOn({ ...state, selectedVoicePathId: "" });
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    expect(field("Live voice model")).toBeNull();
  });

  it("opens every slot of the chosen path, and a speaking model brings its voices", async () => {
    routedFetch(fakeOptions);
    await openOn({ ...state, selectedVoicePathId: "deepgram" });
    await waitFor(() => expect(field("Listening model")).not.toBeNull());
    for (const label of ["Reply model", "Speaking model", "Voice for speaking model"]) expect(field(label), label).not.toBeNull();
    expect(field("Live voice model")).toBeNull();
  });

  it("never shows a model that is not deployed", async () => {
    routedFetch(fakeOptions);
    await openOn();
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    // The stored model name is not in the deployed list, so it must not leak into the dialog.
    expect(document.getElementById("stackSlot-speech_to_speech")!.textContent).toBe("gpt-live-1");
    cleanup();
    routedFetch({ ...fakeOptions, orchestrators: [{ ...fakeOptions.orchestrators[1]!, voicePaths: [{ id: "azure_gpt_live", label: "Azure live", slots: [{ role: "speech_to_speech", models: [{ ...live, id: "gpt-live-2", label: "gpt-live-2" }] }] }] }] });
    await openOn();
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    expect(document.getElementById("stackSlot-speech_to_speech")!.textContent).toBe("gpt-live-2");
    expect(document.body.textContent).not.toContain("gpt-live-1");
  });

  it("says plainly which source failed and why", async () => {
    routedFetch({ ...fakeOptions, sources: [{ provider: "azure", ok: true, checkedAt: now }, { provider: "deepgram", ok: false, detail: "The Deepgram key was refused.", checkedAt: now }] });
    await openOn();
    await waitFor(() => expect(document.getElementById("voiceOptionsStatus")).not.toBeNull());
    expect(document.getElementById("voiceOptionsStatus")!.textContent).toContain("Deepgram models could not be loaded: The Deepgram key was refused.");
  });

  it("reports an unreadable options endpoint instead of falling back to a built-in list", async () => {
    routedFetch({ status: 404 });
    await openOn();
    // With no options at all the dialog says so in its Voice step, in place of the voice fields.
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Voice options could not be loaded"));
    expect(field("Live voice model")).toBeNull();
    expect(field("Voice path")).toBeNull();
    expect(goButton().disabled).toBe(true);
  });

  it("a printable key on a closed dropdown picks nothing and sends nothing", async () => {
    const fetchMock = routedFetch({ ...fakeOptions, orchestrators: [{ ...fakeOptions.orchestrators[0]!, voicePaths: [{ id: "azure_gpt_live", label: "Azure live", slots: [{ role: "speech_to_speech", models: [live, { ...live, id: "gpt-realtime", label: "gpt-realtime" }], defaultId: "gpt-live-1" }] }] }] });
    await openOn({ ...state, selectedOrchestratorId: "direct" });
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    await settle();
    const calls = fetchMock.mock.calls.length;
    for (const key of ["g", "G", "r"]) fireEvent.keyDown(field("Live voice model")!, { key });
    await settle();
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(document.getElementById("stackSlot-speech_to_speech")!.textContent).toBe("gpt-live-1");
  });

  it("warns beside the model when the server does not allow it", async () => {
    routedFetch(fakeOptions);
    const blocked = { ...state, modules: [{ ...state.modules[0]!, modelAllowed: false, modelNotAllowedReason: "gpt-realtime is not allowed for calls." }] };
    await openOn(blocked);
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    expect(screen.getByRole("alert").textContent).toBe("gpt-realtime is not allowed for calls.");
  });

  it("the barge-in choice posts with where it came from", async () => {
    const fetchMock = routedFetch(fakeOptions);
    await openOn({ ...state, staleOutputDrops: [...state.staleOutputDrops, { id: "two_gaps", label: "Two gaps: up to 1.8 seconds" }] });
    await waitFor(() => expect(document.getElementById("setupAdvanced")).not.toBeNull());
    openAdvanced();
    chooseItem(field("After a barge-in")!, "Drop for two pauses");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/stale-output-drop")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/stale-output-drop")[0]).toEqual({ staleOutputDropId: "two_gaps", source: "call-setup" });
  });

  it("a refused decision module choice shows a toast and rereads the state", async () => {
    const { toast } = await import("sonner");
    const refresh = vi.fn(async () => {});
    const withRule = { ...state, decisionModules: [...state.decisionModules, { id: "keyword-stub", label: "keyword-stub", kind: "rule", available: true, selected: false }] };
    const fetchMock = routedFetch(fakeOptions, { "/api/decision-module/select": () => new Response(JSON.stringify({ error: "decision_module_busy" }), { status: 409 }) }, withRule);
    await openOn(withRule, refresh);
    await waitFor(() => expect(document.getElementById("setupAdvanced")).not.toBeNull());
    openAdvanced();
    chooseItem(field("Decision module")!, "Keyword rules");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("decision_module_busy"));
    expect(posted(fetchMock, "/api/decision-module/select")).toEqual([{ decisionModuleId: "keyword-stub", source: "call-setup" }]);
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/state")).toBe(true);
    expect(refresh).toHaveBeenCalledWith(withRule);
  });

  const deepgramOptions: VoiceOptions = {
    ...fakeOptions,
    orchestrators: [fakeOptions.orchestrators[0]!, { ...fakeOptions.orchestrators[1]!, voicePaths: [fakeOptions.orchestrators[1]!.voicePaths[0]!, { id: "deepgram", label: "Deepgram", slots: [
      { role: "reply", models: [{ id: "gpt-5-mini", label: "gpt-5-mini", role: "reply", provider: "azure" }, { id: "gpt-5", label: "gpt-5", role: "reply", provider: "azure" }], defaultId: "gpt-5-mini", selectedId: "gpt-5" },
      { role: "text_to_speech", models: [{ id: "aura-2", label: "aura-2", role: "text_to_speech", provider: "deepgram", voices: ["thalia", "apollo"] }], selectedId: "aura-2", selectedVoice: "apollo" },
    ] }] }],
  };

  it("seeds every slot from the server selection", async () => {
    routedFetch(deepgramOptions);
    await openOn({ ...state, selectedVoicePathId: "deepgram" });
    await waitFor(() => expect(field("Reply model")).not.toBeNull());
    expect(document.getElementById("stackSlot-reply")!.textContent).toBe("gpt-5");
    expect(document.getElementById("stackSlotVoice-text_to_speech")!.textContent).toBe("apollo");
  });

  it("a Deepgram voice change posts the path, role, model, voice and source, then rereads the options", async () => {
    const fetchMock = routedFetch(deepgramOptions, { "/api/voice/path-models": () => new Response(JSON.stringify(deepgramOptions), { status: 200 }) });
    await openOn({ ...state, selectedVoicePathId: "deepgram" });
    await waitFor(() => expect(field("Voice for speaking model")).not.toBeNull());
    await settle();
    const before = fetchMock.mock.calls.filter(([u]) => u === "/api/voice/options").length;
    chooseItem(field("Voice for speaking model")!, "thalia");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/path-models")[0]).toEqual({ voicePathId: "deepgram", role: "text_to_speech", modelId: "aura-2", voice: "thalia", source: "call-setup" });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === "/api/voice/options").length).toBeGreaterThan(before));
  });

  it("a refused slot choice shows a toast and the field keeps the server value", async () => {
    const { toast } = await import("sonner");
    routedFetch(deepgramOptions, { "/api/voice/path-models": () => new Response(JSON.stringify({ error: "deepgram_model_not_offered" }), { status: 409 }) });
    await openOn({ ...state, selectedVoicePathId: "deepgram" });
    await waitFor(() => expect(field("Reply model")).not.toBeNull());
    chooseItem(field("Reply model")!, "gpt-5-mini");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("deepgram_model_not_offered"));
    expect(document.getElementById("stackSlot-reply")!.textContent).toBe("gpt-5");
  });

  const blockedState = { ...state, modules: [{ ...state.modules[0]!, config: { ...state.modules[0]!.config, model: "gpt-realtime" }, modelAllowed: false, modelNotAllowedReason: "gpt-realtime is not allowed for calls." }] };

  it("picking the shown model posts when the stored model is not allowed", async () => {
    const fetchMock = routedFetch(fakeOptions, { "/api/voice/path-models": () => new Response(JSON.stringify(fakeOptions), { status: 200 }) });
    await openOn(blockedState);
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    chooseItem(field("Live voice model")!, "gpt-live-1");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/path-models")[0]).toEqual({ voicePathId: "azure_gpt_live", role: "speech_to_speech", modelId: "gpt-live-1", voice: "verse", source: "call-setup" });
    expect(screen.getByRole("alert")).not.toBeNull();
  });

  const openBlocked = async () => {
    const fetchMock = routedFetch(fakeOptions, { "/api/voice/path-models": () => new Response(JSON.stringify(fakeOptions), { status: 200 }) });
    await openOn(blockedState);
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    fireEvent.keyDown(field("Live voice model")!, { key: "Enter" });
    return { fetchMock, item: screen.getAllByRole("option").find((o) => o.textContent?.startsWith("gpt-live-1"))! };
  };

  it("a release over the shown model with no press on it (the end of the opening click) posts nothing", async () => {
    const { fetchMock, item } = await openBlocked();
    fireEvent.pointerUp(item, { pointerType: "mouse" });
    await settle();
    expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(0);
  });

  it("a touch tap on the shown model posts once, through the click", async () => {
    const { fetchMock, item } = await openBlocked();
    fireEvent.pointerDown(item, { pointerType: "touch" });
    fireEvent.pointerUp(item, { pointerType: "touch" });
    await settle();
    expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(0);
    fireEvent.click(item);
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(1));
  });

  it("picking the shown model sends nothing when the stored model is allowed", async () => {
    const fetchMock = routedFetch(fakeOptions);
    await openOn();
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    chooseItem(field("Live voice model")!, "gpt-live-1");
    await settle();
    expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(0);
  });

  // Azure Voice Live: listed under Direct only; its model and voice live in POST /api/voice/path-models, not on the azure-gpt-live module.
  const voiceLiveVoices = ["en-US-Ava:DragonHDLatestNeural", "en-US-Andrew:DragonHDLatestNeural"];
  const voiceLiveModel = (id: string, label: string): ModelOption => ({ id, label, role: "speech_to_speech", provider: "azure", voices: voiceLiveVoices });
  const voiceLiveOptions: VoiceOptions = {
    ...fakeOptions,
    orchestrators: [{ ...fakeOptions.orchestrators[0]!, voicePaths: [fakeOptions.orchestrators[0]!.voicePaths[0]!, { id: "azure_voice_live", label: "Azure Voice Live", slots: [{
      role: "speech_to_speech",
      models: [voiceLiveModel("gpt-realtime", "gpt-realtime (hears and speaks itself)"), voiceLiveModel("gpt-4.1", "gpt-4.1 (text model, Azure speech in and out)")],
      defaultId: "gpt-realtime", selectedId: "gpt-4.1", selectedVoice: "en-US-Andrew:DragonHDLatestNeural",
    }] }] }, fakeOptions.orchestrators[1]!],
  };
  const onDirect: AppState = {
    ...state,
    selectedOrchestratorId: "direct",
    voicePaths: [...state.voicePaths.slice(0, 1), { id: "azure_voice_live", label: "Azure Voice Live", available: true }, ...state.voicePaths.slice(1)],
  };

  it("picking Azure Voice Live posts the path and leaves the Azure gpt-live model alone", async () => {
    const fetchMock = routedFetch(voiceLiveOptions);
    await openOn(onDirect);
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    chooseItem(field("Voice path")!, "Azure Voice Live");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/path")[0]).toEqual({ voicePathId: "azure_voice_live", source: "call-setup" });
    await settle();
    expect(posted(fetchMock, "/api/modules/azure-gpt-live")).toHaveLength(0);
  });

  it("picking Azure live voice still puts its stored model back to the default", async () => {
    const fetchMock = routedFetch(voiceLiveOptions);
    await openOn({ ...onDirect, selectedVoicePathId: "azure_voice_live" });
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    chooseItem(field("Voice path")!, "Azure live voice");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path")).toHaveLength(1));
    await settle();
    expect(posted(fetchMock, "/api/modules/azure-gpt-live")).toEqual([{ model: "gpt-live-1", voice: "verse", source: "call-setup" }]);
  });

  it("the Azure Voice Live model slot shows its own models and selection, and a choice posts to that path", async () => {
    const fetchMock = routedFetch(voiceLiveOptions, { "/api/voice/path-models": () => new Response(JSON.stringify(voiceLiveOptions), { status: 200 }) });
    await openOn({ ...onDirect, selectedVoicePathId: "azure_voice_live" });
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    expect(document.getElementById("stackSlot-speech_to_speech")!.textContent).toBe("gpt-4.1 (text model, Azure speech in and out)");
    expect(document.getElementById("stackSlotVoice-speech_to_speech")!.textContent).toBe("en-US-Andrew:DragonHDLatestNeural");
    fireEvent.keyDown(field("Live voice model")!, { key: "Enter" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["gpt-realtime (hears and speaks itself)Azure", "gpt-4.1 (text model, Azure speech in and out)Azure"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    chooseItem(field("Live voice model")!, "gpt-realtime (");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/path-models")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/path-models")[0]).toEqual({ voicePathId: "azure_voice_live", role: "speech_to_speech", modelId: "gpt-realtime", voice: "en-US-Ava:DragonHDLatestNeural", source: "call-setup" });
    await settle();
    expect(posted(fetchMock, "/api/modules/azure-gpt-live")).toHaveLength(0);
  });

  it("Azure Voice Live gets one flow choice, step by step by default, posted with where it came from; the other paths get none", async () => {
    const fetchMock = routedFetch(voiceLiveOptions, { "/api/voice/voice-live-flow": () => new Response(JSON.stringify({ ...onDirect, selectedVoicePathId: "azure_voice_live", voiceLiveFlow: "one_prompt" }), { status: 200 }) });
    render(<StatefulPage initial={{ ...onDirect, selectedVoicePathId: "azure_voice_live" }} />);
    openDialog();
    await waitFor(() => expect(radio("direct")).not.toBeNull());
    fireEvent.click(radio("direct"));
    await waitFor(() => expect(field("Flow")).not.toBeNull());
    expect(document.getElementById("setupVoiceLiveFlow")!.textContent).toBe("Step by step");
    expect(document.getElementById("setupStepper")!.textContent).toContain("step by step");
    chooseItem(field("Flow")!, "One prompt");
    await waitFor(() => expect(posted(fetchMock, "/api/voice/voice-live-flow")).toHaveLength(1));
    expect(posted(fetchMock, "/api/voice/voice-live-flow")[0]).toEqual({ flow: "one_prompt", source: "call-setup" });
    await waitFor(() => expect(document.getElementById("setupVoiceLiveFlow")!.textContent).toBe("One prompt"));
    expect(document.getElementById("setupStepper")!.textContent).toContain("one prompt");
    cleanup();
    routedFetch(voiceLiveOptions);
    await openOn(onDirect);
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    expect(field("Flow")).toBeNull();
  });

  it("the Azure Voice Live slot ignores the Azure gpt-live model and its warning", async () => {
    routedFetch({ ...voiceLiveOptions, orchestrators: [{ ...voiceLiveOptions.orchestrators[0]!, voicePaths: [voiceLiveOptions.orchestrators[0]!.voicePaths[0]!, {
      ...voiceLiveOptions.orchestrators[0]!.voicePaths[1]!,
      slots: [{ role: "speech_to_speech", models: [voiceLiveModel("gpt-realtime", "gpt-realtime (hears and speaks itself)"), voiceLiveModel("gpt-4.1", "gpt-4.1 (text model, Azure speech in and out)")], defaultId: "gpt-realtime" }],
    }] }] });
    // The azure-gpt-live module holds a model that is also in the Voice Live list, and the server does not allow it for calls.
    const blocked = { ...onDirect, selectedVoicePathId: "azure_voice_live", modules: [{ ...state.modules[0]!, config: { ...state.modules[0]!.config, model: "gpt-4.1" }, modelAllowed: false, modelNotAllowedReason: "gpt-4.1 is not allowed for calls." }] };
    await openOn(blocked);
    await waitFor(() => expect(field("Live voice model")).not.toBeNull());
    expect(document.getElementById("stackSlot-speech_to_speech")!.textContent).toBe("gpt-realtime (hears and speaks itself)");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an unavailable voice path appears disabled with its reason in plain words", async () => {
    routedFetch({ ...fakeOptions, orchestrators: [fakeOptions.orchestrators[0]!] });
    const down = { ...onDirect, voicePaths: [state.voicePaths[0]!, { id: "azure_voice_live", label: "Azure Voice Live", available: false, unavailableReason: "azure_voice_live_missing_key" }, state.voicePaths[1]!] };
    await openOn(down);
    await waitFor(() => expect(field("Voice path")).not.toBeNull());
    fireEvent.keyDown(field("Voice path")!, { key: "Enter" });
    const option = (name: string) => screen.getAllByRole("option").find((o) => o.textContent?.startsWith(name))!;
    expect(option("Azure live voice").getAttribute("aria-disabled")).not.toBe("true");
    expect(option("Azure Voice Live").getAttribute("aria-disabled")).toBe("true");
    expect(option("Azure Voice Live").textContent).toBe("Azure Voice LiveAZURE_VOICE_LIVE_KEY is missing from the settings file.");
    // A reason the dialog does not know reads as a plain fallback, never as the server's raw text.
    expect(option("Deepgram speech").getAttribute("aria-disabled")).toBe("true");
    expect(option("Deepgram speech").textContent).toBe("Deepgram speechUnavailable right now.");
    expect(document.body.textContent).not.toMatch(/azure_voice_live_missing_key|No Deepgram key/);
  });
});
