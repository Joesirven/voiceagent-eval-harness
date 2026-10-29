/**
 * Known-lead opening checks for the fictional Northwind Insurance Agency cast.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled, setRecordingNoticeEnabled } from "../../src/config.js";
import {
  INBOUND_AI_DISCLOSURE,
  INBOUND_RECORDING_DISCLOSURE,
  aiDisclosureSentence,
  callOpening,
  findInboundDisclosure,
  inboundOpeningScript,
  openingFactsFor,
  openingLine,
} from "../../src/compliance/disclosures.js";
import { CallHarness, disclosureHeardAtEnd } from "../../src/harness/call-harness.js";
import { TreeDialog } from "../../src/decision/engine.js";
import { placeOutboundAttempts } from "../../src/decision/outbound-attempts.js";
import { DecisionModuleRegistry, getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { FULL_TREE_FILE, STUB_TREE_FILE, loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import type { DecisionModule, DecisionRequest, DecisionResult } from "../../src/decision/types.js";
import { resetJudges } from "../../src/judge/index.js";
import { EXPECTED_OPENING_TOOL, RuleBasedPostCallJudge } from "../../src/judge/post-call.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { Judge, JudgeRequest } from "../../src/judge/types.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import type { LeadRecord } from "../../src/store/lead-store.js";
import { newCallContext, runWithTrace } from "../../src/trace/events.js";
import { recordStore, traceBus, type HarnessRecord, type TraceEvent } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const IN_WINDOW = "2026-10-15T14:00:00.000Z";
const PAT = "Hi, this is Pat's AI assistant with Example Mutual.";
const AGENCY_ONLY = "Hi, this is the AI assistant with Example Mutual.";
const CONFIRM = "Is this Maria?";
/** Any question asking a caller who they are or what their business is called. */
const IDENTITY_QUESTION = /may I have your name|your name and the name|name of (the|your) business|business you're with|who am I speaking with|who is calling|who's calling/i;
/** Anything about the account: the renewal, the policy, the carrier, the business on file. */
const ACCOUNT_DETAIL = /renew|workers' compensation|policy|carrier|payroll|Riverside Plumbing|Example Mutual/i;

/** A lead the lead context knows: the owner's name, the producer and the agency, read from the briefing. */
function knownLead(facts: { producerName?: string; agencyName?: string } = { producerName: "Pat Lee", agencyName: "Example Mutual" }): LeadRecord {
  return baseLead({
    name: "Maria Lopez",
    briefing: {
      business: "Riverside Plumbing",
      ownerName: "Maria Lopez",
      carriersCurrent: ["Example Mutual"],
      xDate: { date: "2027-03-14", carrier: "Example Mutual" },
      priorCalls: [],
      priorTexts: [],
      missedOutboundCalls: [],
      ...facts,
    } as LeadRecord["briefing"],
  });
}

beforeEach(() => {
  recordStore.setDir(mkdtempSync(join(tmpdir(), "known-lead-opener-")));
  traceBus.reset();
  resetHarnessConfig();
  resetModuleRegistry();
  resetDecisionRegistry();
  resetJudges();
  process.env.VOICE_HARNESS_DECISION_TREE = FULL_TREE_FILE;
  resetActiveTree();
  resetLeadStore();
  clearCallLogs();
  setAiCallingEnabled("agency-demo", true);
});

describe("the disclosure template", () => {
  it("fills the producer and the agency, falls back to the agency alone, then to the plain disclosure", () => {
    expect(aiDisclosureSentence({ producerFirstName: "Pat", agencyName: "Example Mutual" })).toBe(PAT);
    expect(aiDisclosureSentence({ agencyName: "Example Mutual" })).toBe(AGENCY_ONLY);
    expect(aiDisclosureSentence({ producerFirstName: "Pat" })).toBe(INBOUND_AI_DISCLOSURE);
    expect(aiDisclosureSentence()).toBe(INBOUND_AI_DISCLOSURE);
  });

  it("treats unknown, empty or missing values as absent", () => {
    expect(aiDisclosureSentence({ producerFirstName: "unknown", agencyName: "Example Mutual" })).toBe(AGENCY_ONLY);
    expect(aiDisclosureSentence({ producerFirstName: "Pat", agencyName: " " })).toBe(INBOUND_AI_DISCLOSURE);
    expect(aiDisclosureSentence({ producerFirstName: "Pat", agencyName: "Unknown" })).toBe(INBOUND_AI_DISCLOSURE);
    expect(callOpening({ leadFirstName: "unknown" }).confirm).toBeUndefined();
  });

  it("follows the recording notice switch: the sentence alone while off, the recording sentence after it while on", () => {
    expect(callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual" }).disclosure).toEqual([PAT]);
    setRecordingNoticeEnabled(true);
    expect(callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual" }).disclosure).toEqual([PAT, INBOUND_RECORDING_DISCLOSURE]);
    expect(inboundOpeningScript()).toBe(`${INBOUND_AI_DISCLOSURE} ${INBOUND_RECORDING_DISCLOSURE}`);
  });

  it("a known lead's opening is the disclosure, then the confirmation question", () => {
    const opening = callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" });
    expect(openingLine(opening)).toBe(`${PAT} ${CONFIRM}`);
  });

  it("reads the facts from the lead's briefing; an inbound record without one is not a known lead", () => {
    expect(openingFactsFor(knownLead(), "inbound")).toEqual({ producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" });
    expect(openingFactsFor(baseLead(), "inbound")).toEqual({});
    // An outbound call dials the number on the record, so the record's name counts.
    expect(openingFactsFor(baseLead(), "outbound")).toEqual({ leadFirstName: "Jane" });
    expect(openingFactsFor(knownLead({ producerName: "unknown", agencyName: "" }), "inbound")).toEqual({ leadFirstName: "Maria" });
  });
});

describe("the judges compare against the exact filled disclosure", () => {
  const opening = callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" });
  const PARAPHRASES = [
    "This is Pat's AI assistant from Example Mutual. Is this Maria?",
    "Hi, I'm Pat's assistant at Example Mutual, an AI. Is this Maria?",
    `${INBOUND_AI_DISCLOSURE} Is this Maria?`,
    `Hi Maria. ${PAT}`,
  ];

  const actionJudge = async (direction: "inbound" | "outbound", first: string, expected: string[] | null = opening.disclosure) =>
    (
      await new RuleBasedJudge().judge({
        action: "transfer",
        nodeId: "test",
        direction,
        payload: { reason: "caller_requested" },
        transcript: [
          { role: "agent", text: first, turnIndex: -1, spoken: true },
          { role: "caller", text: "a person please", turnIndex: 0, spoken: true },
        ],
        completed: [],
        now: new Date(IN_WINDOW),
        ...(expected ? { expectedDisclosure: expected } : {}),
      } satisfies JudgeRequest)
    ).scores.find((s) => s.criterion === "disclosure_first")!.score;

  it("the action judge accepts the filled opening and refuses a paraphrase, in both directions", async () => {
    for (const direction of ["inbound", "outbound"] as const) {
      expect(await actionJudge(direction, openingLine(opening))).toBe(1);
      for (const said of PARAPHRASES) expect(await actionJudge(direction, said), said).toBe(0);
    }
  });

  it("with nothing carried, the action judge falls back to the plain disclosure", async () => {
    expect(await actionJudge("inbound", INBOUND_AI_DISCLOSURE, null)).toBe(1);
    expect(await actionJudge("inbound", PAT, null)).toBe(0);
  });

  /** A record of a call that recorded this opening and said `first`. */
  const record = (direction: "inbound" | "outbound", first: string, recorded = true): HarnessRecord => {
    const at = IN_WINDOW;
    const event = (type: TraceEvent["type"], data: Record<string, unknown>, seq: number) =>
      ({ seq, recordSeq: seq, at, atMs: seq, type, leadId: "lead-1", recordId: "call_x", channel: "call", callId: "call_x", data }) as TraceEvent;
    return {
      recordId: "call_x",
      kind: "call",
      leadId: "lead-1",
      direction,
      openedAt: at,
      events: [
        ...(recorded
          ? [event("tool_call", { tool: EXPECTED_OPENING_TOOL, inputs: { direction }, result: { disclosure: opening.disclosure, confirm: opening.confirm }, success: true, durationMs: 0 }, 1)]
          : []),
        event("disposition", { value: "talked" }, 2),
      ],
      transcript: [
        { role: "agent", text: first, turnIndex: -1, spoken: true, at },
        { role: "caller", text: "Yes, speaking.", turnIndex: 0, spoken: true, at },
      ],
      texts: [],
    } as HarnessRecord;
  };
  const postCall = async (r: HarnessRecord) => (await new RuleBasedPostCallJudge().judge(r)).criteria.find((c) => c.criterion === "disclosure_first")!.score;

  it("the post-call judge reads the recorded opening, accepts it and refuses a paraphrase, in both directions", async () => {
    for (const direction of ["inbound", "outbound"] as const) {
      expect(await postCall(record(direction, openingLine(opening)))).toBe(1);
      for (const said of PARAPHRASES) expect(await postCall(record(direction, said)), said).toBe(0);
    }
  });

  it("the post-call judge tolerates the voice check's mismatch on the reworded question, not an interruption", async () => {
    const mismatch = (interrupted: boolean) => ({ tool: "disclosure_check", inputs: { overlap: 0.8, interrupted }, result: null, success: false, durationMs: 0, reason: "disclosure_text_mismatch" });
    const reworded = record("inbound", `${PAT} Is this Maria I'm talking to?`);
    const withCheck = (r: HarnessRecord, data: Record<string, unknown>) => ({ ...r, events: [...r.events, { ...r.events[0]!, data }] });
    expect(await postCall(withCheck(reworded, mismatch(false)))).toBe(1);
    expect(await postCall(withCheck(reworded, mismatch(true)))).toBe(0);
  });

  it("the harness end-of-call check reads the recorded opening and refuses a paraphrase", () => {
    const own = [{ role: "agent" as const, text: openingLine(opening), turnIndex: -1, spoken: true }];
    expect(disclosureHeardAtEnd(own, record("inbound", openingLine(opening)))).toBeNull();
    expect(disclosureHeardAtEnd(own, record("inbound", PARAPHRASES[0]!))).toBe("inbound_disclosure_not_first");
    // A record with no opening recorded: the plain disclosure is expected, so the filled one is not it.
    expect(disclosureHeardAtEnd(own, record("inbound", openingLine(opening), false))).toBe("inbound_disclosure_not_first");
  });

  it("with the recording notice on, both parts are needed, as one line or two", () => {
    const on = callOpening({ producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" }, { recordingNotice: true });
    const agent = (text: string) => ({ role: "agent", text });
    expect(findInboundDisclosure([agent(openingLine(on))], on.disclosure)).not.toBeNull();
    expect(findInboundDisclosure([agent(PAT), { role: "caller", text: "Hello?" }, agent(`${INBOUND_RECORDING_DISCLOSURE} ${CONFIRM}`)], on.disclosure)).not.toBeNull();
    expect(findInboundDisclosure([agent(`${PAT} ${CONFIRM}`)], on.disclosure)).toBeNull();
  });
});

/**
 * Decides from what the request holds, the way a model would: the caller's
 * latest words, read against the question asked at each node.
 */
class NorthwindKnownLeadModel implements DecisionModule {
  readonly id = "northwind-known-lead";
  readonly label = "Northwind known lead test";
  getConfig() {
    return { enabled: true, latencyMs: 0 };
  }
  async decide(req: DecisionRequest): Promise<DecisionResult> {
    const answer = req.nodeId === "interrupts" ? "none" : req.nodeId === "identity.confirm" ? "right_person" : "not_interested";
    return { answer, confidence: 0.95, reason: "test" };
  }
}

function knownLeadDialog(recordingNotice = false) {
  const decisions = new DecisionModuleRegistry();
  const model = new NorthwindKnownLeadModel();
  decisions.register(model);
  decisions.select(model.id);
  const yes = async () => true;
  return new TreeDialog({
    tree: loadActiveTree(),
    decisions,
    gate: { judge: { id: "allow", judge: async () => ({ allowed: true, reason: "test", scores: [] }) }, leadId: "lead-1", callId: "call-test" },
    actions: { transfer: yes, saveQuoteField: yes, saveDetails: yes, book: yes, sendText: yes, endWithDisposition: yes },
    recorder: { record: () => undefined },
    direction: "inbound",
    firstName: "Maria",
    timeZone: "America/Los_Angeles",
    clock: { now: () => new Date(IN_WINDOW) },
    lead: { name: "Maria Lopez", business: "Riverside Plumbing" },
    opening: callOpening(
      { producerFirstName: "Pat", agencyName: "Example Mutual", leadFirstName: "Maria" },
      { recordingNotice },
    ),
  });
}

describe("known leads on the Northwind renewal tree", () => {
  it("opens with the filled disclosure and the tree's renewal-role confirmation", async () => {
    const dialog = knownLeadDialog();
    expect(await dialog.open()).toBe(
      `${PAT} Are you the person who handles the business insurance renewal for Riverside Plumbing?`,
    );
    expect(dialog.transcript[0]!.text).not.toMatch(IDENTITY_QUESTION);
  });

  it("puts the recording notice between the disclosure and the confirmation question", async () => {
    const dialog = knownLeadDialog(true);
    expect(await dialog.open()).toBe(
      `${PAT} ${INBOUND_RECORDING_DISCLOSURE} Are you the person who handles the business insurance renewal for Riverside Plumbing?`,
    );
  });

  it("starts a known lead at identity.confirm and moves to employee discovery after confirmation", async () => {
    const dialog = knownLeadDialog();
    const nodes: string[] = [];
    const off = traceBus.subscribe((event) => {
      if (event.type === "node_enter") nodes.push(String(event.data.nodeId));
    });
    try {
      await runWithTrace(newCallContext("lead-1", "inbound"), async () => {
        await dialog.open();
        await dialog.step("Yes, I handle the renewal.");
      });
    } finally {
      off();
    }
    expect(nodes).toEqual(["identity.confirm", "discovery.employees"]);
  });
});
