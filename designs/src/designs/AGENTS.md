# AGENTS.md: `designs/src/designs/`

The ten decision tree design files. Each exports a name, a one sentence idea and a component. All ten are placeholders that show Not built yet.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- `01-call-script.tsx`: Call script design: a conversation you tap through. Placeholder only.
- `02-step-by-step-wizard.tsx`: Step-by-step wizard design: one question per screen. Placeholder only.
- `03-checklist-by-stage.tsx`: Checklist by stage design: tickable lists per stage. Placeholder only.
- `04-swimlane-by-stage.tsx`: Swimlane by stage design: one row per stage. Placeholder only.
- `05-next-best-line.tsx`: Next best line design: one line to say and three likely answers. Placeholder only.
- `06-traffic-light-map.tsx`: Traffic-light map design: answers coloured by direction, with a dot map. Placeholder only.
- `07-collapsible-outline.tsx`: Collapsible outline design: branches opened one at a time. Placeholder only.
- `08-phrase-book.tsx`: Phrase book design: answers filed by what the caller does. Placeholder only.
- `09-how-calls-end.tsx`: How calls end design: the endings with the shortest road to each. Placeholder only.
- `10-main-road-flowchart.tsx`: Main road flowchart design: only the normal road to a booking. Placeholder only.

## Rules

- Each design file receives the tree through props and imports shared types from ../types.js.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
