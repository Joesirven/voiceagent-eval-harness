# AGENTS.md: `src/server/`

Server side of the harness developer console: the local development server (default port 4310; usually run on 4311), its JSON routes, and the wiring that connects the live judge, objectives judge, post-call scorer, play mode and the Pipecat engine proxy. It also holds the console's static pages and the voice runtime folder.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- [`ui-mock/`](ui-mock/AGENTS.md): Static, invented-data mock of the developer role-play page, for development without a live server.
- [`voice/`](voice/AGENTS.md): Voice runtime folder: Azure and Deepgram voice sessions, Pipecat runtimes, transfer lines, decision routing, credentials loading, and the voice page and its client script.
- `azure-startup-check.ts`: Refuses to start the dev server unless Azure settings are present and a read-only deployment listing succeeds; also blocks new calls on Azure auth failures.
- `call-history.ts`: Read-only GET routes for call history, merging on-disk records, the harness database and the Pipecat engine history, newest first.
- `call-warmup.ts`: Warm-up run when Go is pressed in the call setup dialog: checks voice path, Azure, lead and a tiny decision model call.
- `dev-server.ts`: Local-only control page server started by the dev command, with a static page and a small JSON API over modules, agency flag and scenarios.
- `fake-interactive.ts`: Test-only stand-in for the decision module's interactive call, using keyword matching; the dev server does not use it.
- `flow-editor-routes.ts`: JSON routes for the flows editor: tool catalog, current runtime flow file, and an import route that validates YAML before writing it.
- `leads-search.ts`: Read-only lead search route for the console, reading the development database or demo leads and returning only the last four phone digits.
- `live-judge-wiring.ts`: Installs the live judge and live decision module, both on the Azure decision model; refuses to run without Azure configured.
- `live-test.ts`: Switch between the Vapi phone test path and the Azure browser Talk path, with no silent fallback between them.
- `live-view-core.d.ts`: Type declarations for the shared live view logic used by the server and the page.
- `live-view-core.js`: Pure logic for the live views (grouping and ordering trace events into lines and rows), shared by server tests and the page.
- `objectives-wiring.ts`: Installs the objectives judge on the dev server, asked in the background after each spoken line; can be turned off by an environment setting.
- `pipecat-proxy.ts`: Proxies the console's /api/pipecat/ paths to the local Pipecat engine on loopback, streaming bodies and responses through unchanged.
- `pipecat-trace-route.ts`: POST route that accepts the page's trace rows for a Pipecat call and puts them on the server trace bus, with type and batch limits.
- `play-wiring.ts`: The single place play mode gets its call implementation: the decision module's start, which runs every compliance check through the harness.
- `post-call-score-wiring.ts`: Installs the post-call scorer, asked once per call after it ends on the Azure decision model; can be turned off by an environment setting.
- `rating-routes.ts`: Routes for a person's 1 to 5 rating of a call and a note, saved with the setup snapshot to a local ratings file.
- `simulator-page.html`: Static page for deterministic scenario runs: pick a named case, run it against the harness, and inspect the outcome and trace.

## Rules

- fake-interactive.ts is test only; the dev server never uses it.
- The dev server is local only and refuses to start without working Azure settings (azure-startup-check.ts).
- Routes that read call history, leads and flows are read only; keep it that way.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
