# AGENTS.md: `src/server/voice/`

Server side of the live voice path for the harness test bench. It starts and manages one live session at a time, relays audio to Azure, Deepgram or Pipecat sidecars, and handles transfers to a person and the test phone dials.

Parent: [`../AGENTS.md`](../AGENTS.md). Root rules: [`AGENTS.md`](../../../AGENTS.md).

## Contents

- `azure-credentials.ts`: Loads the Azure realtime endpoint and key for the azure-gpt-live path; never logs them.
- `azure-deployments.ts`: Lists the live Azure deployments offered on the live-test route, matching the Settings model menu.
- `azure-voice-live-credentials.ts`: Reads the Azure Voice Live address and key from the dev environment file; the only module allowed to use that key.
- `decision-router.ts`: Stores the decision router chosen for each voice path until the server restarts.
- `deepgram-voice-runtime.ts`: Starts one Python Pipecat sidecar per Deepgram voice session and talks to it in JSON lines.
- `deepgram-voice-session.ts`: Node side of a Deepgram voice session: records trace events, runs the decision hook and enforces the session cap.
- `dev-env-file.ts`: Reads named keys from the dotenv file at VOICE_HARNESS_DEV_ENV_FILE for the test phone and Vapi call.
- `flow-runtime-bridge.ts`: Node side of the Pipecat Flows runtime for one call: traces nodes and decisions, answers judge and tool requests.
- `flow-tool-runner.ts`: Exposes the flow tool catalog as model function tools and runs each call through the flow tool dispatcher.
- `human-transfer.ts`: Rings the allowlisted cells through Twilio when a Talk call transfers to a person; the first to press 1 takes it.
- `live-thinker.ts`: Thinker for the direct Azure gpt-live path, run by Azure through the responses delegation with the flow tools.
- `loopback.ts`: Guard that accepts plain requests and websocket upgrades only from loopback hosts or names in HARNESS_ALLOWED_HOSTS.
- `manager.ts`: The one place that starts live voice sessions: one at a time, each capped at five minutes.
- `mic-environment.ts`: Browser microphone rules: needs a secure context, so remote plain HTTP hosts are refused with a fix message.
- `path-model-choices.ts`: Stores the model and voice chosen for each slot of a voice path until the server restarts.
- `pipecat-orchestrated-session.ts`: Live session where the Pipecat pipeline worker owns ordering and cancellation, with Azure gpt-live-1 as the speech model.
- `pipecat-voice-runtime.ts`: Starts one Pipecat pipeline worker subprocess per live session; it orders frames and cancellation only.
- `settings-log.ts`: Writes one log line per changed module setting, with old value, new value and the requesting source.
- `socket-route.ts`: Websocket at /api/voice/<callId>/socket that relays browser audio and text to the voice engine and back.
- `test-phone.ts`: Allowlisted test handset for real outbound dials; the number is never sent to the browser.
- `twilio-transfer-line.ts`: Twilio calls to the two allowlisted cells for transfers, plus a local listener that takes answered media streams.
- `vapi-test-call.ts`: Starts a real Vapi outbound test call using the generic example assistant snapshot, only to allowlisted numbers.
- `voice-client.js`: Browser client for live voice: mu-law audio at 8 kilohertz both ways, ringback, barge-in and the five-minute cap.
- `voice-errors.ts`: The one catalog of voice errors with fixed codes, plain titles and fixes; records them without secrets.
- `voice-options-builder.ts`: Builds the voice options response from what is deployed, leaving out any unavailable orchestrator or voice path.
- `voice-options.ts`: Contract for the voice options response: which orchestrators, voice paths and model choices are usable now.
- `voice-page.html`: Standalone simulator page for live voice tests, served by the dev server.

## Rules

- Dials only the allowlisted test numbers; placeCall refuses any other number.
- Secrets are read through the shared credential reader in src/connectors/credentials.ts and are never logged or returned to the browser.
- Node never reaches Azure directly from the browser; every line and event passes through the trace bus.
- Follow the root `AGENTS.md`.
- If you add, rename or remove a file here, update this list.

## Language Rule: No Acronyms
Never use unexplained acronyms in anything written here or in any agent-facing instruction: spell out "knowledge base", "decision record", "work in progress", and so on. Universally-lexicalized technical names (URL, JSON, SSH, API, iOS) and literal identifiers that must match files or code (for example the decision files named `DEC-2026-00N-*`) are allowed, glossed in plain words on first mention. Carry this rule verbatim into every AGENTS.md, CLAUDE.md, skill, or prompt you write or update.

Two additions with the same force (Jose, 2026-07-17), to carry forward the same way:
1. No nicknames or invented shorthand for tasks, concepts, projects, or things unless Jose introduced the name himself. Use the full, established name every time: the file name, the stream name Jose used, the product name. A coined codename or abbreviation of convenience is a name the reader has to reverse-engineer.
2. Em-dashes sparingly. Not banned, but rare: prefer commas, periods, colons, or parentheses. Most paragraphs should have zero; never more than one per paragraph.

A third addition with the same force (Jose, 2026-10-21), to carry forward the same way:
3. Write in ASD-STE100 Simplified Technical English (the aerospace maintenance controlled-language standard). If full compliance is too rigid, write 80% of the way to ASD-STE100. One idea per sentence. Keep sentences short. Active voice. Use commands for procedures. One meaning per word. Prefer simple words (start, not commence). No contractions. Avoid semicolons. Put the condition first: If X, then do Y. This applies to replies, agent-facing instructions, and knowledge-base prose you write. Do not rewrite source code, quoted material, or identifiers that must match files.
