/**
 * The local judge: plain rules checked against the transcript. It never calls
 * a model and never reads anything but the request. Every check yields one
 * score line, so a verdict shows exactly which rule held or failed.
 */

import { findInboundDisclosure, outboundDisclosureFirst } from "../compliance/disclosures.js";
import { detectStopRequest } from "../compliance/stop.js";
import { containsAsWords, evidenceSupportsValue } from "../memory/evidence.js";
import { getHarnessConfig } from "../config.js";
import type { TranscriptTurn } from "../provider/interface.js";
import { hasTimeExpression } from "../decision/extract.js";
import type { Judge, JudgeAction, JudgeRequest, JudgeScoreLine, JudgeVerdict } from "./types.js";

const FIELD_NAME = /^[a-z][a-z_]{0,39}$/;

const AFFIRMATIVE = [
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "correct", "absolutely", "please do", "go ahead", "that works", "sounds good",
  "perfect", "great", "sounds great", "sounds perfect", "lets do it", "lets go", "book it", "do it", "thats fine", "thats right",
  "works for me", "definitely", "of course", "fine by me", "i would like that", "id like that",
];
const NEGATIVE = ["no", "nope", "not", "dont", "do not", "never", "cant", "wont", "wait", "hold on"];

/** A plain yes to the explicit transfer offer: the booking list, plus a bare "please". */
const TRANSFER_YES = [...AFFIRMATIVE, "please"];

/** The agent's last line offers to connect the caller to a person. */
const TRANSFER_OFFER = /\b(connect you|put you through|transfer you|hand you|bring (him|her|them) on)\b/i;

/** Lasting endings whose caller words the decision model judges, not a phrase list. */
const MODEL_JUDGED_DURABLE = new Set(["wrong_number", "declined_ai_or_recording"]);

/** Words a caller uses to ask for a person. */
const ASKS_FOR_PERSON = ["human", "real person", "a person", "someone", "representative", "operator", "manager", "producer", "speak to", "talk to"];

/** Explicit ways to say no to the offer itself. */
const NOT_INTERESTED = ["not interested", "no thanks", "no thank you", "dont want", "do not want", "not looking", "no longer interested"];

/** What each non-durable ending needs to have really happened first. */
const REQUIRED_BEFORE_DISPOSITION: Record<string, JudgeAction> = {
  booked: "book",
  message_left: "save_details",
  handed_off: "transfer",
  quote_started: "save_quote_field",
  message_taken: "save_details",
};

/** The documents email_document may send (src/flow-tools/catalog.json). */
const EMAIL_DOCUMENTS = new Set(["loss_run_request", "no_known_loss_statement"]);
/** The reasons mark_not_eligible may record (src/flow-tools/catalog.json). */
const ELIGIBILITY_REASONS = new Set(["licence", "out_of_business", "out_of_area", "own_carrier", "all_markets_declined", "other"]);

function squash(text: string): string {
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function spoken(transcript: TranscriptTurn[], role: "caller" | "agent"): TranscriptTurn[] {
  return transcript.filter((t) => t.role === role && t.spoken !== false);
}

function mentionsAny(text: string, phrases: string[]): boolean {
  const s = squash(text);
  return phrases.some((p) => containsAsWords(s, squash(p)));
}

/** A clear yes: some affirmative word and no negative word in the caller's latest line. */
export function isExplicitYes(text: string): boolean {
  return mentionsAny(text, AFFIRMATIVE) && !mentionsAny(text, NEGATIVE);
}

function line(criterion: string, pass: boolean, passNote: string, failNote: string): JudgeScoreLine {
  return { criterion, score: pass ? 1 : 0, note: pass ? passNote : failNote };
}

/**
 * The tree's escalation after its clarifying lines are used up: a transfer, or
 * a node's own ending in place of one. The post-call judge reads this line in
 * the verdict to tell the designed escalation from an action on an unsure answer.
 */
function repeatedUnclear(req: JudgeRequest): JudgeScoreLine {
  const { clarifyCount = 0, maxClarifications = 2 } = req.payload;
  return line(
    "repeated_unclear_established",
    clarifyCount >= maxClarifications,
    "the agent has asked for clarification enough times",
    "a person is not needed yet: the agent has not exhausted its clarifying questions",
  );
}

export class RuleBasedJudge implements Judge {
  readonly id = "rule-based-local";

  async judge(req: JudgeRequest): Promise<JudgeVerdict> {
    const scores = [...this.commonChecks(req), ...this.actionChecks(req)];
    const failed = scores.filter((s) => s.score < 1);
    return {
      allowed: failed.length === 0,
      reason: failed.length === 0 ? "every check passed" : failed.map((f) => f.note).join("; "),
      scores,
    };
  }

  private commonChecks(req: JudgeRequest): JudgeScoreLine[] {
    // The opening agent lines, heard or not: a cut-off disclosure fails here even if a later line names the assistant.
    // Inbound, every part of this call's disclosure must be said whole and in order before any other agent line
    // (rule at `findInboundDisclosure`); outbound, the first agent line opens with it. A paraphrase fails.
    const inbound = req.direction === "inbound" ? findInboundDisclosure(req.transcript, req.expectedDisclosure) : null;
    const first = req.transcript.find((t) => t.role === "agent");
    const disclosed =
      req.direction === "inbound"
        ? inbound !== null && inbound.parts.every((p) => p.spoken !== false)
        : first !== undefined && first.spoken !== false && outboundDisclosureFirst(first.text, req.expectedDisclosure);
    const callerTurns = spoken(req.transcript, "caller");
    const stopAsked = callerTurns.some((t) => detectStopRequest(t.text));
    const endsWithStop = req.action === "end_with_disposition" && req.payload.disposition === "do_not_contact";
    // With the compliance checks switched off (VOICE_HARNESS_COMPLIANCE_CHECKS=off, local Talk only), the disclosure check never blocks.
    const checksOff = getHarnessConfig().complianceChecksOff === true;
    return [
      // A missing or cut-off disclosure never stands in the way of honoring a stop.
      line(
        "disclosure_first",
        disclosed || endsWithStop || checksOff,
        disclosed ? "the AI disclosure came first" : checksOff ? "not checked: compliance checks are off" : "a stop is honored even without the AI disclosure",
        "the AI disclosure did not come first",
      ),
      line("caller_spoke", callerTurns.length > 0, "the caller has spoken", "the caller has not said anything yet"),
      line(
        "no_stop_request",
        endsWithStop || !stopAsked,
        "the caller has not asked to stop",
        "the caller asked to stop being contacted",
      ),
    ];
  }

  private actionChecks(req: JudgeRequest): JudgeScoreLine[] {
    switch (req.action) {
      case "transfer":
        return this.transfer(req);
      case "save_details":
        return this.saveDetails(req);
      case "save_quote_field":
        return this.saveQuoteField(req);
      case "book":
        return this.book(req);
      case "send_text":
        return this.sendText(req);
      case "end_with_disposition":
        return this.endWithDisposition(req);
      case "send_email":
        return this.sendEmail(req);
      case "start_quote":
        return this.startQuote(req);
      case "set_eligibility":
        return this.setEligibility(req);
      case "cancel_booking":
        return this.cancelBooking(req);
    }
  }

  /** The catalog tools' evidence quote must sit inside something the caller said. */
  private quoteFromCaller(req: JudgeRequest): JudgeScoreLine {
    const quote = squash(req.payload.evidenceSpan ?? "");
    const fromCaller = quote.length > 0 && spoken(req.transcript, "caller").some((t) => squash(t.text).includes(quote));
    return line("quote_is_callers_words", fromCaller, "the quote is the caller's own words", "the quote is not the caller's own words");
  }

  private sendEmail(req: JudgeRequest): JudgeScoreLine[] {
    const callerTurns = spoken(req.transcript, "caller");
    const lastAgent = spoken(req.transcript, "agent").at(-1)?.text ?? "";
    const asked = callerTurns.some((t) => mentionsAny(t.text, ["email", "e mail", "send me", "send it"]));
    const agreed = /\bemail\b/i.test(lastAgent) && isExplicitYes(callerTurns.at(-1)?.text ?? "");
    return [
      line("document_named", EMAIL_DOCUMENTS.has(req.payload.document ?? ""), "the document is one the agency emails", "the document is not one the agency emails"),
      this.quoteFromCaller(req),
      line("caller_asked_or_agreed", asked || agreed, "the caller asked for the email or agreed to it", "the caller neither asked for nor agreed to an email"),
    ];
  }

  private startQuote(req: JudgeRequest): JudgeScoreLine[] {
    const callerTurns = spoken(req.transcript, "caller");
    const lastAgent = spoken(req.transcript, "agent").at(-1)?.text ?? "";
    const asked = callerTurns.some((t) => mentionsAny(t.text, ["quote", "price", "rate"]));
    const agreed = /\bquote\b/i.test(lastAgent) && isExplicitYes(callerTurns.at(-1)?.text ?? "");
    return [
      line("line_of_business_known", req.payload.line === "workers_compensation", "the line of business is one the agency quotes", "the line of business is not one the agency quotes"),
      this.quoteFromCaller(req),
      line("caller_wants_a_quote", asked || agreed, "the caller asked for a quote or agreed to one", "the caller neither asked for nor agreed to a quote"),
    ];
  }

  private setEligibility(req: JudgeRequest): JudgeScoreLine[] {
    return [
      line("reason_named", ELIGIBILITY_REASONS.has(req.payload.reason ?? ""), "the reason is one the agency records", "the reason is not one the agency records"),
      this.quoteFromCaller(req),
    ];
  }

  private cancelBooking(req: JudgeRequest): JudgeScoreLine[] {
    const callerTurns = spoken(req.transcript, "caller");
    return [
      this.quoteFromCaller(req),
      line("caller_asked_to_cancel", callerTurns.some((t) => mentionsAny(t.text, ["cancel", "call off", "not going to make it", "cant make it"])), "the caller asked to cancel", "the caller did not ask to cancel"),
      line("explicit_yes", isExplicitYes(callerTurns.at(-1)?.text ?? ""), "the caller confirmed the cancellation", "the caller did not clearly confirm the cancellation"),
    ];
  }

  private transfer(req: JudgeRequest): JudgeScoreLine[] {
    const last = spoken(req.transcript, "caller").at(-1)?.text ?? "";
    const { reason } = req.payload;
    if (reason === "repeated_unclear") return [repeatedUnclear(req)];
    const lastAgent = spoken(req.transcript, "agent").at(-1)?.text ?? "";
    const yesToOffer = TRANSFER_OFFER.test(lastAgent) && mentionsAny(last, TRANSFER_YES) && !mentionsAny(last, NEGATIVE);
    return [
      line(
        "caller_asked_for_person",
        reason === "caller_requested" && (mentionsAny(last, ASKS_FOR_PERSON) || yesToOffer),
        "the caller asked for a person",
        "the caller did not ask for a person",
      ),
    ];
  }

  private saveDetails(req: JudgeRequest): JudgeScoreLine[] {
    const body = (req.payload.body ?? "").trim();
    const callerTurns = spoken(req.transcript, "caller").map((t) => squash(t.text));
    const fromCaller = body.length > 0 && callerTurns.some((t) => t.includes(squash(body)));
    return [
      line("details_present", body.length > 0 && body.length <= 1000, "there is something to save", "nothing, or too much, to save"),
      line("details_are_callers_words", fromCaller, "the details are the caller's own words", "the details are not the caller's own words"),
    ];
  }

  private saveQuoteField(req: JudgeRequest): JudgeScoreLine[] {
    const { field = "", value = "", evidenceSpan = "" } = req.payload;
    const callerTexts = spoken(req.transcript, "caller").map((t) => t.text);
    return [
      line("field_name_valid", FIELD_NAME.test(field), "the field name is valid", "the field name is not valid"),
      line(
        "value_from_callers_words",
        evidenceSupportsValue(value, evidenceSpan, callerTexts, field),
        "the value is inside words the caller said",
        "the value does not come from the caller's words",
      ),
    ];
  }

  private book(req: JudgeRequest): JudgeScoreLine[] {
    const { slotIso = "", slotWords = "" } = req.payload;
    const slot = Date.parse(slotIso);
    const callerTurns = spoken(req.transcript, "caller");
    const lastCaller = callerTurns.at(-1)?.text ?? "";
    const lastAgent = spoken(req.transcript, "agent").at(-1)?.text ?? "";
    return [
      line("slot_is_a_future_time", Number.isFinite(slot) && slot > req.now.getTime(), "the slot is a valid future time", "the slot is not a valid future time"),
      line(
        "time_named_by_caller",
        callerTurns.some((t) => hasTimeExpression(t.text)),
        "the caller named a time",
        "the caller never named a time",
      ),
      line(
        "slot_confirmed_aloud",
        slotWords.length > 0 && lastAgent.toLowerCase().includes(slotWords.toLowerCase()),
        "the agent read the slot back to the caller",
        "the agent did not read the slot back before booking",
      ),
      line("explicit_yes", isExplicitYes(lastCaller), "the caller said yes", "the caller did not clearly say yes"),
    ];
  }

  private sendText(req: JudgeRequest): JudgeScoreLine[] {
    const body = (req.payload.body ?? "").trim();
    const lastCaller = spoken(req.transcript, "caller").at(-1)?.text ?? "";
    const lastAgent = spoken(req.transcript, "agent").at(-1)?.text ?? "";
    return [
      line("text_offered_aloud", /\btext\b/i.test(lastAgent), "the agent offered a text", "no text was offered to the caller"),
      line("explicit_yes", isExplicitYes(lastCaller), "the caller said yes to the text", "the caller did not clearly say yes to a text"),
      line("body_acceptable", body.length > 0 && body.length <= 320, "the text is a reasonable length", "the text is empty or too long"),
    ];
  }

  private endWithDisposition(req: JudgeRequest): JudgeScoreLine[] {
    const { disposition = "", durable = false } = req.payload;
    const lastCaller = spoken(req.transcript, "caller").at(-1)?.text ?? "";
    const checks: JudgeScoreLine[] = [
      line("disposition_named", disposition.length > 0, "a disposition is named", "no disposition is named"),
    ];
    if (durable && !MODEL_JUDGED_DURABLE.has(disposition)) {
      const explicit =
        disposition === "do_not_contact" ? detectStopRequest(lastCaller) !== null : mentionsAny(lastCaller, NOT_INTERESTED);
      checks.push(
        line(
          "durable_needs_explicit_caller_words",
          explicit,
          "the caller said so in clear words",
          "a lasting ending needs the caller's explicit words, and they were not there",
        ),
      );
    }
    if (req.payload.reason === "repeated_unclear") checks.push(repeatedUnclear(req));
    const needed = REQUIRED_BEFORE_DISPOSITION[disposition];
    if (needed) {
      checks.push(
        line(
          "outcome_really_happened",
          req.completed.includes(needed),
          "the outcome this ending claims did happen",
          "this ending claims an outcome that did not happen",
        ),
      );
    }
    return checks;
  }
}
