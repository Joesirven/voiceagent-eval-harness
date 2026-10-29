/**
 * Gap-filling scenarios found by the coverage audit (see docs/scenario-coverage.md).
 * Each block names the required scenario it completes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import {
  INBOUND_AI_DISCLOSURE,
  OUTBOUND_AI_TRUTHFUL_ANSWER,
} from "../../src/compliance/disclosures.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs, getCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import type { Clock } from "../../src/types/clock.js";
import { baseLead } from "../helpers/fixtures.js";

const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const IN_WINDOW = "2026-10-15T14:00:00.000Z"; // 10:00 Eastern

beforeEach(() => {
  resetHarnessConfig();
  setAiCallingEnabled("agency-demo", true);
  resetModuleRegistry();
  resetLeadStore();
  clearCallLogs();
});

describe("recognized-lead inbound: disclosure first, recognition, forward motion", () => {
  it("opens with the AI disclosure, greets the lead by name, files a note", async () => {
    seedLead(baseLead());
    const result = await new CallHarness(at(IN_WINDOW)).runInbound("lead-1", "+1", {
      idempotencyKey: "gap-in-1",
      callerUtterances: ["Hi, I am Jane Doe, I need an auto quote.", "I drive a 2019 Honda Civic."],
    });
    const turns = result.transcript ?? [];
    expect(turns[0]?.role).toBe("agent");
    expect(turns[0]?.text).toContain(INBOUND_AI_DISCLOSURE);
    const firstCallerIdx = turns.findIndex((t) => t.role === "caller");
    expect(turns.findIndex((t) => t.text.includes(INBOUND_AI_DISCLOSURE))).toBeLessThan(firstCallerIdx);
    expect(turns.some((t) => t.role === "agent" && t.text.includes("Jane"))).toBe(true);
    const lead = getLead("lead-1");
    expect(lead?.handoffNotes[0]?.promised).toBe("email your quote");
    expect(lead?.quoteFields.vehicle_year?.value).toBe("2019");
  });
});

describe("outbound at the agreed time after text consent", () => {
  it("answers 'are you an AI' truthfully in the call itself", async () => {
    seedLead(baseLead());
    const result = await new CallHarness(at(IN_WINDOW)).runOutbound("lead-1", "+1", {
      idempotencyKey: "gap-out-1",
      scheduledReason: "text_agreed_callback",
      callerUtterances: ["Wait, are you an AI?"],
    });
    const agent = (result.transcript ?? []).filter((t) => t.role === "agent");
    expect(agent[0]?.text).toBe(OUTBOUND_AI_TRUTHFUL_ANSWER);
  });

  it.each([
    ["no consent of any kind", { artificialVoiceConsent: undefined, voiceConsentAt: undefined }],
    ["ordinary call consent only", { artificialVoiceConsent: undefined }],
  ])("text agreement plus %s does not clear the call", async (_name, patch) => {
    seedLead(baseLead(patch));
    const h = new CallHarness(at(IN_WINDOW));
    const r = await h.runOutbound("lead-1", "+1", {
      idempotencyKey: "gap-nc",
      scheduledReason: "text_agreed_callback",
    });
    expect(r).toMatchObject({ status: "blocked", reason: "no_artificial_voice_consent" });
    expect(getCallLogs().some((l) => l.reason === "no_artificial_voice_consent" && l.outcome === "blocked")).toBe(true);
    // texts keep their own consent check
    expect((await h.sendText("lead-1", "hi", "gap-nc-sms")).status).toBe("recorded");
  });

  it("an agency attestation basis clears the call like a lead's own written grant", async () => {
    seedLead(baseLead({ artificialVoiceConsent: { at: "2026-09-01T00:00:00.000Z", basis: "agency_attestation" } }));
    const r = await new CallHarness(at(IN_WINDOW)).runOutbound("lead-1", "+1", {
      idempotencyKey: "gap-att",
      scheduledReason: "text_agreed_callback",
    });
    expect(r.status).toBe("placed");
  });

  it("refuses before the agreed time and without a text agreement", async () => {
    seedLead(baseLead({ scheduledOutboundAt: "2026-10-15T16:00:00.000Z" }));
    const early = await new CallHarness(at(IN_WINDOW)).runOutbound("lead-1", "+1", {
      idempotencyKey: "gap-early",
      scheduledReason: "text_agreed_callback",
    });
    expect(early.reason).toBe("before_scheduled_time");

    seedLead(baseLead({ textAgreementAt: undefined }));
    const noText = await new CallHarness(at(IN_WINDOW)).runOutbound("lead-1", "+1", {
      idempotencyKey: "gap-notext",
      scheduledReason: "text_agreed_callback",
    });
    expect(noText.reason).toBe("text_agreement_missing");
  });
});

describe("quiet hours: 8am to 9pm in the lead's local time, enforced in code", () => {
  async function smsAt(iso: string, timezone = "America/New_York") {
    seedLead(baseLead({ timezone }));
    return new CallHarness(at(iso)).sendText("lead-1", "hi", `q-${iso}-${timezone}`);
  }

  it("edges: 08:00 allowed, 07:59 blocked, 20:59 allowed, 21:00 blocked", async () => {
    expect((await smsAt("2026-10-15T12:00:00.000Z")).status).toBe("recorded");
    expect((await smsAt("2026-10-15T11:59:00.000Z")).status).toBe("blocked");
    expect((await smsAt("2026-10-16T00:59:00.000Z")).status).toBe("recorded");
    expect((await smsAt("2026-10-16T01:00:00.000Z")).status).toBe("blocked");
  });

  it("uses the lead's own timezone, not the server's", async () => {
    // 14:00Z is 10:00 in New York but 07:00 in Los Angeles.
    expect((await smsAt(IN_WINDOW, "America/New_York")).status).toBe("recorded");
    expect((await smsAt(IN_WINDOW, "America/Los_Angeles")).status).toBe("blocked");
  });

  it("blocks when the lead has no timezone rather than guessing", async () => {
    seedLead(baseLead({ timezone: undefined }));
    const r = await new CallHarness(at(IN_WINDOW)).sendText("lead-1", "hi", "q-none");
    expect(r.reason).toBe("unknown_time_zone");
  });
});

describe("STOP and do-not-call suppression before every call and every text", () => {
  it.each([
    ["onStopList", "stop_list"],
    ["onDncList", "dnc_list"],
    ["suppressed", "suppression_list"],
  ] as const)("%s blocks text, outbound call and inbound AI", async (flag, reason) => {
    seedLead(baseLead({ [flag]: true }));
    const h = new CallHarness(at(IN_WINDOW));
    expect((await h.sendText("lead-1", "hi", `s-${flag}`)).reason).toBe(reason);
    expect(
      (await h.runOutbound("lead-1", "+1", {
        idempotencyKey: `o-${flag}`,
        scheduledReason: "text_agreed_callback",
      })).reason,
    ).toBe(reason);
    expect(
      (await h.runInbound("lead-1", "+1", { idempotencyKey: `i-${flag}` })).status,
    ).toBe("normal_answering");
  });

  it("revoked consent blocks text and outbound call", async () => {
    seedLead(baseLead({ consentRevokedAt: "2026-10-10T00:00:00.000Z" }));
    const h = new CallHarness(at(IN_WINDOW));
    expect((await h.sendText("lead-1", "hi", "rv-sms")).reason).toBe("consent_revoked");
    expect(
      (await h.runOutbound("lead-1", "+1", {
        idempotencyKey: "rv-out",
        scheduledReason: "text_agreed_callback",
      })).reason,
    ).toBe("consent_revoked");
  });
});

describe("logging completeness: every attempt ends in a logged outcome with a reason", () => {
  it("each attempt (call, text; allowed or not) adds an entry naming a reason", async () => {
    seedLead(baseLead());
    const h = new CallHarness(at(IN_WINDOW));
    const attempts: Array<() => Promise<unknown>> = [
      () => h.sendText("lead-1", "hi", "lg-sms-ok"),
      () => h.sendText("ghost", "hi", "lg-sms-ghost"),
      () => h.runOutbound("lead-1", "+1", { idempotencyKey: "lg-out-noreason" }),
      () => h.runInbound("lead-1", "+1", { idempotencyKey: "lg-in", callerUtterances: ["Hi"] }),
    ];
    for (const run of attempts) {
      const before = getCallLogs().length;
      await run();
      expect(getCallLogs().length).toBeGreaterThan(before);
    }
    const logs = getCallLogs();
    expect(logs.every((l) => l.reason.length > 0 && l.at && l.leadId)).toBe(true);
    expect(logs.find((l) => l.channel === "sms" && l.outcome === "message_sent")).toBeTruthy();
    expect(logs.find((l) => l.leadId === "ghost")?.reason).toBe("lead_not_found");
    const terminal = new Set(["answered", "skipped", "blocked", "message_sent", "message_blocked", "ended"]);
    for (const key of ["lg-sms-ok", "lg-sms-ghost", "lg-out-noreason", "lg-in"]) {
      expect(logs.some((l) => l.requestKey === key && terminal.has(l.outcome))).toBe(true);
    }
  });
});

describe("quote fields hold only what the caller actually said", () => {
  it("every stored field's value and evidence appear verbatim in caller speech", async () => {
    seedLead(baseLead());
    const utterances = [
      "Hi, Jane Doe, I need an auto quote",
      "It is a 2019 Honda Civic",
      "I want a 500 dollar deductible",
    ];
    await new CallHarness(at(IN_WINDOW)).runInbound("lead-1", "+1", {
      idempotencyKey: "inv-1",
      callerUtterances: utterances,
    });
    const fields = Object.entries(getLead("lead-1")?.quoteFields ?? {});
    expect(fields.length).toBeGreaterThan(0);
    for (const [name, f] of fields) {
      expect(utterances, `${name} evidence`).toContain(f.evidenceSpan);
      expect(f.evidenceSpan.toLowerCase(), `${name} value`).toContain(f.value.toLowerCase());
    }
  });

  it("a caller who states no facts leaves quote fields and handoff empty", async () => {
    seedLead(baseLead());
    await new CallHarness(at(IN_WINDOW)).runInbound("lead-1", "+1", {
      idempotencyKey: "inv-2",
      callerUtterances: ["Hello", "Just checking in", "Thanks"],
    });
    const lead = getLead("lead-1");
    expect(Object.keys(lead?.quoteFields ?? {})).toEqual([]);
    expect(lead?.handoffNotes).toEqual([]);
  });
});

describe("'are you an AI' is matched by whole words", () => {
  const outbound = (utterance: string) =>
    new CallHarness(at(IN_WINDOW)).runOutbound("lead-1", "+1", {
      idempotencyKey: `ai-${utterance}`,
      scheduledReason: "text_agreed_callback",
      callerUtterances: [utterance],
    });

  it.each(["I said hello", "Could you say that again", "Maybe later, wait", "Bring a main dish"])(
    "%s is not the question and files no handoff",
    async (utterance) => {
      seedLead(baseLead());
      const r = await outbound(utterance);
      const agent = (r.transcript ?? []).filter((t) => t.role === "agent");
      expect(agent[0]?.text).not.toBe(OUTBOUND_AI_TRUTHFUL_ANSWER);
      expect(getLead("lead-1")?.handoffNotes).toEqual([]);
    },
  );

  it.each([
    "Are you an AI?",
    "wait, are you an AI",
    "Is this a robot?",
    "Am I talking to a person?",
    "I want a real person",
    "Is this automated?",
  ])("%s gets the truthful answer", async (utterance) => {
    seedLead(baseLead());
    const r = await outbound(utterance);
    const agent = (r.transcript ?? []).filter((t) => t.role === "agent");
    expect(agent[0]?.text).toBe(OUTBOUND_AI_TRUTHFUL_ANSWER);
  });
});
