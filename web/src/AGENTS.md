# AGENTS.md: `web/src/`

Application source for the control page. It holds the app shell with its tabs, the React components, the lazy-loaded console and flow editor views, the client libraries for the API and live events, and the browser test setup.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- [`assets/`](assets/AGENTS.md): Static image assets used by the interface, currently one noise texture PNG.
- [`components/`](components/AGENTS.md): React components for calls, leads, the console, the flow editor, settings and the shared ui primitives, plus their tests.
- [`hooks/`](hooks/AGENTS.md): Custom React hooks, currently the Pipecat metrics hook.
- [`lib/`](lib/AGENTS.md): Client logic: API and live event helpers, call audio and view state, Pipecat call adapters, labels, and their unit tests.
- [`test/`](test/AGENTS.md): Test setup and fixtures: the jsdom setup file, trace fixtures, and voice client audio, ring and pause tests.
- `App.test.tsx`: Tests the tab shell, including that the console module loads only when its tab is first opened.
- `App.tsx`: Top-level app: header brand, tabs for call, console, simulator and flow editor, and the settings sheet.
- `env.d.ts`: Type declarations for the shared voice-client browser module that lives under src/server.
- `index.css`: Global stylesheet: Tailwind imports, the theme color tokens and the light and dark variables.
- `main.tsx`: Browser entry point that mounts the App into the root element and loads the stylesheet.

## Rules

- Heavy modules such as the console and flow editor are loaded lazily, so keep them behind their tab's first open.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
