import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled, setLegalBlocks, setTestPhone, setTestSessionId } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import { assertDestinationAllowed } from "../../src/provider/clearance.js";
import { resolveDestination } from "../../src/harness/gates.js";
import { guardedAction } from "../../src/judge/gate.js";
import { baseLead } from "../helpers/fixtures.js";

const when = "2026-10-15T14:00:00Z";
const harness = () => new CallHarness({ now: () => new Date(when) });
beforeEach(() => {
  resetHarnessConfig();
  resetLeadStore();
  traceBus.reset();
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
});

it("retains the two-attempt limit after record files become unavailable, scoped to the test session", async () => {
  setLegalBlocks("suspended");
  setTestSessionId("original");
  for (const attempt of [1, 2]) {
    const result = await harness().runOutbound("lead-1", "", { idempotencyKey: "attempt-" + attempt, attempt, scheduledReason: "text_agreed_callback", dialOutcome: "no_answer" });
    expect(result.status).toBe("not_answered");
  }
  // Point at a fresh directory without deleting any previous records.
  recordStore.setDir(mkdtempSync(join(tmpdir(), "voice-harness-missing-records-")));
  const blocked = await harness().runOutbound("lead-1", "", { idempotencyKey: "retry", scheduledReason: "text_agreed_callback" });
  expect(blocked.reason).toBe("unanswered_attempt_limit_reached");
  setTestSessionId("new-session");
  const allowed = await harness().runOutbound("lead-1", "", { idempotencyKey: "fresh", scheduledReason: "text_agreed_callback", dialOutcome: "no_answer" });
  expect(allowed.status).toBe("not_answered");
});

it("does not treat a foreign country prefix with matching final digits as the allowlisted phone", () => {
  expect(() => assertDestinationAllowed("suspended", "+15550101", "+15550100")).toThrow("destination_not_allowed_in_test_mode");
  expect(() => assertDestinationAllowed("suspended", "+15550100", "+15550100")).not.toThrow();
});

it("refuses an allowlisted test phone when it is also this lead's number, including inbound and text paths", async () => {
  setLegalBlocks("suspended");
  setTestPhone(baseLead().phone);
  await expect(harness().runInbound("lead-1", "browser", { idempotencyKey: "in", destination: "test_phone" })).rejects.toThrow("lead_number_refused_in_test_mode");
  await expect(harness().sendText("lead-1", "hello", "text", { destination: "test_phone" })).rejects.toThrow("lead_number_refused_in_test_mode");
  expect(() => resolveDestination({ mode: "enforced", sessionId: "" }, "unexpected" as any, "phone")).toThrow("unknown_destination");
});

it("runs code rules before an injected judge, so an always-allow model cannot act without disclosure or caller evidence", async () => {
  const judge = { id: "always-allow-test", judge: vi.fn(async () => ({ allowed: true, reason: "yes", scores: [] })) };
  const action = vi.fn(async () => true);
  const result = await guardedAction({ judge, leadId: "lead-1", callId: "call-test" }, {
    action: "transfer", nodeId: "test", direction: "inbound", transcript: [], completed: [],
    payload: { reason: "caller_requested" }, now: new Date(when),
  }, action);
  expect(result.allowed).toBe(false);
  expect(judge.judge).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});
