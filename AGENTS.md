# AGENTS.md: voiceagent-eval-harness

Rules and an index for agents that work in this repository. Read this file first. Every folder has its own `AGENTS.md` with a file index and its local rules.

This repository is a test bench for phone voice agents. It runs simulated and live test calls on different voice setups, checks calling rules, and grades every call. The human overview is `README.md`.

## Read first

1. `docs/ARCHITECTURE.md`: the main parts, call paths, and code locations.
2. The `AGENTS.md` in the folder you work in.

## Rules

- Use pnpm. Run `pnpm check` before you commit. If a check fails, fix it before you commit.
- Never commit secrets or environment files. Supply credentials through environment variables or files outside the repository.
- Keep real customer identifiers and call data outside the repository.
- Test mode is `legalBlocks` in `src/config.ts`. Keep the library default `enforced`.
- Do not edit generated files by hand. `src/decision-tree/full-tree.flow.yaml` comes from `pnpm tree:flow`.
- For a schema change, add a new numbered file in `supabase/harness/`.
- If you add a folder, add an `AGENTS.md` to it with a file index.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the development server (`src/server/dev-server.ts`). The default port is 4310. Set `PORT=4311` for the usual port. |
| `pnpm check` | Builds the console, runs the type checks, and runs the tests. |
| `pnpm test` | Builds the console and runs the tests. |
| `pnpm typecheck` | Type checks the harness, `web/`, `lab/` and `designs/`. |
| `pnpm tree:validate` | Validates the decision tree. |
| `pnpm tree:assemble` | Assembles the decision tree from its fragments. |
| `pnpm tree:flow` | Compiles the decision tree into a Pipecat Flows file. |
| `pnpm records:purge` | Purges harness records (`scripts/purge-records.ts`). |
| `pnpm smoke:dev` | Runs a smoke check against the development server. |

## Index

- [`src/`](src/AGENTS.md): the harness application.
- [`tests/`](tests/AGENTS.md): the tests.
- [`web/`](web/AGENTS.md): the call console in the browser.
- [`docs/`](docs/AGENTS.md): design notes, research and decisions.
- [`scripts/`](scripts/AGENTS.md): maintenance and one-off scripts.
- [`supabase/`](supabase/AGENTS.md): migrations for the harness Supabase project.
- [`db/`](db/AGENTS.md): generic table definitions for harness data.
- [`lab/`](lab/AGENTS.md): helpers for the decision tree designs page.
- [`designs/`](designs/AGENTS.md): the decision tree designs page.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
