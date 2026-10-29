# AGENTS.md: `src/judging/`

Judges that check the agent during and after calls: the live pre-action judge, the objectives checklist, and the post-call score. Each is a closed question put to a decision model, with rule-based checks run first where they exist.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- [`offline/`](offline/AGENTS.md): Offline judges for past and simulated calls, including Claude-backed pieces, mocks and database writers.
- `live-judge.ts`: Live pre-action judge; runs code rules first, then asks a decision model with a budget and deadline.
- `live-questions.ts`: The closed allow, block or unclear question the live judge puts to a decision model, one per action.
- `objective-definitions.ts`: Pure data for the call objectives, each tied to a flow step; shared with the web console.
- `objectives.ts`: Background objectives judge that writes objective_check trace rows after each spoken line; off the reply path.
- `post-call-score.ts`: Scores a finished call once it ends and writes one judge_score trace row for the console.

## Rules

- Nothing here runs on the live reply path; the speaking model never waits for these judges.
- Model reasons are kept out of the trace; only codes, numbers and answers are recorded.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
