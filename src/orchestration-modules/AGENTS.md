# AGENTS.md: `src/orchestration-modules/`

Orchestration modules that own call ordering and lifecycle, separate from voice and decision code. Two exist: the own-infrastructure adapter and the Pipecat process module, which runs a Python sidecar per session.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- [`pipecat/`](pipecat/AGENTS.md): Python sidecars, Pipecat flow runtime, flow tool handlers and pinned requirements files.
- `contract.ts`: Shared types for orchestration modules, sessions, capabilities, errors and transports.
- `index.ts`: Orchestration registry: lists modules, selects one for future sessions, and creates sessions.
- `own-infrastructure.ts`: The default orchestration adapter that reuses the harness transcript ordering without dialling.
- `pipecat-config.ts`: Resolves the pinned Pipecat interpreter and the debugging switches passed to the sidecar.
- `pipecat.ts`: Pipecat orchestration module: one subprocess per session, with JSON lines to and from the sidecar.
- `session.ts`: Orchestration session lifecycle: validated config snapshot, state moves, and cancellation.

## Rules

- The Pipecat interpreter path comes only from server configuration, never from browser input.
- Credentials reach the Pipecat process only through its spawn environment.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
