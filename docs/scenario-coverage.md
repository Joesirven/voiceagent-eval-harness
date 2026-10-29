# Scenario coverage map

Audit of the required trial scenarios against the tests. "Existing" means present in the scaffold
(`tests/scenarios/voice-harness.test.ts`); "Added" means added by the audit (`audit-gaps.test.ts`,
`modules.test.ts`, `control-page.test.ts`).

| Required scenario | Existing | Added |
|---|---|---|
| Recognized-lead inbound: disclosure first, recognizes lead, moves forward, handoff filed | Test 1 (disclosure listed, quote field, handoff) | Disclosure is the first spoken turn, before any caller turn; agent greets the lead by name; promised follow-up recorded |
| Outbound at agreed time after text consent, truthful "are you an AI" | Test 2 (only compared a constant) | The call also needs artificial-voice consent (lead written grant or agency attestation); a text agreement alone is blocked as `no_artificial_voice_consent`. Question matched by whole words/phrases, so "said" and "again" do not trigger it. Truthful answer asserted in the call transcript; refused before agreed time; refused without text agreement |
| Quiet hours 8am to 9pm local, enforced in code | Test 3 (22:00 call, text, inbound) | Edges 07:59, 08:00, 20:59, 21:00; lead timezone beats server timezone; missing timezone blocked |
| STOP or do-not-call before every call and text | Test 4 (stop list, call and inbound) | Text blocked too; do-not-call and suppression lists; revoked consent |
| Duplicate webhook idempotency | Test 5 (second delivery skipped; blocked attempt keeps its key) | The harness derives the key (outbound: lead plus agreed slot), so differing caller keys and concurrent deliveries place one call; per-lead in-flight lock; texts claim their key; a start failure logs `blocked` and releases the key (section 3) |
| Logging completeness (placed, answered, skipped, blocked, with reason) | Test 6 (all four outcomes appear, reasons non-empty) | Every attempt (call or text, allowed or not) adds an entry; text and unknown-lead entries |
| Flag on and off | Test 7 | Per-agency isolation; off applies on the very next call; disabled module falls back, logged |
| Quote fields hold only what the caller said | Test 8 (weak: premium absent) | Every stored field's evidence is a verbatim caller line containing the value; a caller who states nothing leaves no fields and no handoff; whole-word matching against caller turns only, enforced in the harness and again in the store write (section 4, including value 999 with span "not said") |
| Compliance cannot be bypassed by calling a module directly | None | A module accepts only a single-use clearance that only `CallHarness` can issue (`critic-fixes.test.ts`, section 1) |
| Disclosure is turn 1 on every inbound call | Test 1 only checked it was listed | The harness puts it first and throws if the final transcript does not start with it, even for a module that overrides `streamTranscript` (section 2) |
| Every voice option behind one interface | None | Eight modules run inbound and outbound; config edit and validation; enable and disable |

Known limits: the dialog is rule-based, so these tests prove the harness gates (consent, hours,
suppression, evidence), not the quality of a real model. Caller speech here is typed text; a real
transcript will need the same evidence check applied to speech-to-text output.

## Pending decision for the operator: inbound calls from suppressed or out-of-hours callers

Inbound calls apply the same suppression (stop, do-not-call, suppression list) and quiet-hours checks
as outbound calls, then fall back to normal answering, with a log entry. So a caller on the STOP list
who rings in at 9:30pm in their local time reaches normal answering, not the AI. The harness assumes
that is intended. If the operator wants the AI to answer inbound calls outside 8am to 9pm, or from suppressed
callers who ring in themselves, that rule changes in `runInbound` in `src/harness/call-harness.ts`.

## Other behavior worth knowing

- Outbound calls are limited to one per lead per agreed slot: a retry for the same slot after a
  finished call is treated as a duplicate. A call that failed to start releases its slot.
- Scenario runs on the control page turn the demo agency flag on for the run (the flag defaults to
  off) and put it back afterwards.

## Third review additions (`critic-3.test.ts`)

- Do-not-call: only an explicit clear allows contact; unchecked or missing blocks as `dnc_unchecked`.
- Time zone: state, then area code, no agency fallback; Hawaii 808 and Alaska 907 numbers with an Eastern agency are judged in their own zones; unresolved is `unknown_time_zone`.
- No phone: blocked as `no_phone`; the caller-supplied number is never dialled.
- Final reach gate: a read-only `crm_can_reach` check runs last. No later check can override its refusal.
- Consent ties count as revoked; an open callback task supplies the time but never the agreement; handoff promises must be a contiguous phrase the agent spoke.

## STOP (`stop.test.ts`)

- Phrase detection by whole words ("bus stop" is not a stop; "STOP" alone is).
- Mock store: an inbound caller and an outbound callee who say stop are suppressed and revoked at once, logged `stop_recorded_mock`, never called or texted again, with a note for a person. A texted STOP is recorded once even if delivered twice.
- Custom adapter on the fake client: writes off holds the stop request in memory with no database write. Writes on calls `crm_record_stop` once. A failed write still blocks the lead.
