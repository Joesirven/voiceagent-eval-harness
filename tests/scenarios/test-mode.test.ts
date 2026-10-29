import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHarnessConfig,
  resetHarnessConfig,
  setAiCallingEnabled,
  setLegalBlocks,
  setTestPhone,
  setTestSessionId,
} from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { setAgentLineGuard } from "../../src/harness/agent-line-guard.js";
import { clearTestStops, getTestStops } from "../../src/harness/test-stops.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { startInteractiveCall } from "../../src/decision/interactive.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { assertDialsClearedDestination, type CallClearance } from "../../src/provider/clearance.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { getLead, getStopLedger, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { recordStore, traceBus, type TraceEvent } from "../../src/trace/index.js";
import { describeRow } from "../../src/server/live-view-core.js";
import { startLocalTestMode } from "../../src/server/dev-server.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";
import { AGENCY_ID } from "../helpers/fake-db.js";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const IN_WINDOW = "2026-10-15T14:00:00.000Z";
/** 22:00 Eastern: outside calling hours. */
const NIGHT = "2026-10-16T02:00:00.000Z";
const REASON = "text_agreed_callback";
const LEAD_PHONE = "+15550167";
let keySeq = 0;
const key = () => `k-${++keySeq}`;

const SKIPPED_BY_TEST_MODE = ["do_not_call", "consent", "artificial_voice_consent", "quiet_hours", "store_reach_rules"];

/** A lead every legal block would refuse: no consents, do-not-call unchecked, and called at night. */
const blockedLead = () =>
  baseLead({
    smsConsentAt: undefined,
    voiceConsentAt: undefined,
    artificialVoiceConsent: undefined,
    consentRevokedAt: "2026-10-02T00:00:00.000Z",
    dncStatus: "unchecked",
  });

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "test-mode-")));
  traceBus.reset();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetLeadStore();
  clearCallLogs();
  clearTestStops();
  setAgentLineGuard(null);
  setAiCallingEnabled("agency-demo", true);
  setAiCallingEnabled(AGENCY_ID, true);
  seedLead(baseLead());
});

afterEach(() => {
  setAgentLineGuard(null);
  resetHarnessConfig();
  vi.restoreAllMocks();
});

const harness = (iso = IN_WINDOW, store = mockLeadStore) => new CallHarness(clockAt(iso), store, getModuleRegistry());

function checks(recordId?: string) {
  return traceBus
    .history()
    .filter((e) => e.type === "compliance_check" && (!recordId || e.recordId === recordId))
    .map((e) => e.data as Record<string, any>);
}

/** Records the clearance and destination every telephony call receives. */
function spyOnModule() {
  const module = getModuleRegistry().activeModule()!;
  const seen: Array<{ method: string; toNumber?: string; fromNumber?: string; clearance: CallClearance; packetPhone: string }> = [];
  const outbound = module.startOutboundCall.bind(module);
  const inbound = module.startInboundCall.bind(module);
  vi.spyOn(module, "startOutboundCall").mockImplementation(async (p) => {
    seen.push({ method: "out", toNumber: p.toNumber, clearance: p.clearance, packetPhone: p.contextPacket.phone });
    return outbound(p);
  });
  vi.spyOn(module, "startInboundCall").mockImplementation(async (p) => {
    seen.push({ method: "in", fromNumber: p.fromNumber, clearance: p.clearance, packetPhone: p.contextPacket.phone });
    return inbound(p);
  });
  return seen;
}

describe("the switch", () => {
  it("is enforced by default and after a reset", () => {
    expect(getHarnessConfig().legalBlocks).toBe("enforced");
    setLegalBlocks("suspended");
    resetHarnessConfig();
    expect(getHarnessConfig().legalBlocks).toBe("enforced");
  });

  it("enforced still blocks a lead with no consent, and shows no skipped checks", async () => {
    seedLead(blockedLead());
    const r = await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON });
    expect(r.status).toBe("blocked");
    expect(checks().some((c) => c.skipped || c.check === "legal_blocks")).toBe(false);
  });

  it("suspended places a call to a lead every legal block would refuse, and shows each skipped gate as skipped", async () => {
    setLegalBlocks("suspended");
    seedLead(blockedLead());
    const r = await harness(NIGHT).runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, callerUtterances: ["hello"] });
    expect(r.status).toBe("placed");
    const rows = checks(r.recordId);
    for (const name of SKIPPED_BY_TEST_MODE) {
      const row = rows.find((c) => c.check === name);
      expect(row, name).toBeDefined();
      expect(row).toMatchObject({ passed: null, skipped: true, result: "skipped: test mode" });
    }
    expect(rows.find((c) => c.check === "legal_blocks")).toMatchObject({ mode: "suspended", passed: null, result: "suspended: test mode" });
    // The checks that stay on still run and still pass.
    for (const name of ["suppression", "outbound_schedule", "unanswered_attempts"]) {
      expect(rows.find((c) => c.check === name), name).toMatchObject({ passed: true });
    }
  });

  it("suspended keeps the stop list, the suppression list, the agency flag and the clearance", async () => {
    setLegalBlocks("suspended");
    seedLead(baseLead({ onStopList: true }));
    expect(await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON })).toMatchObject({ status: "blocked", reason: "stop_list" });
    seedLead(baseLead({ onStopList: false, suppressed: true }));
    expect(await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON })).toMatchObject({ reason: "suppression_list" });
    seedLead(baseLead());
    setAiCallingEnabled("agency-demo", false);
    expect(await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON })).toMatchObject({ reason: "ai_calling_disabled" });
  });

  it("a skipped check is never rendered as passed in the live view", async () => {
    setLegalBlocks("suspended");
    const r = await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON });
    const events = traceBus.history().filter((e: TraceEvent) => e.recordId === r.recordId && e.type === "compliance_check");
    const skipped = events.filter((e) => e.data.skipped);
    expect(skipped.length).toBe(SKIPPED_BY_TEST_MODE.length);
    for (const e of skipped) {
      const row = describeRow(e);
      expect(row.bad).toBe(false);
      expect(row.text).toContain("skipped: test mode");
      expect(row.text).not.toContain("passed");
    }
  });

  it("inbound in test mode skips quiet hours and do-not-call, keeps the disclosure first", async () => {
    setLegalBlocks("suspended");
    seedLead(baseLead({ dncStatus: "listed", onDncList: true }));
    const r = await harness(NIGHT).runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["hi"] });
    expect(r.status).toBe("ai_handled");
    const rows = checks(r.recordId);
    expect(rows.filter((c) => c.skipped).map((c) => c.check).sort()).toEqual(["do_not_call", "quiet_hours"]);
    expect(rows.find((c) => c.check === "disclosure_first")).toMatchObject({ passed: true });
  });

  it("a text in test mode skips its consent, quiet hours, do-not-call and reach checks", async () => {
    setLegalBlocks("suspended");
    seedLead(blockedLead());
    const r = await harness(NIGHT).sendText("lead-1", "hello", key());
    expect(r.status).toBe("recorded");
    expect(checks(r.recordId).filter((c) => c.skipped).map((c) => c.check).sort()).toEqual(
      ["consent", "do_not_call", "quiet_hours", "store_reach_rules"],
    );
  });
});

describe("a lead's real number never reaches a telephony module in test mode", () => {
  beforeEach(() => setLegalBlocks("suspended"));

  it("an outbound call dials the clearance's destination, never the lead's number", async () => {
    const seen = spyOnModule();
    await harness().runOutbound("lead-1", LEAD_PHONE, { idempotencyKey: key(), scheduledReason: REASON, callerUtterances: ["hi"] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toNumber).toBe("simulated");
    expect(seen[0]!.clearance.destination).toBe("simulated");
    expect(seen[0]!.clearance.mode).toBe("suspended");
    expect(seen[0]!.packetPhone).toBe("simulated");
    expect(JSON.stringify(seen)).not.toContain(LEAD_PHONE);
    // A module that tried the lead's number with this clearance is refused.
    expect(() => assertDialsClearedDestination(seen[0]!.clearance, LEAD_PHONE)).toThrow("destination_not_cleared");
    expect(() => assertDialsClearedDestination(seen[0]!.clearance, "simulated")).not.toThrow();
  });

  it("the unanswered-dial path dials the destination too", async () => {
    const seen = spyOnModule();
    const r = await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, dialOutcome: "no_answer" });
    expect(r.status).toBe("not_answered");
    expect(seen[0]!.toNumber).toBe("simulated");
    expect(JSON.stringify(seen)).not.toContain(LEAD_PHONE);
  });

  it("asking for the lead's own number throws, for a call, an interactive call and a text", async () => {
    await expect(
      harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, destination: "lead_number" }),
    ).rejects.toThrow("lead_number_refused_in_test_mode");
    await expect(harness().sendText("lead-1", "hi", key(), { destination: "lead_number" })).rejects.toThrow("lead_number_refused_in_test_mode");
    const refused = await harness().startInteractiveCall("lead-1", "outbound", REASON, "lead_number");
    expect(refused).toMatchObject({ status: "blocked", blockedReason: "lead_number_refused_in_test_mode" });
  });

  it("the allowlisted number is the only real number reachable, and only when configured", async () => {
    await expect(
      harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, destination: "test_phone" }),
    ).rejects.toThrow("test_phone_not_configured");
    setTestPhone("+15550100");
    const seen = spyOnModule();
    await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, destination: "test_phone", callerUtterances: ["hi"] });
    expect(seen[0]!.toNumber).toBe("+15550100");
    expect(seen[0]!.packetPhone).toBe("+15550100");
  });

  it("an interactive call starts on the browser line and an inbound call answers from it", async () => {
    const seen = spyOnModule();
    const call = await harness().startInteractiveCall("lead-1", "inbound", REASON, "browser");
    expect(call.status).toBe("connected");
    await call.hangUp();
    expect(seen[0]).toMatchObject({ method: "in", fromNumber: "browser" });
    expect(seen[0]!.clearance.destination).toBe("browser");
    const out = await harness().startInteractiveCall("lead-1", "outbound", REASON);
    await out.hangUp();
    expect(seen[1]).toMatchObject({ method: "out", toNumber: "simulated" });
  });

  it("the play start used by the dev server goes through the same destination rule", async () => {
    const seen = spyOnModule();
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "outbound", harness: harness() });
    await call.hangUp();
    expect(seen[0]!.toNumber).toBe("simulated");
  });

  it("a clearance keeps the mode it was issued under when the switch flips mid-run", async () => {
    const seen = spyOnModule();
    await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, callerUtterances: ["hi"] });
    setLegalBlocks("enforced");
    expect(seen[0]!.clearance.mode).toBe("suspended");
    expect(seen[0]!.clearance.destination).toBe("simulated");
  });

  it("enforced runs still dial the lead's own number", async () => {
    setLegalBlocks("enforced");
    const seen = spyOnModule();
    await harness().runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, callerUtterances: ["hi"] });
    expect(seen[0]!.toNumber).toBe(LEAD_PHONE);
    expect(seen[0]!.clearance.mode).toBe("enforced");
  });
});

describe("a test session scopes duplicate keys and the two-attempt counter", () => {
  beforeEach(() => setLegalBlocks("suspended"));

  it("the same development lead can be replayed in a new session, not twice in one", async () => {
    setTestSessionId("one");
    const first = await harness().runOutbound("lead-1", "", { idempotencyKey: "a", scheduledReason: REASON, callerUtterances: ["hi"] });
    const again = await harness().runOutbound("lead-1", "", { idempotencyKey: "b", scheduledReason: REASON, callerUtterances: ["hi"] });
    expect([first.status, again.status]).toEqual(["placed", "skipped_duplicate"]);
    setTestSessionId("two");
    const fresh = await harness().runOutbound("lead-1", "", { idempotencyKey: "c", scheduledReason: REASON, callerUtterances: ["hi"] });
    expect(fresh.status).toBe("placed");
  });

  it("two unanswered attempts per session, and a new session counts from zero", async () => {
    setTestSessionId("one");
    const h = harness();
    const run = (attempt: number) =>
      h.runOutbound("lead-1", "", { idempotencyKey: key(), scheduledReason: REASON, attempt, dialOutcome: "no_answer" });
    expect((await run(1)).status).toBe("not_answered");
    expect((await run(2)).status).toBe("not_answered");
    expect(await run(3)).toMatchObject({ status: "blocked", reason: "unanswered_attempt_limit_reached" });
    setTestSessionId("two");
    expect((await run(1)).status).toBe("not_answered");
  });

  it("texts are scoped the same way", async () => {
    setTestSessionId("one");
    expect((await harness().sendText("lead-1", "hi", "t1")).status).toBe("recorded");
    expect((await harness().sendText("lead-1", "hi", "t1")).status).toBe("skipped_duplicate");
    setTestSessionId("two");
    expect((await harness().sendText("lead-1", "hi", "t1")).status).toBe("recorded");
  });
});

describe("a STOP spoken in test mode", () => {
  it("is recorded locally only: the store's STOP is never called, and the next session starts clean", async () => {
    setLegalBlocks("suspended");
    setTestSessionId("one");
    const recordStop = vi.spyOn(mockLeadStore, "recordStop");
    const r = await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["Please stop calling me"] });
    expect(r.status).toBe("ai_handled");
    expect(recordStop).not.toHaveBeenCalled();
    expect(getStopLedger()).toHaveLength(0);
    expect(getLead("lead-1")!.onStopList).toBeFalsy();
    expect(getTestStops()).toMatchObject([{ leadId: "lead-1", sessionId: "one", source: "voice_call" }]);
    const note = recordStore.read(r.recordId!)!.handoffNote as { narrative: string };
    expect(note.narrative).toContain("TEST MODE");
    expect(note.narrative).not.toContain("a person must record it");
    const tool = traceBus.history().find((e) => e.type === "tool_call" && e.data.tool === "record_stop");
    expect(tool?.data.inputs).toMatchObject({ testMode: true });
    // Same session: the lead is not contacted again.
    const blocked = await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["hi"] });
    expect(blocked.status).toBe("normal_answering");
    setTestSessionId("two");
    expect((await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["hi"] })).status).toBe("ai_handled");
  });

  it("enforced mode still records through the store", async () => {
    const recordStop = vi.spyOn(mockLeadStore, "recordStop");
    await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["Please stop calling me"] });
    expect(recordStop).toHaveBeenCalledTimes(1);
    expect(getTestStops()).toHaveLength(0);
  });

});

describe("test phone, dev server and the line guard hook", () => {
  it("the dev server starts suspended unless told otherwise", () => {
    startLocalTestMode({ VOICE_HARNESS_TEST_PHONE: "+15550123" });
    expect(getHarnessConfig().legalBlocks).toBe("suspended");
    expect(getHarnessConfig().testPhone).toBe("+15550123");
    resetHarnessConfig();
    startLocalTestMode({ VOICE_HARNESS_LEGAL_BLOCKS: "enforced" });
    expect(getHarnessConfig().legalBlocks).toBe("enforced");
  });

  it("an installed line guard rewrites tree and scripted agent lines but never the opening disclosure", async () => {
    const calls: Array<{ text: string; isDisclosure: boolean }> = [];
    setAgentLineGuard((text, ctx) => {
      calls.push({ text, isDisclosure: ctx.isDisclosure });
      return ctx.isDisclosure ? { text: "CHANGED", verdict: "rewritten" } : { text: `[guarded] ${text}`, verdict: "rewritten", rule: "test_rule" };
    });
    const r = await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), agent: "decision_tree", callerUtterances: ["I need a quote"] });
    const agentTurns = r.transcript!.filter((t) => t.role === "agent");
    expect(agentTurns[0]!.text).not.toContain("CHANGED");
    expect(agentTurns.slice(1).every((t) => t.text.startsWith("[guarded] "))).toBe(true);
    expect(calls.some((c) => c.isDisclosure)).toBe(true);
    expect(checks(r.recordId).some((c) => c.check === "agent_line_guard" && c.rule === "test_rule")).toBe(true);

    const scripted = await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), callerUtterances: ["I need a quote"] });
    expect(scripted.transcript!.filter((t) => t.role === "agent").slice(1).every((t) => t.text.startsWith("[guarded] "))).toBe(true);
  });

  it("the no-op default leaves every line unchanged and adds no trace row", async () => {
    const r = await harness().runInbound("lead-1", "interactive", { idempotencyKey: key(), agent: "decision_tree", callerUtterances: ["I need a quote"] });
    expect(checks(r.recordId).some((c) => c.check === "agent_line_guard")).toBe(false);
  });
});

describe("the harness table migration", () => {
  const sql = readFileSync(new URL("../../supabase/harness/001_voice_harness_runs.sql", import.meta.url), "utf8");

  it("is service role only: row-level security on, no policy, nothing granted to the other roles", () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/force row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    for (const role of ["public", "anon", "authenticated"]) expect(sql).toMatch(new RegExp(`revoke all on table public\\.voice_harness_runs from ${role}`));
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated|public)/i);
    expect(sql).toMatch(/grant select, insert on table public\.voice_harness_runs to service_role/);
  });

  it("holds every column the adapter writes, and a closed status list", () => {
    for (const column of [
      "attempt_id", "record_id", "kind", "direction", "lead_id", "status", "detail_status", "reason", "transcript", "outcome",
      "disposition", "handoff_note", "trace_ref", "test_run_tag", "test_session_id", "voice_setup_id", "decision_setup_id",
      "prompt_setup_id", "stop_requested", "recorded_at",
    ]) expect(sql, column).toMatch(new RegExp(`\\n\\s+${column}\\s`));
    expect(sql).toContain("check (status in ('placed', 'answered', 'skipped', 'blocked', 'failed'))");
  });
});

describe("the local Talk play path (playTalk) in enforced mode", () => {
  const play = (direction: "inbound" | "outbound") =>
    startInteractiveCall({ leadId: "lead-1", direction, harness: harness(), playTalk: true });

  it("skips only do-not-call, and says so in the trace", async () => {
    setLegalBlocks("enforced");
    seedLead(baseLead({ dncStatus: "listed" }));
    const seen = spyOnModule();
    const call = await play("outbound");
    expect(call.status).toBe("connected");
    await call.hangUp();
    expect(seen[0]!.toNumber).toBe(LEAD_PHONE);
    expect(checks().find((c) => c.check === "do_not_call")).toMatchObject({
      passed: null,
      skipped: true,
      result: "skipped: local Talk play path",
    });
  });

  for (const direction of ["inbound", "outbound"] as const) {
    it(`still refuses a ${direction} lead on the suppression list even when it is also on the do-not-call list`, async () => {
      setLegalBlocks("enforced");
      seedLead(baseLead({ dncStatus: "listed", suppressed: true }));
      const seen = spyOnModule();
      const call = await play(direction);
      expect(call).toMatchObject({ status: "blocked", blockedReason: "suppression_list" });
      expect(seen).toHaveLength(0);
    });

    it(`still refuses a ${direction} lead on the stop list`, async () => {
      setLegalBlocks("enforced");
      seedLead(baseLead({ dncStatus: "listed", onStopList: true }));
      const seen = spyOnModule();
      const call = await play(direction);
      expect(call).toMatchObject({ status: "blocked", blockedReason: "stop_list" });
      expect(seen).toHaveLength(0);
    });
  }

  it("without playTalk, a do-not-call lead is refused as before", async () => {
    setLegalBlocks("enforced");
    seedLead(baseLead({ dncStatus: "listed" }));
    const seen = spyOnModule();
    const call = await startInteractiveCall({ leadId: "lead-1", direction: "outbound", harness: harness() });
    expect(call).toMatchObject({ status: "blocked", blockedReason: "dnc_list" });
    expect(seen).toHaveLength(0);
  });
});
