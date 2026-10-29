# AGENTS.md: `src/behaviour/`

Behaviour layer of the voice agent. It holds the enforcement rules, the speech guard, the system prompt builder and the grading data the harness checks calls against.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- [`data/`](data/AGENTS.md): Reviewed rule, rubric, playbook, personality and prompt setup data files, plus the lab voice agent prompt.
- [`guard/`](guard/AGENTS.md): Speech guard: pattern families, redaction and the check that blocks forbidden lines.
- [`prompt/`](prompt/AGENTS.md): System prompt builder: sections, personality, setups, slots, overrides and text.
- `data-files.ts`: Reads a JSON or Markdown file from the data folder and parses it on each call.
- `install-prompt.ts`: Installs the behaviour prompt builder into the harness prompt setup slot.
- `rules.ts`: Loads the enforcement rules from data and looks up rules by identifier.
- `switches.ts`: Legal blocks switch (enforced or suspended), read on every check.
- `types.ts`: Shared contracts for rules, guard families, layers and the legal blocks mode.

## Rules

- Behaviour rules never switch off. Only the legal layer sits behind the legal blocks switch.
- Several JSON files here carry a generatedFrom field naming their source document. Check that source before editing.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
