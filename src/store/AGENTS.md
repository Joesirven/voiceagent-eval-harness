# AGENTS.md: `src/store/`

Lead storage for the voice harness. The mock store is the only built-in store. The `LeadStore` interface is the plug-in point for an external CRM.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `active-store.ts`: Returns the built-in mock store.
- `call-log.ts`: Outcome types and entries for the call log of placed, answered, skipped and blocked calls.
- `database-client.ts`: Row-store types for optional external adapters and test fakes.
- `harness-runs.ts`: One row per call or text attempt for the harness table in the development database.
- `held-stops.ts`: Durable local records for STOP requests that an external adapter could not persist.
- `lead-store-seam.ts`: The single async interface the harness needs from lead storage, with a mock store.
- `lead-store.ts`: Lead record type and the lead store logic, including consent and evidence checks.
- `time-zones.ts`: Generic state and area-code time-zone lookup tables.

## Rules

- Harness run rows are tagged with a test-run source so test rows are never mixed with real ones.
- Do not add any path that sends a call or text from the store code.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
