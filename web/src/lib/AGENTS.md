# AGENTS.md: `web/src/lib/`

Browser-side helper modules for the voice agent evaluation harness console: the HTTP client, the live call event store, call metrics and transcript adapters, call audio hooks, Pipecat call and trace glue, and layout and label helpers. Most files turn trace rows from the shared live-view logic into what the React panels display.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- `api.ts`: HTTP helpers: a JSON fetch wrapper that throws readable errors, a toast-based action runner, and the fetch for voice options.
- `call-metrics.test.ts`: Tests for call metrics: stage timing, reply timings, tool timings, interim responses and objectives, built from sample trace events.
- `call-metrics.ts`: Running metrics and call objectives read from the trace alone, so they work both live and in replay.
- `calls-history.ts`: Loads leads and call history from the server's normalized endpoints, and shapes each call into one summary with its engine and model.
- `conversation-adapter.test.ts`: Tests that the conversation adapter turns sample call events into chat messages.
- `conversation-adapter.ts`: Turns trace groups, judge rows and reasoning results into conversation messages for the transcript and function-call views.
- `labels.ts`: Plain names and one-line descriptions for dropdown options such as orchestrators and voice paths, with server labels as fallback.
- `layout.ts`: Hook that remembers resizable panel sizes between visits in local storage.
- `live.ts`: Shared live view of the call event stream, with a subscription hook and connection state.
- `metrics-adapter.test.ts`: Tests that metric series are labelled simulated or measured correctly, using sample call events.
- `metrics-adapter.ts`: Converts trace rows into metric series for the charts, with labels that say whether each number was simulated or measured.
- `orb-state.test.ts`: Tests the orb state (idle, listening, thinking, talking, working) against sample event timelines.
- `orb-state.ts`: Works out the orb state from recent trace events, using hold times so the orb does not flicker.
- `pipecat-call.ts`: Runs a call on the local Pipecat engine through the server proxy, with a small external store for the call state and the preset configurations.
- `pipecat-flows.test.ts`: Tests the Pipecat Flows preset-to-request mapping for each flow, mover and speaker combination.
- `pipecat-trace.ts`: Turns Pipecat client events and the engine's polled call record into the same trace rows that other engines write.
- `tree.ts`: Helpers for the decision tree: words from ids, and folding follow-up nodes into the node that represents them.
- `types.ts`: Shared TypeScript types for voice modules, module info, choices and voice error records.
- `use-call-audio.test.tsx`: Tests the call audio hook against hand-driven published tracks.
- `use-call-audio.ts`: React hook that reads the call's caller and agent audio tracks from the microphone client, without opening a microphone.
- `use-call-view.test.tsx`: Tests the call view hook with mocked fetch calls and stored events.
- `use-call-view.ts`: React hook that builds the call view: sorted events, context text, the tree and replay data for one call.
- `utils.ts`: The cn class-name helper that merges Tailwind classes.
- `visualizer.ts`: Types and band settings for the audio level visualizer, with silent, speaking, thinking and connecting states.

## Rules

- Test files import shared fixtures from ../test/trace-fixtures and set up jsdom with the setup file where the browser APIs are needed.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
