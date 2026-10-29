# AGENTS.md: `web/src/components/console/`

Panes and shell of the live call console: the conversation, judges, media, metrics, objectives and now board, plus the layout that arranges them. The test files here check these components side by side.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../../AGENTS.md).

## Contents

- `ConversationPane.tsx`: Conversation column with transcript tabs and reasoning rows for decisions, judge verdicts and tool calls.
- `VoiceAgentConsole.tsx`: Console shell that lays out the panes, switching between wide panels and narrow tabs by width.
- `JudgesPane.tsx`: Bottom pane with the judges tab, a raw trace list with plain sentences, and recent voice errors.
- `MediaPane.tsx`: Media pane with agent and caller audio visualizers and the call controls underneath.
- `MetricsPane.tsx`: Running metrics of the call in view: caller wait, model response time, tool timings and interim responses.
- `NowBoard.tsx`: Summary of the current call: disposition, latest decision with confidence, next agent line, judge scoreboard.
- `ObjectivesPane.tsx`: Call stage strip, objectives the judge checks off, and quote fields the lead record still needs.
- `WatchReplayControls.tsx`: Controls to pick a live call to watch, or to replay and step through a stored call.
- `console-controls.test.tsx`: Tests that the call controls survive a layout change without remounting.
- `console-panes.test.tsx`: Tests the metrics, objectives and judges panes against a stubbed call view model.
- `console-shell.test.tsx`: Tests the console shell: width-based layout and watch and replay controls with stubbed panes.
- `conversation-pane.test.tsx`: Tests the conversation pane: transcript text, reasoning rows, empty state and metrics tab.
- `media-pane.test.tsx`: Tests the media pane idle, connecting and ready states and the track each visualizer gets.
- `media-visualizers.test.tsx`: Tests the media pane with the real visualizers, using faked audio and drawing pieces.
- `panel.tsx`: Shared panel chrome for the console and the useMinWidth hook that reads a viewport width.

## Rules

- Tests replace the pane modules and the call view hook with stubs, so keep those module names and exports when renaming.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
