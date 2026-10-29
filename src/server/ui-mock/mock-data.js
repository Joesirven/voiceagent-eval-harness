/**
 * Fake data for the harness interface mock. No network, no real leads: every
 * name, agency, number and date here is invented for the development database
 * look. The scripted call uses the same event vocabulary as the live trace
 * (`src/trace/events.ts`), so the page logic in `live-view-core.js` can group
 * it the same way it groups a real call.
 */

/** Synthetic development-database leads. Fields in braces are substituted into the script. */
export const leads = [
  {
    id: "dev-lead-0412",
    firstName: "Marisol",
    name: "Marisol Ortega",
    business: "Ortega Plumbing Inc.",
    trade: "Plumbing (C-36)",
    entity: "Corporation, 8 to 12 employees",
    city: "Fresno, California",
    phone: "+1 559 555 0142",
    xDate: "2026-12-14",
    xDateWords: "December 14th",
    carrier: "State Fund",
    lastContact: "Oct 17, outbound attempt 2 rang out",
    priorCallSummary: "Two outbound attempts rang out (Oct 15 and Oct 17). No message was left either time. Text agreement on file from Oct 9: \"ok call me\".",
    consents: ["Text agreement Oct 9, 14:02", "Voice consent Oct 9, 14:02", "Artificial-voice consent: agency attestation"],
    outboundAttempts: 2,
    quoteFieldsOnFile: {},
  },
  {
    id: "dev-lead-0388",
    firstName: "Devin",
    name: "Devin Whitaker",
    business: "Whitaker Electric",
    trade: "Electrical (C-10)",
    entity: "Sole owner",
    city: "Sacramento, California",
    phone: "+1 916 555 0177",
    xDate: "2026-12-02",
    xDateWords: "December 2nd",
    carrier: "Zenith",
    lastContact: "Oct 12, text reply: \"call me after 4\"",
    priorCallSummary: "No prior calls. One text exchange on Oct 12; the lead asked for a call after 4 pm.",
    consents: ["Text agreement Oct 12, 16:40", "Voice consent Oct 12, 16:40", "Artificial-voice consent: lead written"],
    outboundAttempts: 2,
    quoteFieldsOnFile: {},
  },
  {
    id: "dev-lead-0290",
    firstName: "Tomas",
    name: "Tomas Reyes",
    business: "Reyes Landscape Co.",
    trade: "Landscaping (C-27)",
    entity: "Limited liability company",
    city: "Bakersfield, California",
    phone: "+1 661 555 0119",
    xDate: "2027-01-20",
    xDateWords: "January 20th",
    carrier: "Employers",
    lastContact: "Oct 3, inbound call, asked us to call in December",
    priorCallSummary: "Inbound call on Oct 3: asked who we were, said he had just renewed, asked for a call in December. Disposition: talked.",
    consents: ["Text agreement Oct 3, 09:15", "Voice consent Oct 3, 09:15", "Artificial-voice consent: agency attestation"],
    outboundAttempts: 2,
    quoteFieldsOnFile: { x_date: { value: "2027-01-20", evidence: "I just renewed, it runs to January" } },
  },
];

export const voiceModules = ["Vapi", "Retell AI", "ElevenLabs Agents", "OpenAI gpt-realtime", "Azure OpenAI gpt-live-1", "Bland AI", "Fish Audio Agents", "Sesame"];
export const decisionModules = ["Jev (default)", "OpenAI gpt-5 mini", "Local rules only"];
export const promptSetups = ["Baseline v3", "Objection first", "Short answers"];

/** The mock's decision tree: the same shape `GET /api/tree` serves, trimmed to what the scripted call touches. */
export const tree = {
  start: "disclosure",
  nodes: [
    { id: "disclosure", label: "Disclosure", edges: [{ answer: "next", to: "recognize_lead" }] },
    { id: "recognize_lead", label: "Recognize the lead", question: "Is the person on the line the lead on file?", edges: [
      { answer: "yes", min: 0.65, to: "discovery" }, { answer: "no", min: 0.7, disposition: "wrong_number" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "discovery", label: "Discovery", question: "What does the caller want? Judge only the caller's own words.", edges: [
      { answer: "quote", min: 0.65, to: "quote_fields" }, { answer: "book", min: 0.65, to: "booking" }, { answer: "message", min: 0.65, to: "message" },
      { answer: "human", min: 0.7, action: "transfer", disposition: "handed_off" }, { answer: "objection", min: 0.65, to: "objection" },
      { answer: "not_interested", min: 0.8, disposition: "not_interested" }, { answer: "do_not_call", min: 0.8, disposition: "do_not_contact" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "objection", label: "Objection", question: "After raising a concern, does the caller still want a producer call?", edges: [
      { answer: "yes", min: 0.7, to: "booking" }, { answer: "no", min: 0.7, disposition: "not_interested" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "quote_fields", label: "Quote details", question: "Did the caller give the detail asked for?", edges: [
      { answer: "given", min: 0.65, action: "save_quote_field", to: "quote_wrap" }, { answer: "no", min: 0.7, to: "discovery" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "quote_wrap", label: "Quote wrap-up", question: "Does the caller want anything else?", edges: [
      { answer: "no", min: 0.7, disposition: "quote_started" }, { answer: "yes", min: 0.7, to: "discovery" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "booking", label: "Booking: ask for a time", question: "Did the caller give a day or a time?", edges: [
      { answer: "time_given", min: 0.65, to: "booking_confirm" }, { answer: "no", min: 0.7, to: "discovery" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "booking_confirm", label: "Booking: confirm", question: "Did the caller say yes to the time read back to them?", edges: [
      { answer: "yes", min: 0.7, action: "book", to: "booking_wrap" }, { answer: "no", min: 0.7, to: "booking" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "booking_wrap", label: "Booking wrap-up", question: "Does the caller want anything else?", edges: [
      { answer: "no", min: 0.7, disposition: "booked" }, { answer: "yes", min: 0.7, to: "discovery" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "message", label: "Message: take it", question: "Did the caller give a message to pass on?", edges: [
      { answer: "message_given", min: 0.6, action: "save_details", to: "message_wrap" }, { answer: "unclear", min: 0, clarify: true } ] },
    { id: "message_wrap", label: "Message wrap-up", question: "Does the caller want anything else?", edges: [
      { answer: "no", min: 0.7, disposition: "message_left" }, { answer: "yes", min: 0.7, to: "discovery" }, { answer: "unclear", min: 0, clarify: true } ] },
  ],
  dispositions: {
    talked: "Talked", not_interested: "Not interested", do_not_contact: "Do not call", booked: "Booked", message_left: "Message left",
    handed_off: "Handed to a person", quote_started: "Quote started", wrong_number: "Wrong number", no_answer: "No answer", voicemail_no_message: "Voicemail, no message",
  },
};

/**
 * The scripted inbound callback. `ms` is milliseconds since the call started.
 * Spoken lines carry `speakMs`: how long the words take to arrive, so the
 * transcript can grow word by word like a live one. Text in braces is filled
 * from the chosen lead and setup.
 */
export const script = [
  { ms: 0, type: "compliance_check", data: { check: "consent", skipped: true, reason: "test mode" } },
  { ms: 2, type: "compliance_check", data: { check: "artificial_voice_consent", skipped: true, reason: "test mode" } },
  { ms: 4, type: "compliance_check", data: { check: "quiet_hours", skipped: true, reason: "test mode" } },
  { ms: 6, type: "compliance_check", data: { check: "do_not_call", skipped: true, reason: "test mode" } },
  { ms: 10, type: "compliance_check", data: { check: "test_destination", passed: true, reason: "line is this browser, not a phone number" } },
  { ms: 14, type: "compliance_check", data: { check: "ai_calling_flag", passed: true, reason: "agency flag is on" } },
  { ms: 30, type: "tool_call", data: { tool: "lead_lookup", success: true, durationMs: 38 } },
  { ms: 72, type: "tool_call", data: { tool: "build_context_packet", success: true, durationMs: 4 } },
  { ms: 80, type: "node_enter", data: { nodeId: "disclosure", label: "Disclosure" } },
  { ms: 300, type: "turn", speakMs: 3600, data: { role: "agent", turnIndex: 0, text: "Thanks for calling Bayline Insurance. I'm an AI assistant, and this call is recorded. Am I speaking with {firstName}?" } },
  { ms: 4200, type: "turn", speakMs: 2400, data: { role: "caller", turnIndex: 1, text: "Yeah, this is {firstName}. I had two missed calls from this number." } },
  { ms: 6800, type: "decision", data: { nodeId: "recognize_lead", answer: "yes", confidence: 0.93, minConfidence: 0.65, routed: "next", module: "{decisionModule}", durationMs: 210, reason: "The caller gave the lead's first name and the number matched the record." } },
  { ms: 6820, type: "node_enter", data: { nodeId: "discovery", label: "Discovery" } },
  { ms: 7100, type: "turn", speakMs: 6200, data: { role: "agent", turnIndex: 2, text: "Thanks, {firstName}. Sorry about the missed calls; we don't leave messages. We called about your workers' comp policy, which our records show renews on {xDateWords}. How can I help today?" } },
  { ms: 13800, type: "turn", speakMs: 3400, data: { role: "caller", turnIndex: 3, text: "Yeah, mid-December sounds right. But honestly I already have insurance, I'm with {carrier}." } },
  { ms: 17400, type: "decision", data: { nodeId: "discovery", answer: "objection", confidence: 0.84, minConfidence: 0.65, routed: "next", module: "{decisionModule}", durationMs: 240, reason: "The caller said they already have insurance and named a carrier." } },
  { ms: 17420, type: "judge_verdict", data: { action: "save_quote_field", target: "x_date", value: "{xDate}", allowed: true, reason: "the caller confirmed the date in their own words: \"mid-December sounds right\"", evidence: "mid-December sounds right" } },
  { ms: 17430, type: "tool_call", data: { tool: "save_quote_field", target: "x_date", success: true, durationMs: 52 } },
  { ms: 17490, type: "judge_verdict", data: { action: "save_quote_field", target: "current_carrier", value: "{carrier}", allowed: true, reason: "\"{carrier}\" appears in the caller's words", evidence: "I'm with {carrier}" } },
  { ms: 17500, type: "tool_call", data: { tool: "save_quote_field", target: "current_carrier", success: true, durationMs: 47 } },
  { ms: 17560, type: "node_enter", data: { nodeId: "objection", label: "Objection" } },
  { ms: 17800, type: "turn", speakMs: 7800, data: { role: "agent", turnIndex: 4, text: "That's fine. You should have cover, and I'm not asking you to switch today. We'd just like to be one of your options when it renews in December. Would a short call with a producer before then be worth it?" } },
  { ms: 26200, type: "turn", speakMs: 1800, data: { role: "caller", turnIndex: 5, text: "Mm, maybe. Depends what it costs." } },
  { ms: 28250, type: "decision", data: { nodeId: "objection", answer: "unclear", confidence: 0.52, minConfidence: 0.7, routed: "clarify", module: "{decisionModule}", durationMs: 260, reason: "\"Maybe\" plus a cost question is neither a yes nor a no." } },
  { ms: 28500, type: "turn", speakMs: 4600, data: { role: "agent", turnIndex: 6, text: "Fair enough. The producer can talk cost; I can't quote. Would a short call be worth it? A yes or no is fine." } },
  { ms: 33800, type: "turn", speakMs: 1600, data: { role: "caller", turnIndex: 7, text: "Sure, yeah. A call is fine." } },
  { ms: 35600, type: "decision", data: { nodeId: "objection", answer: "yes", confidence: 0.9, minConfidence: 0.7, routed: "next", module: "{decisionModule}", durationMs: 190, reason: "\"Sure\" and \"a call is fine\" is a plain yes." } },
  { ms: 35620, type: "node_enter", data: { nodeId: "booking", label: "Booking: ask for a time" } },
  { ms: 35900, type: "turn", speakMs: 2200, data: { role: "agent", turnIndex: 8, text: "Great. What day and time works for you?" } },
  { ms: 38800, type: "turn", speakMs: 1800, data: { role: "caller", turnIndex: 9, text: "Thursday afternoon, like two." } },
  { ms: 40820, type: "decision", data: { nodeId: "booking", answer: "time_given", confidence: 0.87, minConfidence: 0.65, routed: "next", module: "{decisionModule}", durationMs: 230, reason: "A weekday and an hour were given; read as Thursday October 23 at 2 pm.", extracted: { slot: "Thursday October 23, 2:00 pm" } } },
  { ms: 40840, type: "tool_call", data: { tool: "calendar_find_slots", success: false, durationMs: 1500, reason: "timeout after 1500 ms" } },
  { ms: 42360, type: "tool_call", data: { tool: "calendar_find_slots", success: true, durationMs: 420, attempt: 2 } },
  { ms: 42800, type: "node_enter", data: { nodeId: "booking_confirm", label: "Booking: confirm" } },
  { ms: 43000, type: "turn", speakMs: 4200, data: { role: "agent", turnIndex: 10, text: "Just to confirm: Thursday the 23rd at 2 in the afternoon with a producer. Shall I book that?" } },
  { ms: 47800, type: "turn", speakMs: 3600, data: { role: "caller", turnIndex: 11, text: "Yeah, go ahead. Oh, and we've got about eight guys on payroll now." } },
  { ms: 51600, type: "decision", data: { nodeId: "booking_confirm", answer: "yes", confidence: 0.91, minConfidence: 0.7, routed: "next", module: "{decisionModule}", durationMs: 200, reason: "A plain yes to the slot that was read back. The caller also volunteered a headcount.", extracted: { employee_count: "8", annual_payroll: "about 400,000 (estimated)" } } },
  { ms: 51620, type: "judge_verdict", data: { action: "book", target: "Thursday October 23, 2:00 pm", allowed: true, reason: "the caller named the time, it was read back, and the caller said a plain yes", evidence: "Yeah, go ahead." } },
  { ms: 51640, type: "tool_call", data: { tool: "book_appointment", success: true, durationMs: 640 } },
  { ms: 52300, type: "judge_verdict", data: { action: "save_quote_field", target: "employee_count", value: "8", allowed: true, reason: "\"about eight guys on payroll\" is in the caller's words", evidence: "about eight guys on payroll" } },
  { ms: 52320, type: "tool_call", data: { tool: "save_quote_field", target: "employee_count", success: true, durationMs: 44 } },
  { ms: 52380, type: "judge_verdict", data: { action: "save_quote_field", target: "annual_payroll", value: "about 400,000 (estimated)", allowed: false, reason: "no payroll figure appears in the caller's words; the module estimated it from the headcount" } },
  { ms: 52400, type: "node_enter", data: { nodeId: "booking_wrap", label: "Booking wrap-up" } },
  { ms: 52600, type: "turn", speakMs: 5200, data: { role: "agent", turnIndex: 12, text: "Booked: Thursday the 23rd at 2 pm. I've noted about eight on payroll for the producer. Anything else I can help with?" } },
  { ms: 58400, type: "turn", speakMs: 1400, data: { role: "caller", turnIndex: 13, text: "No, that's it. Thanks." } },
  { ms: 60000, type: "decision", data: { nodeId: "booking_wrap", answer: "no", confidence: 0.95, minConfidence: 0.7, routed: "next", module: "{decisionModule}", durationMs: 170, reason: "\"No, that's it\" closes the call." } },
  { ms: 60020, type: "judge_verdict", data: { action: "end_with_disposition", target: "booked", allowed: true, reason: "a booking was made on this call, so the disposition is earned", evidence: "Yeah, go ahead." } },
  { ms: 60040, type: "tool_call", data: { tool: "save_handoff_note", success: true, durationMs: 61 } },
  { ms: 60100, type: "disposition", data: { value: "booked" } },
  { ms: 60300, type: "turn", speakMs: 2200, data: { role: "agent", turnIndex: 14, text: "Wonderful, talk to you Thursday. Goodbye." } },
  { ms: 63000, type: "call_outcome", data: { status: "completed", durationMs: 63000 } },
  { ms: 63200, type: "judge_score", data: { score: 92, criteria: [
    { criterion: "disclosure_first", score: 1, note: "the call opened with the AI disclosure" },
    { criterion: "promises_kept", score: 1, note: "the booking the agent announced was made" },
    { criterion: "fields_evidence_backed", score: 1, note: "every saved field has the caller's words; one estimate was refused" },
    { criterion: "stop_honored", score: 1, note: "the caller did not ask to stop" },
    { criterion: "clarifications", score: 0.6, note: "one clarifying turn was needed" },
  ] } },
];

/** What the end-of-call sheet shows once the call is over. Caller words come from the judge's evidence. */
export const summary = {
  outcome: "Completed, 1 minute 3 seconds",
  handoffNote: "{firstName} ({business}) called back after two unanswered attempts. Has workers' comp with {carrier}, renewing {xDateWords}. Open to a producer call: booked Thursday October 23 at 2 pm. Headcount about 8. Payroll not given; ask on the call.",
  quoteFields: [
    { field: "x_date", value: "{xDate}", evidence: "mid-December sounds right" },
    { field: "current_carrier", value: "{carrier}", evidence: "I'm with {carrier}" },
    { field: "employee_count", value: "8", evidence: "about eight guys on payroll" },
    { field: "annual_payroll", value: "not saved", evidence: "judge refused: no figure in the caller's words" },
  ],
};
