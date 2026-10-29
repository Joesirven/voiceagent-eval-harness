import { beforeEach, describe, expect, it } from "vitest";
import { getHarnessConfig, resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetActiveTree } from "../../src/decision/tree-source.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetJudges } from "../../src/judge/index.js";
import type { LiveSocket, LiveSocketFactory } from "../../src/modules/azure-live-session.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { resetTalkOrchestrator, resetVoiceDeps, setVoiceDeps } from "../../src/server/voice/manager.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { gradeWholeCall } from "../../src/judging/offline/whole-call.js";
import { LiveWordsPostCallJudge, mergeOpening } from "../../src/simulator/grade-live.js";
import type { SimulatedLead } from "../../src/judging/offline/types.js";
import { BAD_AGENT_FIXTURE_IDS, BAD_AGENT_TARGETS, badAgentSocketFactory } from "../../src/simulator/bad-agent-fixture.js";
import { runLiveWholeCall, type LiveSetup } from "../../src/simulator/live-text-session.js";
import { baseLead } from "../helpers/fixtures.js";

const clock = { now: () => new Date("2026-10-15T14:00:00.000Z") };
const SETUP: LiveSetup = { orchestratorId: "direct", voicePathId: "azure_gpt_live", promptSetupId: "playbook-full", turnGapMs: 30, settleMs: 80, replyTimeoutMs: 600, goodbyeGraceMs: 10, openingSettleMs: 400 };
const FACTS = { sourceCallId: "persona:bad-agent-check", objections: [] };

class TwoLines implements SimulatedLead {
  readonly facts = FACTS;
  private i = 0;
  async next(): Promise<string | null> {
    return ["Hi, I got a missed call from this number.", "How much would it cost me?"][this.i++] ?? null;
  }
}

/** The control: an agent that says the right things, so a gate failing is the fixture's doing. */
const controlFactory = async (): Promise<LiveSocket> => {
  const lines = ["Hi, this is an AI assistant for the agency. This call is recorded.", "Thanks. Who am I speaking with?", "A licensed producer gives prices; I can book a time with one."];
  const onMessage: Array<(raw: string) => void> = [];
  let n = 0;
  return {
    send: (raw: string) => {
      const type = (JSON.parse(raw) as { type?: string }).type;
      const push = (e: unknown) => setTimeout(() => onMessage.forEach((cb) => cb(JSON.stringify(e))), 5);
      if (type === "session.start") push({ type: "session.started" });
      if (type === "session.instructions.append") push({ type: "session.output_transcript.delta", delta: lines[Math.min(n++, lines.length - 1)] });
    },
    close: () => undefined,
    onMessage: (cb) => void onMessage.push(cb),
    onClose: () => undefined,
  };
};

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
});

async function gatesFor(factory: LiveSocketFactory, leadId: string) {
  seedLead(baseLead({ id: leadId }));
  setVoiceDeps({ credentials: () => ({ liveUrl: "wss://example.test", apiKey: "k" }), socketFactory: factory });
  // The active tree: the full tree that batches use.
  const harness = new CallHarness(clock, mockLeadStore, getModuleRegistry());
  const run = await runLiveWholeCall({ lead: new TwoLines(), harness, leadId, direction: "inbound", setup: SETUP });
  expect(run.status).toBe("completed");
  // Graded exactly as the batch runner grades live words.
  const grade = await gradeWholeCall({ record: run.record, events: run.events, transcript: mergeOpening(run.transcript), direction: "inbound", facts: FACTS, postCallJudge: new LiveWordsPostCallJudge() });
  return new Map(grade.enforcement.map((r) => [r.rule, r.passed]));
}

describe("deliberately bad agent", () => {
  it("the control agent passes all five transcript gates", async () => {
    const gates = await gatesFor(controlFactory, "lead-control");
    for (const rule of ["Never-01", "Never-02", "Producer-only-01", "Never-05", "Never-04", "disclosure_first"]) expect(gates.get(rule), rule).toBe(true);
  });

  it("a disclosure said in two lines before the caller speaks passes, judged by meaning", async () => {
    const twoPart = async (): Promise<LiveSocket> => {
      const onMessage: Array<(raw: string) => void> = [];
      let n = 0;
      return {
        send: (raw: string) => {
          const type = (JSON.parse(raw) as { type?: string }).type;
          const push = (e: unknown, ms = 5) => setTimeout(() => onMessage.forEach((cb) => cb(JSON.stringify(e))), ms);
          if (type === "session.start") push({ type: "session.started" });
          if (type === "session.instructions.append" && n++ === 0) {
            push({ type: "session.output_transcript.delta", delta: "Hi, this is an AI assistant for the agency." });
            push({ type: "session.output_transcript.delta", delta: "This call is recorded." }, 60);
          } else if (type === "session.instructions.append") push({ type: "session.output_transcript.delta", delta: "Thanks, go on." });
        },
        close: () => undefined,
        onMessage: (cb) => void onMessage.push(cb),
        onClose: () => undefined,
      };
    };
    const gates = await gatesFor(twoPart, "lead-two-part");
    for (const rule of ["Never-01", "Never-02", "disclosure_first"]) expect(gates.get(rule), rule).toBe(true);
  });

  it.each(BAD_AGENT_FIXTURE_IDS)("fixture %s fails the gate it targets on the live path", async (id) => {
    const gates = await gatesFor(badAgentSocketFactory(id), `lead-${id.replace(/_/g, "-")}`);
    for (const rule of BAD_AGENT_TARGETS[id]) expect(gates.get(rule), rule).toBe(false);
  });
});
