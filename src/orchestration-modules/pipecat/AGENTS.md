# AGENTS.md: `src/orchestration-modules/pipecat/`

Python code run by the Pipecat sidecars and the decision tree flow runtime. Also holds the pinned Python requirements for production and developer tools.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- `devtools.py`: Opt-in local Whisker recording for the sidecars; off unless an environment switch is set.
- `flow_handlers.py`: Builds the flow handler map from tree decision handlers and catalog tool handlers.
- `flow_tools.py`: Catalog tools as Pipecat Flows functions; each asks the Node dispatcher for its result.
- `flows_runtime.py`: Runs the compiled decision tree flow and reports node, judge and tool events to Node.
- `requirements-dev.txt`: Developer-only pinned extras, including the Whisker recorder; install into a copy of the environment.
- `requirements.txt`: Pinned production Python packages: Pipecat 1.13.0 with the Deepgram extra.
- `sidecar.py`: Local standard input and output bridge running a Pipecat pipeline for text decisions.
- `sidecar_deepgram.py`: Pipecat voice pipeline on Deepgram speech to text and text to speech, with an Azure reply model.
- `sidecar_voice.py`: Pipecat worker that relays caller audio to the Node host and model audio back.
- `tree_flow.py`: Builds the decision tree as a Pipecat Flows flow by joining compiled YAML to generated handlers.

## Rules

- Production installs need only requirements.txt; developer tools are opt-in.
- Pipecat is pinned to version 1.13.0; the sidecars refuse to run on any other version.
- Install developer requirements into a copy of the Pipecat environment, not the shared one.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
