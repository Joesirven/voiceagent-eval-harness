# AGENTS.md: `src/simulator/`

Simulated and live test calls for the voice agent. It holds the model-played leads built from synthetic personas or real cleared calls, the live text session driver, the grading of finished calls, and a deliberately bad agent used to prove the grader catches rule breaks. Model calls go only through Azure AI Foundry.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `bad-agent-fixture.ts`: Stand-in agent that breaks one calling rule per fixture, to check the gates catch it.
- `grade-live.ts`: Grading adjustments for calls where the agent speaks its own live words.
- `live-text-session.ts`: Runs a whole call where the agent speaks live words, driven by typed lead lines.
- `models.ts`: Model route for the simulator: Azure AI Foundry only, with a deployment per role.
- `persona-grade.ts`: Grades a finished simulated call against the persona's own expectations, from the trace.
- `persona-lead.ts`: Model-played lead that plays one synthetic persona on an Azure deployment.
- `persona.ts`: Adapter that turns one synthetic persona from the training archive into a simulation case.

## Rules

- Model calls go to Azure AI Foundry only. A Gateway-style model identifier is refused before anything is sent.
- The lead model must use a different deployment from the agent so a grader never grades its own model's words.
- Persona leads are never used on a live call.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
