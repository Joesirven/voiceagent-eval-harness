# Live trace and durable records

The harness emits ordered events for conversation turns, decisions, tool calls, safety checks, and outcomes. Each event has a lead identifier, call or message identifier, timestamp, global sequence, and record sequence.

`src/trace/records.ts` stores JSON lines. It creates one record per call attempt and one record per lead text thread. The first line describes the record. Later lines hold events. The final view derives the transcript, outcome, handoff note, and judge result from those events.

The default record folder is `data/records/`. The folder is ignored by Git. Set the records directory environment variable to use another location. Run `pnpm records:purge` to remove local records.

The server exposes read routes for the event stream, record list, one record, and one lead timeline. The plain-language narrator uses an allowlist. It does not include phone numbers, message bodies, transcript text, evidence, field values, or raw error text.

The Voice Agent Console can follow the newest call, pin a call, or replay a stored record. It aligns transcript and trace rows by milliseconds from the first call event.
