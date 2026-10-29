import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHarnessConfig, isAiCallingEnabled, resetHarnessConfig } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { buildLeadContextPacket } from "../../src/memory/context.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { getActiveLeadStore } from "../../src/store/active-store.js";
import { traceBus } from "../../src/trace/index.js";
import { activePromptFor, applySetup, clearActiveSetup, getActiveSetup, type ApplyDeps } from "../../src/setups/active-setup.js";
import { getDecisionCatalog, setDecisionCatalog } from "../../src/setups/decision-catalog.js";
import { RunWriter, buildRunRow, resetRunWriter, setRunWriteBack } from "../../src/setups/run-writer.js";
import { recordStore } from "../../src/trace/index.js";
import { LIVE_AGENCY, PLUMBER, ROOFER, RangeFakeDb, seedSetupWorld, syntheticScripts } from "../helpers/setups-fixtures.js";

const noonPacific = { now: () => new Date("2026-10-15T19:00:00.000Z") };
const setup = { name: "Roofer baseline", voiceModuleId: "vapi", decisionModuleId: "openai-mock", promptSetupId: "baseline-with-lead-record", leadId: ROOFER, direction: "inbound" as const };

let db: RangeFakeDb;
let deps: ApplyDeps;

beforeEach(() => {
  resetHarnessConfig();
  resetModuleRegistry();
  setDecisionCatalog(null);
  clearActiveSetup();
  db = seedSetupWorld(new RangeFakeDb()) as RangeFakeDb;
  deps = {
    db: () => db,
    now: noonPacific.now,
    scripts: syntheticScripts,
  };
});
afterEach(() => {
  clearActiveSetup();
  resetRunWriter();
  setRunWriteBack(undefined);
  resetHarnessConfig();
  resetModuleRegistry();
  setDecisionCatalog(null);
  vi.restoreAllMocks();
});

describe("applying a setup", () => {
  it("switches the voice module, decision module, store and agency flag together, and snapshots the result", async () => {
    const r = await applySetup(setup, deps);
    expect(getModuleRegistry().selectedModuleId()).toBe("vapi");
    expect(getModuleRegistry().activeModule()?.id).toBe("vapi");
    expect(getDecisionCatalog().selectedId()).toBe("openai-mock");
    expect(getHarnessConfig().leadStoreKind).toBe("mock");
    expect(isAiCallingEnabled(LIVE_AGENCY)).toBe(true);
    expect(r.aiCallingEnabledForAgency).toBe(LIVE_AGENCY);
    expect(r.snapshot).toMatchObject({
      name: "Roofer baseline",
      direction: "inbound",
      voiceModule: { id: "vapi" },
      decisionModule: { id: "openai-mock" },
      promptSetup: { id: "baseline-with-lead-record", includesBriefing: true },
      lead: { leadId: ROOFER, agencyId: LIVE_AGENCY, businessName: "Example Ridge Roofing", xDate: "2026-12-14" },
    });
    expect(r.snapshot.renderedPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.promptPreview).toContain("Example Ridge Roofing");
    expect(r.card.you.name).toBe("Dana Roofer");
  });

  it("puts the lead's real record in the agent's context packet", async () => {
    await applySetup(setup, deps);
    const lead = (await getActiveLeadStore().getLead(ROOFER))!;
    expect(lead.briefing?.business).toBe("Example Ridge Roofing");
    const packet = buildLeadContextPacket(lead);
    expect(packet.briefing?.payroll?.annualEstimate).toBe(280000);
    expect(packet.briefing?.missedOutboundCalls).toHaveLength(2);
    expect(activePromptFor(packet)).toContain("Example Ridge Roofing");
  });

  it("the control prompt gives the agent no lead record", async () => {
    await applySetup({ ...setup, promptSetupId: "baseline-no-lead-record" }, deps);
    const lead = (await getActiveLeadStore().getLead(ROOFER))!;
    expect(lead.briefing).toBeUndefined();
    expect(buildLeadContextPacket(lead).briefing).toBeUndefined();
    expect(getActiveSetup()!.snapshot.briefingGiven).toBeNull();
    expect(activePromptFor(buildLeadContextPacket(lead))).not.toContain("Example Ridge Roofing");
    expect(getActiveSetup()!.card.facts.every((f) => !f.inAgentPacket)).toBe(true);
  });

  it("other leads get no record", async () => {
    await applySetup(setup, deps);
    const other = await getActiveLeadStore().getLead(PLUMBER);
    expect(other?.briefing).toBeUndefined();
  });

  it("changes nothing when any choice is wrong", async () => {
    await expect(applySetup({ ...setup, voiceModuleId: "nope" }, deps)).rejects.toThrow("unknown_module:nope");
    await expect(applySetup({ ...setup, decisionModuleId: "nope" }, deps)).rejects.toThrow("unknown_decision_module:nope");
    await expect(applySetup({ ...setup, promptSetupId: "nope" }, deps)).rejects.toThrow("unknown_prompt_setup:nope");
    await expect(applySetup({ ...setup, leadId: "00000000-0000-4000-8000-0000000000ff" }, deps)).rejects.toThrow("lead_not_found");
    await expect(applySetup({ ...setup, personaId: "nope" }, deps)).rejects.toThrow("unknown_persona:nope");
    expect(getHarnessConfig().leadStoreKind).toBe("mock");
    expect(isAiCallingEnabled(LIVE_AGENCY)).toBe(false);
    expect(getModuleRegistry().selectedModuleId()).not.toBe("vapi");
    expect(getActiveSetup()).toBeNull();
  });

  it("works without the scripts file, with a facts-only card", async () => {
    const r = await applySetup(setup, { ...deps, scripts: () => undefined });
    expect(r.card.personaId).toBeUndefined();
    expect(r.card.facts.length).toBeGreaterThan(0);
  });

  it("writes nothing to the profile source", async () => {
    await applySetup(setup, deps);
    await getActiveLeadStore().getLead(ROOFER);
    expect(db.calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("re-applying keeps the one wrapped store and switches the lead record to the new setup", async () => {
    await applySetup(setup, deps);
    const store = getActiveLeadStore();
    await applySetup({ ...setup, promptSetupId: "baseline-no-lead-record" }, deps);
    expect(getActiveLeadStore()).toBe(store);
    expect((await store.getLead(ROOFER))!.briefing).toBeUndefined();
  });

  it("an inbound call run through the real harness starts with the briefing in its context packet", async () => {
    await applySetup(setup, deps);
    const provider = getModuleRegistry().activeModule()!;
    const start = vi.spyOn(provider, "startInboundCall");
    const result = await new CallHarness(noonPacific).runInbound(ROOFER, "+15550101", { idempotencyKey: "setup-1", callerUtterances: ["Hi, who is this?"] });
    expect(result.status).not.toBe("blocked");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].contextPacket.briefing?.business).toBe("Example Ridge Roofing");
  });
});

describe("run write-back", () => {
  const emit = (recordId: string, type: string, data: Record<string, unknown> = {}, leadId = ROOFER) =>
    traceBus.emit({ type, leadId, recordId, channel: "call", direction: "inbound", callId: recordId.replace("call_", "c_"), data } as never);

  async function setupWriter(over: Partial<ConstructorParameters<typeof RunWriter>[0]> = {}) {
    await applySetup(setup, deps);
    setRunWriteBack(true);
    const writer = new RunWriter({ db: () => db, now: noonPacific.now, ...over });
    const detach = writer.attach();
    return { writer, detach };
  }

  it("writes one row per call to harness_run when the call ends, with the setup snapshot", async () => {
    const { writer, detach } = await setupWriter();
    emit("call_run1", "turn", { role: "caller", text: "Hi, who is this?", turnIndex: 0, spoken: true });
    emit("call_run1", "turn", { role: "agent", text: "I am an artificial intelligence assistant.", turnIndex: 1, spoken: true });
    emit("call_run1", "disposition", { value: "booked" });
    emit("call_run1", "call_outcome", { status: "completed", reason: "ended" });
    await writer.idle();
    detach();

    const rows = db.tables.harness_run ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_id: "call_run1",
      lead_id: ROOFER,
      agency_id: LIVE_AGENCY,
      setup_name: "Roofer baseline",
      voice_module_id: "vapi",
      decision_module_id: "openai-mock",
      prompt_setup_id: "baseline-with-lead-record",
      disposition: "booked",
      outcome_status: "completed",
      is_test_run: true,
    });
    expect((rows[0]!.transcript as unknown[]).length).toBe(2);
    expect((rows[0]!.trace as unknown[]).length).toBe(4);
    expect((rows[0]!.setup_snapshot as any).lead.businessName).toBe("Example Ridge Roofing");
    expect(writer.statuses()[0]).toMatchObject({ recordId: "call_run1", status: "written" });
    const written = db.calls.filter((c) => c.op !== "select");
    expect(written.every((c) => c.table === "harness_run")).toBe(true);
  });

  it("a later judge result updates the same row instead of adding another", async () => {
    const { writer, detach } = await setupWriter();
    emit("call_run2", "call_outcome", { status: "completed" });
    await writer.idle();
    emit("call_run2", "judge_verdict", { action: "book_appointment", verdict: "approve" });
    emit("call_run2", "judge_score", { score: 0.8, criteria: [] });
    await writer.idle();
    detach();
    const rows = db.tables.harness_run!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.judge_verdicts).toEqual([{ action: "book_appointment", verdict: "approve" }]);
    expect(rows[0]!.judge_score).toMatchObject({ score: 0.8 });
  });

  it("keeps the setup the call started under, even if another is applied mid-call", async () => {
    const { writer, detach } = await setupWriter();
    emit("call_run3", "turn", { role: "caller", text: "hello", turnIndex: 0 });
    await applySetup({ ...setup, name: "Second", voiceModuleId: "retell" }, deps);
    emit("call_run3", "call_outcome", { status: "completed" });
    await writer.idle();
    detach();
    expect(db.tables.harness_run![0]).toMatchObject({ setup_name: "Roofer baseline", voice_module_id: "vapi" });
  });

  it("writes nothing while switched off, and ignores calls to other leads", async () => {
    await applySetup(setup, deps);
    const writer = new RunWriter({ db: () => db, now: noonPacific.now });
    const detach = writer.attach();
    setRunWriteBack(false);
    emit("call_off", "call_outcome", { status: "completed" });
    setRunWriteBack(true);
    emit("call_other", "call_outcome", { status: "completed" }, PLUMBER);
    await writer.idle();
    detach();
    expect(db.tables.harness_run ?? []).toHaveLength(0);
    expect(writer.statuses()).toEqual([]);
  });

  it("a failed write is reported, never thrown into the call, and can be written again", async () => {
    const real = db.insert.bind(db);
    let fail = true;
    vi.spyOn(db, "insert").mockImplementation(async (...args) => {
      if (fail) throw new Error("database_error:POST:harness_run:404");
      return real(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { writer, detach } = await setupWriter();
    expect(() => emit("call_run4", "call_outcome", { status: "completed" })).not.toThrow();
    await writer.idle();
    expect(writer.statuses()[0]).toMatchObject({ status: "failed", error: "database_error:POST:harness_run:404" });
    fail = false;
    expect((await writer.writeBack("call_run4")).status).toBe("written");
    detach();
    expect(db.tables.harness_run).toHaveLength(1);
  });

  it("builds the row from the stored record on disk", async () => {
    await applySetup(setup, deps);
    emit("call_run5", "turn", { role: "caller", text: "Hello", turnIndex: 0, spoken: true });
    emit("call_run5", "call_outcome", { status: "completed" });
    const record = recordStore.read("call_run5")!;
    const row = buildRunRow(record, getActiveSetup()!.snapshot);
    expect(row.transcript).toHaveLength(1);
    expect(row.ended_at).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/\+1650|@example\.com/);
  });
});
