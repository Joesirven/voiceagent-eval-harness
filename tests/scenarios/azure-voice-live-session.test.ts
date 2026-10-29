/**
 * The Azure Voice Live session on a fake socket: the start and its failures,
 * caller lines and the reply the harness triggers, agent line records on the
 * playback clock, barge-in owned by the server, the stale-output setting, the
 * speaking model's tool calls, the line guard, errors during the call, the
 * reminder, heardWords, and the error catalog. The events follow the Voice Live
 * protocol as observed on the wire on 2026-10-20 (api-version 2026-04-10).
 * Fake timers, no network and no credential file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMIND_AFTER_MS, type LiveSocket, type StaleOutputCapGaps } from "../../src/modules/azure-live-session.js";
import {
  AzureVoiceLiveSession,
  classifyVoiceLiveError,
  heardWords,
  VoiceLiveStartError,
  type VoiceLiveSessionOptions,
  type VoiceLiveTools,
} from "../../src/modules/azure-voice-live-session.js";
import { VOICE_ERROR_CATALOG } from "../../src/server/voice/voice-errors.js";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";

const GAP_MS = 200;
const CALL = "call_voice_live";
const MODEL = "gpt-realtime";
const VOICE = "en-US-Ava:DragonHDLatestNeural";
const INSTRUCTIONS = "You are the agency's assistant. Lead: Pat.";
const DISCLOSURE = "Hi, this is Ava, an artificial intelligence assistant calling from the agency. This call may be recorded.";

const socketUrl = (model: string) => `wss://example.services.ai.azure.com/voice-live/realtime?api-version=2026-04-10&model=${model}`;

type Sent = Record<string, unknown> & { type?: string };

interface FakeSocket {
  socket: LiveSocket;
  sent: Sent[];
  closed: boolean;
  emit(event: Record<string, unknown>): void;
  /** Voice Live closes the connection. */
  drop(): void;
}

function fakeSocket(): FakeSocket {
  let onMessage: (raw: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  const fake: FakeSocket = {
    sent: [],
    closed: false,
    emit: (event) => onMessage(JSON.stringify(event)),
    drop: () => onClose(),
    socket: {
      send: (data) => void fake.sent.push(JSON.parse(data)),
      close: () => void (fake.closed = true),
      onMessage: (cb) => void (onMessage = cb),
      onClose: (cb) => void (onClose = cb),
    },
  };
  return fake;
}

type Options = VoiceLiveSessionOptions & {
  audio: string[];
  ends: Array<{ durationMs: number; reason: string }>;
  clears: number[];
  providerErrors: Array<[string, string | undefined]>;
};

function options(patch: Partial<VoiceLiveSessionOptions> = {}): Options {
  const audio: string[] = [];
  const ends: Array<{ durationMs: number; reason: string }> = [];
  const clears: number[] = [];
  const providerErrors: Array<[string, string | undefined]> = [];
  return {
    socketFactory: async () => fakeSocket().socket,
    credentials: (model) => ({ socketUrl: socketUrl(model), apiKey: "k" }),
    trace: { leadId: "lead-1", recordId: CALL, channel: "call", direction: "inbound", callId: CALL },
    model: MODEL,
    voice: VOICE,
    instructions: INSTRUCTIONS,
    disclosure: DISCLOSURE,
    maxMs: 60_000,
    turnGapMs: GAP_MS,
    startTimeoutMs: 1_000,
    dialogOwnsTranscript: false,
    onAudio: (b64) => void audio.push(b64),
    onClearPlayback: () => void clears.push(Date.now()),
    onProviderError: (code, detail) => void providerErrors.push([code, detail]),
    onEnd: (summary) => void ends.push(summary),
    ...patch,
    audio,
    ends,
    clears,
    providerErrors,
  };
}

/** Voice Live's session.updated: the settings it was sent, with the model and the input sample rate it adds. */
function echoOf(fake: FakeSocket, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const update = fake.sent.find((m) => m.type === "session.update");
  return { id: "sess_1", model: MODEL, input_audio_sampling_rate: 8000, ...(update?.session as Record<string, unknown>), ...patch };
}

/** A started session on a fake socket. */
async function started(patch: Partial<VoiceLiveSessionOptions> = {}) {
  const fake = fakeSocket();
  const o = options({ socketFactory: async () => fake.socket, ...patch });
  const session = new AzureVoiceLiveSession(o);
  const starting = session.start();
  await vi.advanceTimersByTimeAsync(0);
  fake.emit({ type: "session.created", session: { id: "sess_1" } });
  await vi.advanceTimersByTimeAsync(0);
  fake.emit({ type: "session.updated", session: echoOf(fake) });
  await starting;
  return { session, fake, o };
}

/** Lets the caller line queue, the decision step and the tool runner settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Mu-law audio of the given length (8 bytes a millisecond), base64. */
const audio = (ms: number) => Buffer.alloc(ms * 8, 0xff).toString("base64");

const systemItem = (text: string) => ({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
const userItem = (text: string) => ({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

const kinds = (sent: Sent[]) => sent.map((m) => m.type);
const creates = (fake: FakeSocket) => fake.sent.filter((m) => m.type === "response.create");
const systemTexts = (fake: FakeSocket) =>
  fake.sent
    .filter((m) => m.type === "conversation.item.create" && (m.item as Record<string, unknown>).role === "system")
    .map((m) => ((m.item as { content: Array<{ text: string }> }).content[0]!.text));
const toolOutputs = (fake: FakeSocket) =>
  fake.sent.filter((m) => m.type === "conversation.item.create" && (m.item as Record<string, unknown>).type === "function_call_output").map((m) => m.item);

const tools = (name: string) => traceBus.history().filter((e) => e.type === "tool_call" && e.data.tool === name);
const inputsOf = (e: TraceEvent) => e.data.inputs as Record<string, unknown>;
/** The call's recorded lines (agent and caller), oldest first. */
const lines = () => traceBus.history().filter((e) => e.callId === CALL && (e.type === "transcript_final" || e.type === "turn"));

const speechStarted = { type: "input_audio_buffer.speech_started", audio_start_ms: 4_000, item_id: "item_caller_speech" };

/** Voice Live's transcript of a finished caller line. */
const heard = (fake: FakeSocket, transcript: string, itemId = "item_caller") =>
  fake.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, content_index: 0, transcript });

const created = (fake: FakeSocket, responseId: string) => fake.emit({ type: "response.created", response: { id: responseId, status: "in_progress" } });
const responseDone = (fake: FakeSocket, responseId: string, status = "completed") => fake.emit({ type: "response.done", response: { id: responseId, status } });

interface ItemSpec {
  responseId: string;
  itemId: string;
  text: string;
  /** Milliseconds of audio, sent as one delta. */
  ms: number;
  /** Word timestamps: milliseconds into the item's audio, and the word. */
  words?: Array<[number, string]>;
  /** Leave out the transcript's end (and the item's end) for now. */
  transcriptOpen?: boolean;
}

/** One assistant message item, in Voice Live's event order. Returns the audio chunk sent. */
function agentItem(fake: FakeSocket, s: ItemSpec): string {
  const ids = { response_id: s.responseId, item_id: s.itemId, output_index: 0, content_index: 0 };
  const chunk = audio(s.ms);
  fake.emit({ type: "response.output_item.added", response_id: s.responseId, output_index: 0, item: { id: s.itemId, type: "message", role: "assistant", content: [] } });
  fake.emit({ type: "response.content_part.added", ...ids, part: { type: "audio", transcript: "" } });
  fake.emit({ type: "response.audio_transcript.delta", ...ids, delta: s.text });
  if (s.ms > 0) fake.emit({ type: "response.audio.delta", ...ids, delta: chunk });
  for (const [at, text] of s.words ?? []) {
    fake.emit({ type: "response.audio_timestamp.delta", ...ids, audio_offset_ms: at, audio_duration_ms: 50, text, timestamp_type: "word" });
  }
  fake.emit({ type: "response.audio.done", ...ids });
  if (!s.transcriptOpen) transcriptDone(fake, s);
  return chunk;
}

function transcriptDone(fake: FakeSocket, s: Pick<ItemSpec, "responseId" | "itemId" | "text">): void {
  const ids = { response_id: s.responseId, item_id: s.itemId, output_index: 0, content_index: 0 };
  fake.emit({ type: "response.audio_transcript.done", ...ids, transcript: s.text });
  fake.emit({ type: "response.content_part.done", ...ids, part: { type: "audio", transcript: s.text } });
  fake.emit({ type: "response.output_item.done", response_id: s.responseId, output_index: 0, item: { id: s.itemId, type: "message", role: "assistant" } });
}

/** A whole reply: response.created, one item, response.done. */
function reply(fake: FakeSocket, s: ItemSpec): string {
  created(fake, s.responseId);
  const chunk = agentItem(fake, s);
  responseDone(fake, s.responseId);
  return chunk;
}

/** The opening disclosure said word for word, its response done, and its audio played out. */
async function playOpening(fake: FakeSocket, ms = 300): Promise<void> {
  reply(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms });
  await vi.advanceTimersByTimeAsync(ms + 10);
}

const REPLY_TEXT = "Sure, let me check that for you.";
const REPLY_WORDS: Array<[number, string]> = [[0, "Sure"], [60, ","], [80, "let"], [150, "me"], [210, "check"], [290, "that"], [330, "for"], [360, "you"], [390, "."]];

/** The opening has played, a caller line came in, and the agent's 400 millisecond reply (resp_2, item_2) has just started playing. */
async function speaking(patch: Partial<VoiceLiveSessionOptions> = {}, opts: { responseDone?: boolean } = {}) {
  const ctx = await started(patch);
  await playOpening(ctx.fake);
  heard(ctx.fake, "I want a quote.");
  await flush();
  created(ctx.fake, "resp_2");
  agentItem(ctx.fake, { responseId: "resp_2", itemId: "item_2", text: REPLY_TEXT, ms: 400, words: REPLY_WORDS });
  if (opts.responseDone) responseDone(ctx.fake, "resp_2");
  return ctx;
}

/** A start that may fail, with its socket open and nothing answered yet. */
async function connecting(patch: Partial<VoiceLiveSessionOptions> = {}) {
  const fake = fakeSocket();
  const o = options({ socketFactory: async () => fake.socket, ...patch });
  const session = new AzureVoiceLiveSession(o);
  const starting = failure(session.start());
  await vi.advanceTimersByTimeAsync(0);
  return { fake, o, session, starting };
}

/** The error a start fails with (the test fails if it succeeds). */
const failure = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error("expected the start to fail");
    },
    (err: Error) => err,
  );

beforeEach(() => {
  vi.useFakeTimers();
  traceBus.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the start", () => {
  it("asks for the model's credentials, opens the socket with their address and key, and sends nothing before session.created", async () => {
    const fake = fakeSocket();
    const credentials = vi.fn((model: string) => ({ socketUrl: socketUrl(model), apiKey: "k" }));
    const factory = vi.fn(async (_url: string, _key: string) => fake.socket);
    const session = new AzureVoiceLiveSession(options({ credentials, socketFactory: factory }));
    let resolved = false;
    const starting = session.start().then(() => void (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(credentials).toHaveBeenCalledWith(MODEL);
    expect(factory).toHaveBeenCalledWith(socketUrl(MODEL), "k");
    expect(fake.sent).toEqual([]);
    fake.emit({ type: "session.created", session: { id: "sess_1" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(fake.sent)).toEqual(["session.update"]);
    // The start waits for Voice Live's echo of the settings.
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    fake.emit({ type: "session.updated", session: echoOf(fake) });
    await starting;
    expect(resolved).toBe(true);
  });

  it("sends every setting in session.update, with the tools and tool_choice auto when there are tools", async () => {
    const definitions = [{ type: "function" as const, name: "write_quote_field", description: "Save a fact the caller stated.", parameters: { type: "object", properties: {} } }];
    const { fake } = await started({ tools: { definitions, call: async () => ({ output: "{}", ok: true }) } });
    const update = fake.sent.find((m) => m.type === "session.update")!;
    expect(update.session).toEqual({
      instructions: INSTRUCTIONS,
      modalities: ["text", "audio"],
      voice: { name: VOICE, type: "azure-standard" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: { model: "gpt-4o-transcribe" },
      input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
      input_audio_echo_cancellation: { type: "server_echo_cancellation" },
      turn_detection: { type: "semantic_vad", eagerness: "high", create_response: false, interrupt_response: false },
      output_audio_timestamp_types: ["word"],
      tools: definitions,
      tool_choice: "auto",
    });
  });

  it("a text model gets Azure multilingual turn detection, its chosen transcription and the interim response; a speech to speech model gets neither", async () => {
    const { fake: text } = await started({ model: "gpt-6-luna", transcriptionModel: "mai-transcribe-2" });
    const t = text.sent.find((m) => m.type === "session.update")!.session as Record<string, any>;
    expect(t.turn_detection).toEqual({
      type: "azure_semantic_vad_multilingual", remove_filler_words: true, languages: ["en", "es"], auto_truncate: true, create_response: false, interrupt_response: false,
    });
    expect(t.input_audio_transcription).toEqual({ model: "mai-transcribe-2" });
    expect(t.interim_response).toEqual({
      type: "llm_interim_response",
      triggers: ["latency", "tool"],
      latency_threshold_ms: 180,
      model: "gpt-4o-mini",
      max_completion_tokens: 50,
      instructions: "Create short, friendly interim responses that tell the caller you are processing or looking something up. Do not include one in every response. Never say that you do not have real-time access to information.",
    });
    expect(t).toMatchObject({ input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw", input_audio_noise_reduction: { type: "azure_deep_noise_suppression" }, voice: { name: VOICE, type: "azure-standard" } });
    // A text model with no transcription chosen uses Azure speech.
    const { fake: plain } = await started({ model: "gpt-4.1" });
    expect((plain.sent.find((m) => m.type === "session.update")!.session as Record<string, any>).input_audio_transcription).toEqual({ model: "azure-speech" });
    for (const model of ["gpt-realtime", "gpt-realtime-2.1"]) {
      const { fake } = await started({ model, transcriptionModel: "mai-transcribe-2" });
      const u = fake.sent.find((m) => m.type === "session.update")!.session as Record<string, any>;
      expect(u).not.toHaveProperty("interim_response");
      expect(u.turn_detection).toEqual({ type: "semantic_vad", eagerness: "high", create_response: false, interrupt_response: false });
      expect(u.input_audio_transcription).toEqual({ model: "gpt-4o-transcribe" });
    }
  });

  it("sends no tools key and no tool_choice when there are no tools, or an empty list", async () => {
    for (const patch of [{}, { tools: { definitions: [], call: async () => ({ output: "{}", ok: true }) } }]) {
      const { fake, session } = await started(patch);
      const update = fake.sent.find((m) => m.type === "session.update")!;
      expect(update.session).not.toHaveProperty("tools");
      expect(update.session).not.toHaveProperty("tool_choice");
      session.stop();
    }
  });

  it("traces the open (server-owned barge-in, the stale-output setting) and Voice Live's echo, never the instruction text", async () => {
    await started({ staleOutputCapGaps: 2 });
    const open = tools("voice_session_open");
    expect(open).toHaveLength(1);
    expect(open[0]!.data.success).toBe(true);
    expect(inputsOf(open[0]!)).toEqual({
      provider: "azure_voice_live",
      model: MODEL,
      voice: VOICE,
      instructionsChars: INSTRUCTIONS.length,
      tools: 0,
      staleOutputCapGaps: 2,
      bargeInOwner: "server",
    });
    const echo = tools("voice_live_session_echo");
    expect(echo).toHaveLength(1);
    expect(inputsOf(echo[0]!)).toEqual({
      model: MODEL,
      voice: VOICE,
      voiceType: "azure-standard",
      inputAudioFormat: "g711_ulaw",
      outputAudioFormat: "g711_ulaw",
      inputSampleRate: 8000,
      transcription: "gpt-4o-transcribe",
      noiseReduction: "azure_deep_noise_suppression",
      echoCancellation: "server_echo_cancellation",
      turnDetection: "semantic_vad",
      eagerness: "high",
      createResponse: false,
      interruptResponse: false,
      timestamps: ["word"],
      tools: 0,
    });
    expect(JSON.stringify(traceBus.history())).not.toContain(INSTRUCTIONS);
  });

  it("the open trace carries the default stale-output setting (one turn gap) when none is given", async () => {
    await started();
    expect(inputsOf(tools("voice_session_open")[0]!).staleOutputCapGaps).toBe(1);
  });

  it("then sends the opening system item, which says exactly the disclosure, and one response.create", async () => {
    const { fake } = await started();
    const afterUpdate = fake.sent.slice(fake.sent.findIndex((m) => m.type === "session.update") + 1);
    expect(afterUpdate).toEqual([
      systemItem(`The call just connected. Speak first: say exactly "${DISCLOSURE}" and then stop and listen.`),
      { type: "response.create", event_id: "response_create_1" },
    ]);
  });

  it("forwards caller audio only once the session has started", async () => {
    const fake = fakeSocket();
    const session = new AzureVoiceLiveSession(options({ socketFactory: async () => fake.socket }));
    const starting = session.start();
    await vi.advanceTimersByTimeAsync(0);
    session.sendAudio(audio(20));
    expect(fake.sent).toEqual([]);
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ type: "session.updated", session: echoOf(fake) });
    await starting;
    const chunk = audio(20);
    session.sendAudio(chunk);
    expect(fake.sent.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: chunk });
    expect(session.inputAudioAppendCount).toBe(1);
  });
});

describe("a start that fails", () => {
  it.each(["invalid_model", "model_retired"])(
    "a model refused right after connect (%s, before session.created) is azure_voice_live_session_rejected with Voice Live's type and code",
    async (code) => {
      const { fake, o, starting } = await connecting();
      fake.emit({ type: "error", event_id: "event_1", error: { type: "invalid_request_error", code, message: "Model gpt-live-1 is not supported in this region." } });
      const err = await starting;
      expect(err).toBeInstanceOf(VoiceLiveStartError);
      expect(err.message).toBe("azure_voice_live_session_rejected");
      expect((err as VoiceLiveStartError).providerDetail).toBe(`invalid_request_error / ${code}`);
      expect(fake.sent).toEqual([]);
      expect(fake.closed).toBe(true);
      expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
      const open = tools("voice_session_open");
      expect(open).toHaveLength(1);
      expect(open[0]!.data).toMatchObject({
        success: false,
        reason: "azure_voice_live_session_rejected",
        inputs: { provider: "azure_voice_live", model: MODEL, voice: VOICE, instructionsChars: INSTRUCTIONS.length },
      });
      expect(tools("voice_session_close")).toHaveLength(0);
      expect(JSON.stringify(traceBus.history())).not.toContain("not supported in this region");
      expect(JSON.stringify(traceBus.history())).not.toContain(INSTRUCTIONS);
    },
  );

  it("settings refused after session.created (invalid_session_update_message) are azure_voice_live_session_rejected with Voice Live's type and code", async () => {
    const { fake, o, starting } = await connecting();
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "invalid_session_update_message" } });
    const err = await starting;
    expect(err.message).toBe("azure_voice_live_session_rejected");
    expect((err as VoiceLiveStartError).providerDetail).toBe("invalid_request_error / invalid_session_update_message");
    expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
  });

  const authErrors: Array<[string, Record<string, unknown>]> = [
    ["invalid_api_key", { type: "invalid_request_error", code: "invalid_api_key" }],
    ["authentication_error", { type: "authentication_error", code: "unauthorized" }],
    ["status 401", { type: "invalid_request_error", status: 401 }],
  ];
  it.each(authErrors)("an authentication error before the start (%s) is azure_voice_live_auth_failed", async (_name, error) => {
    const { fake, o, starting } = await connecting();
    fake.emit({ type: "error", error });
    const err = await starting;
    expect(err.message).toBe("azure_voice_live_auth_failed");
    expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
  });

  it("a rate limit before the start is azure_voice_live_rate_limited", async () => {
    const { fake, starting } = await connecting();
    fake.emit({ type: "error", error: { type: "rate_limit_error", code: "rate_limit_exceeded" } });
    expect((await starting).message).toBe("azure_voice_live_rate_limited");
  });

  const badEchoes: Array<[string, Record<string, unknown>, string]> = [
    ["the output format is pcm16", { output_audio_format: "pcm16" }, "echo_audio_format"],
    ["the input format is pcm16", { input_audio_format: "pcm16" }, "echo_audio_format"],
    ["create_response is true", { turn_detection: { type: "semantic_vad", eagerness: "high", create_response: true, interrupt_response: false } }, "echo_create_response"],
    ["there is no transcription", { input_audio_transcription: null }, "echo_no_transcription"],
  ];
  it.each(badEchoes)("an echo where %s is rejected", async (_what, patch, detail) => {
    const { fake, o, starting } = await connecting();
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ type: "session.updated", session: echoOf(fake, patch) });
    const err = await starting;
    expect(err.message).toBe("azure_voice_live_session_rejected");
    expect((err as VoiceLiveStartError).providerDetail).toBe(detail);
    expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
    expect(creates(fake)).toHaveLength(0);
    expect(tools("voice_session_open")[0]!.data).toMatchObject({ success: false, reason: "azure_voice_live_session_rejected" });
  });

  it("a socket factory that rejects with a fixed code ends the start with that code; any other rejection is azure_voice_live_connect_failed", async () => {
    const cases: Array<[string, string]> = [
      ["azure_voice_live_auth_failed", "azure_voice_live_auth_failed"],
      ["azure_voice_live_rate_limited", "azure_voice_live_rate_limited"],
      ["azure_voice_live_session_rejected", "azure_voice_live_session_rejected"],
      ["connect ECONNREFUSED 10.0.0.1:443", "azure_voice_live_connect_failed"],
    ];
    for (const [thrown, code] of cases) {
      traceBus.reset();
      const o = options({
        socketFactory: async () => {
          throw new Error(thrown);
        },
      });
      const err = await failure(new AzureVoiceLiveSession(o).start());
      expect(err.message).toBe(code);
      expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
      expect(tools("voice_session_open")[0]!.data).toMatchObject({ success: false, reason: code });
    }
  });

  it("credentials that throw end the start with their code before any socket opens", async () => {
    const factory = vi.fn(async () => fakeSocket().socket);
    const o = options({
      socketFactory: factory,
      credentials: () => {
        throw new Error("azure_voice_live_missing_key");
      },
    });
    const err = await failure(new AzureVoiceLiveSession(o).start());
    expect(err.message).toBe("azure_voice_live_missing_key");
    expect(factory).not.toHaveBeenCalled();
    expect(o.ends.map((e) => e.reason)).toEqual(["start_failed"]);
  });

  it("no answer ends the start with azure_voice_live_start_timeout at the deadline", async () => {
    const { fake, o, starting } = await connecting({ startTimeoutMs: 500 });
    fake.emit({ type: "session.created" });
    let settled = false;
    void starting.then(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(480);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect((await starting).message).toBe("azure_voice_live_start_timeout");
    expect(o.ends.map((e) => e.reason)).toEqual(["start_timeout"]);
    expect(fake.closed).toBe(true);
    expect(tools("voice_session_open")[0]!.data).toMatchObject({ success: false, reason: "azure_voice_live_start_timeout" });
  });

  it("a socket that never opens fails at the same deadline", async () => {
    const o = options({ socketFactory: () => new Promise<LiveSocket>(() => undefined), startTimeoutMs: 500 });
    const starting = failure(new AzureVoiceLiveSession(o).start());
    await vi.advanceTimersByTimeAsync(501);
    expect((await starting).message).toBe("azure_voice_live_start_timeout");
    expect(o.ends.map((e) => e.reason)).toEqual(["start_timeout"]);
  });

  it("a socket that closes before the start ends it with azure_voice_live_closed_before_start", async () => {
    const { fake, o, starting } = await connecting();
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    fake.drop();
    expect((await starting).message).toBe("azure_voice_live_closed_before_start");
    expect(o.ends).toHaveLength(1);
    expect(tools("voice_session_open")[0]!.data).toMatchObject({ success: false, reason: "azure_voice_live_closed_before_start" });
    expect(tools("voice_session_close")).toHaveLength(0);
  });

  it("an already aborted signal ends it with voice_session_ended and opens no socket", async () => {
    const factory = vi.fn(async () => fakeSocket().socket);
    const abort = new AbortController();
    abort.abort();
    const o = options({ socketFactory: factory, signal: abort.signal });
    const err = await failure(new AzureVoiceLiveSession(o).start());
    expect(err.message).toBe("voice_session_ended");
    expect(factory).not.toHaveBeenCalled();
    expect(o.ends.map((e) => e.reason)).toEqual(["caller_hangup"]);
  });

  it("aborting while the socket is pending ends it with voice_session_ended and closes the late socket", async () => {
    const fake = fakeSocket();
    let resolveSocket: (s: LiveSocket) => void = () => undefined;
    const abort = new AbortController();
    const o = options({ socketFactory: () => new Promise<LiveSocket>((resolve) => (resolveSocket = resolve)), signal: abort.signal });
    const starting = failure(new AzureVoiceLiveSession(o).start());
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect((await starting).message).toBe("voice_session_ended");
    resolveSocket(fake.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.closed).toBe(true);
    expect(fake.sent).toEqual([]);
    expect(o.ends.map((e) => e.reason)).toEqual(["caller_hangup"]);
  });

  // A caller who hangs up once the socket is open (before session.updated) is not a provider failure:
  // openVoiceSession treats only voice_session_ended as the caller leaving.
  it("aborting after the socket opened, before session.updated, ends the start with voice_session_ended", async () => {
    const abort = new AbortController();
    const { fake, o, starting } = await connecting({ signal: abort.signal });
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    const err = await starting;
    expect(o.ends.map((e) => e.reason)).toEqual(["caller_hangup"]);
    expect(err.message).toBe("voice_session_ended");
  });

  // The same, through stop().
  it("stop() after the socket opened, before session.updated, ends the start with voice_session_ended", async () => {
    const { fake, session, starting } = await connecting();
    fake.emit({ type: "session.created" });
    await vi.advanceTimersByTimeAsync(0);
    session.stop("server_stop");
    expect((await starting).message).toBe("voice_session_ended");
  });
});

describe("a spoken caller line", () => {
  const STEER = 'The decision module chose what to say next. Say this in your own natural words, keeping its meaning: "Ask which car they drive."';

  it("runs the decision step once, then sends the steer and response.create, and the context update after them (the reply never waits for it)", async () => {
    const onCallerFinal = vi.fn(async (_text: string) => "Ask which car they drive.");
    const update = "Stage: quote. Known so far: renewal in March 2027.";
    const contextUpdate = vi.fn(async () => update);
    const { fake } = await started({ onCallerFinal, contextUpdate });
    await playOpening(fake);
    const before = fake.sent.length;
    heard(fake, "I want a quote for my car.");
    await flush();
    expect(onCallerFinal).toHaveBeenCalledTimes(1);
    expect(onCallerFinal).toHaveBeenCalledWith("I want a quote for my car.");
    expect(fake.sent.slice(before)).toEqual([systemItem(STEER), { type: "response.create", event_id: "response_create_2" }, systemItem(update)]);
    const traced = traceBus.history().filter((e) => e.type === "tool_call" && ["call_context_update", "steer_voice_model"].includes(e.data.tool as string));
    expect(traced.map((e) => e.data.tool)).toEqual(["steer_voice_model", "call_context_update"]);
    expect(inputsOf(traced[0]!)).toEqual({ instruction: STEER });
    expect(inputsOf(traced[1]!)).toEqual({ chars: update.length });
    // The dialog owns the caller's record when it runs the decision step.
    expect(lines().filter((e) => e.data.role === "caller")).toHaveLength(0);
  });

  it("with no guidance and no context update still sends response.create", async () => {
    const { fake } = await started({ onCallerFinal: async () => undefined, contextUpdate: async () => undefined });
    await playOpening(fake);
    const before = fake.sent.length;
    heard(fake, "Hello?");
    await flush();
    expect(fake.sent.slice(before)).toEqual([{ type: "response.create", event_id: "response_create_2" }]);
    expect(tools("steer_voice_model")).toHaveLength(0);
    expect(tools("call_context_update")).toHaveLength(0);
  });

  it("a decision step that throws is traced and the reply is still asked for", async () => {
    const { fake } = await started({
      onCallerFinal: async () => {
        throw new Error("boom");
      },
    });
    await playOpening(fake);
    heard(fake, "Hello?");
    await flush();
    expect(tools("decision_step")[0]!.data).toMatchObject({ success: false, reason: "decision_step_failed" });
    expect(creates(fake)).toHaveLength(2);
  });

  it("without a decision step the session records the caller line itself", async () => {
    const { fake } = await started();
    await playOpening(fake);
    heard(fake, "  Hello?  ");
    await flush();
    expect(lines().at(-1)!).toMatchObject({ type: "transcript_final", data: { role: "caller", text: "Hello?", turnIndex: 1, source: "voice_module" } });
  });

  it("a failed transcription asks the caller to say it again, as a system item and a reply", async () => {
    const { fake } = await started();
    await playOpening(fake);
    const before = fake.sent.length;
    fake.emit({ type: "conversation.item.input_audio_transcription.failed", item_id: "item_c1", content_index: 0, error: { type: "transcription_error" } });
    expect(tools("caller_transcription_failed")[0]!.data).toMatchObject({ success: false, reason: "transcription_failed" });
    expect(fake.sent.slice(before)).toEqual([
      systemItem("The caller's last words could not be heard clearly. Ask them briefly to say that again."),
      { type: "response.create", event_id: "response_create_2" },
    ]);
  });

  it("ignores an empty transcript", async () => {
    const onCallerFinal = vi.fn(async () => undefined);
    const { fake } = await started({ onCallerFinal });
    await playOpening(fake);
    heard(fake, "   ");
    await flush();
    expect(onCallerFinal).not.toHaveBeenCalled();
    expect(creates(fake)).toHaveLength(1);
  });

  it("runs caller lines one at a time, in arrival order", async () => {
    const gates: Array<() => void> = [];
    const calls: string[] = [];
    const onCallerFinal = vi.fn((text: string) => {
      calls.push(text);
      return new Promise<string | undefined>((resolve) => gates.push(() => resolve(undefined)));
    });
    const { fake } = await started({ onCallerFinal });
    await playOpening(fake);
    heard(fake, "first", "item_c1");
    heard(fake, "second", "item_c2");
    await flush();
    expect(calls).toEqual(["first"]);
    gates[0]!();
    await flush();
    expect(calls).toEqual(["first", "second"]);
    gates[1]!();
    await flush();
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("a typed caller line", () => {
  it("sends the typed words as a user item before the decision step, then the steer and response.create", async () => {
    let sentAtDecision: Sent[] = [];
    const holder: { fake?: FakeSocket } = {};
    const onCallerFinal = vi.fn(async () => {
      sentAtDecision = [...holder.fake!.sent];
      return "Tell them the price comes by text.";
    });
    const { fake, session } = await started({ onCallerFinal });
    holder.fake = fake;
    await playOpening(fake);
    const before = fake.sent.length;
    void session.sendCallerText("What does it cost?");
    expect(fake.sent.slice(before)).toEqual([userItem("What does it cost?")]);
    expect(onCallerFinal).not.toHaveBeenCalled();
    await flush();
    expect(onCallerFinal).toHaveBeenCalledWith("What does it cost?");
    expect(sentAtDecision.at(-1)).toEqual(userItem("What does it cost?"));
    expect(fake.sent.slice(before)).toEqual([
      userItem("What does it cost?"),
      systemItem('The decision module chose what to say next. Say this in your own natural words, keeping its meaning: "Tell them the price comes by text."'),
      { type: "response.create", event_id: "response_create_2" },
    ]);
    // The reply's timing trace names the typed line as its source.
    reply(fake, { responseId: "resp_2", itemId: "item_2", text: "It comes by text.", ms: 100 });
    expect(inputsOf(tools("voice_live_reply_timing").at(-1)!).source).toBe("typed_caller_line");
  });

  it("refuses a typed line once the session has ended", async () => {
    const { session } = await started();
    session.stop();
    await expect(session.sendCallerText("Hello?")).rejects.toThrow("voice_session_ended");
  });
});

describe("one response at a time", () => {
  it("a reply asked for while a response is being made waits for its response.done", async () => {
    const { fake } = await started({ onCallerFinal: async () => "Ask for the renewal date." });
    // The opening is said and played out, but its response.done has not come yet.
    created(fake, "resp_open");
    agentItem(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 100 });
    await vi.advanceTimersByTimeAsync(110);
    heard(fake, "Hello?");
    await flush();
    expect(creates(fake)).toHaveLength(1);
    responseDone(fake, "resp_open");
    expect(creates(fake)).toEqual([
      { type: "response.create", event_id: "response_create_1" },
      { type: "response.create", event_id: "response_create_2" },
    ]);
  });

  // A reply asked for while a response.create is still unanswered keeps its own timing and is asked for at
  // that response's end (the first reply's transcript clears owesLine, so the reminder would not recover it).
  it("a reply asked for before Voice Live has answered the last response.create is asked for once that response ends", async () => {
    const { fake, session } = await started();
    await playOpening(fake);
    heard(fake, "I want a quote.");
    await flush();
    expect(creates(fake)).toHaveLength(2);
    // A typed line before Voice Live answers response_create_2 with response.created.
    void session.sendCallerText("For my car.");
    await flush();
    expect(creates(fake)).toHaveLength(2);
    reply(fake, { responseId: "resp_2", itemId: "item_2", text: "Sure, I can help with that.", ms: 100 });
    await flush();
    expect(creates(fake).map((m) => m.event_id)).toEqual(["response_create_1", "response_create_2", "response_create_3"]);
  });

  it("a refused response.create does not hold back later replies", async () => {
    const { fake, session } = await started();
    fake.emit({ type: "error", event_id: "event_9", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", event_id: "response_create_1" } });
    expect(tools("voice_provider_warning").map((e) => e.data.reason)).toEqual(["conversation_already_has_active_response"]);
    expect(session.isEnded).toBe(false);
    heard(fake, "Hello?");
    await flush();
    expect(creates(fake).map((m) => m.event_id)).toEqual(["response_create_1", "response_create_2"]);
  });

  it("a refused request that is not a response.create leaves the pending reply waiting", async () => {
    const { fake } = await started();
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "invalid_audio_end_time", event_id: "item_truncate_1" } });
    heard(fake, "Hello?");
    await flush();
    expect(creates(fake)).toHaveLength(1);
  });
});

describe("agent line records", () => {
  it("plays audio at once and records the line, from voice_module and spoken, only once its audio has played out", async () => {
    const { fake, o } = await started();
    created(fake, "resp_open");
    const chunk = agentItem(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 400 });
    expect(o.audio).toEqual([chunk]);
    responseDone(fake, "resp_open");
    await vi.advanceTimersByTimeAsync(390);
    expect(lines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ type: "transcript_final", data: { role: "agent", text: DISCLOSURE, turnIndex: 0, spoken: true, source: "voice_module" } });
  });

  it("records the line as a turn when the dialog owns the transcript", async () => {
    const { fake } = await started({ dialogOwnsTranscript: true });
    await playOpening(fake);
    expect(lines().map((e) => e.type)).toEqual(["turn"]);
    expect(lines()[0]!.data).toMatchObject({ role: "agent", text: DISCLOSURE, spoken: true, source: "voice_module" });
  });

  it("waits for audio that arrives after the transcript before recording", async () => {
    const { fake } = await started();
    created(fake, "resp_open");
    agentItem(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 200 });
    fake.emit({ type: "response.audio.delta", response_id: "resp_open", item_id: "item_open", delta: audio(200) });
    await vi.advanceTimersByTimeAsync(210);
    expect(lines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(lines()).toHaveLength(1);
  });

  it("traces what was said against the steer's guidance", async () => {
    const { fake } = await started({ onCallerFinal: async () => "Ask which car they drive." });
    await playOpening(fake);
    heard(fake, "I want a quote.");
    await flush();
    reply(fake, { responseId: "resp_2", itemId: "item_2", text: "Sure. Which car do you drive?", ms: 200 });
    await vi.advanceTimersByTimeAsync(210);
    const traced = tools("spoken_vs_intended");
    expect(inputsOf(traced[0]!)).toMatchObject({ intended: DISCLOSURE, spoken: DISCLOSURE, overlap: 1, diverged: false });
    expect(inputsOf(traced.at(-1)!)).toMatchObject({ intended: "Ask which car they drive.", spoken: "Sure. Which car do you drive?", diverged: false });
    // A line far from the guidance is marked as diverged.
    heard(fake, "Fine.");
    await flush();
    reply(fake, { responseId: "resp_3", itemId: "item_3", text: "Let me tell you about our bundles.", ms: 100 });
    await vi.advanceTimersByTimeAsync(110);
    expect(inputsOf(tools("spoken_vs_intended").at(-1)!)).toMatchObject({ intended: "Ask which car they drive.", diverged: true });
  });

  it("passes the disclosure check for the opening said word for word", async () => {
    const { fake } = await started();
    await playOpening(fake);
    const checks = tools("disclosure_check");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.data).toMatchObject({ success: true, inputs: { overlap: 1 } });
    expect(checks[0]!.data).not.toHaveProperty("reason");
  });

  it("fails the disclosure check (disclosure_text_mismatch) for an opening that is not the disclosure, and checks only once", async () => {
    const { fake } = await started();
    await playOpening(fake);
    traceBus.reset();
    const other = await started();
    reply(other.fake, { responseId: "resp_open", itemId: "item_open", text: "Hello! How can I help you with your insurance today?", ms: 300 });
    await vi.advanceTimersByTimeAsync(310);
    heard(other.fake, "Who is this?");
    await flush();
    reply(other.fake, { responseId: "resp_2", itemId: "item_2", text: DISCLOSURE, ms: 100 });
    await vi.advanceTimersByTimeAsync(110);
    const checks = tools("disclosure_check");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.data).toMatchObject({ success: false, reason: "disclosure_text_mismatch" });
  });
});

describe("record order", () => {
  it("a caller line transcribed while the disclosure plays is recorded after the disclosure line", async () => {
    const { fake } = await started();
    reply(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 1_000 });
    await vi.advanceTimersByTimeAsync(300);
    fake.emit(speechStarted);
    heard(fake, "Hello, who is this?");
    await flush();
    expect(lines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(710);
    await flush();
    expect(lines().map((e) => [e.data.role, e.data.turnIndex])).toEqual([
      ["agent", 0],
      ["caller", 1],
    ]);
  });
});

describe("barge-in owned by the server", () => {
  it("speech over the agent clears playback, cancels the response, truncates at the milliseconds heard and records the words heard as not spoken", async () => {
    const { fake, o } = await speaking();
    await vi.advanceTimersByTimeAsync(200);
    const before = fake.sent.length;
    const recorded = lines().length;
    fake.emit(speechStarted);
    expect(o.clears).toHaveLength(1);
    expect(tools("clear_playback").map(inputsOf)).toEqual([{ reason: "caller_spoke_over" }]);
    expect(fake.sent.slice(before)).toEqual([
      { type: "response.cancel" },
      { type: "conversation.item.truncate", item_id: "item_2", content_index: 0, audio_end_ms: 200 },
    ]);
    expect(inputsOf(tools("truncate_agent_line").at(-1)!)).toEqual({ playedMs: 200, audioMs: 400, audioEndMs: 200 });
    expect(lines().at(-1)!.data).toMatchObject({ role: "agent", text: "Sure, let me", spoken: false, source: "voice_module" });
    // Nothing more is recorded for the line, and it is not compared with any guidance.
    await vi.advanceTimersByTimeAsync(500);
    expect(lines()).toHaveLength(recorded + 1);
    expect(tools("spoken_vs_intended").filter((e) => inputsOf(e).spoken === REPLY_TEXT)).toHaveLength(0);
    // The caller's line that cut in is recorded after the words they heard.
    heard(fake, "Actually, wait.", "item_caller_speech");
    await flush();
    expect(lines().slice(-2).map((e) => [e.data.role, e.data.text])).toEqual([
      ["agent", "Sure, let me"],
      ["caller", "Actually, wait."],
    ]);
  });

  it("sends no response.cancel when the response is already done, and keeps the truncate inside the item's audio", async () => {
    const { fake, o } = await speaking({}, { responseDone: true });
    await vi.advanceTimersByTimeAsync(390);
    const before = fake.sent.length;
    fake.emit(speechStarted);
    expect(o.clears).toHaveLength(1);
    expect(fake.sent.slice(before)).toEqual([{ type: "conversation.item.truncate", item_id: "item_2", content_index: 0, audio_end_ms: 380 }]);
  });

  it("truncates items not heard yet to 0 and never records them", async () => {
    const { fake } = await speaking();
    agentItem(fake, { responseId: "resp_2", itemId: "item_3", text: "Which car do you drive?", ms: 300 });
    await vi.advanceTimersByTimeAsync(100);
    const before = fake.sent.length;
    fake.emit(speechStarted);
    expect(fake.sent.slice(before)).toEqual([
      { type: "response.cancel" },
      { type: "conversation.item.truncate", item_id: "item_2", content_index: 0, audio_end_ms: 100 },
      { type: "conversation.item.truncate", item_id: "item_3", content_index: 0, audio_end_ms: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines().filter((e) => String(e.data.text).includes("Which car"))).toHaveLength(0);
  });

  it("does nothing when nothing is audible and no response is being made", async () => {
    const { fake, o } = await speaking({}, { responseDone: true });
    await vi.advanceTimersByTimeAsync(410);
    const before = fake.sent.length;
    const traced = traceBus.history().length;
    fake.emit(speechStarted);
    expect(o.clears).toHaveLength(0);
    expect(fake.sent).toHaveLength(before);
    expect(traceBus.history()).toHaveLength(traced);
  });

  it("ignores speech while the opening disclosure is made and played (traced once), and not once it has played out", async () => {
    const { fake, o } = await started({ onCallerFinal: async () => "Ask how they found the agency." });
    const before = fake.sent.length;
    created(fake, "resp_open");
    // Being made: no audio yet.
    fake.emit(speechStarted);
    agentItem(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 500 });
    responseDone(fake, "resp_open");
    await vi.advanceTimersByTimeAsync(100);
    // Playing.
    fake.emit(speechStarted);
    expect(o.clears).toHaveLength(0);
    expect(fake.sent).toHaveLength(before);
    expect(tools("barge_in_ignored").map((e) => e.data.reason)).toEqual(["disclosure_playing"]);
    await vi.advanceTimersByTimeAsync(410);
    expect(lines().at(-1)!.data).toMatchObject({ role: "agent", text: DISCLOSURE, spoken: true });
    heard(fake, "Hi.");
    await flush();
    created(fake, "resp_2");
    agentItem(fake, { responseId: "resp_2", itemId: "item_2", text: REPLY_TEXT, ms: 400 });
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(speechStarted);
    expect(o.clears).toHaveLength(1);
    expect(tools("barge_in_ignored")).toHaveLength(1);
  });

  it("ignores the browser's loudness barge-in and traces it once", async () => {
    const { session, fake, o } = await speaking();
    await vi.advanceTimersByTimeAsync(100);
    const before = fake.sent.length;
    session.bargeIn();
    session.bargeIn();
    expect(o.clears).toHaveLength(0);
    expect(fake.sent).toHaveLength(before);
    expect(tools("barge_in_ignored").map((e) => e.data.reason)).toEqual(["server_owns_barge_in"]);
  });

  it("a typed line while the agent is audible is a barge-in too, before the user item goes out", async () => {
    const { session, fake, o } = await speaking();
    await vi.advanceTimersByTimeAsync(100);
    const before = fake.sent.length;
    void session.sendCallerText("Wait, one question.");
    expect(o.clears).toHaveLength(1);
    expect(tools("clear_playback").map(inputsOf)).toEqual([{ reason: "typed_text" }]);
    expect(kinds(fake.sent.slice(before))).toEqual(["response.cancel", "conversation.item.truncate", "conversation.item.create"]);
    expect(fake.sent.at(-1)).toEqual(userItem("Wait, one question."));
    expect(lines().at(-1)!.data).toMatchObject({ role: "agent", text: "Sure, let", spoken: false });
  });
});

describe("stale output after a barge-in", () => {
  /** A barge-in over a response still being made, then its late audio keeps coming every 20 milliseconds for three turn gaps. */
  async function lateAudio(staleOutputCapGaps?: StaleOutputCapGaps) {
    const ctx = await speaking(staleOutputCapGaps === undefined ? {} : { staleOutputCapGaps });
    await vi.advanceTimersByTimeAsync(100);
    ctx.fake.emit(speechStarted);
    const tracedFrom = traceBus.history().length;
    const playedBefore = ctx.o.audio.length;
    let sent = 0;
    for (let t = 0; t < GAP_MS * 3; t += 20) {
      ctx.fake.emit({ type: "response.audio.delta", response_id: "resp_2", item_id: "item_2", delta: audio(20) });
      sent += 1;
      await vi.advanceTimersByTimeAsync(20);
    }
    const traced = traceBus.history().slice(tracedFrom).filter((e) => e.type === "tool_call" && e.data.tool === "drop_stale_agent_audio");
    ctx.session.stop();
    return { dropped: sent - (ctx.o.audio.length - playedBefore), traced };
  }

  it("drops it for at most one turn gap by default, and traces the count when the window ends", async () => {
    const { dropped, traced } = await lateAudio();
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(GAP_MS / 20 + 1);
    expect(traced).toHaveLength(1);
    expect(inputsOf(traced[0]!)).toEqual({ chunks: dropped });
    expect((await lateAudio(1)).dropped).toBe(dropped);
  });

  it("drops it for longer than one gap and at most two at 2", async () => {
    const one = (await lateAudio(1)).dropped;
    const { dropped, traced } = await lateAudio(2);
    expect(dropped).toBeGreaterThan(one);
    expect(dropped).toBeLessThanOrEqual((2 * GAP_MS) / 20 + 1);
    expect(inputsOf(traced[0]!)).toEqual({ chunks: dropped });
  });

  it("plays it at once when the setting is 0", async () => {
    const { dropped, traced } = await lateAudio(0);
    expect(dropped).toBe(0);
    expect(traced).toHaveLength(0);
  });
});

describe("the speaking model's tool calls", () => {
  const ARGS = { field: "x_date", value: "March 2027", evidence_quote: "renewal is in March 2027" };

  /** A tool runner whose calls wait until the test answers them. */
  function deferredTools() {
    const calls: Array<{ name: string; args: unknown; answer: (r: Awaited<ReturnType<VoiceLiveTools["call"]>>) => void }> = [];
    const runner: VoiceLiveTools = {
      definitions: [{ type: "function", name: "write_quote_field", description: "Save a fact the caller stated.", parameters: { type: "object", properties: {} } }],
      call: (name, args) => new Promise((resolve) => calls.push({ name, args, answer: resolve })),
    };
    return { runner, calls };
  }

  const functionCallDone = (responseId: string, callId: string, name: string, args: string) => ({
    type: "response.output_item.done",
    response_id: responseId,
    output_index: 0,
    item: { id: `fc_${callId}`, type: "function_call", call_id: callId, name, arguments: args },
  });

  /** The opening has played, a caller line came in, and Voice Live is making resp_2. */
  async function asked(patch: Partial<VoiceLiveSessionOptions>) {
    const ctx = await started({ onCallerFinal: async () => "Save the renewal date, then ask how many employees they have.", ...patch });
    await playOpening(ctx.fake);
    heard(ctx.fake, "Our renewal is in March 2027.");
    await flush();
    created(ctx.fake, "resp_2");
    return ctx;
  }

  it("runs the call once with its parsed arguments, sends its output back, and asks for one reply after the response is done", async () => {
    const t = deferredTools();
    const { fake } = await asked({ tools: t.runner });
    const json = JSON.stringify(ARGS);
    fake.emit({ type: "response.output_item.added", response_id: "resp_2", output_index: 0, item: { id: "fc_call_1", type: "function_call", name: "write_quote_field", call_id: "call_1" } });
    fake.emit({ type: "response.function_call_arguments.delta", response_id: "resp_2", item_id: "fc_call_1", call_id: "call_1", delta: json });
    fake.emit({ type: "response.function_call_arguments.done", response_id: "resp_2", item_id: "fc_call_1", call_id: "call_1", name: "write_quote_field", arguments: json });
    fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", json));
    await flush();
    expect(t.calls.map((c) => [c.name, c.args])).toEqual([["write_quote_field", ARGS]]);
    const createsBefore = creates(fake).length;
    t.calls[0]!.answer({ output: '{"ok":true,"speakable":"Saved."}', ok: true });
    await flush();
    expect(toolOutputs(fake)).toEqual([{ type: "function_call_output", call_id: "call_1", output: '{"ok":true,"speakable":"Saved."}' }]);
    // The response that asked is still being made.
    expect(creates(fake)).toHaveLength(createsBefore);
    responseDone(fake, "resp_2");
    expect(creates(fake)).toHaveLength(createsBefore + 1);
    const traced = tools("voice_live_tool_call");
    expect(traced).toHaveLength(1);
    expect(inputsOf(traced[0]!)).toEqual({ name: "write_quote_field", callId: "call_1", ok: true });
    expect(traced[0]!.data.success).toBe(true);
    expect(traced[0]!.data).not.toHaveProperty("reason");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(creates(fake)).toHaveLength(createsBefore + 1);
    expect(t.calls).toHaveLength(1);
  });

  it("asks for the reply once the output is sent when the response was already done", async () => {
    const t = deferredTools();
    const { fake } = await asked({ tools: t.runner });
    fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", JSON.stringify(ARGS)));
    responseDone(fake, "resp_2");
    await flush();
    const createsBefore = creates(fake).length;
    t.calls[0]!.answer({ output: '{"ok":true}', ok: true });
    await flush();
    expect(creates(fake)).toHaveLength(createsBefore + 1);
    // The output goes out before the reply is asked for.
    const outputAt = fake.sent.findIndex((m) => (m.item as Record<string, unknown> | undefined)?.type === "function_call_output");
    expect(fake.sent.lastIndexOf(creates(fake).at(-1)!)).toBeGreaterThan(outputAt);
  });

  it("waits for every call of the turn before one response.create", async () => {
    const t = deferredTools();
    const { fake } = await asked({ tools: t.runner });
    fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", JSON.stringify(ARGS)));
    fake.emit(functionCallDone("resp_2", "call_2", "save_message", "{}"));
    await flush();
    expect(t.calls.map((c) => c.name)).toEqual(["write_quote_field", "save_message"]);
    const createsBefore = creates(fake).length;
    t.calls[0]!.answer({ output: '{"ok":true}', ok: true });
    await flush();
    responseDone(fake, "resp_2");
    await flush();
    expect(creates(fake)).toHaveLength(createsBefore);
    t.calls[1]!.answer({ output: '{"ok":true}', ok: true });
    await flush();
    expect(toolOutputs(fake).map((i) => (i as Record<string, unknown>).call_id)).toEqual(["call_1", "call_2"]);
    expect(creates(fake)).toHaveLength(createsBefore + 1);
  });

  it("traces a refusal with its code as the reason, and an ending call", async () => {
    const t = deferredTools();
    const { fake } = await asked({ tools: t.runner });
    fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", JSON.stringify(ARGS)));
    fake.emit(functionCallDone("resp_2", "call_2", "end_call", "{}"));
    await flush();
    t.calls[0]!.answer({ output: '{"ok":false,"refused":{"code":"evidence_not_heard"}}', ok: false, refusedCode: "evidence_not_heard" });
    t.calls[1]!.answer({ output: '{"ok":true,"endCall":true}', ok: true, endCall: true });
    await flush();
    const traced = tools("voice_live_tool_call");
    expect(traced[0]!.data).toMatchObject({ success: false, reason: "evidence_not_heard", inputs: { name: "write_quote_field", callId: "call_1", ok: false } });
    expect(traced[1]!.data).toMatchObject({ success: true, inputs: { name: "end_call", callId: "call_2", ok: true, endCall: true } });
  });

  it("reads malformed arguments as an empty object", async () => {
    const t = deferredTools();
    const { fake } = await asked({ tools: t.runner });
    ["{not json", "", "42", "null", '"text"'].forEach((args, i) => fake.emit(functionCallDone("resp_2", `call_${i}`, "write_quote_field", args)));
    await flush();
    expect(t.calls.map((c) => c.args)).toEqual([{}, {}, {}, {}, {}]);
  });

  it("does not run a call of a response cancelled by a barge-in, and answers it as interrupted", async () => {
    const t = deferredTools();
    const { fake } = await speaking({ tools: t.runner });
    await vi.advanceTimersByTimeAsync(100);
    fake.emit(speechStarted);
    const createsBefore = creates(fake).length;
    fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", JSON.stringify(ARGS)));
    responseDone(fake, "resp_2", "cancelled");
    await flush();
    expect(t.calls).toHaveLength(0);
    expect(toolOutputs(fake)).toEqual([
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ ok: false, refused: { code: "interrupted", reason: "caller_spoke_over" } }) },
    ]);
    expect(tools("voice_live_tool_call")[0]!.data).toMatchObject({ success: false, reason: "interrupted", inputs: { name: "write_quote_field", callId: "call_1" } });
    expect(creates(fake)).toHaveLength(createsBefore);
  });

  it("answers no_tools when the session has no runner, and run_failed when the runner throws", async () => {
    const plain = await asked({});
    plain.fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", "{}"));
    await flush();
    expect(JSON.parse(String((toolOutputs(plain.fake)[0] as Record<string, unknown>).output))).toMatchObject({ ok: false, refused: { code: "no_tools" } });
    plain.session.stop();
    const throwing = await asked({
      tools: {
        definitions: [],
        call: async () => {
          throw new Error("boom");
        },
      },
    });
    throwing.fake.emit(functionCallDone("resp_2", "call_1", "write_quote_field", "{}"));
    await flush();
    expect(JSON.parse(String((toolOutputs(throwing.fake)[0] as Record<string, unknown>).output))).toMatchObject({ ok: false, refused: { code: "run_failed" } });
    expect(tools("voice_live_tool_call").at(-1)!.data).toMatchObject({ success: false, reason: "run_failed" });
  });
});

describe("the line guard", () => {
  it("does not hold the opening disclosure", async () => {
    const guard = vi.fn(async (line: string) => line);
    const { fake, o } = await started({ guardAgentLine: guard });
    created(fake, "resp_open");
    const chunk = agentItem(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE, ms: 300, transcriptOpen: true });
    expect(o.audio).toEqual([chunk]);
    transcriptDone(fake, { responseId: "resp_open", itemId: "item_open", text: DISCLOSURE });
    responseDone(fake, "resp_open");
    await vi.advanceTimersByTimeAsync(310);
    expect(guard).not.toHaveBeenCalled();
    expect(lines().at(-1)!.data).toMatchObject({ text: DISCLOSURE, spoken: true });
  });

  it("holds a line's audio until its transcript is done, then plays it and records the checked text", async () => {
    const guard = vi.fn(async (line: string) => line.replace("guaranteed", "estimated"));
    const { fake, o } = await started({ guardAgentLine: guard, onCallerFinal: async () => "Say the price comes by text." });
    await playOpening(fake);
    heard(fake, "What will it cost?");
    await flush();
    const played = o.audio.length;
    const text = "Your guaranteed price comes by text.";
    created(fake, "resp_2");
    const chunk = agentItem(fake, { responseId: "resp_2", itemId: "item_2", text, ms: 200, transcriptOpen: true });
    expect(o.audio).toHaveLength(played);
    transcriptDone(fake, { responseId: "resp_2", itemId: "item_2", text });
    responseDone(fake, "resp_2");
    await flush();
    expect(guard).toHaveBeenCalledWith(text);
    expect(o.audio.slice(played)).toEqual([chunk]);
    expect(tools("guard_agent_line").at(-1)!.data).toMatchObject({ success: true, inputs: { chars: text.length } });
    await vi.advanceTimersByTimeAsync(190);
    expect(lines().filter((e) => e.data.role === "agent")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(lines().at(-1)!.data).toMatchObject({ role: "agent", text: "Your estimated price comes by text.", spoken: true, source: "voice_module" });
  });

  it("drops a blocked line with a truncate to 0 and records nothing", async () => {
    const guard = vi.fn(async () => null);
    const { fake, o } = await started({ guardAgentLine: guard });
    await playOpening(fake);
    heard(fake, "What will it cost?");
    await flush();
    const played = o.audio.length;
    const before = fake.sent.length;
    const text = "Your guaranteed price is forty dollars.";
    created(fake, "resp_2");
    agentItem(fake, { responseId: "resp_2", itemId: "item_2", text, ms: 200 });
    responseDone(fake, "resp_2");
    await flush();
    expect(o.audio).toHaveLength(played);
    expect(fake.sent.slice(before)).toContainEqual({ type: "conversation.item.truncate", item_id: "item_2", content_index: 0, audio_end_ms: 0 });
    expect(tools("guard_agent_line").at(-1)!.data).toMatchObject({ success: false, reason: "agent_line_blocked" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines().filter((e) => e.data.text === text)).toHaveLength(0);
    // Late audio of the blocked line is never played.
    fake.emit({ type: "response.audio.delta", response_id: "resp_2", item_id: "item_2", delta: audio(20) });
    expect(o.audio).toHaveLength(played);
  });

  it("treats a guard that throws as a block", async () => {
    const guard = vi.fn(async (): Promise<string | null> => {
      throw new Error("guard down");
    });
    const { fake, o } = await started({ guardAgentLine: guard });
    await playOpening(fake);
    heard(fake, "Hi.");
    await flush();
    const played = o.audio.length;
    reply(fake, { responseId: "resp_2", itemId: "item_2", text: "Anything.", ms: 100 });
    await flush();
    expect(o.audio).toHaveLength(played);
    expect(tools("guard_agent_line").at(-1)!.data).toMatchObject({ success: false, reason: "agent_line_blocked" });
  });
});

describe("errors and endings during the call", () => {
  it("a refused request is a warning with its code, and the call goes on", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "invalid_audio_end_time", message: "audio_end_ms is past the end." } });
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active" } });
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "Not An Identifier" } });
    expect(tools("voice_provider_warning").map((e) => e.data.reason)).toEqual(["invalid_audio_end_time", "response_cancel_not_active", "invalid_request"]);
    expect(session.isEnded).toBe(false);
    expect(o.providerErrors).toEqual([]);
    expect(o.ends).toEqual([]);
    expect(JSON.stringify(traceBus.history())).not.toContain("past the end");
  });

  it("a failed response is a warning with its code", async () => {
    const { fake, session } = await started();
    created(fake, "resp_open");
    fake.emit({ type: "response.done", response: { id: "resp_open", status: "failed", status_details: { error: { type: "server_error", code: "output_creation_failed" } } } });
    expect(tools("voice_provider_warning").map((e) => e.data.reason)).toEqual(["output_creation_failed"]);
    expect(session.isEnded).toBe(false);
  });

  it("a server error ends the call with azure_voice_live_error and Voice Live's type and code", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "error", error: { type: "server_error", code: "internal_error", message: "Something broke." } });
    expect(o.providerErrors).toEqual([["azure_voice_live_error", "server_error / internal_error"]]);
    expect(tools("voice_provider_error")[0]!.data).toMatchObject({ success: false, reason: "azure_voice_live_error" });
    expect(session.isEnded).toBe(true);
    expect(o.ends.map((e) => e.reason)).toEqual(["voice_live_error"]);
    expect(tools("voice_session_close")[0]!.data).toMatchObject({ inputs: { reason: "voice_live_error" } });
    expect(fake.closed).toBe(true);
  });

  it("an authentication error during the call ends it with azure_voice_live_auth_failed", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key" } });
    expect(o.providerErrors.map(([code]) => code)).toEqual(["azure_voice_live_auth_failed"]);
    expect(session.isEnded).toBe(true);
  });

  it("the socket closing ends the call with voice_live_closed", async () => {
    const { session, fake, o } = await started();
    fake.drop();
    expect(session.isEnded).toBe(true);
    expect(o.ends.map((e) => e.reason)).toEqual(["voice_live_closed"]);
    expect(tools("voice_session_close")[0]!.data).toMatchObject({ inputs: { reason: "voice_live_closed" } });
  });

  it("the cap ends the call with session_cap, and voice_session_close carries the duration", async () => {
    const { session, o } = await started({ maxMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_990);
    expect(session.isEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(o.ends).toEqual([{ reason: "session_cap", durationMs: 5_000 }]);
    const close = tools("voice_session_close");
    expect(close).toHaveLength(1);
    expect(close[0]!.data).toMatchObject({ success: true, durationMs: 5_000, inputs: { reason: "session_cap" } });
  });

  it("stop() records a line still playing as interrupted, with the words heard so far, and ends once", async () => {
    const { session, fake, o } = await speaking();
    await vi.advanceTimersByTimeAsync(200);
    session.stop();
    session.stop();
    expect(lines().at(-1)!.data).toMatchObject({ role: "agent", text: "Sure, let me", spoken: false, source: "voice_module" });
    expect(o.ends.map((e) => e.reason)).toEqual(["caller_hangup"]);
    expect(tools("voice_session_close")).toHaveLength(1);
    expect(fake.closed).toBe(true);
    // Nothing after the end: no events handled, no audio sent.
    const sent = fake.sent.length;
    fake.emit({ type: "response.audio.delta", response_id: "resp_2", item_id: "item_2", delta: audio(20) });
    session.sendAudio(audio(20));
    expect(fake.sent).toHaveLength(sent);
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS * 2);
    expect(lines().filter((e) => e.data.text === REPLY_TEXT)).toHaveLength(0);
  });

  it("aborting the signal during the call ends it as a caller hangup", async () => {
    const abort = new AbortController();
    const { session, o } = await started({ signal: abort.signal });
    abort.abort();
    expect(session.isEnded).toBe(true);
    expect(o.ends.map((e) => e.reason)).toEqual(["caller_hangup"]);
  });
});

describe("the reminder", () => {
  it("with no agent words REMIND_AFTER_MS after a steer, reminds once with the guidance and asks for a reply, never twice", async () => {
    const { session, fake } = await started({ onCallerFinal: async () => "Ask which car they drive." });
    await playOpening(fake);
    heard(fake, "I want a quote.");
    await flush();
    // Voice Live makes a response with nothing in it.
    created(fake, "resp_2");
    responseDone(fake, "resp_2");
    const before = fake.sent.length;
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS - 10);
    expect(fake.sent).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(20);
    expect(tools("remind_voice_model")).toHaveLength(1);
    expect(fake.sent.slice(before)).toEqual([
      systemItem('The caller is waiting for your reply. Say this in your own natural words, keeping its meaning: "Ask which car they drive."'),
      { type: "response.create", event_id: "response_create_3" },
    ]);
    session.remind();
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS * 2);
    expect(tools("remind_voice_model")).toHaveLength(1);
    expect(fake.sent).toHaveLength(before + 2);
  });

  it("reminds the opening word for word", async () => {
    const { fake } = await started();
    // The opening's response.create was refused, so nothing is being made.
    fake.emit({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", event_id: "response_create_1" } });
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS + 10);
    expect(systemTexts(fake).at(-1)).toBe(`The caller is waiting for your reply. Say exactly "${DISCLOSURE}" now.`);
    expect(creates(fake).map((m) => m.event_id)).toEqual(["response_create_1", "response_create_2"]);
  });

  it("does not remind once the agent's words arrive", async () => {
    const { fake } = await started({ onCallerFinal: async () => "Ask which car they drive." });
    await playOpening(fake);
    heard(fake, "I want a quote.");
    await flush();
    created(fake, "resp_2");
    fake.emit({ type: "response.output_item.added", response_id: "resp_2", item: { id: "item_2", type: "message", role: "assistant" } });
    fake.emit({ type: "response.audio_transcript.delta", response_id: "resp_2", item_id: "item_2", delta: "Which car" });
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS + 10);
    expect(tools("remind_voice_model")).toHaveLength(0);
  });
});

describe("heardWords", () => {
  const words = [
    { atMs: 0, text: "Sure" },
    { atMs: 60, text: "," },
    { atMs: 80, text: "let" },
    { atMs: 150, text: "me" },
    { atMs: 210, text: "check" },
    { atMs: 290, text: "." },
  ];

  it("cuts the word timestamps at the milliseconds played, with punctuation attached", () => {
    const item = { text: "Sure, let me check.", textDone: true, words, audioMs: 400 };
    expect(heardWords(item, 0)).toBe("");
    expect(heardWords(item, 70)).toBe("Sure,");
    expect(heardWords(item, 150)).toBe("Sure, let");
    expect(heardWords(item, 200)).toBe("Sure, let me");
    expect(heardWords(item, 400)).toBe("Sure, let me check.");
  });

  it("uses the timestamps before the transcript is done when they reach the milliseconds played", () => {
    expect(heardWords({ text: "Sure, let me", textDone: false, words, audioMs: 400 }, 200)).toBe("Sure, let me");
  });

  it("without timestamps takes the same share of the words", () => {
    const item = { text: "one two three four five six seven eight", words: [], audioMs: 800 };
    expect(heardWords(item, 400)).toBe("one two three four");
    expect(heardWords(item, 150)).toBe("one");
    expect(heardWords(item, 0)).toBe("");
    expect(heardWords(item, 2_000)).toBe(item.text);
    expect(heardWords({ ...item, audioMs: 0 }, 100)).toBe("");
    expect(heardWords({ ...item, text: "  " }, 400)).toBe("");
  });

  it("falls back to the share when the timestamps stop short of the milliseconds played and the transcript is still coming", () => {
    const item = { text: "one two three four", textDone: false, words: [{ atMs: 0, text: "one" }], audioMs: 400 };
    expect(heardWords(item, 200)).toBe("one two");
  });
});

describe("the voice error catalog", () => {
  it("has every code the session can throw or report", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/modules/azure-voice-live-session.ts", import.meta.url)), "utf8");
    // The session modes share the prefix but are not errors; if a mode is added, this line has to change with it.
    expect(src).toContain('export type VoiceLiveSessionMode = "azure_voice_live_microphone" | "azure_voice_live_text";');
    const modes = new Set(["azure_voice_live_microphone", "azure_voice_live_text"]);
    const found = new Set([...src.matchAll(/"(azure_voice_live_[a-z_]+)"/g)].map((m) => m[1]!).filter((c) => !modes.has(c)));
    const shapes: unknown[] = [
      undefined,
      "text",
      {},
      { type: "server_error", code: "internal_error" },
      { type: "invalid_request_error", code: "invalid_model" },
      { type: "invalid_request_error", code: "invalid_api_key" },
      { status: 403 },
      { type: "rate_limit_error", code: "rate_limit_exceeded" },
      { status: 429 },
      { code: "insufficient_quota" },
    ];
    for (const error of shapes) found.add(classifyVoiceLiveError(error));
    expect(found.size).toBeGreaterThan(6);
    expect([...found].filter((code) => !(code in VOICE_ERROR_CATALOG))).toEqual([]);
    for (const code of found) expect((VOICE_ERROR_CATALOG as Record<string, { path: string }>)[code]!.path, code).toBe("azure_voice_live");
  });

  it("classifies from the code, type and status fields only, never the message", () => {
    expect(classifyVoiceLiveError({ type: "server_error", message: "401 unauthorized rate limit" })).toBe("azure_voice_live_error");
    expect(classifyVoiceLiveError({ code: "access_denied" })).toBe("azure_voice_live_auth_failed");
    expect(classifyVoiceLiveError({ status: 429 })).toBe("azure_voice_live_rate_limited");
  });
});
