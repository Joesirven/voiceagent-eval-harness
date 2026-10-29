# AGENTS.md: `src/lead-context/`

Builds the lead context block the agent receives: who is calling, the call stage, the quote checklist, and days until renewal. It is information for the agent, not lines to read aloud, and some values are held until the named person is confirmed.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `build.ts`: Pure builder of the lead context block; the clock is passed in as an input.
- `checklist.ts`: Builds the quote checklist, one row per quote field, still-needed rows first.
- `facts.ts`: Builds the who-is-calling facts, each with its source; absent values are shown as unknown.
- `index.ts`: Public re-exports for the lead context modules.
- `last-conversation.ts`: Reads an excerpt of the last finished call with a lead, with sensitive sentences removed; never throws.
- `live-update.ts`: Sends a changed-only context update after each caller line, on its own channel.
- `renewal.ts`: Counts whole calendar days from today in the lead's time zone to the policy renewal date.
- `route.ts`: Read-only GET handler for the lead context of the live or last call, served to the call console bot.
- `stage.ts`: Maps each flow step to a plain-words stage meaning for the agent.
- `types.ts`: Type shapes and source labels for the lead context block; no database or clock.

## Rules

- Held values (such as the account and renewal date) must stay withheld until the named person is confirmed; the route replaces them with a withheld marker.
- The route is read only and writes nothing.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
