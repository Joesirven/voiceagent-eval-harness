# Swappable orchestration modules

Candidate for . Shared server routes, browser controls, core harness,
judges and persistence are deliberately outside this candidate's integration scope.

## Contract and supported paths

`src/orchestration-modules/index.ts` exports the registry, session, contracts,
`OwnInfrastructureModule` and `PipecatModule`. Orchestration selection is separate
from the existing voice registry. A session snapshots its orchestration, mode,
voice provider, decision model, prompt setup, decision route and configuration
revision. Changing registry selection affects future sessions. Existing sessions
keep their adapter and frozen snapshot. A content-derived `snapshotId`, unique
`sessionId`, `traceId`, ordered sequence and ISO timestamp accompany every event.
Snapshots contain identifiers only, never credential objects or prompt bodies.

| Path | Own infrastructure | Pipecat 1.13.0 |
| --- | --- | --- |
| Manual live text | Supported | Supported with pinned interpreter |
| Text supplied by an external automated lead | Supported | Supported with pinned interpreter |
| the operator speaks through a live audio transport | Unavailable in this adapter (the dev server's direct Azure Talk path covers it) | Live Talk only, through `sidecar_voice.py` and `src/server/voice/pipecat-orchestrated-session.ts` (see below) |
| Automated audio input/output | Unavailable | Unavailable |
| Graceful drain and end | Supported | Real `EndFrame` |
| Cancel during a decision | Abort signal; discard late output | Real `worker.cancel()` / `CancelFrame`, bounded forced termination if hung |

Manual text is not live voice. `liveText` must not be used to enable a microphone
control. Neither adapter claims audio playback, speech recognition, speech
synthesis, interruption handling or a model conversation. The deterministic
smoke supplies synthetic text and a synthetic decision function. Both modules
reject audio before resource creation. The Pipecat capabilities report missing
interpreter configuration as `unavailableReason`; startup additionally verifies
that the installed package is exactly `pipecat-ai==1.13.0`. No failure selects
the other adapter.

The own infrastructure adapter reuses the existing `eventsFromScript` and
`collectFinalTranscript` ordering functions from `src/orchestration/call-loop.ts`
around a host-supplied decision reply. It does not call an unapproved interactive
implementation or claim to run the complete harness by itself.

## Integration boundary

Install modules once, select a default with `registry.select(id)`, and create a
session with `registry.createSession(config, decisionRuntime, options)`. A
per-session `orchestrationId` overrides the default. `start()`, `say(text)`,
`end()` and `cancel()` are identical for both modules. `options.systemInstruction`
is required: standing rules plus the lead packet, built with
`buildAgentSystemInstruction` (see `docs/memory-context.md`). Session construction
rejects an instruction carrying simulated caller persona markers. `say` returns the agent
line, allowing the canonical `SimulatedLead.next(agentLine) => line | null` to
supply the next caller turn externally. There is no simulator loop, persona copy,
batch runner or invented outcome calculation here.

**Before wiring, read the latest  comments.** The module owner's canonical
simulator is in `src/judging/offline/{simulated-lead.ts,whole-call.ts,types.ts}`
on its separate branch and must arrive as an approved commit. Its whole-call
path is `startInteractiveCall` then `say`; outcomes come from the harness trace.
Do not copy its uncommitted code or run its unapproved direct Claude path.
Reuse the existing synthetic persona schema and source for live persona cards.

The integrator must retain `startInteractiveCall` clearance and the existing
judge/mutation boundary before installing a session. `DecisionRuntime.reply`
is a server-installed seam for the approved call's guarded decision path;
this module grants no clearance and performs no writes, judging, dialing or
text messaging. Its `agent_text` event means a text response was delivered,
not that audio was spoken or a business outcome verified. A trace bridge may
consume `onEvent`; this candidate never mutates shared trace records itself.
Event consumers own their persistence and observer errors.

`decisionRoute` permits `deterministic` or `azure-foundry` and must match the
installed runtime. Runtime functions are trusted server code, never browser
configuration. The production runtime must use the existing Azure credential
loader and frozen Foundry client contract at `235430e`; no model library or
credentials are installed in the sidecar. No actual Azure model call was made
or verified for this candidate. Paid model calls still require `router_spend`.

## Lifecycle, errors and transport seam

Sessions progress from `created` through `starting`, `active`, `ending` and
`ended`; `cancelled` and `failed` are terminal. Graceful end rejects newly
submitted turns, drains accepted turns and waits for runtime shutdown. Cancel
preempts startup, active decisions and queued turns; late replies cannot emit
agent events. Turn work and startup/end have a configurable bound, defaulting to
15 seconds. Cancellation gives the sidecar 500 milliseconds for graceful
cancellation before forced termination. It does not promise to undo effects
already performed by a host callback. Callbacks must honor the abort signal
and retain existing mutation guards.

`OrchestrationError.code` uses a fixed code, including `unavailable`,
`unsupported_capability`, `provider_failed`, `protocol_error`, `timeout` or
`cancelled`. Exceptions from decisions or subprocesses never enter trace events.
Unexpected runtime termination also reports failure while the session is idle.
Identifiers and raw caller/agent text are trace data; keep that data within the
existing authorized local harness boundary.

`OrchestrationTransport` is the stable resource seam: `open(signal, onFailure)`,
`exchange(text, reply, signal)`, `close()` and `cancel()`. The Pipecat implementation
starts one Python process per session over standard input/output JSON lines.
Caller text enters a real `CallerText(TextFrame)`, `DecisionBridge` requests the
host decision, and an `AgentText(TextFrame)` passes through `OutputBridge` before
a result is returned. `StartFrame` confirms readiness; `EndFrame` drains the
pipeline; cancel calls the real worker. A disconnected host cancels the worker.
Library diagnostics are drained without forwarding and child environment
variables are allowlisted, so development credentials are never inherited.

Live Talk on the dev server (added after this candidate, from `6f917ff` on master and `40e4d1d` and `3dfa7be` on the Talk branch) runs a separate voice sidecar, `sidecar_voice.py`: browser microphone μ-law 8 kHz frames pass through a Pipecat `PipelineWorker` to an Azure gpt-live-1 session, and agent audio comes back the same way. It is selected per Talk session from the Call tab and is not exposed through this module's `audio` capability flags, which stay false. A caller barge-in reaches the sidecar as a Pipecat `InterruptionFrame`, which drops queued agent audio and leaves the worker running. It used to be a `CancelFrame`, which ends the pipeline: on the operator's first real Pipecat Talk call (2026-10-19) caller audio stopped reaching Azure at the caller's first barge-in, with no error logged. `tests/scenarios/pipecat-microphone-call.test.ts` covers this against the pinned sidecar and a local fake Azure server.

Further live audio work should extend this same Pipecat transport and sidecar, adding
explicit typed audio methods and tested capability flags while retaining the
session lifecycle, host decision bridge and cancellation. It needs actual
Pipecat transport input/output processors, sample-rate/encoding agreement,
Azure speech/model services through approved server loaders, and tested
browser transport wiring. Do not create a second Pipecat integration or enable
audio flags based on text tests.

## Deepgram voice path: standard input and output protocol

Agreed between the Node side (`src/server/voice/deepgram-voice-runtime.ts`, `deepgram-voice-session.ts`) and the Python side (`src/orchestration-modules/pipecat/sidecar_deepgram.py`) on 2026-10-19. The Call tab "Voice path" picker chooses it for the next Talk session (`POST /api/voice/path` with `voicePathId`: `azure_gpt_live`, the default, or `deepgram`; shown in `/api/state` as `voicePaths` and `selectedVoicePathId`). It is separate from the orchestrator picker.

Framing: one JSON object per line. The child is started as `python -I -u <sidecar>` with exactly this environment: `PATH`, `PYTHONIOENCODING`, `DEEPGRAM_API_KEY`, `AZURE_FOUNDRY_URL` (the `/openai/v1` route), `AZURE_FOUNDRY_KEY` and optionally `AZURE_REPLY_DEPLOYMENT`. Credentials never travel in messages. Audio is base64 mu-law at 8 kilohertz, at most 48000 raw bytes per message. Standard error carries only Pipecat's warnings and errors as a level and a source location (module, function, line), never message text, exception text, tracebacks or local values, since those can quote provider error bodies and addresses; the standard logging module (asyncio's unretrieved task errors among them), warnings and uncaught exceptions are cut down the same way, to a level and a logger or exception type name; Node forwards it to the dev log at warning level, scrubbed of credentials and rate limited.

Node to Python:

| Message | Meaning |
| --- | --- |
| `{"type":"start","instructions","disclosure","turn_gap_ms","stale_output_cap_gaps":0\|1\|2,"guard":bool,"voice"?,"stt_model"?,"decision_router"?,"direction"?}` | First line, written before ready. `decision_router` is `decision_model` (default: the guidance wait below), `pipecat_flows` or `pipecat_classifier`; any other router is loaded from its module in the pipecat folder (`flows_runtime.py`, `classifier_runtime.py`) and replies without the guidance wait, sending its own requests to Node and taking Node's `flow_reply` lines; a missing module refuses the start. `direction` is `inbound` (default) or `outbound`, the start node the router enters after the disclosure. `instructions` is the full agent instruction; `disclosure` is spoken word for word first; `voice` is an optional Aura-2 voice id (Python validates it, default `aura-2-thalia-en`); `stt_model` is an optional Deepgram speech to text model, the exact `model` query value (Python validates its shape, default `nova-3-general`). Node sends both from the Deepgram path's choices in Settings (`POST /api/voice/path-models`, slots `text_to_speech` with `selectedVoice` and `speech_to_text` with `selectedId`). |
| `{"type":"audio_in","data"}` | Caller microphone. |
| `{"type":"caller_text","text"}` | Typed caller line. Treated as a finished line: the sidecar answers with `caller_final`. During the disclosure it is held like a spoken line (see `agent_line`). |
| `{"type":"guidance","turn","text":str\|null}` | The decision module's reply to `caller_final` for that turn: the meaning to say next, or null to reply naturally. The sidecar waits up to 4 seconds, then replies without it; guidance for an older turn is ignored. |
| `{"type":"line_verdict","line_id","text":str\|null}` | With `guard` true: the checked line (possibly edited) or null to block. The sidecar holds the reply text, so no audio exists before the verdict; it allows the line after 2 seconds without one. |
| `{"type":"barge_in"}` | The browser heard the caller over the agent. Ignored while the disclosure is protected (see `agent_line`); otherwise the sidecar interrupts a busy agent and answers with `cleared` reason `host_barge_in`. |
| `{"type":"end"}` / `{"type":"cancel"}` | Graceful drain / immediate stop. |

Python to Node:

| Message | Meaning |
| --- | --- |
| `{"id":0,"type":"ready"}` | After the pipeline is built (or `{"error":"unavailable"\|"failed"}`); the sidecar then speaks the disclosure. Node allows 20 seconds. |
| `{"type":"audio_out","data"}` | Agent speech to play. |
| `{"type":"cleared","reason":"interim_transcript"\|"final_transcript"\|"typed_text"\|"host_barge_in"\|"reply_failed"}` | Queued agent audio dropped; in order with `audio_out` (everything before is stale, everything after is fresh). `reason` says what interrupted: an interim Deepgram transcript of at least 2 words while the agent is audible, a final transcript or typed `caller_text` while the agent is busy (replying or audible), the host's `barge_in`, or a reply that failed after some of its text had gone to text to speech (see `warning`). Node always relays it to the browser's playback clear, but not before the disclosure has played in the browser: the sidecar's protection ends when its audio was sent, so a `cleared` that arrives while Node still protects the disclosure is traced at once and applied at the end of the disclosure's window, and the `audio_out` that follows it waits until then; Node's own clear from the browser's loudness barge-in has reason `browser_loudness`, and a `cleared` within 400 milliseconds of it records no second `clear_playback` trace. |
| `{"type":"caller_partial","text"}` | Optional live caption; not traced. Node logs its timing (milliseconds since the agent's last audio) and word count to the dev log, never the words. |
| `{"type":"caller_final","turn","text"}` | Finished caller line; `turn` counts from 1. Node runs the decision hook and answers with `guidance`. |
| `{"type":"agent_line","line_id","text","interrupted"}` | Once per reply, when it is complete; `interrupted` carries only the text spoken so far. Spoken pieces are joined the way Pipecat's aggregator joins them (it honors `includes_inter_frame_spaces`), so sentences read "that. Could", not "that.Could". A reply that fails before any word was spoken is not reported (a `warning` says why). The disclosure is reported exactly once as `line_id` 0, when text to speech stops (its stop frame), always, even with empty `text`, and with `interrupted` true only if a pipeline error cut it (an empty line 0 means none of it was spoken: Node traces `disclosure_check` failed with reason `disclosure_not_spoken` and records nothing as said): Node records it then, and no `line_verdict` is awaited for it. That is before the browser has played it all: the sidecar keeps protecting it until its own audible window (the audio it sent, at real time) has passed, and Node must too: Node ignores the browser's barge-in (no playback clear, no `barge_in` sent) until the audio it relayed has played at real time plus 250 milliseconds, counted from `agent_line` 0 (or from any later line, should line 0 never come). While it is protected, interim and final transcripts, typed `caller_text` and `barge_in` interrupt nothing; caller words are kept, and the caller line is finished (`caller_final`) only after `agent_line` 0, even if the turn gap passed during the disclosure. |
| `{"type":"stale_dropped","chunks"}` | Optional and not sent by the current sidecar (Pipecat cancels an interrupted reply and its queued speech at the source). If it is ever sent, Node traces `drop_stale_agent_audio`. |
| `{"type":"stats","audio_in","stt_final","tts_chunks"}` | Counts only: on the first `audio_in` and every 50th. Node logs them to the dev log. |
| `{"type":"metrics","turn","stage":"speech_to_text"\|"reply"\|"text_to_speech","kind":"time_to_first_byte"\|"processing","milliseconds"}` | Pipecat's service metrics (`enable_metrics` and `enable_usage_metrics` are on), one message per measurement: integers and fixed names only. `turn` is the latest caller turn when it was measured (0 for the disclosure). Usage metrics and zero readings are not sent. Stage `speech_to_text` is not sent yet: Pipecat starts speech to text time to first byte only at a voice activity detector's stop frame, and Deepgram speech to text has no processing metric, so it needs a voice activity detector (later work, alongside the output transport). Node accepts the stage for then. Node traces them per turn. |
| `{"type":"warning","code"}` | A non-fatal pipeline error, with the same fixed codes as `error`. The call goes on: Pipecat's services retry or reconnect. When the reply model or text to speech failed, the sidecar settles the current line and speaks one fallback line, "Sorry, could you say that again?", as a new reply line (its own `line_id` and `agent_line`), at most once per caller turn; a failed disclosure or fallback gets none. With the line check on, a reply the check already settled (empty) still gets its fallback. If some of the failed reply's text had already gone to text to speech, it is cut first (`cleared` reason `reply_failed`), so its speech is not taken for the fallback's. A caller line held behind the failed reply is answered after the fallback line. Node traces it and does not end the session. |
| `{"type":"error","code"}` | Fixed codes only: `deepgram_failed`, `deepgram_key_rejected`, `azure_failed`, `azure_auth_failed`, `azure_deployment_not_found`, `azure_rate_limited`, `protocol_error`. Sent only for a fatal error, following Pipecat's own worker rule: the error is marked fatal (deprecated in Pipecat), or the processor that raised it can no longer be used (a permanent category such as rejected credentials or an unknown deployment, or a reconnect that gave up). Node ends the session. |
| `{"type":"ended"}` | Sent once after end, cancel or an error. |

The interruption gates (the protected disclosure, and the 2 word and audible rule for interim transcripts) stand in for Pipecat's MuteUntilFirstBotCompleteUserMuteStrategy and MinWordsUserTurnStartStrategy, which need an output transport this pipeline does not have yet.

Pipecat cancels an interrupted reply and its queued speech at the source, so the sidecar has no separate stale-output drop and never sends `stale_dropped`; Node must not drop audio either, because `cleared` already separates stale from fresh and dropping would lose fresh speech. The guard hold (reply text, and so its audio, waits for `line_verdict`) is done in the sidecar. The sidecar tests (`tests/orchestration-modules/pipecat-deepgram-sidecar.test.ts`) show that no `audio_out` follows `cleared` for any `stale_output_cap_gaps` (0, 1, 2), so the field needs no extra drop; with `guard` true, `agent_line` is sent once before speech, no audio exists before `line_verdict`, and a null verdict says nothing; without `guard` there is one `agent_line` per reply, at completion or interruption. A typed `caller_text` or a final transcript while the agent is busy interrupts it first, outside the protected disclosure. Node keeps the disclosure record (from `agent_line` 0), the decision hook, every trace event (`voice_session_open` with `provider: "deepgram"`, transcripts or turns, `clear_playback`, `guard_agent_line`, `steer_voice_model`, `spoken_vs_intended`, `drop_stale_agent_audio`, `voice_provider_error`, `voice_provider_warning` (success false, reason the fixed code; the session goes on), `voice_metrics` (inputs `turn`, `stage`, `kind`, `milliseconds`), `barge_in_ignored` (reason `disclosure_playing`, once per call), `voice_session_close`; a sidecar error ends the session with reason `deepgram_error`), the line guard decision and the five minute cap. Tests run against `tests/helpers/fake-deepgram-sidecar.mjs`, which follows this table.

## Debugging with Whisker

Whisker (`pipecat-ai-whisker`, Pipecat's pipeline debugger) records every frame that crosses a sidecar's pipeline. It is off by default and developer-only: `requirements.txt` does not include it, and `src/orchestration-modules/pipecat/devtools.py` imports nothing unless a switch is set. The text, audio relay and Deepgram sidecars (`sidecar.py`, `sidecar_voice.py`, `sidecar_deepgram.py`) each call `devtools.attach(runner, worker)` once, after `runner.add_workers(worker)`, and Node passes the `VOICE_HARNESS_WHISKER` switches through to each sidecar's environment (nothing else). If `devtools.py` is missing or broken the sidecar prints a line on standard error and carries on.

- `VOICE_HARNESS_WHISKER=file` writes `data/whisker/<call id>.whisk` (git-ignored; `VOICE_HARNESS_WHISKER_DIR` overrides the folder). The call id comes from the argument, then `VOICE_HARNESS_CALL_ID`, then a timestamp and process id, and is reduced to letters, digits, `_` and `-`.
- `VOICE_HARNESS_WHISKER=live` also runs a Whisker server on `127.0.0.1:9090` (`VOICE_HARNESS_WHISKER_PORT` overrides the port) and still records the file. If the port is taken, the call records to the file only.
- Unset, empty or any other value does nothing. If the package is not installed the helper logs one line to standard error and carries on.
- Call content stays on this machine: loopback only, and never the hosted interface at whisker.pipecat.ai or ngrok. Do not point a recording at either. Loopback does not protect against other web pages open in your own browser: the Whisker server accepts a websocket from any origin, so use live mode only in a browser with no other pages open (file mode has no such exposure).

Install into a copy of the Pipecat environment, not the shared one: `uv venv --python 3.12 /tmp/voice-agent-pipecat-venv-devtools`, then `uv pip install --python /tmp/voice-agent-pipecat-venv-devtools/bin/python -r src/orchestration-modules/pipecat/requirements-dev.txt`. Whisker requires `websockets<16`, so it cannot share an environment with a newer `websockets`. Start the dev server or a test with `VOICE_HARNESS_PIPECAT_PYTHON=/tmp/voice-agent-pipecat-venv-devtools/bin/python` plus `VOICE_HARNESS_WHISKER=file` (or `live`). Measured on 2026-10-20: with `websockets` 15.0.1 (forced by Whisker) three Deepgram sidecar tests timed out or failed that all pass on the shared environment (`websockets` 17.3), so treat Deepgram recordings made in that environment as unreliable evidence about the Deepgram path; the text and audio relay sidecars were unaffected.

The host starts sidecars with an environment of only `PATH` and `PYTHONIOENCODING`, so the switches reach a sidecar only through the spawn sites (`pipecat.ts`, `pipecat-voice-runtime.ts`, `deepgram-voice-runtime.ts`) once they pass `pipecatDevtoolsEnv()`; until then set them in tests that spawn the sidecar directly.

To look at a recording, run the Whisker interface locally (`git clone https://github.com/pipecat-ai/whisker`, then `cd whisker/ui`, `npm install`, `npm run dev`) and open the `.whisk` file in it; live mode connects the interface to `ws://localhost:9090` from a browser on the same machine (from another machine, tunnel with `ssh -L 9090:127.0.0.1:9090 <host>`). Tail (`pipecat-ai-tail`) is not wired in: it is built on Pipecat's RTVI events, which these sidecars do not produce.

## Official sources, verified 2026-10-19

Read using the agent-reach web backend (Jina Reader):

- [Exact release and Python package metadata](https://pypi.org/project/pipecat-ai/1.13.0/).
  Installed `pipecat-ai==1.13.0`; metadata requires Python >=3.11; tested on 3.12.12.
- [Pipeline and frame processing](https://docs.pipecat.ai/pipecat/learn/pipeline.md).
  `Pipeline` connects `FrameProcessor` instances; frames retain order within
  their processing lane.
- [Pipeline termination](https://docs.pipecat.ai/pipecat/learn/pipeline-termination.md).
  `EndFrame` drains; `worker.cancel()` cancels. Current `PipelineWorker` replaces
  deprecated `PipelineTask` (the installed wrapper subclasses the worker).
- [Transports](https://docs.pipecat.ai/pipecat/learn/transports.md).
  Actual voice requires transport `input()` and `output()` plus the relevant
  speech processors. SmallWebRTC and WebSocket are separate available choices;
  no such transport or optional extras were installed here.

The old `/server/frameworks-and-runners/pipeline/pipeline-task` page returned a
page-not-found document. Discovery continued through the official `llms.txt`.
The implementation uses the verified current worker interface.

## Reproduce without a paid call

From the candidate worktree, create a dedicated Python environment outside the
repository and install only the pinned package's base dependencies:

```sh
uv venv /tmp/voice-agent-pipecat-venv --python 3.12
uv pip install --python /tmp/voice-agent-pipecat-venv/bin/python -r src/orchestration-modules/pipecat/requirements.txt
/tmp/voice-agent-pipecat-venv/bin/python -c 'from importlib.metadata import version; print(version("pipecat-ai"))'
pnpm install --frozen-lockfile
VOICE_HARNESS_PIPECAT_PYTHON=/tmp/voice-agent-pipecat-venv/bin/python pnpm check
VOICE_HARNESS_PIPECAT_PYTHON=/tmp/voice-agent-pipecat-venv/bin/python pnpm exec tsx scripts/smoke-orchestration-pipecat.ts
```

All commands above were run successfully (exit 0). With the environment variable
unset, the real Pipecat test group is explicitly skipped so normal package tests
do not require a Python installation. It must be set for candidate acceptance.
Tests cover actual frame execution, graceful drain, in-flight cancellation,
missing runtime, decision failure, timeout, ordered turns, snapshot immutability,
selection changes, unsolicited runtime failure and event metadata. No live
voice, paid model, canonical simulator, database persistence or shared-route
integration check was run because those paths are outside this candidate and
remain unimplemented here. Independent checker approval remains required.
