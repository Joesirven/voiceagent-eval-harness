/**
 * The post-call no-action-on-unsure-answer check against the Northwind tree's
 * designed escalation after its clarifying lines are used.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { startInteractiveCall, type InteractiveCall } from "../../src/decision/interactive.js";
import { resetActiveTree } from "../../src/decision/tree-source.js";
import { resetJudges } from "../../src/judge/index.js";
import { RuleBasedPostCallJudge } from "../../src/judge/post-call.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus, type HarnessRecord, type TraceEvent } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const open: InteractiveCall[] = [];

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "escalation-after-clarify-test-")));
  traceBus.reset();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

afterEach(async () => {
  for (const call of open.splice(0)) if (call.status === "connected") await call.hangUp();
});

const recordOf = (events: TraceEvent[]): HarnessRecord =>
  ({ recordId: "r", kind: "call", leadId: "lead-1", direction: "inbound", openedAt: "", events, transcript: [], texts: [] }) as HarnessRecord;

async function unsureScore(events: TraceEvent[]) {
  const score = await new RuleBasedPostCallJudge().judge(recordOf(events));
  return score.criteria.find((criterion) => criterion.criterion === "no_action_on_unsure_answer")!;
}

async function repeatedUnclear(): Promise<TraceEvent[]> {
  const harness = new CallHarness({ now: () => new Date(IN_WINDOW) }, undefined, getModuleRegistry());
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness });
  open.push(call);
  await call.say("Hmm.");
  await call.say("I am still not sure.");
  return traceBus.history().filter((event) => event.callId === call.callId);
}

describe("designed escalation after clarification", () => {
  it("ends with completed after two unclear answers and does not count as a breach", async () => {
    const events = await repeatedUnclear();
    expect(events.filter((event) => event.type === "decision").map((event) => event.data.routed)).toContain("clarify");
    expect(events.filter((event) => event.type === "disposition").map((event) => event.data.value)).toEqual(["completed"]);
    const ending = events.find((event) => event.type === "judge_verdict" && event.data.action === "end_with_disposition")!;
    expect((ending.data.scores as Array<{ criterion: string; score: number }>)).toContainEqual(
      expect.objectContaining({ criterion: "repeated_unclear_established", score: 1 }),
    );
    expect(await unsureScore(events)).toMatchObject({ score: 1 });
  });

  it("still counts an ordinary action after a clarify decision as a breach", async () => {
    const events = [
      { type: "decision", data: { nodeId: "entry.greeting", routed: "clarify" } },
      { type: "tool_call", data: { tool: "save_message", success: true } },
    ] as unknown as TraceEvent[];
    expect(await unsureScore(events)).toMatchObject({ score: 0 });
  });
});
