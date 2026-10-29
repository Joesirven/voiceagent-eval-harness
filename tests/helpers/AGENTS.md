# AGENTS.md: `tests/helpers/`

Shared test helpers for the harness suites: local fakes for Deepgram, Azure chat and the database, a scripted decision model, fixture leads, and a helper that starts a cleared test call. The fakes stand in for real services so tests make no network calls.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `cleared-call.ts`: Starts a real test-mode call on a simulated line that connects, for tests that need one.
- `control-page.ts`: Reads the built control page HTML and its script text so tests can check the page contents.
- `deepgram-sidecar.ts`: Drives the real Python Deepgram sidecar subprocess over its stdio protocol.
- `fake-azure-chat.ts`: Local stand-in for the Azure chat route that streams replies and records each request body.
- `fake-db.ts`: In-memory fake of the database client, with no network, used by tests.
- `fake-deepgram-sidecar.mjs`: Node stand-in for the Python Deepgram sidecar; logs every line it receives to a file.
- `fake-deepgram.ts`: Local fake Deepgram WebSocket server for speech to text and text to speech paths.
- `fixtures.ts`: Builds a base test lead record, with optional overrides, for the test suites.
- `scripted-model.ts`: Decision model stand-in that answers from a per-node script and never touches the network.
- `setups-fixtures.ts`: Fake database with range and text filters, plus fixed agency, role and lead identifiers for setup tests.

## Rules

- Fakes stand in for real services; keep them free of network calls to real providers.
- The scripted model fails a test when a node is answered with an option that node does not offer.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
