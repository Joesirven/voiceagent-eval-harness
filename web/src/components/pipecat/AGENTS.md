# AGENTS.md: `web/src/components/pipecat/`

Copied Pipecat user interface kit components the console uses: audio visualizers, conversation message rendering, metric tiles and a shader. These files are reused from Pipecat, so change them with care.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../../AGENTS.md).

## Contents

- [`metrics/`](metrics/AGENTS.md): Subfolder with the chart and the performance, usage and combined metrics views.
- `audio-visualizer-radial.tsx`: Radial dot-ring visualizer for an audio track, with connecting and thinking animations.
- `audio-visualizer-wave.tsx`: Wave visualizer for an audio track, with connecting and thinking states and a shader background.
- `conversation-message.tsx`: Renders one conversation message: bot text in karaoke, captions or instant mode, and function call rows.
- `conversation.tsx`: Scrolling conversation list that auto-scrolls to the newest message unless the reader has scrolled away.
- `kit.test.tsx`: Tests that the copied kit files render metric tiles, metric charts and function call rows.
- `metric.tsx`: Single metric tile showing a value, a unit and an empty placeholder.
- `wave-shader.tsx`: WebGL shader component that draws the wave visualizer's animated background.

## Rules

- These files are copied from the Pipecat user interface kit; kit.test.tsx checks that the copies still render.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
