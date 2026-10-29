import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHarnessConfig, resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { loadTree } from "../../src/decision/tree.js";
import { resetActiveTree } from "../../src/decision/tree-source.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetJudges } from "../../src/judge/index.js";
import type { LiveSocket } from "../../src/modules/azure-live-session.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { resetTalkOrchestrator, resetVoiceDeps, setVoiceDeps } from "../../src/server/voice/manager.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import type { SimulatedLead } from "../../src/judging/offline/types.js";
import { runLiveWholeCall, type LiveSetup } from "../../src/simulator/live-text-session.js";
import { baseLead } from "../helpers/fixtures.js";

const clock = { now: () => new Date("2026-10-15T14:00:00.000Z") };

/** One question, then a booking or a polite end. The stub keyword module routes on the cues. */
function tinyTree() {
  return loadTree({
    id: "live-text-test-tree",
    version: "0.0.1",
    start: "disclosure",
    maxClarifications: 2,
    escalation: { say: "Let me bring in a person.", disposition: "handed_off" },
    dispositions: [
      { name: "handed_off", label: "Handed off", durable: false },
      { name: "talked", label: "Talked", durable: false },
    ],
    nodes: [
      { id: "disclosure", label: "Disclosure", flowStep: "disclosure", next: "ask" },
      {
        id: "ask",
        label: "Ask",
        flowStep: "recognize_lead",
        agentLines: [{ line: "Do you have a minute?" }],
        clarify: "Sorry, do you have a minute?",
        decision: {
          question: "Does the caller have a minute?",
          answers: [
            { answer: "yes", disposition: "talked", say: "Great, thanks. Goodbye.", minConfidence: 0.5, cues: ["sure", "yes"], onBlocked: { say: "Sorry, do you have a minute?" } },
            { answer: "unclear", minConfidence: 0 },
          ],
        },
      },
    ],
  });
}

interface FakeAzure {
  sent: string[];
  /** Agent replies to steers: the n-th steer gets reply n; a missing entry means silence. */
  replies: Array<string | null>;
}

function fakeAzure(f: FakeAzure) {
  return async (): Promise<LiveSocket> => {
    const onMessage: Array<(raw: string) => void> = [];
    const onClose: Array<() => void> = [];
    const push = (event: unknown) => setTimeout(() => onMessage.forEach((cb) => cb(JSON.stringify(event))), 5);
    let steers = 0;
    return {
      send: (raw: string) => {
        const msg = JSON.parse(raw) as { type: string; content?: string };
        f.sent.push(msg.type);
        if (msg.type === "session.start") push({ type: "session.started" });
        if (msg.type === "session.instructions.append") {
          // The first append is the disclosure; later ones are steers.
          const quoted = /"([^"]+)"/.exec(msg.content ?? "")?.[1] ?? "";
          const reply = steers === 0 ? quoted : f.replies[steers - 1];
          steers += 1;
          if (reply) push({ type: "session.output_transcript.delta", delta: `LIVE: ${reply}` });
        }
      },
      close: () => onClose.forEach((cb) => cb()),
      onMessage: (cb) => void onMessage.push(cb),
      onClose: (cb) => void onClose.push(cb),
    };
  };
}

class Lines implements SimulatedLead {
  readonly facts = { sourceCallId: "persona:test", objections: [] };
  private i = 0;
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines[this.i++] ?? null;
  }
}

const SETUP: LiveSetup = { orchestratorId: "direct", voicePathId: "azure_gpt_live", promptSetupId: "playbook-full", turnGapMs: 30, settleMs: 80, replyTimeoutMs: 600, goodbyeGraceMs: 10, openingSettleMs: 80 };

beforeEach(() => {
  resetHarnessConfig();
  resetLeadStore();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  resetActiveTree();
  resetTalkOrchestrator();
  resetVoiceDeps();
  setAiCallingEnabled(getHarnessConfig().agencyId, true);
  seedLead(baseLead());
});

afterEach(() => resetVoiceDeps());

describe("live text whole call", () => {
  it("records the live model's words as the transcript, steered by the tree, and streams silence", async () => {
    const sent: string[] = [];
    setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: fakeAzure({ sent, replies: ["Thanks, and goodbye for now."] }) });
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    const run = await runLiveWholeCall({ lead: new Lines(["Sure, yes."]), harness, leadId: "lead-1", direction: "inbound", setup: SETUP });

    expect(run.status).toBe("completed");
    expect(run.endedBy).toBe("agent_ended");
    const agent = run.transcript.filter((t) => t.role === "agent").map((t) => t.text);
    expect(agent.length).toBeGreaterThanOrEqual(2);
    expect(agent.every((t) => t.startsWith("LIVE: "))).toBe(true);
    expect(run.transcript.some((t) => t.role === "caller" && t.text === "Sure, yes.")).toBe(true);
    expect(run.events.some((e) => e.type === "disposition" && e.data.value === "talked")).toBe(true);
    // The tree's own lines are intended lines, not spoken ones.
    expect(run.events.some((e) => e.type === "tool_call" && e.data.tool === "intended_agent_line")).toBe(true);
    expect(sent).toContain("session.input_audio.append");
    expect(run.ran).toMatchObject({ orchestratorId: "direct", voicePathId: "azure_gpt_live", voiceModuleId: "azure-gpt-live", promptSetupId: "playbook-full" });
    expect(run.replyLatenciesMs).toHaveLength(1);
  });

  it("ends reply_timeout when the live model stays silent, and frees the session slot", async () => {
    setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: fakeAzure({ sent: [], replies: [null] }) });
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    const silent = await runLiveWholeCall({ lead: new Lines(["Hmm."]), harness, leadId: "lead-1", direction: "inbound", setup: SETUP });
    expect([silent.status, silent.endedBy, silent.leadTurns, silent.interrupted]).toEqual(["completed", "reply_timeout", 1, true]);

    // A second call can open at once: the first session's slot was released.
    seedLead(baseLead({ id: "lead-2" }));
    setVoiceDeps({ socketFactory: fakeAzure({ sent: [], replies: [] }) });
    const next = await runLiveWholeCall({ lead: new Lines([]), harness, leadId: "lead-2", direction: "inbound", setup: SETUP });
    expect([next.status, next.endedBy]).toEqual(["completed", "lead_hung_up"]);
  });

  it("refuses the unnamed prompt setup", async () => {
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    await expect(runLiveWholeCall({ lead: new Lines([]), harness, leadId: "lead-1", direction: "inbound", setup: { ...SETUP, promptSetupId: "default" } })).rejects.toThrow(
      "prompt_setup_must_be_named",
    );
  });

  it("records a start that fails before any session exists, and returns at once", async () => {
    setVoiceDeps({
      credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }),
      socketFactory: async () => {
        throw new Error("azure_connect_failed");
      },
    });
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    const run = await runLiveWholeCall({ lead: new Lines(["Sure."]), harness, leadId: "lead-1", direction: "inbound", setup: SETUP });
    expect([run.status, run.failureCode]).toEqual(["failed", "azure_connect_failed"]);
  });

  it("hangs the harness call up when the lead throws mid-call", async () => {
    setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: fakeAzure({ sent: [], replies: ["Go on."] }) });
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    const throwing: SimulatedLead = { facts: { sourceCallId: "persona:test", objections: [] }, next: async () => Promise.reject(new Error("model_ask_cap_reached")) };
    await expect(runLiveWholeCall({ lead: throwing, harness, leadId: "lead-1", direction: "inbound", setup: SETUP })).rejects.toThrow("model_ask_cap_reached");
    // The slot and the call are free: the next call for another lead opens and ends normally.
    seedLead(baseLead({ id: "lead-2" }));
    const next = await runLiveWholeCall({ lead: new Lines([]), harness, leadId: "lead-2", direction: "inbound", setup: SETUP });
    expect(next.endedBy).toBe("lead_hung_up");
  });

  it("calls an ending the tree filed agent_ended even when the live model then says nothing", async () => {
    setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: fakeAzure({ sent: [], replies: [null] }) });
    const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry(), { tree: tinyTree() });
    const run = await runLiveWholeCall({ lead: new Lines(["Sure, yes."]), harness, leadId: "lead-1", direction: "inbound", setup: SETUP });
    expect([run.endedBy, run.interrupted]).toEqual(["agent_ended", false]);
  });
});
