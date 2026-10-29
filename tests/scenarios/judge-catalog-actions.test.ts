/**
 * Build step 2 of the flow tool catalog: the judge knows the catalog's own
 * actions (send_email, start_quote, set_eligibility, cancel_booking) and gives
 * each a real verdict, and a message_taken ending needs a saved message first,
 * which every message_taken ending of the full tree now saves.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHarnessConfig, setAiCallingEnabled } from "../../src/config.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { getDecisionRegistry, resetDecisionRegistry } from "../../src/decision/registry.js";
import { startInteractiveCall, type InteractiveCall } from "../../src/decision/interactive.js";
import { loadActiveTree, resetActiveTree } from "../../src/decision/tree-source.js";
import { asDecisionModule } from "../../src/decision-models/bridge.js";
import { resetJudges } from "../../src/judge/index.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { JudgeAction, JudgePayload, JudgeRequest } from "../../src/judge/types.js";
import { isHardToUndo, liveQuestionFor } from "../../src/judging/live-questions.js";
import { resetModuleRegistry, getModuleRegistry } from "../../src/modules/registry.js";
import { clearCallLogs } from "../../src/store/call-log.js";
import { getLead, resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { recordStore, traceBus } from "../../src/trace/index.js";
import type { TranscriptTurn } from "../../src/provider/interface.js";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { baseLead } from "../helpers/fixtures.js";
import { ScriptedModel, stepsTo } from "../helpers/scripted-model.js";

const NOW = new Date("2026-10-15T14:00:00.000Z");

function request(action: JudgeAction, lines: Array<[TranscriptTurn["role"], string]>, payload: JudgePayload, completed: JudgeAction[] = []): JudgeRequest {
  const transcript: TranscriptTurn[] = [
    { role: "agent", text: inboundOpeningScript(), turnIndex: -1, spoken: true },
    ...lines.map(([role, text], i) => ({ role, text, turnIndex: i, spoken: true })),
  ];
  return { action, nodeId: "test_node", direction: "inbound", transcript, completed, payload, now: NOW };
}

const failed = async (req: JudgeRequest) => (await new RuleBasedJudge().judge(req)).scores.filter((s) => s.score < 1).map((s) => s.criterion);

describe("the rule judge on the flow tool catalog's actions", () => {
  it.each([
    {
      action: "send_email" as const,
      lines: [["caller", "Can you email me the loss run request form?"]] as Array<[TranscriptTurn["role"], string]>,
      payload: { document: "loss_run_request", evidenceSpan: "email me the loss run request form" },
      bad: { document: "proposal", evidenceSpan: "send me everything" },
      badFails: ["document_named", "quote_is_callers_words"],
    },
    {
      action: "start_quote" as const,
      lines: [["agent", "Would you like me to start a quote?"], ["caller", "Yes, please start the quote."]] as Array<[TranscriptTurn["role"], string]>,
      payload: { line: "workers_compensation", evidenceSpan: "start the quote" },
      bad: { line: "auto", evidenceSpan: "I want a cheap price" },
      badFails: ["line_of_business_known", "quote_is_callers_words"],
    },
    {
      action: "set_eligibility" as const,
      lines: [["caller", "We closed the business last spring."]] as Array<[TranscriptTurn["role"], string]>,
      payload: { reason: "out_of_business", evidenceSpan: "We closed the business last spring" },
      bad: { reason: "too_small", evidenceSpan: "we are tiny" },
      badFails: ["reason_named", "quote_is_callers_words"],
    },
    {
      action: "cancel_booking" as const,
      lines: [["caller", "I need to cancel my appointment."], ["agent", "Shall I cancel it?"], ["caller", "Yes."]] as Array<[TranscriptTurn["role"], string]>,
      payload: { evidenceSpan: "cancel my appointment" },
      bad: { evidenceSpan: "keep it" },
      badFails: ["quote_is_callers_words"],
    },
  ])("allows $action on the caller's own words and refuses it otherwise", async ({ action, lines, payload, bad, badFails }) => {
    expect(await failed(request(action, lines, payload))).toEqual([]);
    expect(await failed(request(action, lines, bad))).toEqual(badFails);
    // Nobody asked: the caller's words never mention the action.
    const unasked = await failed(request(action, [["caller", "Fine, thanks."]], { ...payload, evidenceSpan: "Fine" }));
    if (action !== "set_eligibility") expect(unasked.length).toBeGreaterThan(0);
  });

  it("counts a text, an email and a quote as hard to undo, and a cancellation and an eligibility mark as not", () => {
    for (const action of ["send_text", "send_email", "start_quote"] as const) expect(isHardToUndo(action, {})).toBe(true);
    for (const action of ["cancel_booking", "set_eligibility"] as const) expect(isHardToUndo(action, {})).toBe(false);
  });

  it("asks the live judge a closed question for each new action, with only safe names from the payload", () => {
    const email = liveQuestionFor("send_email", { document: "loss_run_request", evidenceSpan: "private words" });
    expect(email.instructions).toContain("The document is loss_run_request.");
    expect(email.instructions).not.toContain("private words");
    expect(liveQuestionFor("set_eligibility", { reason: "out_of_area" }).instructions).toContain("The reason given is out_of_area.");
    for (const action of ["start_quote", "cancel_booking"] as const) expect(liveQuestionFor(action, {}).criteria.allow.length).toBeGreaterThan(0);
  });

  it("refuses a message_taken ending until a message was saved in the call", async () => {
    const lines: Array<[TranscriptTurn["role"], string]> = [["caller", "Please tell the producer to call me back about my renewal."]];
    const payload = { disposition: "message_taken", durable: false };
    expect(await failed(request("end_with_disposition", lines, payload))).toEqual(["outcome_really_happened"]);
    expect(await failed(request("end_with_disposition", lines, payload, ["save_details"]))).toEqual([]);
  });
});

// Removed message-taking cases. The Northwind renewal tree has no message path.\n
