import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePipecatPython } from "../../src/orchestration-modules/pipecat-config.js";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { baseLead } from "../helpers/fixtures.js";
import { clearedTestCall } from "../helpers/cleared-call.js";
import {
  activeVoiceCallId,
  closeActiveVoiceSession,
  resetTalkOrchestrator,
  resetVoiceDeps,
  resolveVoiceSessionMode,
  selectTalkOrchestrator,
  selectedTalkOrchestrator,
} from "../../src/server/voice/manager.js";

const pipecatPython = resolvePipecatPython();

beforeEach(() => {
  resetTalkOrchestrator();
  resetVoiceDeps();
  resetHarnessConfig();
  resetLeadStore();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

const clearedCall = clearedTestCall;

function openParams(callId: string) {
  return {
    input: "text" as const,
    trace: { leadId: "lead-1", recordId: callId, channel: "call" as const, direction: "inbound" as const, callId },
    leadFirstName: "Jane",
    direction: "inbound" as const,
    disclosure: "Hi",
    packet: { leadId: "lead-1", name: "Jane", agencyId: "agency-1", phone: "+15550100", priorCallSummaries: [], quoteFields: {}, consentSnapshot: {} },
    dialogOwnsTranscript: false,
    onAudio: () => {},
    onClearPlayback: () => {},
  };
}

describe("voice session slot", () => {
  it("closeActiveVoiceSession is a no-op when idle", () => {
    expect(activeVoiceCallId()).toBeUndefined();
    closeActiveVoiceSession("test");
    expect(activeVoiceCallId()).toBeUndefined();
  });

  it("selectTalkOrchestrator clears the slot when a session was registered", async () => {
    const stop = vi.fn();
    const { openVoiceSession, setVoiceDeps } = await import("../../src/server/voice/manager.js");
    setVoiceDeps({
      credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }),
      socketFactory: async () => {
        const handlers: Array<(raw: string) => void> = [];
        return {
          send: () => {},
          close: () => handlers.forEach((h) => h("")),
          onMessage: (cb) => void handlers.push(cb),
          onClose: (cb) => void handlers.push(() => cb()),
        };
      },
    });
    const session = {
      start: async () => {},
      stop,
      sendAudio: () => {},
      bargeIn: () => {},
      sendCallerText: async () => {},
      isEnded: false,
    };
    const mod = (await import("../../src/modules/registry.js")).getModuleRegistry().get("azure-gpt-live") as unknown as {
      openLiveSession: (...args: unknown[]) => unknown;
    };
    const orig = mod.openLiveSession.bind(mod);
    mod.openLiveSession = () => session as never;
    const call = await clearedCall();
    try {
      selectTalkOrchestrator("direct");
      await openVoiceSession({ ...openParams(call.callId), call, dialogOwnsTranscript: true });
      expect(activeVoiceCallId()).toBe(call.callId);
      selectTalkOrchestrator("pipecat");
      expect(activeVoiceCallId()).toBeUndefined();
      expect(stop).toHaveBeenCalledWith("orchestrator_switch");
    } finally {
      mod.openLiveSession = orig;
      resetVoiceDeps();
      resetTalkOrchestrator();
      await call.hangUp();
    }
  });
});

describe("a browser that leaves while the session is starting", () => {
  it("cancels a pending socket setup and frees the voice slot", async () => {
    const { openVoiceSession, setVoiceDeps } = await import("../../src/server/voice/manager.js");
    let lateClose = false;
    let resolveSocket: (s: never) => void = () => undefined;
    setVoiceDeps({
      credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }),
      socketFactory: () => new Promise((resolve) => (resolveSocket = resolve as never)),
    });
    selectTalkOrchestrator("direct");
    const call = await clearedCall();
    const left = new AbortController();
    const opening = openVoiceSession({ ...openParams(call.callId), call, signal: left.signal }).catch((err: Error) => err.message);
    expect(activeVoiceCallId()).toBe(call.callId);
    left.abort();
    expect(await opening).toBe("voice_session_ended");
    expect(activeVoiceCallId()).toBeUndefined();
    resolveSocket({ send: () => {}, close: () => void (lateClose = true), onMessage: () => {}, onClose: () => {} } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(lateClose).toBe(true);
    await call.hangUp();
  });
});

describe("only a call the harness cleared gets a live session", () => {
  it("refuses a look-alike object that only claims to be connected, and opens no socket", async () => {
    const { openVoiceSession, setVoiceDeps } = await import("../../src/server/voice/manager.js");
    const factory = vi.fn(async () => ({ send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} }));
    setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: factory });
    selectTalkOrchestrator("direct");
    const opened = await openVoiceSession({ ...openParams("call_forged"), call: { callId: "call_forged", status: "connected" } }).catch((err: Error) => err.message);
    expect(opened).toBe("call_not_cleared");
    expect(factory).not.toHaveBeenCalled();
    expect(activeVoiceCallId()).toBeUndefined();
    const mod = (await import("../../src/modules/registry.js")).getModuleRegistry().get("azure-gpt-live") as unknown as {
      openLiveSession: (call: unknown, o: unknown) => unknown;
    };
    expect(() => mod.openLiveSession({ status: "connected" }, {})).toThrow("call_not_cleared");
  });

  it("refuses a genuine call whose trace names another call", async () => {
    const { openVoiceSession } = await import("../../src/server/voice/manager.js");
    selectTalkOrchestrator("direct");
    const call = await clearedCall();
    try {
      const opened = await openVoiceSession({ ...openParams("call_other"), call }).catch((err: Error) => err.message);
      expect(opened).toBe("call_not_cleared");
    } finally {
      await call.hangUp();
    }
  });
});

describe("voice session mode", () => {
  it.skipIf(!pipecatPython)("defaults to Pipecat when Pipecat is configured", () => {
    resetTalkOrchestrator();
    expect(selectedTalkOrchestrator()).toBe("pipecat");
  });

  it("labels direct Azure microphone and text honestly", () => {
    selectTalkOrchestrator("direct");
    expect(resolveVoiceSessionMode("audio")).toBe("direct_azure_microphone");
    expect(resolveVoiceSessionMode("text")).toBe("direct_azure_text");
  });

  it.skipIf(!pipecatPython)("uses pipecat modes when pipecat is selected", () => {
    selectTalkOrchestrator("pipecat");
    expect(resolveVoiceSessionMode("audio")).toBe("pipecat_microphone");
    expect(resolveVoiceSessionMode("text")).toBe("pipecat_text_stand_in");
  });
});

describe("stale-output drop setting", () => {
  it("defaults to one gap, lists three choices, and refuses an unknown id", async () => {
    const m = await import("../../src/server/voice/manager.js");
    m.resetStaleOutputDrop();
    expect(m.selectedStaleOutputDrop()).toBe("one_gap");
    expect(m.listStaleOutputDrops(900).map((d) => [d.id, d.maxMs])).toEqual([["off", 0], ["one_gap", 900], ["two_gaps", 1800]]);
    expect(() => m.selectStaleOutputDrop("forever" as never)).toThrow("unknown_stale_output_drop");
    expect(() => m.selectStaleOutputDrop("toString" as never)).toThrow("unknown_stale_output_drop");
    expect(() => m.selectStaleOutputDrop(["off"] as never)).toThrow("unknown_stale_output_drop");
    expect(m.selectedStaleOutputDrop()).toBe("one_gap");
  });

  it("the next Direct Azure session gets the selected cap", async () => {
    const m = await import("../../src/server/voice/manager.js");
    const mod = (await import("../../src/modules/registry.js")).getModuleRegistry().get("azure-gpt-live") as unknown as {
      openLiveSession: (...args: unknown[]) => unknown;
    };
    const orig = mod.openLiveSession.bind(mod);
    const seen: unknown[] = [];
    mod.openLiveSession = (...args: unknown[]) => {
      seen.push((args[1] as { staleOutputCapGaps?: number }).staleOutputCapGaps);
      return { start: async () => {}, stop: () => {}, sendAudio: () => {}, bargeIn: () => {}, sendCallerText: async () => {}, isEnded: false } as never;
    };
    try {
      m.selectTalkOrchestrator("direct");
      for (const choice of ["off", "two_gaps", "one_gap"] as const) {
        m.selectStaleOutputDrop(choice);
        const call = await clearedCall();
        await m.openVoiceSession({ ...openParams(call.callId), call, dialogOwnsTranscript: true });
        m.closeActiveVoiceSession("test");
        await call.hangUp();
      }
      expect(seen).toEqual([0, 2, 1]);
    } finally {
      mod.openLiveSession = orig;
      m.resetStaleOutputDrop();
      m.resetTalkOrchestrator();
    }
  });

  it("the Pipecat session passes the cap to its Azure session", async () => {
    const { PipecatOrchestratedLiveSession } = await import("../../src/server/voice/pipecat-orchestrated-session.js");
    const s = new PipecatOrchestratedLiveSession(
      "pipecat_microphone",
      {
        socketFactory: async () => ({ send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} }),
        credentials: () => ({ liveUrl: "wss://example.openai.azure.com/x", apiKey: "k" }),
        trace: { leadId: "lead-1", recordId: "call_p", channel: "call", direction: "inbound", callId: "call_p" },
        model: "gpt-live-1",
        voice: "verse",
        instructions: "x",
        disclosure: "Hi",
        maxMs: 1000,
        staleOutputCapGaps: 0,
        dialogOwnsTranscript: true,
        onAudio: () => {},
        onClearPlayback: () => {},
        onEnd: () => {},
      },
      () => {},
      () => {},
      "call_p",
    );
    expect((s as unknown as { azure: { o: { staleOutputCapGaps?: number } } }).azure.o.staleOutputCapGaps).toBe(0);
  });
});
