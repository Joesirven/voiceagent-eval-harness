# AGENTS.md: `tests/scenarios/`

Scenario tests for the voice agent test bench: calling rules, disclosures, decision tree and judge behavior, voice session paths, transfers to a person, and local control pages.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `audit-gaps.test.ts`: Gap-filling scenarios from the coverage audit, covering inbound disclosure and recognized-lead flow.
- `azure-catalog.test.ts`: Checks the decision model catalog and the Azure model listing; notes no test reaches Deepgram.
- `azure-decision.test.ts`: Tests the Azure decision model, its mock, and the default decision model choice.
- `azure-live-session.test.ts`: Azure live voice session on a fake socket, with timing gaps and event emission.
- `azure-live-voice.test.ts`: Tests the Azure live voice path (no header comment; named by its subject).
- `azure-module-wiring.test.ts`: Checks how the azure-gpt-live module is wired from the dev environment file.
- `azure-startup-check.test.ts`: Tests the Azure startup health check, readiness gate, and failure watching.
- `azure-voice-live-credentials.test.ts`: Tests loading Azure Voice Live credentials, URL building, and unavailable reasons.
- `azure-voice-live-path.test.ts`: Tests the Azure Voice Live voice path (no header comment; named by its subject).
- `azure-voice-live-session.test.ts`: Voice Live session on a fake socket: start, caller lines, barge-in, tool calls, errors, and error catalog.
- `call-warmup.test.ts`: Tests the call warm-up behavior (no header comment; named by its subject).
- `connector-credentials.test.ts`: Tests reading Azure, Deepgram and gateway credentials and their status reports.
- `control-page.test.ts`: Tests the control page served on a local server through the loopback guard.
- `critic-fixes.test.ts`: Regression tests for the critic's blocking findings, per the scenario coverage document.
- `decision-answer-meanings.test.ts`: Tests what each decision answer means (no header comment; named by its subject).
- `decision-models.test.ts`: Tests the decision model classes, catalog, and their mock and direct variants.
- `decision-module-switch.test.ts`: Tests switching between decision modules (no header comment; named by its subject).
- `decision-router.test.ts`: Tests choosing and storing the decision router.
- `decision-tree-picker.test.ts`: Tests picking the stub or full decision tree file.
- `decision-tree.test.ts`: Tests the decision tree structure and behavior (no header comment; named by its subject).
- `deepgram-voice-path.test.ts`: Tests the Deepgram voice path (no header comment; named by its subject).
- `deepgram-voice-session.test.ts`: Deepgram voice session tests that start a fake sidecar process and wait for call events.
- `disclosure-cut-off.test.ts`: Checks that a disclosure cut off before the caller heard it does not count as disclosed.
- `escalation-after-clarify.test.ts`: Checks the no-action-on-unsure-answer criterion against the tree's own escalation after clarifying lines.
- `fable-analysis.test.ts`: Tests the Fable analysis (no header comment; named by its subject).
- `foundry.test.ts`: Tests the Foundry client: config loading, URL normalization, deployments, and the mock client.
- `full-tree-defects.test.ts`: Checks safety regressions in the short Northwind renewal tree.
- `full-tree.test.ts`: Tests the shipped Northwind renewal tree structure and main paths.
- `harness-migrations.test.ts`: Checks the harness database migration files for row level security and grant rules.
- `human-transfer-socket.test.ts`: Tests the voice socket route side of a transfer to a person, with fake session and Twilio clients.
- `human-transfer.test.ts`: Tests a transfer to a person from a Talk call, with a fake Twilio client and stream.
- `improved-tree-end-to-end.test.ts`: Runs the alternate Northwind tree file through booking, refusal and clarification paths.
- `improved-tree.test.ts`: Checks that the alternate tree file matches the shipped Northwind renewal tree.
- `json-client.test.ts`: Tests the JSON model clients for Azure and the gateway, including error handling.
- `judge-catalog-actions.test.ts`: Tests the judge's verdicts on the flow tool catalog actions.
- `judge-window.test.ts`: Tests how judge verdicts become rows for the control page.
- `known-lead-opener.test.ts`: Tests the opener for a known lead: disclosure first, then confirming the lead by name.
- `list-azure-deployments.test.ts`: Tests the Azure deployment listing, including that the key never goes to a non-Azure host.
- `live-judge-wiring.test.ts`: Tests wiring the live judge into calls, using a mock Foundry client and the dev server.
- `live-judge.test.ts`: Tests the live judge that checks each action against the decision model.
- `live-test.test.ts`: Tests the switch between live test paths and resetting live test state.
- `live-thinker.test.ts`: Tests the thinker on the direct Azure live path: session start, function calls, and environment switch.
- `live-views.test.ts`: Tests the live views (no header comment; named by its subject).
- `local-postgres.test.ts`: Tests the local Postgres setup, isolating it from inherited remote database and Docker settings.
- `mic-environment.test.ts`: Tests the microphone access check, which blocks remote plain HTTP hosts.
- `modules.test.ts`: Checks the expected list of voice and decision module identifiers.
- `objectives-judge.test.ts`: Tests the objectives judge, using a scripted stand-in decision model.
- `pipecat-microphone-call.test.ts`: Tests opening a Pipecat microphone voice session and the voice dependencies.
- `pipecat-trace-route.test.ts`: Tests how Pipecat call rows from the page map onto the trace bus in order.
- `pipecat-voice-runtime.test.ts`: Starts a real Python Pipecat voice sidecar and relays audio; skipped when Python is missing.
- `recovery-invariants.test.ts`: Tests recovery invariants for calls (no header comment; named by its subject).
- `rules-that-still-refuse.test.ts`: One case per code rule that still refuses outright, per the decision tree and judge document.
- `run-sink-content.test.ts`: Checks that a harness call's content goes to the harness project in full.
- `run-writer-talk.test.ts`: Tests the run writer for Talk calls and its write-back environment switch.
- `setups-apply-runs.test.ts`: Tests applying setup runs (no header comment; named by its subject).
- `setups-persona-store.test.ts`: Tests the persona card: facts from the real lead, the rest from the script.
- `setups-picker-profile.test.ts`: Tests database client filters for the setup picker and profile queries.
- `setups-routes.test.ts`: Tests the setup routes (no header comment; named by its subject).
- `sim-writer.test.ts`: Tests the simulator writer (no header comment; named by its subject).
- `stop.test.ts`: Tests the STOP request: recorded at once and the lead is never contacted again.
- `test-mode.test.ts`: Tests test mode: config reset, AI calling switch, legal blocks, test phone and session settings.
- `trace.test.ts`: Tests the trace (no header comment; named by its subject).
- `transcript-redact.test.ts`: Tests transcript redaction of phones, emails, addresses, policy numbers and spelled-out numbers.
- `tree-designs.test.ts`: Tests the tree designs page at /tree-designs behind the loopback guard, and the removed tree lab path.
- `tree-fold.test.ts`: Tests folding follow-up nodes into their parent nodes in the full decision tree.
- `tree-interrupts.test.ts`: Tests interrupts in the decision tree (no header comment; named by its subject).
- `ui-mock.test.ts`: Tests the interface mock at /mock, built from fake data and rendered with text content only.
- `views-compat.test.ts`: Compile-time checks that the decision module's start and tree keep the shapes the views expect.
- `voice-closing-line.test.ts`: Checks that a call stays open until the closing line or goodbye has played, on both voice paths.
- `voice-error-paths.test.ts`: Tests voice error paths (no header comment; named by its subject).
- `voice-errors.test.ts`: Tests the voice error catalog, code normalization, and the recent errors limit.
- `voice-harness.test.ts`: Tests the voice harness against the lead store, including idempotency keys.
- `voice-manager.test.ts`: Tests the voice manager: active call, closing sessions, orchestrator selection and session mode.
- `whole-call-judge.test.ts`: Tests the whole-call judge (no header comment; named by its subject).

## Rules

- Tests run offline with fake sockets, fake clients and fake timers; they must not reach real services or read real credential files.
- Shared fixtures come from tests/helpers (for example baseLead in tests/helpers/fixtures.js).
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
