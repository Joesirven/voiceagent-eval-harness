# Voice stack research

**Scope:** Inbound/outbound insurance-agency lead calls behind one feature flag. Success bar: end-to-end inbound and outbound, ~500-call productivity framing (350+ productive calls, **zero invented facts** on the lead record).

**Sources used:** Hacker News, Reddit, X, and official documentation from the named providers and regulators. No private application code was reviewed.

**2026-10-19 extension:** Exa search, Jina Reader, the Hacker News Algolia API, and the GitHub repository API. X and Reddit were not reachable on that pass (see source gaps). New sections do not replace the findings above.

---

## Ranked findings (highest signal first)

1. **Turn-taking and barge-in dominate perceived quality more than “faster language model.”** Builders instrument speech-to-text partial → final → language-model first token → text-to-speech first audio → play → barge-in ([Reddit r/SelfHostedAI](https://reddit.com/r/SelfHostedAI/comments/1vn98mt/what_sttllmtts_stack_are_you_using_for_production/)); a Hacker News thread on ~400ms agents stresses semantic end-of-turn, streaming, and instant cancel on interrupt ([Hacker News 47224295](https://news.ycombinator.com/item?id=47224295), [write-up](https://www.ntik.me/posts/voice-agent)).

2. **Twilio bidirectional Media Streams + speech-to-speech realtime model is the default “serious telephony” pattern.** Twilio documents bidirectional streams for AI assistants ([Media Streams overview](https://www.twilio.com/docs/voice/media-streams)); OpenAI documents a dedicated Twilio transport with interruption handling ([OpenAI Agents Twilio extension](https://openai.github.io/openai-agents-js/extensions/twilio/)); Twilio’s OpenAI Realtime tutorial is the reference bridge ([Twilio blog](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)).

3. **Hosted platforms (Vapi, Retell, ElevenLabs Agents) trade control for time-to-demo; self-orchestration (Pipecat/LiveKit/custom) trades engineering time for latency tuning.** A Hacker News “Vapi alternatives” thread cites Twilio and session initiation protocol pain, tool calls interrupting speech, and latency vs competitors ([Hacker News 44435733](https://news.ycombinator.com/item?id=44435733)). Retell’s Hacker News launch shows strong demos but date/time and interruption edge cases in the wild ([Hacker News 39453402](https://news.ycombinator.com/item?id=39453402)).

4. **Outbound AI voice is legally “robocall class” in the United States: prior express consent, identification, opt-out, and state/time rules, not optional product polish.** The Federal Communications Commission declaratory ruling on AI-generated voices under the Telephone Consumer Protection Act ([document FCC-24-17](https://www.fcc.gov/document/fcc-confirms-tcpa-applies-ai-technologies-generate-human-voices)); Twilio’s summary for builders ([Twilio summary of the ruling](https://www.twilio.com/en-us/blog/fcc-ruling-ai-generated-voices-robocalls)).

5. **Schema-valid extraction ≠ caller truth.** Separate “valid JSON” from evidence-backed fields before customer-record writes ([Hamming checklist](https://hamming.ai/resources/voice-agent-structured-output-validation-checklist)); validate caller-influenced tool args on the server ([Vapi tools](https://docs.vapi.ai/tools)).

6. **Testing is a first-class gap.** Multiple Hacker News launches target replay/simulation (Hamming [Hacker News 41257369](https://news.ycombinator.com/item?id=41257369), Roark [Hacker News 43080895](https://news.ycombinator.com/item?id=43080895)); voicetest explicitly names Retell, Vapi, LiveKit, Bland ([Hacker News 47048811](https://news.ycombinator.com/item?id=47048811)).

7. **Hybrid “realtime audio + text supervisor” keeps appearing** as a pattern when pure speech-to-speech is not smart enough ([X @noahmacca](https://twitter.com/noahmacca/status/1927014156152058075)).

8. **Sesame and Fish Audio are strong on voice quality and research; thin telephony and compliance evidence vs Retell/Vapi/Twilio stacks in public builder threads** (Sesame [journal](https://www.sesame.com/journal/crossing-the-uncanny-valley-of-voice); Fish [Agents quickstart](https://docs.fish.audio/agents/quickstart)).

---

## Eight evaluated options

| # | Platform | Telephony | Typical builder posture | Latency / turn-taking (reported) | Compliance / enterprise | 2-day trial fit |
|---|----------|-----------|-------------------------|----------------------------------|-------------------------|-----------------|
| 1 | **Vapi** | Twilio and session initiation protocol; API-first | Max flexibility, you own webhooks/tools | Hacker News user: latency below competitors; tool calls interrupt conversation ([Hacker News 44435733](https://news.ycombinator.com/item?id=44435733)). Vendor positions modular “own the layers” ([X @Vapi_AI](https://twitter.com/Vapi_AI/status/2082176772334903780)). | Health-privacy add-on mentioned in comparisons; tool rejection plans in docs | **Good** if greenfield; overlaps custom bridge |
| 2 | **Retell AI** | Built-in + Twilio | Visual builder + API; healthcare builders cite pay-as-you-go terms under the United States health privacy law (HIPAA) ([Reddit](https://reddit.com/r/VoiceAutomationAI/comments/1v10wyh/struggling_with_empathy_using_retellai_for/)) | Hacker News launch: impressive conversational demo; users report scheduling/interrupt bugs ([Hacker News 39453402](https://news.ycombinator.com/item?id=39453402)). Third-party benchmarks ~600ms class ([APIScout](https://apiscout.dev/guides/vapi-vs-retell-ai-voice-agent-api-2026)) | System and Organization Controls 2; vendor materials say eligible under that health privacy law | **Strong** fastest path without custom bridge |
| 3 | **ElevenLabs Agents** | Telephony integrations in product docs | Voice quality + agent builder | Hacker News interest in Conversational AI 2.0 ([Hacker News ElevenLabs blog item](https://news.ycombinator.com/item?id=41803040) via search) | Enterprise features in docs; check a business associate agreement before sending protected health information | **Good** for voice polish; verify telephony + tools |
| 4 | **Bland AI** | Own + custom Twilio | Pathways, outbound-heavy enterprises | Mixed Reddit ops reviews vs Vapi ([Reddit LeadGeneration](https://reddit.com/r/LeadGeneration/comments/1g0sj3n/tested_vapiai_blandai_and_taalkai_taalkai_is_the/)); docs emphasize pathways/webhooks ([Bland docs](https://www.bland.ai/docs)) | Enterprise positioning; confirm Telephone Consumer Protection Act workflows | **Medium**; platform churn noted in docs banner |
| 5 | **Fish Audio Agents** | Web + phone per docs | Newer all-in-one agent product | Public beta; publish-before-call; token-billed language model ([Fish quickstart](https://docs.fish.audio/agents/quickstart)) | Less public compliance narrative | **Risky** for regulated insurance in 2 days |
| 6 | **OpenAI gpt-realtime** | You bridge (for example a Twilio WebSocket) | Reference: OpenAI Agents Twilio layer | Speech-to-speech latency focus ([Twilio+OpenAI blog](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node)) | Your compliance layer | **Same as custom bridge** if already on OpenAI realtime |
| 7 | **Azure OpenAI gpt-live / gpt-realtime** | Twilio → your bridge → Azure; also session initiation protocol to Azure | Custom bridge | Microsoft documents session initiation protocol plus webhook accept for realtime audio ([Learn: Realtime via session initiation protocol](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/realtime-audio-sip)) | Azure enterprise agreements; you implement disclosures | **Strong** when an Azure bridge already exists |
| 8 | **Sesame** | No standard public switched telephone network product in public docs | Research and conversational speech model demos | Focus on expressivity, not public switched telephone network orchestration ([Sesame journal](https://www.sesame.com/journal/crossing-the-uncanny-valley-of-voice)) | Not applicable for production calls | **Not for a 2-day public switched telephone network harness** |

**Trial ranking for insurance leads:** (7) Azure realtime + Twilio → (2) Retell → (1) Vapi → (3) ElevenLabs → (4) Bland → (6) OpenAI-hosted bridge → (5) Fish → (8) Sesame.

The harness keeps non-selected providers as scripted mocks. See `docs/live-trace-and-records.md`.

---

## Twilio Media Streams bridges

- **Unidirectional** `<Start><Stream>`: listen-only (analytics, transcription).
- **Bidirectional** `<Connect><Stream>`: AI speaks back; inbound track only; use `clear` on barge-in ([Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)).
- **Audio:** μ-law 8 kHz on the wire; extra hop latency vs web real-time communication lab demos ([OpenAI Twilio transport notes](https://openai.github.io/openai-agents-js/extensions/twilio/)).
- **Custom bridge pattern:** Twilio WebSocket ↔ your TypeScript server ↔ Azure or OpenAI realtime session. Keep one long-lived session per call. Connect the WebSocket before slow Twilio Markup Language chains.

---

## Latency budgets (practical targets)

| Segment | Budget (phone, conversational) | Notes |
|---------|-------------------------------|--------|
| End-of-turn detection | 100–300 ms after true intent complete | Voice-activity detection alone fails; add semantic endpointing ([ntik.me](https://www.ntik.me/posts/voice-agent), [Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)) |
| Speech-to-text partial → final | Log both | Delay often “before the language model” ([Reddit stack thread](https://reddit.com/r/SelfHostedAI/comments/1vn98mt/what_sttllmtts_stack_are_you_using_for_production/)) |
| Language-model time-to-first token | Minimize | Dominates stitched pipelines ([Hacker News 47224295](https://news.ycombinator.com/item?id=47224295)) |
| Text-to-speech time-to-first audio | Stream | Do not wait for full utterance |
| **User stop → agent first syllable** | **&lt;500–700 ms** feels OK; **&lt;400 ms** feels excellent | Hacker News front-page build claims ~400 ms ([Hacker News 47224295](https://news.ycombinator.com/item?id=47224295)) |
| Geographic colocation | Non-optional | Same region for Twilio edge, your server, model region |

Log the Reddit thread’s timeline fields in your harness metrics from day one.

---

## Barge-in handling

- **Must:** stop text-to-speech playback immediately (`clear` on Twilio stream), cancel in-flight language model and text-to-speech work, commit only **spoken** text to context ([Pipecat interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)).
- **Retell healthcare builder pain:** interruptions + “hold on” + overlapping questions ([Reddit](https://reddit.com/r/VoiceAutomationAI/comments/1v10wyh/struggling_with_empathy_using_retellai_for/)).
- **Vapi:** tool calls can interrupt conversation per a Hacker News report ([Hacker News 44435733](https://news.ycombinator.com/item?id=44435733)). Prefer async tools or short “let me check” fillers.
- **Tuning:** min-word thresholds, backchannel filtering (Pipecat/Krisp strategies in docs).

---

## Function and tool calling from voice loops

- **Vapi model:** model picks tool → platform merges static params → HTTP/webhook/built-in → result spoken; validate untrusted args ([docs.vapi.ai/tools](https://docs.vapi.ai/tools)).
- **Retell:** workflows for pre-call and post-call customer records (vendor video; [X @retellai workflows](https://x.com/retellai/status/2092317274292289891)).
- **Harness pattern:** tools return **short** speakable summaries; never read JSON; cap concurrent tools; timeout → honest “I couldn’t confirm that on the call.”
- **Insurance:** quote/booking tools should be idempotent and keyed by `lead_id`; read-only lead context injected at call start.

---

## Hallucination guards for extracted fields

**Rule:** A field may be written to the lead only if it is **evidence-backed**, not merely schema-valid ([Hamming checklist](https://hamming.ai/resources/voice-agent-structured-output-validation-checklist)).

Minimum pipeline:

1. **During call:** agent may *paraphrase*; structured capture runs on **final transcript** (or realtime session transcript).
2. **Per field:** `raw_utterance`, `normalized_value`, `evidence_span` (turn + char range), `confidence`, `review_status`.
3. **High-risk fields** (name, date of birth, policy number, premium, appointment time): if confidence low or normalization ambiguous → `needs_review` and **do not** auto-write.
4. **Post-call extractor** with strict JSON schema; second pass: “list each field and quote the caller’s words supporting it—empty string if unsupported.”
5. **Block invented facts in handoff note:** template requires “Caller said: …” bullets. The “zero invented facts” bar means every written field on the audited calls has an evidence span.

---

## Consent, recording, and dialing compliance (United States lead context)

| Requirement | Implementation sketch |
|-------------|----------------------|
| **AI disclosure** | Inbound script: “AI assistant”; outbound: truthful answer if asked ([trial spec]) |
| **Recording disclosure** | Inbound opening: “this call may be recorded”; follow state one-party/two-party rules |
| **Consent on file / not revoked** | Store `sms_consent_at`, `voice_consent_at`, purpose; outbound only if text-agreed slot |
| **STOP / do-not-call / suppression** | Honor STOP on text messages and voice; sync suppression list before dialer run |
| **8 a.m.–9 p.m. local** | Lead timezone on record; scheduler rejects outside window |
| **Telephone Consumer Protection Act / AI voice** | Prior express consent for artificial, prerecorded, or AI voice calls ([Federal Communications Commission](https://www.fcc.gov/document/fcc-confirms-tcpa-applies-ai-technologies-generate-human-voices), [Twilio](https://www.twilio.com/en-us/blog/fcc-ruling-ai-generated-voices-robocalls)) |
| **Marketing vs service** | Insurance quote follow-up may be telemarketing-class. Get legal sign-off on consent copy |

Log consent snapshot on each `call_started` event (flags and timestamps, not personally identifiable information in logs).

---

## Memory and context design

| Layer | Contents | Lifetime |
|-------|----------|----------|
| **Per-lead** | Name, agency, prior text-message thread, consent flags, producer calendar link, last outcome | Database; read-only inject at call start |
| **In-call state** | Current intent (quote / book / message), slot-filled quote fields, pending tool results | Ephemeral; reset each call |
| **Post-call handoff** | Structured extraction + short narrative (“what caller wanted”, “what we promised”, “open questions”) | Write once to lead; immutable audit row |

**Do not** rely on model long-context for compliance facts; pass structured lead JSON in system instructions and refresh after each tool call.

Retell’s Hacker News launch comments note long-context limits across sessions ([Hacker News 39453402](https://news.ycombinator.com/item?id=39453402)). Treat every call as fresh with an explicit lead packet.

---

## Logic routing (added 2026-10-19)

Builders do not leave the whole call to one prompt. The pattern that shows up in vendor docs is a graph the code owns, with a language model only inside the current node.

- **State on the server, tools change with the state.** Retell’s custom-model guide says that after a few tools, inferring “where we are” from the transcript gets unreliable. Keep per-call state keyed by the call identifier, and at each state choose the prompt, the tools, and the legal transitions ([Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)).
- **Pathways: nodes, labeled edges, and a hold until the slots are filled.** Bland’s pathway tutorial walks an agent from node to node using the label on the edge. A node condition (“you must get the date, time, and guest count”) keeps the agent there until those slots exist. A global node can answer an off-script question and then return to the node that was in progress. Draft edits do not affect live calls until that version is published ([Bland pathways](https://docs.bland.ai/tutorials/pathways)).
- **One node, only the tools that node needs.** Pipecat Flows (now inside Pipecat, not a separate package) is a graph on top of the audio pipeline. The stated reason is the same as Vapi’s: one long prompt plus every tool raises hallucination, cost, and delay. A declarative flow file can hold the nodes and prompts while Python holds the functions that actually run ([Pipecat Flows](https://docs.pipecat.ai/guides/features/pipecat-flows)).
- **Handoff to a specialist, not a bigger prompt.** Vapi Squads start the call on the first member and move with a handoff tool whose description says when to transfer (their example: lead qualification, then appointment booking). They say the full conversation context is kept across the handoff, while each member’s prompt stays short ([Vapi Squads](https://docs.vapi.ai/squads)). OpenAI’s realtime agents demo shows the same sequential handoff, plus a second pattern below ([openai-realtime-agents](https://github.com/openai/openai-realtime-agents)).
- **Code gate, then the model chooses.** Parloa describes two layers: activation restrictions are boolean checks on stored variables and are not interpreted by a model; the live model may hand off only to sub-agents that already passed ([Parloa, 2026-05-21](https://www.parloa.com/labs/insights/multi-agent-architecture-for-voice/)).
- **When to leave speech-to-speech for a text model.** OpenAI’s demo keeps a realtime agent on the line for ordinary turns and calls a text supervisor (their example is `gpt-4.1`) for tool calls and harder answers, accepting a small extra delay ([openai-realtime-agents](https://github.com/openai/openai-realtime-agents)). Sierra writes that enterprise work still needs a text reasoning stage because “you still can’t make an API call to a system of record with voice tokens,” even when a speech-to-speech model is available ([Sierra latency, 2025-10-09](https://sierra.ai/blog/voice-latency)). Twilio’s latency guide says the same split: a light conversational model for the live turn, heavier reasoning in the background ([Twilio core latency, 2025-11-17](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents)). For this harness, stay on the speech session for talk and barge-in, and step out to a text model only for quote math, booking, and the post-call note.

Picovoice’s orchestration guide is a vendor document, not a phone-platform post, but it states the split cleanly: working context in the prompt, task state in a code state machine, long-term facts stored outside the call and injected at the start. The transcript is evidence, not the database ([Picovoice](https://picovoice.ai/guide/voice-agents/reasoning-orchestration/)).

---

## Tool calling from the live loop (added 2026-10-19)

This extends the shorter tool section above. The new sources agree on four mechanics.

**Filler speech while a tool runs.** Retell says most providers return either a tool call or spoken text, not both. Without a parameter that carries a line to say, the agent goes silent at the moment the caller is waiting. Their fix is a `message` (or equivalent) on the tool, spoken as the call starts ([Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)). AssemblyAI splits execution into `interactive` (keep talking: lookups that return in a few seconds, with a line like “let me check”) and `hold` (go quiet: transfers and long jobs). They warn that putting a slow lookup on hold makes the caller think the line dropped, and that filling a thirty-second transfer with small talk makes the caller suspicious ([AssemblyAI tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview)). Sierra’s version is a progress line that names the work (“let me pull up your order”) and they refuse to count generic filler as a successful first response ([Sierra latency](https://sierra.ai/blog/voice-latency)). OpenAI’s realtime conversation guide shows the event order (function call, your code, `function_call_output`, then `response.create`) and does not itself specify a spoken filler ([OpenAI realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)). Treat filler as application behavior, not as something the model protocol guarantees.

**Timeouts.** AssemblyAI’s table is the most concrete public split I found: interactive for work under about five seconds, hold for work over about ten seconds or for anything sensitive. If the tool is slower than `timeout_seconds`, the agent treats it as an internal timeout ([AssemblyAI tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview)). Retell’s failure notes: if the provider errors and you never send the “content complete” frame, the turn never finishes and the agent stays quiet until the caller speaks again. Close that frame in a `finally` path, and have a spoken apology plus a transfer when the model provider is down ([Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)).

**Server-side validation.** The model’s arguments are untrusted. OpenAI’s guide puts execution in your application: you read the arguments, you run the function, you return the output ([OpenAI realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)). Retell adds prompt-side guards that do not replace that check: describe when not to call the tool, and expose only the tools legal in the current state ([Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)). AssemblyAI’s “agent invents a result” fix is to reveal the write tool only after the read tool has returned, plus an instruction that answering from memory is worse than an extra tool call ([AssemblyAI tools](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview)). A purpose-built tool (“book this producer’s slot”) beats a generic HTTP request the model has to assemble ([Respeecher, 2026-08-27](https://www.respeecher.com/blog/voice-agents-engineering-lessons)).

**Idempotent tools.** Retell documents a real double-fire: the platform discards a response when the caller keeps talking, then asks again, so a booking tool runs twice for one request. A staleness check on the response identifier misses the case where the write already committed. Their fix is an idempotency key from the call identifier plus the arguments, so the repeat is a no-op ([Retell function calling](https://docs.retellai.com/integrate-llm/integrate-function-calling), [Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)). That matches the insurance note already in the shorter tool section: booking keyed by the lead, and a failed tool spoken as “I could not confirm that,” never as a guessed confirmation.

---

## Caller context and memory across calls (added 2026-10-19)

The three-layer table above still holds. These sources say how to fill it.

**Per-caller injection.** Put a small structured packet in the instructions at call start: name, agency, consent flags, last outcome, and the one or two facts this call needs. Sierra prefetches likely records when a known customer connects, so a question can be answered without a cold lookup ([Sierra latency](https://sierra.ai/blog/voice-latency)). Picovoice says long-term memory is re-injected selectively, not as a dump of every past word ([Picovoice](https://picovoice.ai/guide/voice-agents/reasoning-orchestration/)). Anthropic does not publish a phone-agent engineering post (see the engineering section). Their Sendbird customer story does say most agents still start each conversation from zero, and that a returning person should already have history and what was resolved ([Sendbird on Anthropic](https://www.anthropic.com/customers/sendbird)).

**Prior-call summaries.** Store a short written summary after the call (what they wanted, what was promised, what is open) and inject that summary next time. Do not inject the full prior transcript into the live session. Retell’s launch thread, already cited above, is the public warning that long context across sessions falls over. The Sendbird story also separates a slower after-the-fact pass (topic, sentiment, hallucination check) from the live turn, because the live turn has to stay fast ([Sendbird on Anthropic](https://www.anthropic.com/customers/sendbird)).

**In-call state.** This is code, keyed by the call, not a paragraph the model is trusted to remember. It holds the current intent, filled slots, and pending tool results, and it decides which tools are visible ([Retell best practices](https://docs.retellai.com/integrate-llm/llm-best-practice)). Vapi Squads and Pipecat Flows both keep that state while swapping the active prompt ([Vapi Squads](https://docs.vapi.ai/squads), [Pipecat Flows](https://docs.pipecat.ai/guides/features/pipecat-flows)). After a barge-in, the state must record only what was actually played. The interruption section above already points at Pipecat for that rule.

**Post-call structured notes.** Write once, from the final transcript, with the evidence fields in the hallucination section. The live model may paraphrase during the call. It does not get to invent the lead note. Decagon’s 2026 write-up is about operating many agents, not about a schema, but the operational lesson is the same shape: outbound flows got reliable when tribal call knowledge moved into playbooks and simulated calls, not when each agent kept a longer memory ([Decagon, 2026-07-13](https://decagon.ai/blog/what-i-learned-building-voice-agents-at-decagon)).

---

## Open-source repositories (stars read 2026-10-19)

Star counts are the GitHub repository API `stargazers_count` on 2026-10-19. They move. I did not audit the insurance repositories beyond the public description.

| Repository | Stars | What to copy |
|---|---:|---|
| [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | 16610 | Interruption handling and “only spoken words stay in context.” Flows now live in `pipecat.flows` ([guide](https://docs.pipecat.ai/guides/features/pipecat-flows)). |
| [livekit/agents](https://github.com/livekit/agents) | 14846 | A full realtime agent framework if you ever leave a raw Twilio socket. Not required for the two-day harness. |
| [livekit/livekit](https://github.com/livekit/livekit) | 21654 | The media server underneath LiveKit agents. Copy nothing unless you change transport. |
| [dograh-hq/dograh](https://github.com/dograh-hq/dograh) | 5906 | Public description calls it a self-hosted alternative to Vapi and Retell. Noted as a reference, not reviewed line by line. |
| [openai/openai-realtime-agents](https://github.com/openai/openai-realtime-agents) | 7002 | Chat-supervisor and sequential handoff. This is the pattern to copy in TypeScript if speech-to-speech is not enough for a quote. |
| [openai/openai-realtime-console](https://github.com/openai/openai-realtime-console) | 3616 | A debugger for the realtime event stream. Useful as a mental model of events, not as a phone bridge. |
| [openai/openai-realtime-twilio-demo](https://github.com/openai/openai-realtime-twilio-demo) | 534 | The small official Twilio bridge. Compare with custom bridge; do not paste it in. |
| [twilio-samples/speech-assistant-openai-realtime-api-node](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node) | 362 | Node reference for bidirectional media streams plus the realtime session. |
| [twilio-samples/speech-assistant-openai-realtime-api-python](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-python) | 349 | Same bridge in Python. |
| [vocodedev/vocode-core](https://github.com/vocodedev/vocode-core) | 3805 | Older modular voice-agent framework. `vocodedev/vocode-python` redirects to this same repository. |
| [pipecat-ai/pipecat-flows](https://github.com/pipecat-ai/pipecat-flows) | 627 | Archived. The readme says it merged into Pipecat and the separate package is frozen. Do not depend on it. |

Insurance and lead-calling repositories found by GitHub search. Star counts are too low to treat as battle-tested. Copy the shape of the problem (outbound retention, lead qualification), not the code, and do not import anything from them into this repo.

| Repository | Stars | Public description (not reviewed) |
|---|---:|---|
| [Risabkshetri/AI-Telecalling](https://github.com/Risabkshetri/AI-Telecalling) | 4 | Voice calling for real-estate lead qualification and objection handling. |
| [Nuraveda/echo](https://github.com/Nuraveda/echo) | 3 | Open-source voice calling plus a lead record for inbound and outbound. |
| [Zimal-Fatemah/Multilingual-Outbound-Retention-VoiceAgent](https://github.com/Zimal-Fatemah/Multilingual-Outbound-Retention-VoiceAgent) | 1 | Outbound insurance retention agent. |
| [Masum58/insureflow-voice-Sass-platform](https://github.com/Masum58/insureflow-voice-Sass-platform) | 1 | Multi-tenant voice agent described as for insurance agencies. |

---

## Engineering articles (added 2026-10-19)

One lesson each. Where a named company has no phone-agent engineering post, that is stated instead of stretching a different article.

- **Twilio** ([core latency guide, 2025-11-17](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents)): separate the delay on every ordinary turn from spikes caused by tools, and keep the live model small enough that speech can start on the first tokens.
- **OpenAI** ([realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)): your code executes the function and must return `function_call_output` before the next spoken response. The [agents demo](https://github.com/openai/openai-realtime-agents) adds the lesson the guide does not: a text supervisor or a specialist handoff when one realtime prompt would hold every tool.
- **Sierra** ([2025-10-09](https://sierra.ai/blog/voice-latency)): measure time to the first relevant audio, not to a filler noise; prefetch known customer data; run independent checks in parallel; a system-of-record call still happens in text.
- **Decagon** ([2026-07-13](https://decagon.ai/blog/what-i-learned-building-voice-agents-at-decagon)): outbound (refills, collections) is where branching gets hard, and they scaled it with playbooks and simulated calls. A Modal write-up with Decagon says latency fell after smaller models plus inference work. The post states a relative drop and does not give the before-and-after measurements, so that figure stays their claim ([Modal, 2025-11-13](https://modal.com/blog/decagon-case-study)).
- **Anthropic:** no first-party engineering article on phone agents turned up on 2026-10-19. A recorded webinar with Vapi is an event page, not a write-up ([webinar](https://www.anthropic.com/webinars/voice-and-intelligence-building-the-human-interface-for-customer-experience)). The closest lesson is in the Sendbird customer story: latency is the product on voice, and hallucination checks can be a slower pass after the call ([Sendbird](https://www.anthropic.com/customers/sendbird)).
- **Stripe:** no voice-agent engineering article found. The 2018 post about taking card payments on a Twilio call is a different product and is not guidance here.
- **Ramp** ([how to build agents users can trust](https://engineering.ramp.com/post/how-to-build-agents-users-can-trust)): this is an expense-approval agent, not a phone agent. The transferable lesson is an explicit “not sure” exit into human review, and a warning that a confidence number the model prints is not a measurement.
- **Parloa** ([2026-05-21](https://www.parloa.com/labs/insights/multi-agent-architecture-for-voice/)): eligibility is code; the model only picks among agents the code already allowed.
- **Respeecher** ([2026-08-27](https://www.respeecher.com/blog/voice-agents-engineering-lessons)): give the model business actions, not a generic HTTP tool, and check that the right facts were retrieved before you rewrite the prompt.

---


## Same-day builder checklist

- [ ] Feature flag wraps inbound Twilio number + outbound job runner only.
- [ ] Opening inbound: AI identity + recording disclosure; outbound: confirm text consent window.
- [ ] Metrics: full audio-to-audio timeline per call.
- [ ] Barge-in: cancel + `clear` tested with intentional overlap.
- [ ] Tools: book producer slot, save message, read lead context (read-only).
- [ ] Post-call: evidence-backed extraction → lead note; block write if evidence missing.
- [ ] Suppression + local-time dial guard on outbound.
- [ ] 10-call smoke + 50-call extraction audit before scaling toward 500.

---

## Source gaps

- **Reddit:** live fetch blocked on the first pass; post bodies from [PullPush API](https://api.pullpush.io) (may lag/delete). On 2026-10-19 the OpenCLI Reddit backend had no connected browser, and a follow-up PullPush query returned “rate limit exceeded.” No new Reddit posts were added in this extension.
- **X:** no search without login; cited posts fetched via vxtwitter mirror when available. On 2026-10-19 twitter-cli had no explicit credentials, and a web search restricted to x.com returned no posts. No new X posts were added.
- **Hacker News:** Algolia search on 2026-10-19 did not surface new high-signal threads beyond the ones already cited (pathways and tool-filler queries mostly missed).
- **Vendor latency numbers:** treat third-party comparisons as directional unless measured on your Twilio region. Decagon’s latency-drop figure is theirs; the post does not state the before-and-after measurements.
- **Anthropic, Stripe:** no first-party phone-agent engineering post verified on this pass.
- **Insurance GitHub repositories:** descriptions only. Star counts are 1 to 4. Code was not reviewed.

---

## Five most-used tools / approaches (across Hacker News, Reddit, X)

Re-checked on 2026-10-19 against the routing, tool, memory, repository, and engineering sources added above. The order stays the same. Sierra, Decagon, and the OpenAI realtime agents demo still put a phone transport plus a realtime or cascaded speech loop first, then a hosted orchestrator or an open-source pipeline, then a test harness. Nothing in the new sources displaced Twilio media streams or the Azure realtime path custom bridge already uses.

### 1. Twilio Programmable Voice + Media Streams

Shows up in almost every production thread (SelfHostedAI stack list, smallbusiness Twilio+Realtime comment, Twilio/OpenAI tutorials). **Copy:** bidirectional `<Connect><Stream>`, explicit `clear` on interrupt, connect realtime session immediately on `start`.

### 2. OpenAI / Azure Realtime (speech-to-speech)

Default “low-latency brain” in 2025–2026 guides ([Twilio blog](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node), [Azure session initiation protocol](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/realtime-audio-sip)). **Copy:** one session per call; g.711 format; custom bridge already here. Add metrics and extraction, not a new vendor.

### 3. Retell AI or Vapi (hosted orchestration)

Most named pair in Reddit and Hacker News comparisons ([LeadGeneration Vapi/Bland](https://reddit.com/r/LeadGeneration/comments/1g0sj3n/tested_vapiai_blandai_and_taalkai_taalkai_is_the/), [vapiai vs Retell](https://reddit.com/r/vapiai/comments/1pqqoyq/why_i_ditched_retell_for_vapi_in_my_n8n_voice/nuxx8jk/), [Hacker News Vapi launch](https://news.ycombinator.com/item?id=43556789)). **Copy:** if timeboxed, Retell for a health-privacy narrative and a faster demo; Vapi if you need webhook-first tool control.

### 4. Pipecat or LiveKit Agents (self-hosted orchestration)

Hacker News commenters point here when platforms frustrate ([Hacker News 47224295 comments](https://news.ycombinator.com/item?id=47224295), [Hamming + Pipecat](https://news.ycombinator.com/item?id=41257369)). **Copy:** interruption frame pattern and “only spoken words in context.” Worth copying in TypeScript even if you don’t adopt Pipecat.

### 5. Voice-agent test harnesses (Hamming, Roark, voicetest)

Repeated Hacker News launches ([41257369](https://news.ycombinator.com/item?id=41257369), [43080895](https://news.ycombinator.com/item?id=43080895), [47048811](https://news.ycombinator.com/item?id=47048811)). **Copy:** define expected slots per scenario; replay transcripts; gate the 500-call plan on extraction audits, not vibe checks. Sierra’s voice simulations and Decagon’s simulated-call write-up, linked above, are the same lesson from two more vendors.
