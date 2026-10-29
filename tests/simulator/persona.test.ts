import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  batchClockFor,
  buildPersonaCase,
  directionOf,
  loadPersonaFile,
  parseLeadRecord,
  personaFacts,
  personaFilePath,
  spokenOpening,
  withoutDialAgreement,
  type SimPersona,
} from "../../src/simulator/persona.js";

/** A made-up persona in the file's shape. Nothing here is copied from lead-scripts.json. */
function persona(overrides: Partial<SimPersona> = {}): SimPersona {
  return {
    id: "test-roofer",
    title: "Test roofer",
    situation: "callback_after_missed_calls",
    persona: { name: "Pat Example", role: "owner", trade: "roofing", temperament: "brisk", language: "en" },
    setup: {
      call_origin_note: "Inbound. Does not know the number.",
      lead_record_on_file: "Summit Roofing, owner Priya Shah, mobile +15550199, public-record renewal 2026-12-01, carrier on file 'Example Mutual'.",
    },
    truth: { x_date: "2026-12-02", carrier: "Acme Workers' Mutual", employees_full_time: 4, annual_payroll: 150000 },
    objections: [
      { order: 2, class: "email_me", line: "Just email me." },
      { order: 1, class: "busy", line: "I'm busy." },
    ],
    expected: { best_disposition: "appointment_booked" },
    ...overrides,
  };
}

const OPTS = { agencyId: "agency-test", today: "2026-10-19" };

describe("persona direction", () => {
  it("comes from the call-origin note, not the situation", () => {
    expect(directionOf(persona())).toBe("inbound");
    expect(directionOf(persona({ situation: "gatekeeper", setup: { call_origin_note: "Outbound to the shop line." } }))).toBe("outbound");
  });

  it("refuses a note that names neither direction", () => {
    expect(() => directionOf(persona({ setup: { call_origin_note: "A referral." } }))).toThrow("persona_direction_unknown:test-roofer");
  });
});

describe("lead record on file", () => {
  it("parses the business, owner, renewal, carrier with an apostrophe, and phone", () => {
    const r = parseLeadRecord(persona().setup!.lead_record_on_file);
    expect(r.kind).toBe("record");
    if (r.kind !== "record") return;
    expect(r.briefing.business).toBe("Summit Roofing");
    expect(r.briefing.ownerName).toBe("Priya Shah");
    expect(r.briefing.xDate).toEqual({ date: "2026-12-01", line: "workers' compensation", carrier: "Example Mutual" });
    expect(r.briefing.carriersCurrent).toEqual(["Example Mutual"]);
    expect(r.phone).toBe("+15550199");
    expect(r.existingClient).toBe(false);
  });

  it("parses an accented business name", () => {
    const r = parseLeadRecord("Sample Carpentry, public-record renewal 2026-12-23, mobile +15550198.");
    expect(r.kind === "record" && r.briefing.business).toBe("Sample Carpentry");
  });

  it("reads an existing policyholder and a reassigned number", () => {
    const client = parseLeadRecord("Existing policyholder Sample Plastering; renewal 2026-12-15.");
    expect(client.kind === "record" && [client.briefing.business, client.briefing.xDate?.date, client.existingClient]).toEqual([
      "Sample Plastering",
      "2026-12-15",
      true,
    ]);
    const former = parseLeadRecord("A lead record lists the number for a former contractor, 'Gone Roofing Supply', no longer valid.");
    expect(former.kind === "record" && former.briefing.business).toBe("Gone Roofing Supply");
  });

  it("gives no record when the caller's number has none, even if a match exists elsewhere", () => {
    expect(parseLeadRecord("No record under her number. A lead record exists under Other Plumbing with public-record renewal 2026-11-30.")).toEqual({
      kind: "no_record",
    });
  });

  it("refuses what it cannot read instead of guessing", () => {
    expect(parseLeadRecord(undefined)).toEqual({ kind: "unparsed", reason: "no_lead_record_on_file" });
    expect(parseLeadRecord("some lead record, maybe.")).toEqual({ kind: "unparsed", reason: "no_business_name" });
  });
});

describe("persona case", () => {
  it("gives the agent the persona's record, never its truth", () => {
    const c = buildPersonaCase(persona(), OPTS);
    // The record says December 1st; the truth says December 2nd. The agent holds the record.
    expect(c.lead.briefing?.xDate?.date).toBe("2026-12-01");
    expect(c.facts.renewalDate).toBe("2026-12-02");
    expect(c.lead.briefing?.employees).toBeUndefined();
    expect(c.lead.briefing?.payroll).toBeUndefined();
    expect(c.lead.name).toBe("Priya Shah");
    expect(c.lead.phone).toBe("+15550199");
    expect(c.lead.dncStatus).toBe("clear");
  });

  it("holds consent only where the system dialled, and never a text agreement after the missed calls", () => {
    const callback = buildPersonaCase(persona(), OPTS).lead;
    expect([!!callback.textAgreementAt, !!callback.artificialVoiceConsent, callback.smsConsentAt]).toEqual([true, true, undefined]);
    expect(withoutDialAgreement(callback).textAgreementAt).toBeUndefined();
    // The missed calls are counted under the scheduled dial time, so it stays.
    expect(withoutDialAgreement(callback).scheduledOutboundAt).toBe(callback.scheduledOutboundAt);
    const cold = buildPersonaCase(persona({ situation: "cold_inbound" }), OPTS).lead;
    expect([cold.textAgreementAt, cold.smsConsentAt, cold.voiceConsentAt, cold.artificialVoiceConsent]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("gives no record to a caller ringing from a number that is not the record's", () => {
    const c = buildPersonaCase(persona({ setup: { ...persona().setup, call_origin_note: "Inbound from +15550100, which does not match the number on file." } }), OPTS);
    expect([c.record.kind, c.callerNumberMismatch, c.lead.briefing]).toEqual(["no_record", true, undefined]);
  });

  it("turns a stage-direction opening into its quoted words", () => {
    expect(spokenOpening("(silence for six seconds, then a muffled 'hello?')")).toBe("hello?");
    expect(spokenOpening("(silence)")).toBeUndefined();
    expect(spokenOpening("Hi, who is this?")).toBe("Hi, who is this?");
  });

  it("places two missed attempts before a callback, none otherwise", () => {
    expect(buildPersonaCase(persona(), OPTS).missedAttempts).toBe(2);
    expect(buildPersonaCase(persona({ situation: "cold_inbound" }), OPTS).missedAttempts).toBe(0);
    const rangTwice = persona({
      situation: "cold_inbound",
      setup: { call_origin_note: "Inbound.", lead_record_on_file: "Loud Excavating, public-record renewal 2026-12-28. The system rang him twice." },
    });
    expect(buildPersonaCase(rangTwice, OPTS).missedAttempts).toBe(2);
  });

  it("calls an unknown caller with no record and a fictional number", () => {
    const c = buildPersonaCase(persona({ setup: { call_origin_note: "Inbound, new.", lead_record_on_file: "No record under his number." } }), OPTS);
    expect(c.record.kind).toBe("no_record");
    expect(c.lead.briefing).toBeUndefined();
    expect(c.lead.name).toBe("Unknown caller");
    expect(c.lead.phone).toMatch(/^\+1555010\d{4}$/);
  });

  it("marks a Spanish persona as not supported and refuses an unreadable record", () => {
    expect(buildPersonaCase(persona({ persona: { language: "es" } }), OPTS).languageSupported).toBe(false);
    expect(() => buildPersonaCase(persona({ setup: { call_origin_note: "Inbound.", lead_record_on_file: "?" } }), OPTS)).toThrow(
      "persona_lead_record_unparsed:test-roofer:no_business_name",
    );
  });

  it("maps the truth to lead facts named after the persona, objections in order", () => {
    expect(personaFacts(persona())).toEqual({
      sourceCallId: "persona:test-roofer",
      businessType: "roofing",
      renewalDate: "2026-12-02",
      annualPayroll: "150,000 dollars",
      employeeCount: 4,
      currentCarrier: "Acme Workers' Mutual",
      language: "en",
      objections: ["I'm busy.", "Just email me."],
      temperament: "brisk",
    });
  });

  it("puts the batch clock inside the California calling window on the file's day", () => {
    expect(batchClockFor("2026-10-19").iso).toBe("2026-10-19T18:00:00.000Z");
  });
});

describe("persona file", () => {
  it("reads the day, the hash and the vocabularies, and refuses a persona without expectations", () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-"));
    const path = join(dir, "lead-scripts.json");
    const body = { today_for_all_dates: "2026-10-19 (a Monday)", vocabularies: { typed_questions: { language: ["en", "es"] }, dispositions: { message_taken: "x" } }, personas: [persona()] };
    writeFileSync(path, JSON.stringify(body));
    const file = loadPersonaFile(path);
    expect([file.today, file.personas.length, file.typedQuestions.language, file.dispositions]).toEqual(["2026-10-19", 1, ["en", "es"], ["message_taken"]]);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(path, JSON.stringify({ ...body, personas: [{ ...persona(), expected: undefined }] }));
    expect(() => loadPersonaFile(path)).toThrow("persona_file_bad_persona");
    expect(() => loadPersonaFile(join(dir, "missing.json"))).toThrow("persona_file_unavailable");
  });

  // Runs only where the training archive's file exists (a configured test machine); it is never copied into the repository.
  it.runIf(existsSync(personaFilePath()))("builds a case for every persona in the real file, all inbound by their own notes", () => {
    const file = loadPersonaFile();
    const cases = file.personas.map((p) => buildPersonaCase(p, { agencyId: "agency-test", today: file.today }));
    expect(cases).toHaveLength(41);
    expect(cases.every((c) => c.direction === "inbound")).toBe(true);
    expect(cases.filter((c) => c.missedAttempts === 2).length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((c) => !c.languageSupported)).toHaveLength(7);
  });
});

describe("callback missed calls", () => {
  it("the inbound callback still counts the two missed calls after the text agreement is removed", async () => {
    const { getHarnessConfig, resetHarnessConfig, setAiCallingEnabled } = await import("../../src/config.js");
    const { CallHarness } = await import("../../src/harness/call-harness.js");
    const { getModuleRegistry, resetModuleRegistry } = await import("../../src/modules/registry.js");
    const { mockLeadStore } = await import("../../src/store/lead-store-seam.js");
    const { getLead, resetLeadStore, seedLead } = await import("../../src/store/lead-store.js");
    const { placeOutboundAttempts, countUnansweredAttempts } = await import("../../src/decision/outbound-attempts.js");
    const { readRunMode, scopedSlot } = await import("../../src/harness/gates.js");
    resetHarnessConfig();
    resetLeadStore();
    resetModuleRegistry();
    setAiCallingEnabled(getHarnessConfig().agencyId, true);
    const c = buildPersonaCase(persona(), { agencyId: getHarnessConfig().agencyId, today: "2026-10-19" });
    seedLead(structuredClone(c.lead));
    const harness = new CallHarness(batchClockFor("2026-10-19"), mockLeadStore, getModuleRegistry());
    const results = await placeOutboundAttempts(harness, c.leadId, { idempotencyKey: "m", scheduledReason: "text_agreed_callback", outcomes: ["no_answer", "no_answer"], agent: "decision_tree" });
    expect(results.map((r) => r.status)).toEqual(["not_answered", "not_answered"]);
    seedLead(withoutDialAgreement(getLead(c.leadId)!));
    const lead = getLead(c.leadId)!;
    expect(countUnansweredAttempts(lead.id, scopedSlot(readRunMode(), lead.scheduledOutboundAt ?? "no-slot"))).toBe(2);
  }, 30_000);
});
