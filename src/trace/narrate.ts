/**
 * Plain-language sentences for an agency agent: one short sentence per
 * meaningful step. Allow-list only: a sentence is built from the lead's first
 * name, a fixed phrase for a known reason code, and (for a quote field) the
 * field's own name. Raw inputs, results, message bodies, phone numbers,
 * transcript text, field values and evidence spans never reach a sentence.
 */

import type { TraceEvent } from "./events.js";

const REASON_PHRASES: Record<string, string> = {
  lead_not_found: "no record of this lead was found",
  ai_calling_disabled: "AI calling is switched off for this agency",
  no_voice_module_enabled: "no voice module is switched on",
  no_phone: "there is no phone number on file",
  stop_list: "they are on the stop list",
  dnc_list: "they are on the do-not-call list",
  dnc_unchecked: "the do-not-call check has not been completed",
  suppression_list: "they are on the suppression list",
  consent_revoked: "they withdrew their consent",
  no_artificial_voice_consent: "they have not agreed to calls in an AI voice",
  sms_consent_missing: "they have not agreed to texts",
  unknown_time_zone: "their time zone is not known",
  scheduled_reason_missing: "there is no reason for a scheduled call",
  text_agreement_missing: "they have not agreed by text to a call",
  scheduled_time_missing: "no call time was agreed",
  invalid_scheduled_time: "the agreed call time is not valid",
  before_scheduled_time: "it is not yet the agreed call time",
  duplicate_idempotency_key: "this request was already handled",
  call_in_flight_for_lead: "another call with them is already in progress",
  reach_check_failed: "the agency's own contact rules could not be checked",
  inbound_disclosure_not_first: "the AI and recording disclosure did not come first",
  develop_writes_off: "saving to the external lead store is switched off",
  unanswered_attempt_limit_reached: "two calls already went unanswered, so no more are placed",
  attempt_out_of_order: "this attempt does not follow the earlier unanswered ones",
};

/** Turns a known reason code into a fixed phrase. Unknown codes get a generic phrase. */
export function reasonPhrase(reason: unknown): string {
  if (typeof reason !== "string") return "a safety check did not pass";
  const code = reason.split(":")[0] ?? "";
  if (REASON_PHRASES[code]) return REASON_PHRASES[code]!;
  if (/^outside_quiet_hours_local_\d+$/.test(code)) return "it is outside calling hours where they live";
  // The store's own reach rules produce their own codes; never repeat them.
  if (code.startsWith("reach_")) return "the agency's own contact rules say not to reach out right now";
  return "a safety check did not pass";
}

/** A field's own name in plain words; anything that is not a simple field name becomes "a detail". */
function fieldWords(field: unknown): string {
  return typeof field === "string" && /^[a-z][a-z_]{0,39}$/.test(field) ? field.replace(/_/g, " ") : "a detail";
}

const TOOL_WORDS: Record<string, string> = {
  read_lead_context: "looking up the record",
  save_message: "saving a message",
  book_producer: "booking a producer time",
  write_quote_field: "saving a quote detail",
  append_handoff_note: "filing the handoff note",
  record_stop: "recording the stop request",
  transfer_to_human: "passing the call to a person",
  record_disposition: "recording how the call ended",
  human_transfer_unavailable: "ringing a licensed producer",
  human_transfer_leg_failed: "ringing a licensed producer",
};

/** Whose cell a transfer rang (human-transfer.ts names them, never their numbers). */
const PERSON_NAMES: Record<string, string> = { pat: "Pat", dana: "Dana" };
const personName = (who: unknown) => PERSON_NAMES[String(who)] ?? "a producer";
const seconds = (ms: unknown) => (typeof ms === "number" ? Math.round(ms / 1000) : 0);
const TRANSFER_ENDINGS: Record<string, string> = { person_hung_up: "the producer hung up", caller_hung_up: "the caller hung up", bridge_cap: "it reached five minutes" };

const ACTION_WORDS: Record<string, string> = {
  transfer: "pass the call to a person",
  save_details: "save the details",
  save_quote_field: "save a quote detail",
  book: "book a time",
  send_text: "send a text",
  end_with_disposition: "end the call that way",
};

function strOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One short sentence for a meaningful step, or null when the step is only for the developer trace. */
export function narrate(event: TraceEvent): string | null {
  const name = event.leadLabel ?? "this lead";
  const d = event.data;
  switch (event.type) {
    case "compliance_check": {
      if (d.passed !== false) return null;
      const check = strOf(d.check);
      if (check === "evidence_supports_field") {
        return `Did not save ${fieldWords(d.field)} for ${name}: the caller's own words did not support it.`;
      }
      if (check === "handoff_claims_supported") {
        return `Did not file a handoff note for ${name}: it claimed things the caller did not say.`;
      }
      const why = reasonPhrase(d.reason);
      if (event.channel === "sms") return `Did not text ${name}: ${why}.`;
      if (event.direction === "inbound") return `Passed ${name}'s call to normal answering: ${why}.`;
      return `Did not call ${name}: ${why}.`;
    }
    case "tool_call": {
      const tool = strOf(d.tool) ?? "";
      if (d.success === false) {
        if (tool === "start_outbound_call" || tool === "start_inbound_call") {
          return `Could not start the call with ${name}: the voice service would not connect.`;
        }
        if (tool === "human_transfer_no_answer") return `No one took ${name}'s call after ${seconds(d.durationMs)} seconds of ringing, so the agent has it back.`;
        if (tool === "human_transfer_cancelled") return `Stopped ringing a producer: ${name}'s call ended first.`;
        return `A step failed for ${name} while ${TOOL_WORDS[tool] ?? "working"}.`;
      }
      switch (tool) {
        case "read_lead_context":
          return `Looked up ${name}'s record.`;
        case "save_message":
          return `Saved a message from ${name} for the team.`;
        case "book_producer":
          return `Booked a producer time for ${name}.`;
        case "transfer_to_human":
          return `Passed ${name}'s call to a person.`;
        case "human_transfer_ringing": {
          const people = (d.inputs as { people?: unknown } | null)?.people;
          return `Ringing ${Array.isArray(people) ? people.map(personName).join(" and ") : "a producer"} to take ${name}'s call.`;
        }
        case "human_transfer_answered":
          return `${personName((d.inputs as { who?: unknown } | null)?.who)} took ${name}'s call after ${seconds(d.durationMs)} seconds.`;
        case "human_transfer_bridge_ended": {
          const inputs = d.inputs as { who?: unknown; endedBy?: unknown } | null;
          return `${name}'s call with ${personName(inputs?.who)} ended after ${seconds(d.durationMs)} seconds: ${TRANSFER_ENDINGS[String(inputs?.endedBy)] ?? "the call ended"}.`;
        }
        case "record_stop":
          return `Recorded ${name}'s stop request, so no one will contact them again.`;
        case "write_quote_field":
          return d.result === true
            ? `Recorded ${fieldWords((d.inputs as Record<string, unknown> | null)?.field)} from what ${name} said.`
            : `Did not save ${fieldWords((d.inputs as Record<string, unknown> | null)?.field)} for ${name}: the record store would not accept it.`;
        case "reply_timing":
        case "voice_live_reply_timing": {
          const ms = (d.inputs as Record<string, unknown> | null)?.callerFinalToFirstAudioMs;
          return typeof ms === "number" ? `The agent started answering ${name} ${(ms / 1000).toFixed(1)} seconds after they stopped speaking.` : `The agent started answering ${name}.`;
        }
        case "objective_check": {
          const rows = (d.inputs as { objectives?: Array<{ status?: unknown }> } | null)?.objectives;
          const done = Array.isArray(rows) ? rows.filter((r) => r.status === "done").length : 0;
          const total = Array.isArray(rows) ? rows.length : 0;
          return total ? `Checked the call's objectives in the background: ${done} of ${total} done so far.` : "Checked the call's objectives in the background.";
        }
        default:
          return null;
      }
    }
    case "judge_verdict":
      return d.allowed === false ? `Held back from trying to ${ACTION_WORDS[strOf(d.action) ?? ""] ?? "take that step"} for ${name}: the safety review said no.` : null;
    case "disposition":
      return `Ended ${name}'s call as: ${fieldWords(d.value) === "a detail" ? "done" : fieldWords(d.value)}.`;
    case "handoff":
      return d.filed === true ? `Filed a handoff note for ${name} so the team can pick up.` : null;
    case "text":
      if (d.status === "recorded") return `Recorded a text for ${name}; no sender is connected, so nothing was sent.`;
      if (d.status === "received" && d.stop === true && d.reason === null) return `${name} texted a request to stop.`;
      if (d.status === "failed") return `Handling ${name}'s text stopped because of an error.`;
      return null;
    case "call_outcome": {
      switch (d.status) {
        case "placed":
          return `Called ${name}; the call has ended.`;
        case "ai_handled":
          return `Answered ${name}'s call with the assistant.`;
        case "failed":
          return `The call with ${name} stopped because of an error.`;
        case "abandoned":
          return `The call with ${name} ended because nobody spoke for too long.`;
        case "not_answered":
          return `Called ${name}; ${d.dialOutcome === "voicemail" ? "it went to voicemail" : "no one answered"}. Hung up without leaving a message.`;
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
