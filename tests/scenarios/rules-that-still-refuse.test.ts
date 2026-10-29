import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { FULL_TREE_FILE } from "../../src/decision/tree-source.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import type { JudgeAction, JudgePayload, JudgeRequest } from "../../src/judge/types.js";
import type { TranscriptTurn } from "../../src/provider/interface.js";

// One case per code rule that still refuses outright (see "Rules that still refuse" in docs/decision-tree-and-judge.md).

const NOW = new Date("2026-10-15T14:00:00.000Z");
const turn = (role: "agent" | "caller", text: string, turnIndex: number): TranscriptTurn => ({ role, text, turnIndex, spoken: true });
const open = turn("agent", inboundOpeningScript(), -1);

function request(action: JudgeAction, transcript: TranscriptTurn[], payload: JudgePayload, completed: JudgeAction[] = []): JudgeRequest {
  return { action, nodeId: "n", direction: "inbound", transcript, completed, payload, now: NOW };
}

/** The names of the score lines that failed. */
async function failedRules(req: JudgeRequest): Promise<string[]> {
  const verdict = await new RuleBasedJudge().judge(req);
  return verdict.scores.filter((s) => s.score < 1).map((s) => s.criterion);
}

const slot = { slotIso: "2026-10-16T19:00:00.000Z", slotWords: "tomorrow at 3 PM" };
const bookTurns = (last: string) => [open, turn("caller", "I want tomorrow at 3 pm", 0), turn("agent", "So that is tomorrow at 3 PM. Shall I book it? Please say yes to confirm.", 1), turn("caller", last, 2)];

describe("rules that still refuse, whatever the decision model says", () => {
  it("every action: the disclosure first, the caller has spoken, no stop request earlier", async () => {
    const p = { reason: "caller_requested" };
    expect(await failedRules(request("transfer", [turn("agent", "Hello there", -1), turn("caller", "a person please", 0)], p))).toEqual(["disclosure_first"]);
    expect(await failedRules(request("transfer", [open], p))).toContain("caller_spoke");
    expect(await failedRules(request("transfer", [open, turn("caller", "please stop calling me", 0), turn("caller", "a person please", 1)], p))).toEqual(["no_stop_request"]);
  });

  it("transfer: a bare yes without a transfer offer is refused, a request for a person passes; repeated_unclear needs the clarifying questions used up", async () => {
    expect(await failedRules(request("transfer", [open, turn("caller", "yes", 0)], { reason: "caller_requested" }))).toEqual(["caller_asked_for_person"]);
    expect(await failedRules(request("transfer", [open, turn("caller", "yes, put me through to a person", 0)], { reason: "caller_requested" }))).toEqual([]);
    expect(await failedRules(request("transfer", [open, turn("caller", "hm", 0)], { reason: "repeated_unclear", clarifyCount: 1, maxClarifications: 2 }))).toEqual(["repeated_unclear_established"]);
    expect(await failedRules(request("transfer", [open, turn("caller", "hm", 0)], { reason: "repeated_unclear", clarifyCount: 2, maxClarifications: 2 }))).toEqual([]);
  });

  it("transfer: a plain yes after the explicit transfer offer passes; a negated reply does not", async () => {
    const offer = turn("agent", "I can try to connect you with a licensed producer now. Would you like that? This call stays recorded.", 0);
    for (const reply of ["yes", "yeah", "sure", "okay", "please"]) {
      expect(await failedRules(request("transfer", [open, offer, turn("caller", reply, 1)], { reason: "caller_requested" }))).toEqual([]);
    }
    for (const reply of ["no", "not now", "don't", "yes, wait"]) {
      expect(await failedRules(request("transfer", [open, offer, turn("caller", reply, 1)], { reason: "caller_requested" }))).toEqual(["caller_asked_for_person"]);
    }
  });

  it("book: natural agreement passes the yes rule; negations still refuse", async () => {
    for (const reply of ["perfect", "let's do it", "sounds great", "great", "that's fine", "of course"]) {
      expect(await failedRules(request("book", bookTurns(reply), slot))).toEqual([]);
    }
    for (const reply of ["no", "not now", "don't", "perfect, wait"]) {
      expect(await failedRules(request("book", bookTurns(reply), slot))).toEqual(["explicit_yes"]);
    }
  });

  it("book: each of the four rules refuses on its own", async () => {
    expect(await failedRules(request("book", bookTurns("yes"), slot))).toEqual([]);
    expect(await failedRules(request("book", bookTurns("yes"), { ...slot, slotIso: "2026-10-01T19:00:00.000Z" }))).toEqual(["slot_is_a_future_time"]);
    expect(await failedRules(request("book", [open, turn("caller", "hello", 0), turn("agent", "So that is tomorrow at 3 PM. Shall I book it?", 1), turn("caller", "yes", 2)], slot))).toEqual(["time_named_by_caller"]);
    expect(await failedRules(request("book", [...bookTurns("yes").slice(0, 2), turn("agent", "Could you say that again?", 2), turn("caller", "yes", 3)], slot))).toEqual(["slot_confirmed_aloud"]);
    for (const reply of ["maybe", "yes, not sure", "no problem, yes"]) {
      expect(await failedRules(request("book", bookTurns(reply), slot))).toEqual(["explicit_yes"]);
    }
  });

  it("end_with_disposition: lasting endings need the caller's explicit words", async () => {
    const ending = (disposition: string, last: string) => request("end_with_disposition", [open, turn("caller", last, 0)], { disposition, durable: true });
    expect(await failedRules(ending("not_interested", "I already told you no"))).toEqual(["durable_needs_explicit_caller_words"]);
    expect(await failedRules(ending("not_interested", "no thanks"))).toEqual([]);
    expect(await failedRules(ending("do_not_contact", "yes that is right"))).toEqual(["durable_needs_explicit_caller_words"]);
  });

  it("end_with_disposition: wrong_number and declined_ai_or_recording can end the call; a stop request still refuses them", async () => {
    const ending = (disposition: string, ...lines: string[]) => request("end_with_disposition", [open, ...lines.map((l, i) => turn("caller", l, i))], { disposition, durable: true });
    expect(await failedRules(ending("wrong_number", "you have the wrong number"))).toEqual([]);
    expect(await failedRules(ending("declined_ai_or_recording", "I will not talk to a robot, goodbye"))).toEqual([]);
    expect(await failedRules(ending("wrong_number", "stop calling me", "wrong number"))).toEqual(["no_stop_request"]);
    expect(await failedRules(ending("declined_ai_or_recording", "please do not call me again", "no robots"))).toEqual(["no_stop_request"]);
  });

  it("end_with_disposition: an ending that names an outcome needs it to have happened", async () => {
    const ending = (disposition: string, completed: JudgeAction[]) => request("end_with_disposition", [open, turn("caller", "ok", 0)], { disposition, durable: false }, completed);
    expect(await failedRules(ending("booked", []))).toEqual(["outcome_really_happened"]);
    expect(await failedRules(ending("booked", ["book"]))).toEqual([]);
    expect(await failedRules(ending("handed_off", []))).toEqual(["outcome_really_happened"]);
    expect(await failedRules(ending("handed_off", ["transfer"]))).toEqual([]);
    expect(await failedRules(ending("message_left", []))).toEqual(["outcome_really_happened"]);
    expect(await failedRules(ending("quote_started", []))).toEqual(["outcome_really_happened"]);
    // message_taken needs a saved message (flow tool catalog build step 2); names not in the rule's table are never checked.
    expect(await failedRules(ending("message_taken", []))).toEqual(["outcome_really_happened"]);
    expect(await failedRules(ending("message_taken", ["save_details"]))).toEqual([]);
    expect(await failedRules(ending("callback", []))).toEqual([]);
  });

  it("save_details, save_quote_field and send_text refuse on their own rules", async () => {
    expect(await failedRules(request("save_details", [open, turn("caller", "call me back", 0)], { body: "" }))).toEqual(["details_present", "details_are_callers_words"]);
    expect(await failedRules(request("save_details", [open, turn("caller", "call me back", 0)], { body: "ring me later" }))).toEqual(["details_are_callers_words"]);
    expect(await failedRules(request("save_quote_field", [open, turn("caller", "old car", 0)], { field: "Vehicle Year", value: "2019", evidenceSpan: "2019" }))).toEqual(["field_name_valid", "value_from_callers_words"]);
    expect(await failedRules(request("send_text", [open, turn("caller", "yes", 0)], { body: "hi" }))).toEqual(["text_offered_aloud"]);
    expect(await failedRules(request("send_text", [open, turn("agent", "Can I text you?", 0), turn("caller", "maybe", 1)], { body: "hi" }))).toEqual(["explicit_yes"]);
    expect(await failedRules(request("send_text", [open, turn("agent", "Can I text you?", 0), turn("caller", "yes", 1)], { body: "x".repeat(321) }))).toEqual(["body_acceptable"]);
  });
});

describe("what the full tree can ask the judge for", () => {
  const tree = JSON.parse(readFileSync(FULL_TREE_FILE, "utf8")) as {
    dispositions: Array<{ name: string; durable: boolean }>;
    nodes: Array<{ id: string; decision?: { answers: Array<{ action?: { type: string; reason?: string }; disposition?: string }> } }>;
  };

  it("lists the actions and durable endings used by the Northwind renewal tree", () => {
    const actions = new Set<string>();
    const dispositions = new Set<string>();
    for (const node of tree.nodes) {
      for (const a of node.decision?.answers ?? []) {
        if (a.action) actions.add(`${a.action.type}${a.action.reason ? `:${a.action.reason}` : ""}`);
        if (a.disposition) dispositions.add(a.disposition);
      }
    }
    expect([...actions].sort()).toEqual(["book", "save_quote_field"]);
    expect(tree.dispositions.filter((d) => d.durable).map((d) => d.name).sort()).toEqual(["do_not_contact", "not_interested"]);
    expect([...dispositions].sort()).toEqual(["booked", "completed", "do_not_contact", "not_interested"]);
  });
});
