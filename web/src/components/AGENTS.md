# AGENTS.md: `web/src/components/`

React components for the harness web page: the call view, call setup and settings dialogs, lead search and lead detail, the simulator, the decision tree views, the post-call score, and the flow editor frame. Most files pair with a test file of the same topic.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- [`ai-elements/`](ai-elements/AGENTS.md): Chat conversation and message parts adapted from the AI Elements kit, trimmed to plain text.
- [`console/`](console/AGENTS.md): Console pieces: the shell, conversation, judges, media, metrics, objectives, replay controls, and their tests.
- [`pipecat/`](pipecat/AGENTS.md): Pipecat-style display pieces: audio visualizers, conversation message, metrics and a wave shader, with a kit test.
- [`ui/`](ui/AGENTS.md): Reusable interface primitives such as buttons, dialogs, selects, tables, sheets, charts, the orb and waveform.
- `AgentContextEditor.tsx`: Collapsible editor for the lab agent's standing rules, a per-call override, and a preview of the lead block.
- `AgentSettings.tsx`: Lab voice agent settings for the next call: prompt, lead context gate, transcript write-back, thinker and presets.
- `CallOrb.tsx`: Animated orb and waveform showing whether the agent is listening, thinking, working on a step, or talking.
- `CallSetupDialog.tsx`: Dialog to choose orchestrator, voice path, models and flow, check warmup steps, then start a call.
- `CallTimeline.tsx`: Lanes that place caller turns, agent turns, tool calls and latency along the call's time.
- `CallView.tsx`: Main call pane joining the lead view, transcript, decision stage, score, judge and metrics for a call.
- `ErrorsPanel.tsx`: Shows each new voice error once as a toast and lists recent errors with their fix steps.
- `FlowEditorView.tsx`: Frame for the Pipecat flows editor, which runs as its own program and talks to the page by messages.
- `JudgeDialog.tsx`: Judge verdict table for a call (action, result, reason, confidence) and the post-call score text.
- `LeadDetail.tsx`: Record view for the lead chosen in the call bar, with its context rows and recent calls.
- `LeadSearch.tsx`: Lead search box and filters for trade, renewal window, call history and stage, used by two panes.
- `LeadsPanel.tsx`: Left pane to find a lead, see its calls, and open any call for replay with its transcript.
- `LiveVoiceCard.tsx`: Live voice call controls (lead, direction, Play, pause, end, clock) bound by element id to the microphone client.
- `RateCallDialog.tsx`: Dialog to rate a finished call on five criteria, plus the rating keys and the ratings board.
- `ScoreCard.tsx`: Post-call score card: overall number, model grade, each criterion with a bar, and the Rate this call button.
- `SettingsSheet.tsx`: Side panel for environment switches such as AI calling per agency and the lead database.
- `SimulatorView.tsx`: Simulator page with scenarios, a lead timeline lookup and run results in resizable panels.
- `Stage.tsx`: Shows where the call is in the decision tree: path so far, the question, and branches with score bars.
- `Transcript.tsx`: One column that puts each caller or agent line before its reasoning steps; shows text only, never markup.
- `TreeFocus.tsx`: Plain-words view of the current decision step, its question, and the next steps without ids.
- `TreeMap.tsx`: Decision tree drawn as an SVG map with the current node, visited nodes and taken edge highlighted.
- `call-controls.test.tsx`: Tests that the live voice controls keep every element id the microphone client binds to.
- `call-orb-waveform.test.tsx`: Tests the call orb's waveform bars against simulated call audio, using a stand-in canvas.
- `call-setup.test.tsx`: Tests the call setup dialog's options, voice steps and start behaviour with the voice client mocked.
- `context-panel.test.tsx`: Tests the lead view and settings button placement, and that agent context is not a separate pane.
- `flow-editor-routes-contract.test.tsx`: Runs the flows editor page against the real route handlers on a local server; skipped without the Pipecat interpreter.
- `flow-editor-view.test.tsx`: Tests the flows editor view: function names by node, usage in the flow, and the tool catalog display.
- `live-columns.test.tsx`: Tests the combined transcript and reasoning column and the judge table.
- `settings-controls.tsx`: Shared setup controls: a labelled dropdown, the voice options loader, and the voice path and model steps.
- `settings.test.tsx`: Tests the settings panel, which holds only the environment switches.
- `tree-focus.test.tsx`: Tests that the decision tree next steps read in plain words and show no internal ids.

## Rules

- Element ids in LiveVoiceCard.tsx and settings-controls.tsx are kept on purpose: the shared microphone client finds its elements by id.
- Caller words are untrusted: render them as React text, never as markup (Transcript.tsx, ai-elements/message.tsx).
- Test files in this folder start with the jsdom environment comment and use @testing-library/react.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
