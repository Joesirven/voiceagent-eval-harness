/**
 * Plain words for the tree: what a salesperson should read instead of node
 * ids, answer names and disposition names. Everything falls back to a readable
 * form of the real name, so a new node never shows as a blank.
 */

/** The tree's areas, in the order a call usually meets them. The key is the id prefix (`open.greeting` sits in `open`). */
export const AREA_ORDER = ["entry", "open", "discovery", "objection", "service", "close", "compliance"] as const;
export type AreaKey = (typeof AREA_ORDER)[number];

export const AREA_WORDS: Record<AreaKey, string> = {
  entry: "Open the call",
  open: "Open the call",
  discovery: "Learn about them",
  objection: "Handle pushback",
  service: "Help a client",
  close: "Book or hand off",
  compliance: "Safety and rules",
};

export function areaOf(nodeId: string): AreaKey {
  const prefix = nodeId.split(".")[0] as AreaKey;
  return (AREA_ORDER as readonly string[]).includes(prefix) ? prefix : "open";
}

/** Plain names for nodes. Missing identifiers fall back to `labelWords`. */
const NODE_WORDS: Record<string, string> = {
  "entry.outbound": "Check you have the right person",
  "open.greeting": "Say hello and ask why they called",
  "open.clarify_first_reply": "Work out what they meant",
  "open.silence_or_noise": "Nobody is talking",
  "open.language_switch": "They want another language",
  "open.ai_question": "They ask if you are a robot",
  "open.recording_objection": "They don't want to be recorded",
  "open.why_we_called": "Explain why we called",
  "open.identity_gate": "Get their name and business",
  "open.state_purpose": "Say why you are calling",
  "open.busy_now": "They are busy right now",
  "open.existing_client": "They are already a client",
  "open.asks_for_person": "They ask for a person",
  "open.gatekeeper": "Someone else answered",
  "open.wrong_number": "Wrong number",
  "open.automated_caller": "A machine is calling",
  "open.message_fallback": "Take a message instead",
  "open.new_caller": "A new person is calling",
  "open.greet_new_person_on_line": "A new person joins the call",
  "discovery.start": "Start the questions",
  "discovery.who_handles_insurance": "Find out who handles insurance",
  "discovery.reach_decision_maker": "Reach the decision maker",
  "discovery.confirm_xdate": "Confirm the renewal date",
  "discovery.confirm_carrier": "Confirm their current carrier",
  "discovery.renewed_recently": "They renewed recently",
  "discovery.no_active_policy": "They have no policy now",
  "discovery.business_class": "What kind of work they do",
  "discovery.headcount": "How many people work there",
  "discovery.owner_only": "Only the owner works there",
  "discovery.workers_not_on_a_policy": "Some workers are not covered",
  "discovery.payroll": "Ask about payroll",
  "discovery.general_liability": "Ask about general liability cover",
  "discovery.certificates": "Ask about certificates of insurance",
  "discovery.commercial_auto": "Ask about work vehicles",
  "discovery.choose_next_question": "Pick the next question",
  "discovery.check_caller_pace": "Check they are keeping up",
  "discovery.does_not_know_value": "They don't know the answer",
  "discovery.declines_to_say": "They would rather not say",
  "discovery.handle_correction": "They correct something",
  "discovery.caller_asks_for_price_or_advice": "They ask for a price or advice",
  "discovery.review_before_save": "Read back what you heard",
  "objection.classify": "Sort out the pushback",
  "objection.busy": "“I'm busy”",
  "objection.not_interested": "“Not interested”",
  "objection.happy_current": "“I'm happy with who I have”",
  "objection.broker_or_payroll_company": "“My broker or payroll company does it”",
  "objection.send_by_email": "“Just email me”",
  "objection.price_only": "“Only the price matters”",
  "objection.spouse_decides": "“Someone else decides”",
  "objection.already_renewed": "“I already renewed”",
  "objection.how_got_number": "“How did you get my number?”",
  "objection.too_expensive": "“It costs too much”",
  "objection.bad_experience": "“I had a bad experience”",
  "objection.confirm_stop": "Check: do they want us to stop?",
  "service.identify_need": "Find out what they need help with",
  "service.cancellation": "They want to cancel",
  "service.rate_increase": "Their price went up",
  "service.claim_or_loss": "They have a claim",
  "service.certificate_request": "They need a certificate",
  "service.policy_change": "They want to change their policy",
  "service.billing_or_payment": "A billing or payment question",
  "service.notice_received": "They got a notice",
  "service.coverage_question": "A coverage question",
  "service.capture_callback": "Note a callback for the team",
  "service.confirm_and_close": "Confirm and wrap up",
  "service.producer_offer": "Offer a talk with a producer",
  "close.pre_ask_check": "Check they are ready for a booking",
  "close.authority_check": "Check they can decide",
  "close.ask_for_appointment": "Ask for the appointment",
  "close.offer_times": "Offer two times",
  "close.confirm_booking": "Read back the time and book it",
  "close.after_booking_prep": "Tell them what to have ready",
  "close.offer_live_transfer": "Offer to connect them to a person",
  "close.callback_schedule": "Agree a time to call back",
  "close.confirm_callback_time": "Confirm the callback time",
  "close.take_message": "Take a message",
  "close.confirm_message": "Read the message back",
  "close.write_handoff_note": "Write a note for the producer",
  "close.wrap_up": "Say goodbye",
  "close.final_disposition": "Record how the call ended",
  "close.caller_dropped": "They dropped off",
  "close.clarify_intent": "Check what they want",
  "close.reschedule_booking": "Move the appointment",
  "compliance.stop_clarify": "Make sure they want us to stop",
  "compliance.stop_apply": "Stop and take them off the list",
  "compliance.recording_objection": "They refuse to be recorded",
  "compliance.upset_deescalate": "They are upset: calm things down",
  "compliance.legal_threat": "They mention a lawyer or complaint",
  "compliance.emergency_safety": "Someone may be in danger",
  "compliance.advice_redirect": "They ask for advice we can't give",
  "compliance.possible_minor": "You may be talking to a child",
  "compliance.human_request": "They ask for a person",
};

/** Turns a tree label such as "Confirm xdate (further answers 2)" into readable words. */
export function labelWords(label: string): string {
  return label
    .replace(/\s*\(further answers \d+\)/i, ", more answers")
    .replace(/\bxdate\b/i, "renewal date")
    .replace(/\bai\b/i, "machine");
}

export function nodeWords(nodeId: string, label?: string): string {
  const base = nodeId.replace(/_more\d+$/, "");
  const known = NODE_WORDS[base];
  if (known) return /_more\d+$/.test(nodeId) ? `${known}, more answers` : known;
  return label ? labelWords(label) : nodeId.split(".").slice(1).join(" ").replace(/_/g, " ");
}

/** Plain words for answers. Missing names fall back to the name with spaces. */
const ANSWER_WORDS: Record<string, string> = {
  returning_missed_calls: "They are calling us back",
  new_inquiry_wants_quote_or_review: "They want a quote or a review",
  existing_client_service_request: "They are a client who needs something",
  asks_why_we_called_or_who_this_is: "They ask why we called",
  asks_for_a_person_or_the_owner: "They want a person",
  owner_or_decision_maker: "They own or run the business",
  insurance_handler_staff: "They handle the insurance for the owner",
  can_talk_now: "They can talk now",
  busy_now_or_driving_or_on_a_job: "They are busy right now",
  says_they_already_have_coverage_or_a_broker: "They already have coverage",
  says_not_interested: "They say not interested",
  gives_a_date_where_none_was_on_file: "They gave the renewal date",
  confirms_the_date_as_read_back: "They confirmed the date",
  gives_the_month_only: "They gave the month",
  kind_of_work: "Next: what work they do",
  employee_count: "Next: how many people",
  payroll: "Next: payroll",
  ordinary_contractor_work_described: "Ordinary contractor work",
  engaged_and_answering_easily: "They are engaged, keep going",
  answers_getting_shorter_or_hesitant: "They are getting short, wrap up the questions",
  gives_an_employee_number_and_all_are_on_a_policy_or_not_mentioned: "They gave a headcount",
  every_candidate_is_in_the_callers_own_words: "Everything matches their words",
  agrees: "They agree",
  accepts_time: "They picked a time",
  yes: "A clear yes",
  text_ok_to_this_number: "A text is fine",
  all_supported: "The note matches the call",
  all_set: "They are all set",
  appointment_booked: "An appointment was booked",
  agrees_to_book_a_time_with_a_producer: "They will book a time",
  names_a_time_to_be_called_but_no_slot_is_booked: "They named a time to call back",
  specific_day_and_time: "A day and a time",
  confirms_and_text_ok: "Confirmed, and a text is fine",
  callback_agreed_by_caller: "They agreed to a callback",
  open_to_a_short_review: "Open to a short review",
  firm_no_after_agreement: "A firm no",
  firm_or_repeated_no: "A firm no, said twice",
  soft_timing_only: "Not now, but maybe later",
  other: "Something else, check the next list",
  says_it_is_the_wrong_number: "They say wrong number",
  confirms_the_number_is_wrong_for_the_business: "Wrong number, confirmed",
  not_interested: "Not interested",
  unclear: "Could not tell, ask again",
  none: "No interruption",
};

export function answerWords(answer: string): string {
  return ANSWER_WORDS[answer] ?? answer.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Plain words for the 13 endings. */
const ENDING_WORDS: Record<string, string> = {
  booked: "Appointment booked",
  callback: "Callback set",
  compliance_review: "Held for a compliance review",
  declined_ai_or_recording: "Declined the assistant or the recording",
  do_not_contact: "Do not contact again",
  handed_off: "Handed to a person",
  hung_up: "They hung up",
  message_taken: "Message taken",
  no_answer: "No answer",
  not_interested: "Not interested",
  soft_declined: "Declined twice",
  talked: "Talked, no next step yet",
  wrong_number: "Wrong number",
};

export function endingWords(name: string, label?: string): string {
  return ENDING_WORDS[name] ?? (label ? labelWords(label) : name.replace(/_/g, " "));
}
