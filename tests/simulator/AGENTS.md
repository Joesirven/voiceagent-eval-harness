# AGENTS.md: `tests/simulator/`

Vitest tests for the simulated caller (persona) and live text session features of the harness. They check persona loading, the grading of persona calls, and a bad-agent fixture that should fail the calling rules while a control agent passes.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `bad-agent.test.ts`: Checks that a deliberately bad agent fixture fails the gates, while a control agent that says the right things passes.
- `live-text-session.test.ts`: Tests a whole live text call run against a small decision tree and stub keyword routing.
- `persona-grade.test.ts`: Tests grading of persona calls: disposition checks, gated action checks, must-not checks and whole-call grades.
- `persona.test.ts`: Tests persona file parsing, persona case building, facts, spoken openings and dial agreement handling, using made-up personas.

## Rules

- Test personas are made up. Do not copy real lead records from lead-scripts.json into these tests.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
