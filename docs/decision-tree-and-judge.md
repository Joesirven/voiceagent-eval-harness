# Decision tree, judge gate and outbound pattern

## Rules that still refuse

the operator decides each of these. They are the code rules in `src/judge/rule-judge.ts`. They run first, in the gate and again inside the live judge, and a failed rule refuses the action outright: no decision model is asked, and the model cannot override it. The live decision model, by contrast, now only blocks (see "The live judge" below). Each line below was read from the file, and `tests/scenarios/rules-that-still-refuse.test.ts` runs one case per rule.

"On the full tree" says whether the rule can fire for `src/decision-tree/full-tree.json` as it stands. The full tree has exactly two actions (`book`, and `transfer` with reason `caller_requested`) and four lasting endings: `declined_ai_or_recording`, `do_not_contact`, `not_interested`, `wrong_number`. It has no `save_details`, `save_quote_field` or `send_text` answers, so those rules can fire only on other paths (the stub tree, and the scripted agent's guarded tools).

**Every action (three checks)**

| Check | Refuses when | Reason text | On the full tree |
|---|---|---|---|
| `disclosure_first` | Inbound: the first spoken agent line is not exactly the inbound opening script. Outbound: the first spoken agent line does not contain "AI assistant". | the AI disclosure did not come first | Cannot fire: the engine always speaks the disclosure first. |
| `caller_spoke` | The caller has no spoken turn. | the caller has not said anything yet | Cannot fire: every action runs after a caller line is recorded. |
| `no_stop_request` | Any spoken caller turn contains a stop request, unless the action is an ending with `do_not_contact`. | the caller asked to stop being contacted | Cannot fire: the engine catches a stop request on the same line, before any node runs, and ends the call itself. |

**`transfer`**

| Check | Refuses when | Reason text | On the full tree |
|---|---|---|---|
| `caller_asked_for_person` | The reason is `caller_requested` (or anything but `repeated_unclear`) and the caller's last line has none of: human, real person, a person, someone, representative, operator, manager, producer, speak to, talk to, and is not a plain yes to an explicit transfer offer. A plain yes is yes, yeah, sure, okay, please (and the other agreement phrases in the booking list), with no negative word, and counts only when the agent's last line offers to connect, put through, transfer or hand the caller over. | the caller did not ask for a person | Fires only for a reply that is neither a request for a person nor a plain yes to the offer. `close.offer_live_transfer` asks "Would you like that?", so "yes", "sure" and "please" now pass; "no", "not now" and "yes, wait" are still refused. |
| `repeated_unclear_established` | The reason is `repeated_unclear` and the clarifying questions asked are fewer than the maximum. | a person is not needed yet: the agent has not exhausted its clarifying questions | Cannot fire: the engine only escalates once the count has reached the maximum. |

**`book`**

| Check | Refuses when | Reason text | On the full tree |
|---|---|---|---|
| `slot_is_a_future_time` | The slot does not parse, or is not after now. | the slot is not a valid future time | Cannot fire in practice: the slot comes from time extraction, which produces future times. |
| `time_named_by_caller` | No spoken caller turn contains a time expression (a clock time, noon, a weekday, today, tomorrow, or a part of the day). | the caller never named a time | Cannot fire: the slot is built from the caller's own words. |
| `slot_confirmed_aloud` | The agent's last spoken line does not contain the slot words. | the agent did not read the slot back before booking | Fires only if another agent line (a clarification) came between the read-back and the answer. |
| `explicit_yes` | The caller's last line has no affirmative phrase (yes, yeah, yep, yup, sure, ok, okay, correct, absolutely, please do, go ahead, that works, sounds good, perfect, great, sounds great, sounds perfect, let's do it, let's go, book it, do it, that's fine, that's right, works for me, definitely, of course, fine by me, I would like that), or has a negative word (no, nope, not, dont, do not, never, cant, wont, wait, hold on). | the caller did not clearly say yes | Fires for hedges and negations: "maybe", "yes, not sure", "no problem, yes", "no", "not now", "don't". "Perfect", "sounds great" and "let's do it" now pass. |

**`end_with_disposition`**

| Check | Refuses when | Reason text | On the full tree |
|---|---|---|---|
| `disposition_named` | The disposition is empty. | no disposition is named | Cannot fire: every ending is named. |
| `durable_needs_explicit_caller_words`, for `do_not_contact` | The ending is lasting and the caller's last line has no stop request. | a lasting ending needs the caller's explicit words, and they were not there | **Always fires through the gate**: `compliance.stop_apply` is reached only after a line that has no stop request (a line with one is ended by the engine directly, without the gate). Whether the engine's direct end is allowed is a separate decision for the operator. |
| `durable_needs_explicit_caller_words`, for `not_interested` | The ending is lasting and the caller's last line has none of: not interested, no thanks, no thank you, dont want, do not want, not looking, no longer interested. | same text | **Fires.** "I already told you no" is refused for `not_interested`. |
| (no code rule), for `wrong_number`, `declined_ai_or_recording` | Never refuses on caller words: these two lasting endings may end the call and be filed. The decision model judges the caller's words; the three every-action checks (including a stop request earlier in the call) still apply. | none | Cannot fire. |
| `outcome_really_happened` | The ending is `booked` (needs `book` done earlier in the call), `handed_off` (needs `transfer`), `message_left` (needs `save_details`) or `quote_started` (needs `save_quote_field`) and the earlier action did not happen. | this ending claims an outcome that did not happen | Fires if `close.final_disposition` picks `appointment_booked` with no booking, or `transferred_to_producer` with no transfer. The names `message_left` and `quote_started` are not in the full tree, and `message_taken` (the tree's name) is not checked at all, so the tree can file a message taken with nothing saved. |

**`save_details`** (not in the full tree)

| Check | Refuses when | Reason text |
|---|---|---|
| `details_present` | The body is empty or longer than 1000 characters. | nothing, or too much, to save |
| `details_are_callers_words` | The body is not inside a caller turn (after removing punctuation and case). | the details are not the caller's own words |

**`save_quote_field`** (not in the full tree)

| Check | Refuses when | Reason text |
|---|---|---|
| `field_name_valid` | The field name is not lowercase letters and underscores, up to 40 characters. | the field name is not valid |
| `value_from_callers_words` | The value is not inside the evidence span, or the span is not inside caller words. | the value does not come from the caller's words |

**`send_text`** (not in the full tree)

| Check | Refuses when | Reason text |
|---|---|---|
| `text_offered_aloud` | The agent's last line does not contain the word "text". | no text was offered to the caller |
| `explicit_yes` | The caller's last line is not an explicit yes (same word lists as `book`). | the caller did not clearly say yes to a text |
| `body_acceptable` | The body is empty or longer than 320 characters. | the text is empty or too long |

Rules that fire today on the full tree, for the operator to decide: a transfer reply that is neither a request for a person nor a plain yes to the offer; the booking yes list for hedges and negations; the lasting ending `not_interested` needing "not interested" style words (`wrong_number` and `declined_ai_or_recording` no longer refuse); `do_not_contact` through the gate; the outcome check for `booked` and `handed_off`; `message_taken` not checked.

## The live judge

An action goes ahead by default. After the code rules pass, the live judge asks one decision model "Should the agent carry out this action now?" (answers `allow`, `block`, `unclear`) and stops the action only when the model answers `block` with a confidence at or above that action's block threshold (one default for every action: 0.7; configurable per action with the `blockThresholds` option). An `allow`, an `unclear`, a `block` below the threshold, and a model that cannot answer (off, too slow, over budget, an error, an invalid answer, or a thrown error) all let the action proceed. A timeout or an error is first retried, up to 2 more times with a short wait (150 then 300 milliseconds), as long as time remains in the action deadline; each attempt gets at most 3000 milliseconds (a real Azure chat model takes about 1.5 to 2 seconds) and the whole decision at most 6000 milliseconds, so the call cannot hang. An invalid answer, an off model, and any real answer are never retried. All settings are options on the judge (`attemptBudgetMs`, `deadlineMs`, `retries`, `backoffMs`). If every attempt fails the action proceeds. Every attempt (number, outcome code, latency) is recorded in the trace decision event and shown in the judge window. The failure is recorded in the trace decision event (`failureReason`, with `policyApplied: "proceed"`). The event also carries the threshold, the model's answer and its confidence, and the judge window on the control page shows them. The old per-action failure policy (`block` or `rules_only`) is removed: with every failure letting the action proceed there is nothing left for it to choose.

The gate has the same stance toward a judge that fails: a judge that throws or returns an invalid verdict no longer refuses the action. The action proceeds and a `judge_error` trace event records a code only (`judge_threw` or `judge_invalid_verdict`), never text from the error. A refusal from a judge, a refusal from the code rules, and a failure of the code rules themselves still refuse.

## Pieces
- `src/decision/`: decision modules (the Azure model in live use; `jev-mock` and `openai-mock` for tests) behind a registry, the tree loader and engine, the actions the engine may take, the play-a-lead call.
- `src/judge/`: the judge interface, the local rule-based judge, the one gate every destructive action goes through, the post-call score.
- `src/harness/call-harness.ts`: runs the tree when a run asks for `agent: "decision_tree"`. Every compliance check still runs first, in the same order, and the disclosure is the first agent turn.

## One step per caller line
1. A spoken stop request is honored first. The tree and the judge are not consulted; the harness records the stop and ends the call.
2. The selected decision module answers the current node's typed question with one of its closed answers, a confidence and a reason.
3. "unclear", or a confidence below the answer's minimum, routes to the node's clarifying line. Asked twice in a row, a person is brought in (through the judge).
4. A confident answer may carry an action. The action goes through `guardedAction`: the judge runs, a `judge_verdict` event is emitted, and the action runs only if allowed. A refusal (a failed code rule, or a live judge block) is logged as `judge_refused:<action>` and the node's `onBlocked` line is spoken.
5. The next node's line is spoken. With `carry`, the next question is asked of the same caller line (so "Hi, I need a quote" is not asked twice).

## The six judged actions
`transfer`, `save_details`, `save_quote_field`, `book`, `send_text`, `end_with_disposition`. The rule judge checks, for example: a quote field's value is inside words the caller said; a booking has a time the caller named, the slot read back aloud, and a plain yes; a lasting ending (Not interested, Do not call) has the caller's explicit words; a disposition such as booked only follows a real booking.

## Swapping things
- Live defaults: the decision module and the judge's model are both `azure-decision` (deployment `gpt-5.6-luna`), the tree is the full 109-node tree, and each decision has a 6000 millisecond limit (a real Azure call takes 1.5 to 1.8 seconds). The server refuses to start without working Azure settings (see `docs/interfaces.md`), so there is no keyword fallback and the judge always has its model. If Azure later stops working (authentication or not-found failure), new calls are refused and `/api/state` shows the warning until it works again. No mock is part of the live path.
- Decision module: `VOICE_HARNESS_DECISION_MODULE=<id>` at start, or `getDecisionRegistry().select(id)` in code. The mock modules `jev-mock` and `openai-mock` exist for tests only (not listed or selectable on the Call tab); on clear lines they change confidence, latency and the module name only.
- Judge: `setActionJudge(...)`, or `new CallHarness(clock, store, registry, { judge })`.
- Tree: only the full tree is live (the Call tab shows one read-only line). Tests and tools pick the stub or the fixture with `selectDecisionTreeForTest` or `VOICE_HARNESS_DECISION_TREE`. The default is the assembled `src/decision-tree/full-tree.json` (`pnpm tree:assemble <fragment directory>`; fit report in `docs/full-tree-fit-report.md`). To change it, edit `src/decision/tree-source.ts` (file path, plus `adaptRawTree` if the shape differs). `loadTree` rejects a broken tree before any call.

## Outbound pattern
At most two outbound attempts may go unanswered per agreed slot (counted from the durable records, so a restart does not reset it). Voicemail or no answer: hang up, say nothing, log it, record the disposition. The attempt number comes from the caller's job but is checked against the records (`attempt_out_of_order`, `unanswered_attempt_limit_reached`). Attempt 1 keeps the original idempotency key; attempt 2 adds `:attempt-2`. The lead calling back is an inbound call. A person answering an attempt gets the normal outbound flow.

## Play a lead
`CallHarness.startInteractiveCall(leadId, direction)` runs the real inbound or outbound run with live caller lines. `src/decision/interactive.ts` wraps it. A handle exists only for a call the harness cleared; a refused start returns a handle with `status: "blocked"` and `blockedReason`.

The dev server installs this start by default (`src/server/play-wiring.ts`). `POST /api/play/start` answers 409 with `{ blocked: true, reason }` when a check refuses, and opens nothing. `hangUp("abandoned")` records an `abandoned` call outcome.
