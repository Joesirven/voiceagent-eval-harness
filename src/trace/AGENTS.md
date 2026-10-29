# AGENTS.md: `src/trace/`

Trace model for calls and text threads: one event model with an in-process event bus, the on-disk record store, plain-language sentences for agency agents, and interface-only extension points for later work.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `events.ts`: Trace event model and in-process event bus that every step of a call emits to.
- `extensions.ts`: Interfaces only, not implemented or called; extension points for later work.
- `index.ts`: Barrel file that re-exports the event, extension, narrate and record modules.
- `narrate.ts`: Builds short plain-language sentences from an allow-list of fields, never raw content.
- `records.ts`: Writes trace records as JSON lines on disk, one file per call or text thread.

## Rules

- Personal data stays in the gitignored records directory. Nothing here is sent to another service.
- Narration sentences must never include raw inputs, message bodies, phone numbers, transcript text or field values.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
