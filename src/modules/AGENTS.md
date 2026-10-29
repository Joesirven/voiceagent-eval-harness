# AGENTS.md: `src/modules/`

Voice option modules: one per voice provider, behind one shared mock base class and a registry. Live Azure speech-to-speech sessions, the Azure and Deepgram model catalogs, and the Voice Live step-by-step flow also live here.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../AGENTS.md).

## Contents

- `agent-instructions.ts`: Builds agent-bound instructions and blocks persona truth markers from reaching the live agent.
- `azure-catalog.ts`: Lists the models actually deployed on the Azure resource and assigns each a role.
- `azure-gpt-live.ts`: Azure gpt-live-1 voice module, the default; scripted calls use a mock session.
- `azure-live-session.ts`: One live speech-to-speech session with the Azure gpt-live-1 deployment over an injected socket.
- `azure-realtime.ts`: Mock Azure realtime session store that keeps lead context packets per call.
- `azure-voice-live-session.ts`: One call on Azure Voice Live, with barge-in, flow tools and the harness-triggered replies.
- `base-module.ts`: Shared mock voice module base class, config types and the one VoiceProvider interface.
- `bland.ts`: Mock Bland AI voice module, disabled by default, with no network calls.
- `deepgram-catalog.ts`: Asks Deepgram which speech models the account can use, cached for a few minutes.
- `elevenlabs-agents.ts`: Mock ElevenLabs Agents voice module, disabled by default, with no network calls.
- `fish-audio.ts`: Mock Fish Audio Agents voice module, disabled by default, with no network calls.
- `open-live-session.ts`: Type definition for the browser-relayed live session surface (Azure gpt-live-1 only).
- `openai-realtime.ts`: Mock OpenAI gpt-realtime voice module whose model menu comes from the Azure live deployments.
- `prompt-setup.ts`: Harness prompt setup: standing rules plus lead packet for agents, and simulated-caller personas kept separate.
- `registry.ts`: The one place that knows every voice module; selects one for routing and applies defaults.
- `retell.ts`: Mock Retell AI voice module, disabled by default, with no network calls.
- `sesame.ts`: Mock Sesame voice module, disabled by default, with no network calls.
- `twilio-media-streams.ts`: Mock bidirectional Twilio Media Streams: one session per call, cleared on barge-in.
- `vapi.ts`: Mock Vapi voice module, disabled by default, with no network calls.
- `voice-live-flow.ts`: Turns the five-step conversation flow into Voice Live session updates, one per transition.

## Rules

- Agent-bound text must never contain persona truth markers such as revealMap or expectedDisposition; agent-instructions.ts checks this.
- Mock modules make no network calls; the live paths are azure-live-session.ts and azure-voice-live-session.ts.
- Only a clearance-issued call may be placed; see provider/clearance.ts.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
