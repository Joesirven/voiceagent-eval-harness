# AGENTS.md: `scripts/`

Command-line scripts for the harness: building and checking the decision tree, judging and simulating calls, database maintenance, and smoke checks.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../AGENTS.md).

## Contents

- [`flows-editor/`](flows-editor/AGENTS.md): Bridge between the Pipecat flows visual editor and the harness: export, import, check and catalog sync.
- `assemble-decision-tree.ts`: Assembles six decision tree fragments into the single tree the harness loads, deterministically.
- `call_tree_flow_tool.py`: Calls tools of a compiled tree flow at chosen nodes and prints where each call leads, as JSON.
- `check_flows_runtime.py`: Runs the flow runtime through fixed offline scenarios (schemas, tool call, gated answer, start) and prints results.
- `check_tree_flow.py`: Loads a compiled tree flow and prints node, function, handler and branch summaries, with schema checks.
- `compile-tree-flow.ts`: Compiles the full decision tree into the Pipecat Flows configuration file; output is generated, not hand edited.
- `harness-db.ts`: Applies, verifies, smoke-tests and rule-checks the harness database; prints no row content.
- `import-training-output.ts`: One-time import of reviewed training outputs into behaviour data files; re-running overwrites hand edits.
- `judges-fable.ts`: Runs the Fable analysis over stored call records and writes a report and worksheet of disagreements.
- `judges-whole-call.ts`: Plays simulated whole calls against the agent with a simulated lead and grades each call.
- `list-azure-deployments.ts`: Read-only listing of the model deployments on the Azure endpoint; prints no host or key.
- `probe-protocol.ts`: Billed probe of a live voice session setting; prints event kinds only.
- `purge-records.ts`: Deletes every call and text record stored on disk by the harness.
- `score-diarization.ts`: Scores one diarization result against a reference and prints aggregate numbers only.
- `simulate-personas.ts`: Runs a bounded batch of whole-call simulations, one per persona or real call, in its own process.
- `smoke-lab-demo.ts`: Live demo of the lab voice agent through the typed-text path; the call is real and billed.
- `smoke-orchestration-pipecat.ts`: Synthetic text smoke test of the Pipecat orchestration session; not a model conversation.
- `smoke-voice.ts`: One short real session with the Azure live voice model, billed; prints counts and spoken lines only.
- `spot-check-page.mjs`: Loopback-only web page for reviewing clips one at a time and recording right or wrong answers.
- `validate-decision-tree.ts`: Lists every problem in a decision tree file; exits 0 when the tree is sound.

## Rules

- Scripts that need credentials read them from a dotenv file named by an environment variable; never print values from it.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
