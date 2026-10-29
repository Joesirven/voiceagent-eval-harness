# AGENTS.md: `tests/orchestration-modules/`

Tests for the orchestration modules: the session contract, agent instructions, the flow runtime bridge and the Pipecat sidecar and devtools. Pipecat tests run only when the Pipecat Python is installed.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `agent-instructions.test.ts`: Tests agent system instructions and checks that persona truth markers never appear in them.
- `flow-runtime-bridge.test.ts`: Tests the flow runtime bridge between the dispatcher, the judge gate and replies.
- `flows-runtime.test.ts`: Runs the flow runtime check script under the pinned Pipecat Python and checks its JSON output.
- `pipecat-deepgram-sidecar-errors.test.ts`: Tests sidecar error handling, including failed speech services and the fallback line.
- `pipecat-deepgram-sidecar-models.test.ts`: Tests that the sidecar uses the speech model Node chose and refuses unsafe model names.
- `pipecat-deepgram-sidecar.test.ts`: Tests sidecar startup, the spoken disclosure and the mu-law audio output size.
- `pipecat-devtools-deepgram.test.ts`: Tests the sidecar with the devtools hook recording calls to files; skipped unless the hook and whisker are present.
- `pipecat-devtools-fixture.py`: Fake Pipecat pipeline run as a child process by the devtools tests, with switches for timing and cancel.
- `pipecat-devtools.test.ts`: Tests the Pipecat devtools hook: attach, file output and cancellation.
- `session.test.ts`: Tests the orchestration session lifecycle and event sequence in live and simulator modes.

## Rules

- Pipecat tests skip when the Pipecat Python or the devtools hook is not available; they do not fail.
- The fixture script is run with the isolated Python flag by the test; keep it free of extra imports.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
