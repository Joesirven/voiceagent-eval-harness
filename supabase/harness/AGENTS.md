# AGENTS.md: `supabase/harness/`

Numbered SQL migrations for harness-owned tables.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `001_voice_harness_runs.sql`: Creates the legacy public run table that the optional adapter can write.
- `002_harness_run.sql`: Creates the harness run table with full call content, trace and setup snapshot.
- `003_voice_harness_cleaned_transcripts.sql`: Creates generic call transcript and transcript turn tables.
- `004_simulation.sql`: Creates the lead facts, batch, run, turn and turn evaluation tables for simulations.
- `005_call_lead_facts.sql`: Creates structured lead facts for calls used by simulations.
- `006_prototype_eval_without_redaction.sql`: Changes the prototype evaluation requirement to require a speaker role.
- `007_cleared_calls_followups.sql`: Adds the prototype transcript view and call fact link constraints.
- `008_call_direction.sql`: Adds call direction and its source to call transcripts.

## Rules

- Add a new numbered migration for each schema change.
- Apply these migrations only to a database dedicated to harness data.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
