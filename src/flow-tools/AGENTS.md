# AGENTS.md: `src/flow-tools/`

The tool layer for Pipecat flows: a catalog of tools a flow may call, a dispatcher that runs them with judge checks, and helpers for quotes, reads, and after-call filings. Lasting writes are queued for after the call.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `catalog.json`: Single source of the flow tool catalog: tool names, schemas, risks, and judge actions.
- `catalog.ts`: Loads and validates the catalog, and refuses to load a catalog that breaks a rule.
- `crm-stub.ts`: Records customer relationship management actions locally and returns plausible results for tests and simulations.
- `dispatch.ts`: Per-call dispatcher that runs flow tools in fixed order, with stop and quote checks and judge gating.
- `filings.ts`: After-call queue of customer relationship management filings and producer follow-ups when no credential is held.
- `quotes.ts`: Matches a model's quote against the caller's spoken words, ignoring case and punctuation.
- `reads.ts`: Read-only flow tools that answer in one speakable sentence, with bounded booking times.

## Rules

- catalog.json is the one source for the tool catalog. Change tools there, not in catalog.ts.
- During a call, actions stay in harness memory. The local customer relationship management stub records integration actions. Lasting writes are queued as filings.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
