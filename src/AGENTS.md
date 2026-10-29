# AGENTS.md: `src/`

The main TypeScript source of the CRM harness, the test bench for the voice agent. It holds the call logic, compliance checks, decision engines, lead context, judges, simulators, server routes and stores, grouped by job.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../AGENTS.md).

## Contents

- [`behaviour/`](behaviour/AGENTS.md): Behaviour layer: enforcement rules, speech guard, prompt builder and grading rubric data.
- [`compliance/`](compliance/AGENTS.md): Legal checks for calls and texts: consent, disclosures, outbound schedule, quiet hours, STOP handling and suppression.
- [`connectors/`](connectors/AGENTS.md): Shared credential loading and JSON HTTP client used by outside connectors.
- [`decision-models/`](decision-models/AGENTS.md): Adapters for decision models: Azure, bridge, gateway, HTTP, OpenAI, mocks, catalog and redaction of model inputs.
- [`decision-tree/`](decision-tree/AGENTS.md): Loads, compiles and validates the decision tree flow files (YAML and JSON) that guide a call.
- [`decision/`](decision/AGENTS.md): Decision engine: runs actions, extraction, interactive calls, outbound attempts, recording and module registry.
- [`diarization/`](diarization/AGENTS.md): Speaker separation: Azure diarization client, its contract and scoring.
- [`flow-tools/`](flow-tools/AGENTS.md): Tools a voice flow can call (catalog, dispatch, filings, quotes, reads) for the flows editor and live voice runs.
- [`harness/`](harness/AGENTS.md): Call harness that places or simulates a call, applies gates, guards the agent line and handles test stops.
- [`judge/`](judge/AGENTS.md): Call judging: gate, post-call judge, rule-based judge and shared types.
- [`judging/`](judging/AGENTS.md): Live and post-call scoring: objectives, definitions, questions and score calculation.
- [`lead-context/`](lead-context/AGENTS.md): Builds the lead context the agent sees: facts, checklist, renewal dates, call stage, last conversation and live updates.
- [`memory/`](memory/AGENTS.md): Briefings, context, evidence and handoff notes kept about a lead.
- [`models/`](models/AGENTS.md): Model client for Foundry (foundry.ts).
- [`modules/`](modules/AGENTS.md): Voice and text modules: agent instructions, Azure live and realtime sessions, Bland, ElevenLabs, Fish Audio, Deepgram and open live sessions, plus base module.
- [`orchestration-modules/`](orchestration-modules/AGENTS.md): Orchestration modules that run a session through Pipecat or the harness's own infrastructure, with shared contract and config.
- [`orchestration/`](orchestration/AGENTS.md): Call loop that drives a call from start to finish.
- [`provider/`](provider/AGENTS.md): Provider interface and clearance check for voice providers.
- [`scenarios/`](scenarios/AGENTS.md): Trial scenarios used in tests and simulated runs.
- [`server/`](server/AGENTS.md): Development server, routes, live test and live view, call history, warm-up, lead search, objectives and flow editor routes.
- [`setups/`](setups/AGENTS.md): Prompt setups, agent settings, lead picker and profile, run writer and sink, persona card, routes and local Postgres helper.
- [`simulator/`](simulator/AGENTS.md): Simulated callers (personas and leads), live text sessions, real call helpers and grading of live and persona runs.
- [`store/`](store/AGENTS.md): Mock lead storage, the `LeadStore` plug-in interface, call logs, run rows and generic helpers.
- [`tools/`](tools/AGENTS.md): Agent tools definitions (agent-tools.ts).
- [`trace/`](trace/AGENTS.md): Event trace: event records, extensions, narration and an index.
- [`transcripts/`](transcripts/AGENTS.md): Transcript redaction.
- [`types/`](types/AGENTS.md): Shared type definitions, such as the clock type.
- `config.ts`: Harness configuration type and defaults, including agency flags and legal blocks mode.

## Rules

- The legal blocks default is enforced. Only the local development server starts suspended (src/config.ts).
- In test mode, the dial path must reach only an allowlisted test phone, a browser or a simulated line.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
