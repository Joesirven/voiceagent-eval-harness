# AGENTS.md: `src/setups/`

Lead setups for the test bench: choose a voice module, decision module, prompt setup and real development lead, then save, apply and record each run. Reads the development database and writes run rows only to the harness database.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `active-setup.ts`: Applies a saved setup to the running process and keeps a snapshot of what it resolved to.
- `agent-context.ts`: Serves the editable standing rules and the live lead context block for the call setup dialog.
- `agent-settings.ts`: Runtime settings for the lab voice agent, switched per call without restarting the server.
- `decision-catalog.ts`: Lists the decision modules a setup can pick, standing in for the decision engine registry.
- `lead-picker.ts`: Searches or picks random leads from the development database; never returns phone numbers or emails.
- `lead-profile.ts`: Reads one real lead from the development database, read only, for the agent and the persona card.
- `local-postgres.ts`: Connects only to a PostgreSQL database on the same machine.
- `persona-card.ts`: Builds the persona card a tester uses to play the lead, with facts and script lines from an external file.
- `prompt-setups.ts`: Named prompt variants, with and without the lead record, and the function that renders the agent prompt.
- `routes.ts`: JSON routes for lead setups, picker, persona cards, saved setups, apply and run status on the dev server.
- `run-sink.ts`: Destination for run rows in the local PostgreSQL database.
- `run-writer.ts`: Writes each test call's transcript, trace, verdicts and setup snapshot to the harness_run table only.
- `setup-store.ts`: Saves named setups as small JSON files in the gitignored data directory with owner-only permissions.
- `setups-page.html`: Lead setups page: picks the lead, persona, voice module and prompt, then applies or saves the setup.
- `util.ts`: Small shared helpers: a unique identifier pattern and a function that splits arrays into chunks.

## Rules

- Writes go only to the harness_run table; the develop-writes switch that refuses real dials and texts is never changed here.
- Nothing is written to a lead database. The built-in lead store is in memory. Optional run storage uses only a database on the same machine.
- Saved setup files live in the gitignored data directory and must keep owner-only permissions.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
