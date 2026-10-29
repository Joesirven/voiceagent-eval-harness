# Harness interfaces

These interfaces keep voice transport, decision logic, lead data, and evaluation replaceable.

## Test mode

`legalBlocks` is `enforced` or `suspended`. The library default is `enforced`. Suspend blocks only for synthetic test calls. The trace records the active mode.

## Lead store

`LeadStore` supplies lead search, lead context, idempotency, evidence-backed quote fields, handoff notes, stop requests, messages, and bookings. The mock implementation is the default.

A custom customer relationship management system adapter runs on the server. It must keep credentials out of browser code. It must make every external write explicit.

## Voice module

A voice module starts an inbound or outbound session, streams transcript events, and ends the session. The harness supplies a cleared destination. A module must not dial another destination or speak before the disclosure step.

## Decision module

A decision module receives a tree node and redacted conversation state. It returns one allowed answer, confidence, latency, and model metadata. Deterministic mocks support tests.

## Action judge

An action judge receives the action, proposed arguments, evidence, and call state. It returns allow or block with score lines. The dispatcher records the verdict before an external write.

## Model connector

A model connector reads its base URL, deployment name, and credential from server configuration. It returns short stable error codes. It never serializes the credential.

## Trace and record store

Trace events are append-only and ordered. A record store saves the setup snapshot, transcript, trace, outcome, disposition, handoff note, and judge results. A failed durable write does not change the completed call result.
