# AGENTS.md: `docs/`

Design notes, research, interface contracts, and status summaries for the voice agent evaluation harness.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../AGENTS.md).

## Contents

- `ARCHITECTURE.md`: How the engine, harness, console, and optional integrations connect.
- [`voice-bakeoff/`](voice-bakeoff/AGENTS.md): Voice bake-off material; holds the configs folder.
- `behaviour-layers.md`: Contract for the behaviour layers: enforced rules, legal blocks, guard seams and the prompt builder.
- `decision-models-and-judges.md`: Decision model adapters, their mocks, credential sources, and the live and offline judges.
- `decision-tree-and-judge.md`: Rules in the judge gate that still refuse actions, checked action by action against the full tree.
- `decision-tree-flow.md`: How the decision tree compiles into a Pipecat Flows YAML file and its generated Python handlers.
- `interfaces.md`: Frozen interfaces the workstreams build against, such as the test mode switch and the decision module.
- `lab-voice-agent.md`: Branch summary of the insurance sales lab voice agent: prompt, context injection and tool calling.
- `lead-setups.md`: Lead setup parts: lead picker, profiles, prompt setups, persona card, run table and safety rules.
- `live-trace-and-records.md`: Live trace events, local records, live call views, and browser Talk on the Azure live model.
- `live-voice.md`: Local browser voice testing on the Azure live model: path, guard, barge-in, limits and voice paths.
- `memory-context.md`: How the harness models per-lead memory, in-call state and handoff notes, for a later production port.
- `orchestration-modules.md`: Contract for swappable orchestration modules, with supported paths for own infrastructure and Pipecat.
- `research-voice-stacks.md`: Research on voice calling platforms and stacks, with ranked findings and eight options.
- `scenario-coverage.md`: Audit mapping the required trial scenarios to the tests that cover them.

## Rules

- Use the configured local port for browser testing.
- Citations in behaviour files are data only and never go into prompt text.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
