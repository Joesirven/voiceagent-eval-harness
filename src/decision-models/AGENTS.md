# AGENTS.md: `src/decision-models/`

Adapters that let the voice agent's decision tree ask a fast model one closed, typed question about a conversation. Each adapter has a deterministic mock, and a catalog hands out the real model when its credential is present.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `azure.ts`: Decision model on Azure AI Foundry, using a decision deployment or a chat fallback deployment.
- `bridge.ts`: Turns any decision model into the tree engine's decision module, with reasons written from fixed templates.
- `catalog.ts`: Lists every decision model adapter and returns the real model or its mock, saying which one.
- `credentials.ts`: Loads decision model credentials through the shared credential loader, with a file fallback.
- `gateway.ts`: Decision models behind the Vercel AI Gateway, including Jev, with zero data retention headers.
- `http.ts`: Shared JSON POST helper with timeout that maps every failure to a short code.
- `index.ts`: Re-exports the public parts of the decision model package.
- `mocks.ts`: Deterministic keyword-based mock for each adapter, with no network calls and simulated latency.
- `openai-decisions.ts`: Adapter for the OpenAI Decisions API beta, mapping its probability list to answer confidence.
- `redact.ts`: Masks emails, phone numbers, identifiers and long digit runs before any text leaves for a provider.
- `state.ts`: Builds the conversation text and closed question sent to every provider, and reads answers back.
- `system-one.ts`: System One route used by Jev direct and self-hosted Kev, refusing plain http except to localhost.
- `types.ts`: Contract for decision models: request, answer, failure shapes, and call options.

## Rules

- Decision models never throw. Failures come back as results with a reason and a short code.
- Redaction is best effort. The transport's data retention settings are the real guarantee.
- Tests must pass credentials in so they never read a credential file.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
