/**
 * A disclosure the caller did not hear whole does not count as disclosed.
 * The synthetic fixture marks the opening disclosure as cut off.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled, setRecordingNoticeEnabled } from "../../src/config.js";
import { INBOUND_AI_DISCLOSURE, INBOUND_RECORDING_DISCLOSURE, inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { CallHarness, disclosureHeardAtEnd } from "../../src/harness/call-harness.js";
import { resetDecisionRegistry } from "../../src/decision/registry.js";
import { resetActiveTree, STUB_TREE_FILE } from "../../src/decision/tree-source.js";
import { resetJudges } from "../../src/judge/index.js";
import { RuleBasedPostCallJudge, disclosureNotHeard, inboundDisclosureHeard } from "../../src/judge/post-call.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { JudgeRequest } from "../../src/judge/types.js";
import { getModuleRegistry, resetModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { emitTrace, recordStore, traceBus, type HarnessRecord, type TraceEvent } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

// The recorded call said both sentences, so these tests run with the recording notice on.
// The harness tests below reset it to the default (off); a section at the end covers it off.
beforeEach(() => {
  resetHarnessConfig();
  setRecordingNoticeEnabled(true);
});

function fixture(): HarnessRecord {
  const at = "2026-10-20T08:19:12.000Z";
  const events = [
    { type: "transcript_final", at, data: { role: "agent", text: inboundOpeningScript(), turnIndex: 0, spoken: false } },
    { type: "tool_call", at, data: { tool: "disclosure_check", inputs: { interrupted: true }, result: null, success: false, durationMs: 0, reason: "disclosure_cut_off" } },
  ] as unknown as TraceEvent[];
  return {
    recordId: "synthetic-disclosure-cut-off",
    kind: "call",
    leadId: "00000000-0000-4000-8000-0000000000b1",
    direction: "inbound",
    openedAt: at,
    events,
    transcript: [{ role: "agent", text: inboundOpeningScript(), turnIndex: 0, spoken: false, at }],
    texts: [],
  } as HarnessRecord;
}

/** The fixture refolded with some events changed, so each signal can be tested on its own. */
function variant(change: (events: TraceEvent[]) => TraceEvent[]): HarnessRecord {
  const base = fixture();
  const events = change(structuredClone(base.events));
  const transcript = events
    .filter((e) => e.type === "transcript_final")
    .map((e) => ({
      role: e.data.role as "caller" | "agent",
      text: String(e.data.text),
      turnIndex: Number(e.data.turnIndex),
      spoken: e.data.spoken !== false,
      at: e.at,
    }));
  return { ...base, events, transcript };
}

const isCheck = (e: TraceEvent) => e.type === "tool_call" && e.data.tool === "disclosure_check";
const isDisclosureTurn = (e: TraceEvent) => e.type === "transcript_final" && e.data.role === "agent" && e.data.text === inboundOpeningScript();

async function disclosureScore(record: HarnessRecord) {
  const score = await new RuleBasedPostCallJudge().judge(record);
  return score.criteria.find((c) => c.criterion === "disclosure_first")!;
}

describe("the post-call judge on a synthetic call with a cut-off disclosure", () => {
  it("fails disclosure_first and no longer scores 90", async () => {
    const record = fixture();
    expect(record.transcript[0]).toMatchObject({ role: "agent", text: inboundOpeningScript(), spoken: false });
    const score = await new RuleBasedPostCallJudge().judge(record);
    expect(score.criteria.find((c) => c.criterion === "disclosure_first")).toMatchObject({
      score: 0,
      note: "the AI disclosure was cut off before the caller heard it",
    });
    expect(score.score).toBeLessThan(90);
  });

  it("fails on the failed disclosure check alone, with the line marked spoken", async () => {
    const record = variant((events) => events.map((e) => (isDisclosureTurn(e) ? { ...e, data: { ...e.data, spoken: true } } : e)));
    expect(record.transcript[0]?.spoken).toBe(true);
    expect((await disclosureScore(record)).score).toBe(0);
  });

  it("fails on the line marked not spoken alone, with no disclosure check", async () => {
    const record = variant((events) => events.filter((e) => !isCheck(e)));
    expect((await disclosureScore(record)).score).toBe(0);
  });

  it("passes the same opening when it was heard whole", async () => {
    const record = variant((events) =>
      events
        .filter((e) => !isCheck(e))
        .map((e) => (isDisclosureTurn(e) ? { ...e, data: { ...e.data, spoken: true } } : e)),
    );
    expect(await disclosureScore(record)).toMatchObject({ score: 1, note: "the call opened with the AI disclosure" });
  });

  it("a second line 0 reported as a duplicate does not count against the first", () => {
    const duplicate = { type: "tool_call", data: { tool: "disclosure_check", success: false, reason: "duplicate_disclosure_line" } } as unknown as TraceEvent;
    const unsaid = { type: "tool_call", data: { tool: "agent_line_not_said", inputs: { turnIndex: -1 } } } as unknown as TraceEvent;
    const laterUnsaid = { type: "tool_call", data: { tool: "agent_line_not_said", inputs: { turnIndex: 3 } } } as unknown as TraceEvent;
    expect(disclosureNotHeard([duplicate])).toBe(false);
    expect(disclosureNotHeard([laterUnsaid])).toBe(false);
    expect(disclosureNotHeard([unsaid])).toBe(true);
  });
});

describe("the live rule judge with a cut-off disclosure", () => {
  const request = (direction: "inbound" | "outbound", opening: string): JudgeRequest =>
    ({
      action: "transfer",
      direction,
      payload: { reason: "caller_requested" },
      transcript: [
        { role: "agent", text: opening, turnIndex: -1, spoken: false },
        { role: "agent", text: "I'm an AI assistant for the agency.", turnIndex: 0, spoken: true },
        { role: "caller", text: "a person please", turnIndex: 1, spoken: true },
      ],
    }) as unknown as JudgeRequest;

  it("fails disclosure_first even when a later spoken line names the assistant", async () => {
    for (const [direction, opening] of [
      ["inbound", inboundOpeningScript()],
      ["outbound", "Hi, this is the AI assistant calling for the agency."],
    ] as const) {
      const verdict = await new RuleBasedJudge().judge(request(direction, opening));
      expect(verdict.scores.find((s) => s.criterion === "disclosure_first")?.score).toBe(0);
    }
  });

  it("still lets a stop ending through, so a do-not-contact request is never dropped", async () => {
    const req = request("inbound", inboundOpeningScript());
    const stopping = {
      ...req,
      action: "end_with_disposition",
      payload: { disposition: "do_not_contact", durable: true },
      transcript: [...req.transcript.slice(0, 2), { role: "caller", text: "please stop calling me", turnIndex: 1, spoken: true }],
    } as unknown as JudgeRequest;
    const verdict = await new RuleBasedJudge().judge(stopping);
    expect(verdict.scores.find((s) => s.criterion === "disclosure_first")).toMatchObject({
      score: 1,
      note: "a stop is honored even without the AI disclosure",
    });
  });
});

describe("the harness end-of-call check with a cut-off disclosure", () => {
  beforeEach(() => {
    recordStore.setDir(mkdtempSync(join(tmpdir(), "disclosure-cut-off-")));
    traceBus.reset();
    resetHarnessConfig();
    resetModuleRegistry();
    resetDecisionRegistry();
    resetJudges();
    process.env.VOICE_HARNESS_DECISION_TREE = STUB_TREE_FILE;
    resetActiveTree();
    resetLeadStore();
    clearCallLogs();
    setAiCallingEnabled("agency-demo", true);
    seedLead(baseLead());
  });

  /** Caller lines that first report the disclosure as cut off, the way the voice session does. */
  function cutOffSource(lines: string[]) {
    const queue = [...lines];
    let reported = false;
    return {
      next: async () => {
        if (!reported) {
          reported = true;
          emitTrace("tool_call", { tool: "disclosure_check", inputs: { overlap: 1, interrupted: true }, result: null, success: false, durationMs: 0, reason: "disclosure_cut_off" });
        }
        return queue.shift() ?? null;
      },
    };
  }

  const run = (key: string, callerSource?: ReturnType<typeof cutOffSource>) =>
    new CallHarness({ now: () => new Date("2026-10-15T14:00:00.000Z") }, undefined, getModuleRegistry()).runInbound("lead-1", "+15550143", {
      idempotencyKey: key,
      agent: "decision_tree",
      ...(callerSource ? { callerSource } : { callerUtterances: ["Hi, it is Jane", "I need a quote"] }),
    });

  it("records the check as failed and still ends the call, writes the outcome and scores it", async () => {
    const result = await run("cut-1", cutOffSource(["Hi, it is Jane", "I need a quote"]));
    expect(result.status).toBe("ai_handled");
    const record = recordStore.read(result.recordId!)!;
    const checks = record.events.filter((e) => e.type === "compliance_check" && e.data.check === "disclosure_first");
    expect(checks.map((e) => e.data)).toEqual([{ check: "disclosure_first", passed: false, reason: "inbound_disclosure_cut_off" }]);
    expect(record.events.some((e) => e.type === "tool_call" && e.data.tool === "end_call")).toBe(true);
    expect(record.outcome?.status).toBe("ai_handled");
    expect(record.judge?.criteria.find((c) => c.criterion === "disclosure_first")?.score).toBe(0);
  });

  it("passes the check once when the disclosure was heard", async () => {
    const result = await run("heard-1");
    const record = recordStore.read(result.recordId!)!;
    const checks = record.events.filter((e) => e.type === "compliance_check" && e.data.check === "disclosure_first");
    expect(checks.map((e) => e.data.passed)).toEqual([true]);
    expect(record.judge?.criteria.find((c) => c.criterion === "disclosure_first")?.score).toBe(1);
  });
});

/**
 * The live voice model sometimes says the disclosure as two lines with a pause,
 * and the caller can speak in the pause (call cold-is-this-a-robot). The voice
 * session then checks only the first part against the whole disclosure, so its
 * check reports a text mismatch with no interruption. Both parts said whole, in
 * order, before any other agent line, is a disclosure; anything else is not.
 */
describe("a disclosure said in two parts", () => {
  const PARTS = [INBOUND_AI_DISCLOSURE, INBOUND_RECORDING_DISCLOSURE];
  const mismatch = (interrupted: boolean) => ({ tool: "disclosure_check", inputs: { overlap: 0.4, interrupted }, result: null, success: false, durationMs: 0, reason: "disclosure_text_mismatch" });

  /** The fixture with its opening replaced by `lines` (agent and caller), and its disclosure check by `check`. */
  function split(lines: Array<{ role: "agent" | "caller"; text: string; spoken?: boolean }>, check: Record<string, unknown> | null): HarnessRecord {
    return variant((events) => {
      const opening = (template: TraceEvent) =>
        lines.map((l, i) => ({ ...template, data: { role: l.role, text: l.text, turnIndex: i, spoken: l.spoken !== false, source: "voice_module" } }));
      return events.flatMap((e) => (isDisclosureTurn(e) ? opening(e) : isCheck(e) ? (check ? [{ ...e, data: check }] : []) : [e]));
    });
  }

  const withCaller = [
    { role: "agent" as const, text: PARTS[0]! },
    { role: "caller" as const, text: "Wait, is this a robot?" },
    { role: "agent" as const, text: PARTS[1]! },
  ];

  it("passes with the caller speaking between the parts, the post-call judge and the end-of-call check alike", async () => {
    const record = split(withCaller, mismatch(false));
    expect(record.transcript.slice(0, 3).map((t) => t.role)).toEqual(["agent", "caller", "agent"]);
    expect(await disclosureScore(record)).toMatchObject({ score: 1, note: "the call opened with the AI disclosure" });
    expect(inboundDisclosureHeard(record.transcript, record.events)).toBe("heard");
    // The harness's own transcript holds the whole line; the record shows how it was really said.
    const own = [{ role: "agent" as const, text: inboundOpeningScript(), turnIndex: -1, spoken: true }];
    expect(disclosureHeardAtEnd(own, record)).toBeNull();
  });

  it("passes with no caller line between the parts too", async () => {
    expect((await disclosureScore(split([withCaller[0]!, withCaller[2]!], mismatch(false)))).score).toBe(1);
  });

  it("fails when either part was interrupted or marked not spoken", async () => {
    expect((await disclosureScore(split(withCaller, mismatch(true))))).toMatchObject({ score: 0, note: "the AI disclosure was cut off before the caller heard it" });
    const secondCut = [withCaller[0]!, withCaller[1]!, { ...withCaller[2]!, spoken: false }];
    const record = split(secondCut, null);
    expect((await disclosureScore(record)).score).toBe(0);
    expect(disclosureHeardAtEnd([{ role: "agent", text: inboundOpeningScript(), turnIndex: -1, spoken: true }], record)).toBe("inbound_disclosure_cut_off");
  });

  it("fails with an agent line other than the second part between them", async () => {
    const between = [withCaller[0]!, withCaller[1]!, { role: "agent" as const, text: "Yes, I'm an AI assistant." }, withCaller[2]!];
    const record = split(between, mismatch(false));
    expect(await disclosureScore(record)).toMatchObject({ score: 0, note: "the call did not open with the AI disclosure" });
    expect(disclosureHeardAtEnd([{ role: "agent", text: inboundOpeningScript(), turnIndex: -1, spoken: true }], record)).toBe("inbound_disclosure_not_first");
  });

  it("fails with the parts in the wrong order", async () => {
    expect((await disclosureScore(split([withCaller[2]!, withCaller[1]!, withCaller[0]!], mismatch(false)))).score).toBe(0);
  });

  it("fails on a paraphrase, as one line or as two parts", async () => {
    const oneLine = [{ role: "agent" as const, text: "Just so you know, I'm an AI assistant and this call is recorded." }];
    expect((await disclosureScore(split(oneLine, mismatch(false)))).score).toBe(0);
    const paraphrasedPart = [{ role: "agent" as const, text: "You are talking to an AI assistant." }, withCaller[1]!, withCaller[2]!];
    expect((await disclosureScore(split(paraphrasedPart, mismatch(false)))).score).toBe(0);
  });

  it("a whole line whose text did not match the voice session's check still fails", async () => {
    const record = variant((events) => events.map((e) => (isCheck(e) ? { ...e, data: mismatch(false) } : isDisclosureTurn(e) ? { ...e, data: { ...e.data, spoken: true } } : e)));
    expect((await disclosureScore(record)).score).toBe(0);
  });

  it("the original cut-off record still fails", async () => {
    expect((await disclosureScore(fixture())).score).toBe(0);
  });

  describe("the live rule judge", () => {
    const transfer = (opening: Array<{ role: "agent" | "caller"; text: string; spoken?: boolean }>): JudgeRequest =>
      ({
        action: "transfer",
        direction: "inbound",
        payload: { reason: "caller_requested" },
        transcript: [...opening.map((l, i) => ({ ...l, turnIndex: i, spoken: l.spoken !== false })), { role: "caller", text: "a person please", turnIndex: 9, spoken: true }],
      }) as unknown as JudgeRequest;
    const disclosureLine = async (req: JudgeRequest) => (await new RuleBasedJudge().judge(req)).scores.find((s) => s.criterion === "disclosure_first")!.score;

    it("passes the split disclosure with the caller between the parts", async () => {
      expect(await disclosureLine(transfer(withCaller))).toBe(1);
    });

    it("fails an agent line between the parts, a paraphrase and a cut-off part", async () => {
      expect(await disclosureLine(transfer([withCaller[0]!, { role: "agent", text: "One moment." }, withCaller[2]!]))).toBe(0);
      expect(await disclosureLine(transfer([{ role: "agent", text: "You are talking to an AI assistant." }, withCaller[2]!]))).toBe(0);
      expect(await disclosureLine(transfer([withCaller[0]!, withCaller[1]!, { ...withCaller[2]!, spoken: false }]))).toBe(0);
    });
  });
});

/** With the recording notice off, the disclosure is the artificial intelligence sentence alone. */
describe("a disclosure with the recording notice off", () => {
  beforeEach(() => setRecordingNoticeEnabled(false));
  const line = (role: "agent" | "caller", text: string, spoken = true) => ({ role, text, spoken });

  it("the artificial intelligence sentence alone is the whole disclosure, for the post-call judge and the end-of-call check", () => {
    const transcript = [line("agent", INBOUND_AI_DISCLOSURE), line("caller", "Hello?")];
    expect(inboundOpeningScript()).toBe(INBOUND_AI_DISCLOSURE);
    expect(inboundDisclosureHeard(transcript, [])).toBe("heard");
    expect(disclosureHeardAtEnd([{ role: "agent", text: INBOUND_AI_DISCLOSURE, turnIndex: -1, spoken: true }])).toBeNull();
  });

  it("the recording sentence first, or a paraphrase, still fails; the artificial intelligence sentence cut off fails", () => {
    expect(inboundDisclosureHeard([line("agent", INBOUND_RECORDING_DISCLOSURE), line("agent", INBOUND_AI_DISCLOSURE)], [])).toBe("not_first");
    expect(inboundDisclosureHeard([line("agent", "You are talking to an AI assistant.")], [])).toBe("not_first");
    expect(inboundDisclosureHeard([line("agent", INBOUND_AI_DISCLOSURE, false)], [])).toBe("cut_off");
  });

  it("the live rule judge passes the sentence alone and refuses a paraphrase", async () => {
    const judge = async (opening: string) =>
      (
        await new RuleBasedJudge().judge({
          action: "transfer",
          direction: "inbound",
          payload: { reason: "caller_requested" },
          transcript: [{ role: "agent", text: opening, turnIndex: -1, spoken: true }, { role: "caller", text: "a person please", turnIndex: 0, spoken: true }],
        } as unknown as JudgeRequest)
      ).scores.find((s) => s.criterion === "disclosure_first")!.score;
    expect(await judge(INBOUND_AI_DISCLOSURE)).toBe(1);
    expect(await judge("Just so you know, I'm an AI assistant.")).toBe(0);
  });
});
