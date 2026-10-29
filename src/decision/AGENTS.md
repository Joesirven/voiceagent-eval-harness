# AGENTS.md: `src/decision/`

The decision-tree engine that runs one call. A keyword mock or a real module answers each typed question, and the engine moves through the tree. Judge-gated actions are the only way the decision code writes, books, transfers or sends.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `actions.ts`: Defines the action port for transfer, quote fields, details, booking, texts and dispositions, called only through the judge gate.
- `engine.ts`: Runs one caller line per tree step; honours stop requests first, then the tree, with the disclosure first.
- `extract.ts`: Pulls years, clock times and caller details from the caller's own words, so values can be checked.
- `index.ts`: Re-exports the decision types, modules, registry, tree, engine, actions, recorder and outbound attempt modules.
- `interactive-call.ts`: Holds the live caller-line queue and the call handle, which exists only for a cleared call.
- `interactive.ts`: Starts an interactive play-a-lead call through the harness so every compliance gate runs first.
- `lexicon.ts`: Keyword cues shared by the two mock decision modules, keyed by answer name, with weights.
- `modules.ts`: The two keyword mock decision modules with calibrated confidence and simulated latency; no network.
- `outbound-attempts.ts`: Places at most two unanswered outbound attempts, counted from durable records, and never a third.
- `recorder.ts`: Keeps every decision record of one call in memory.
- `registry.ts`: Registry of decision modules with one selected; the default is the jev-mock module.
- `stub-tree.json`: Small stub decision tree with dispositions and nodes, used as an opt-in fixture for the engine.
- `tree-source.ts`: Chooses which decision tree file loads; the full assembled tree by default, with an environment override.
- `tree.ts`: Typed decision tree shape with nodes, answers, minimum confidence, actions and dispositions; validated at load.
- `types.ts`: Defines the decision request and result contract: a closed answer list, confidence, reason and scores.

## Rules

- Only the judge gate may call the action port; nothing else in this module writes, books, transfers or sends.
- Each tree answer needs a minimum confidence; a low or unclear answer routes to the clarifying line.
- The mock modules have no network access and are for testing only.
- Trace and log output must never include answer criteria.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
