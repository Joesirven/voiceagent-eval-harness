# AGENTS.md: `web/`

The Voice Agent Console, built with Vite and React. It holds the HTML entry, component settings, Vite configuration, and TypeScript settings for browser code.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../AGENTS.md).

## Contents

- [`src/`](src/AGENTS.md): React source for the control page: app shell, components, hooks, libraries, tests and assets.
- `components.json`: shadcn/ui settings: style, Tailwind stylesheet path, and the component and library import aliases.
- `index.html`: HTML shell with a root element that loads src/main.tsx as a module.
- `tsconfig.json`: TypeScript settings for the browser code, with the @ alias pointing at src and Vite types included.
- `vite.config.ts`: Vite setup: React and Tailwind plugins, the @ alias, build output to web/dist, and a dev proxy for /api and /ws.

## Rules

- The dev server serves web/dist at the root path and proxies /api and /ws to 127.0.0.1:4310.
- The microphone client and live-view logic are imported from src/server so the browser bundle and the standalone voice page share one copy.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
