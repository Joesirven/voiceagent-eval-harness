# AGENTS.md: `tests/`

Automated tests for the harness, covering behaviour, decision trees, diarization, flow tools, the flows editor, scenarios and the simulator. Setup files in this folder give each test temporary data and block access to real services.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../AGENTS.md).

## Contents

- [`behaviour/`](behaviour/AGENTS.md): Tests for the spoken prompt builder, personality profiles, prompt setups and redaction of sensitive summaries.
- [`decision-tree/`](decision-tree/AGENTS.md): Tests for the decision tree fixture, the flow compiler, and the validity of the shipped tree.
- [`diarization/`](diarization/AGENTS.md): Tests for converting Azure speaker results and for the diarization error-rate scorer.
- [`fixtures/`](fixtures/AGENTS.md): Saved sample data that tests read as input.
- [`flow-tools/`](flow-tools/AGENTS.md): Tests for the flow tool catalog, the dispatcher, quote matching and workforce totals.
- [`flows-editor/`](flows-editor/AGENTS.md): Tests for the flows editor bridge, catalog routes, import route and catalog sync.
- [`helpers/`](helpers/AGENTS.md): Shared test helpers, such as fake database, fake speech services and scripted model.
- [`lab/`](lab/AGENTS.md): Tests for the lab walk-through.
- [`lead-context/`](lead-context/AGENTS.md): Tests for lead context, live updates and producer name handling.
- [`migrations/`](migrations/AGENTS.md): Tests for the simulation migration, both static checks and run checks.
- [`modules/`](modules/AGENTS.md): Tests for the Deepgram catalog and the prompt setup module.
- [`orchestration-modules/`](orchestration-modules/AGENTS.md): Tests for agent instructions, the flow runtime bridge, the Deepgram sidecar, devtools and sessions.
- [`scenarios/`](scenarios/AGENTS.md): End-to-end scenario tests for calls, Azure voice paths, compliance disclosures, decisions and the judge.
- [`simulator/`](simulator/AGENTS.md): Tests for the simulator: bad agent behaviour, live text sessions and persona grading.
- `setup-data.ts`: Setup file that gives each test an empty held-stop directory and blocks the harness database project.
- `setup-no-azure-listing.ts`: Setup file that makes the Azure deployment listing refuse network calls during tests.
- `setup-records.ts`: Setup file that points record output at a temporary directory for each test worker.

## Rules

- No test may reach an external database. setup-data.ts points the local database setting at a file that does not exist.
- No test may reach the real Azure deployment listing; tests that need it pass their own fake fetch.
- Test records are written to temporary directories, never to ./data.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
