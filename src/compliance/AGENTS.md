# AGENTS.md: `src/compliance/`

Compliance checks run before and during calls: consent, required disclosures, outbound schedule, quiet hours, stop requests, and suppression lists. Each check returns a short reason string when it blocks, or null when it allows.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `consent.ts`: Checks consent for artificial voice calls and for text messages; a revoked consent always blocks.
- `disclosures.ts`: Holds the fixed opening disclosure sentences and builds the call opening from the call facts.
- `outbound-schedule.ts`: Allows an outbound call only with a reason, a text agreement, and a clock at or after the agreed time.
- `quiet-hours.ts`: Blocks calls outside 8 to 21 local time, and blocks leads with no or unknown time zone.
- `stop.ts`: Detects whole-word or whole-phrase requests from a caller or texter to stop being contacted.
- `suppression.ts`: Checks the stop list, the suppression list, and do-not-call status; a test mode keeps only the stop and suppression lists.

## Rules

- Checks return a reason code or null; a blocked lead is never guessed past.
- Quiet hours and schedule checks take an injected clock so tests control the time.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
