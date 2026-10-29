# AGENTS.md: `src/judging/offline/`

Offline-only judging tools for past calls and simulated leads, such as turn-level pairwise judging, whole-call grading and Fable analysis. Nothing here runs during a live call, and tests use mocks instead of a network.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- `claude-lead.ts`: Claude-backed fact extractor from past calls and a simulated lead that plays against the agent.
- `claude-turns.ts`: Claude-backed reply agent and pairwise judge for turn-level judging of past calls.
- `claude.ts`: Shared structured-JSON ask and model ids used by the offline judges and simulated lead.
- `connector-client.ts`: Builds the offline judge JSON client from the credential loader; names variables, never values.
- `fable-analysis.ts`: Compares model answers with Fable's answers, producing a confusion table and a worksheet of disagreements.
- `mocks.ts`: Deterministic stand-ins for reply agents and pairwise judges, used by tests.
- `sim-rows.ts`: Row types, column lists and the content rule for the simulation tables in the harness database.
- `sim-writer.ts`: Writes simulation rows into the harness database, idempotently, after the content rule passes.
- `simulated-lead.ts`: Deterministic scripted lead for whole-call judging; same facts and agent lines give the same answers.
- `turn-judge.ts`: Turn-level pairwise judging: picks the better of two replies, run in both orders to cancel position bias.
- `types.ts`: Shared shapes for the offline judges, including past call turns and the turn cap of 25.
- `whole-call.ts`: Runs a simulated lead through a full call and grades it from trace outcomes and transcript gates.

## Rules

- Redact past-call text (redactText) before it goes into any prompt.
- Tests must use the mock classes; no test may reach a model over the network.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
