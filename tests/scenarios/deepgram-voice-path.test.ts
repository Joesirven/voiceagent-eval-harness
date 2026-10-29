import { createServer, type Server } from "node:http";
import { controlPageBundle } from "../helpers/control-page.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { handle } from "../../src/server/dev-server.js";
import { deepgramUnavailableReason, DeepgramVoiceRuntime } from "../../src/server/voice/deepgram-voice-runtime.js";
import { storePathModel } from "../../src/server/voice/path-model-choices.js";
import { recentVoiceErrors } from "../../src/server/voice/voice-errors.js";
import {
  activeVoiceCallId,
  closeActiveVoiceSession,
  listVoicePaths,
  openVoiceSession,
  resetVoiceDeps,
  selectStaleOutputDrop,
  selectTalkOrchestrator,
  selectVoicePath,
  selectedVoicePath,
  setVoiceDeps,
} from "../../src/server/voice/manager.js";
import { baseLead } from "../helpers/fixtures.js";
import { clearedTestCall } from "../helpers/cleared-call.js";

const fakeSidecar = fileURLToPath(new URL("../helpers/fake-deepgram-sidecar.mjs", import.meta.url));

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  resetVoiceDeps();
  resetHarnessConfig();
  resetLeadStore();
  resetModuleRegistry();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

function openParams(callId: string) {
  return {
    input: "text" as const,
    trace: { leadId: "lead-1", recordId: callId, channel: "call" as const, direction: "inbound" as const, callId },
    leadFirstName: "Jane",
    direction: "inbound" as const,
    disclosure: "Hi, I am an AI assistant.",
    packet: { leadId: "lead-1", name: "Jane", agencyId: "agency-1", phone: "+15550100", priorCallSummaries: [], quoteFields: {}, consentSnapshot: {} },
    dialogOwnsTranscript: false,
    onAudio: () => {},
    onClearPlayback: () => {},
  };
}

describe("voice path picker", () => {
  it("defaults to Azure gpt-live and lists every path in /api/state", async () => {
    const state = await (await fetch(base + "/api/state")).json();
    expect(state.selectedVoicePathId).toBe("azure_gpt_live");
    expect(state.voicePaths.map((v: { id: string }) => v.id)).toEqual(["azure_gpt_live", "azure_voice_live", "deepgram"]);
    expect(state.voicePaths[0].available).toBe(true);
    const reason = deepgramUnavailableReason();
    const dg = state.voicePaths.find((v: { id: string }) => v.id === "deepgram");
    expect(dg.available).toBe(!reason);
    expect(dg.unavailableReason).toBe(reason);
    expect(await controlPageBundle(base)).toContain("stackVoicePath");
  });

  it("refuses an unknown id, and Deepgram while its sidecar or interpreter is missing", async () => {
    expect((await post("/api/voice/path", { voicePathId: "vapi" })).status).toBeGreaterThanOrEqual(400);
    expect((await post("/api/voice/path", { voicePathId: ["deepgram"] })).status).toBeGreaterThanOrEqual(400);
    const reason = deepgramUnavailableReason();
    const res = await post("/api/voice/path", { voicePathId: "deepgram" });
    if (reason) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(selectedVoicePath()).toBe("azure_gpt_live");
    } else {
      expect(res.json.selectedVoicePathId).toBe("deepgram");
    }
    const back = await post("/api/voice/path", { voicePathId: "azure_gpt_live" });
    expect(back.json.selectedVoicePathId).toBe("azure_gpt_live");
  });

  it("the next Talk session runs the Deepgram sidecar with the selected stale-output cap, and switching path ends it", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "dg-path-")), "received.jsonl");
    const received = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    setVoiceDeps({
      deepgramRuntime: () =>
        new DeepgramVoiceRuntime(() => ({ command: process.execPath, args: [fakeSidecar], env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile } })),
    });
    expect(listVoicePaths().find((v) => v.id === "deepgram")!.available).toBe(true);
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    selectStaleOutputDrop("two_gaps");
    const call = await clearedTestCall();
    try {
      const session = (await openVoiceSession({ ...openParams(call.callId), call })) as { sessionMode?: string };
      expect(session.sessionMode).toBe("deepgram_pipecat");
      expect(activeVoiceCallId()).toBe(call.callId);
      expect(received()[0]).toMatchObject({ type: "start", stale_output_cap_gaps: 2, disclosure: "Hi, I am an AI assistant." });
      selectVoicePath("deepgram");
      expect(activeVoiceCallId()).toBe(call.callId);
      expect((session as { isEnded?: boolean }).isEnded).toBe(false);
      selectVoicePath("azure_gpt_live");
      expect(activeVoiceCallId()).toBeUndefined();
      expect((session as { isEnded?: boolean }).isEnded).toBe(true);
    } finally {
      closeActiveVoiceSession("test");
      selectStaleOutputDrop("one_gap");
      resetVoiceDeps();
      await call.hangUp();
    }
  });

  it("the next Talk session sends the speech to text model and the Aura-2 voice chosen in Settings", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "dg-path-")), "received.jsonl");
    const received = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    setVoiceDeps({
      deepgramRuntime: () =>
        new DeepgramVoiceRuntime(() => ({ command: process.execPath, args: [fakeSidecar], env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile } })),
    });
    selectTalkOrchestrator("pipecat"); // the Deepgram path runs through the Pipecat helper
    selectVoicePath("deepgram");
    // What POST /api/voice/path-models stores once GET /api/voice/options offers it.
    storePathModel("deepgram", "speech_to_text", { modelId: "nova-3-medical" });
    storePathModel("deepgram", "text_to_speech", { modelId: "aura-2", voice: "aura-2-orion-en" });
    const call = await clearedTestCall();
    try {
      await openVoiceSession({ ...openParams(call.callId), call });
      expect(received()[0]).toMatchObject({ type: "start", stt_model: "nova-3-medical", voice: "aura-2-orion-en" });
    } finally {
      closeActiveVoiceSession("test");
      resetVoiceDeps();
      await call.hangUp();
    }
  });

  it("refuses the Deepgram path with the Direct orchestrator, as GET /api/voice/options lists it under Pipecat only", async () => {
    setVoiceDeps({ deepgramRuntime: () => new DeepgramVoiceRuntime(() => ({ command: process.execPath, args: [fakeSidecar], env: { PATH: process.env.PATH ?? "" } })) });
    selectTalkOrchestrator("direct");
    expect(() => selectVoicePath("deepgram")).toThrow("deepgram_needs_pipecat");
    expect(recentVoiceErrors().at(-1)).toMatchObject({ code: "deepgram_needs_pipecat", path: "deepgram" });
    selectTalkOrchestrator("pipecat");
    selectVoicePath("deepgram");
    // Going back to Direct also takes the speech path back to Azure gpt-live, so the two never disagree.
    selectTalkOrchestrator("direct");
    expect(selectedVoicePath()).toBe("azure_gpt_live");
    resetVoiceDeps();
  });
});
