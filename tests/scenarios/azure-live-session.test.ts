import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureLiveSession, isSpeech, muLawMagnitude, REMIND_AFTER_MS, STEER_HOLD_CAP_MS, STEER_QUIET_MS, type LiveSessionOptions, type LiveSocket } from "../../src/modules/azure-live-session.js";
import * as simulator from "../../src/simulator/live-text-session.js";
import { traceBus } from "../../src/trace/index.js";

const GAP_MS = 100;

interface FakeSocket {
  socket: LiveSocket;
  sent: Array<{ type?: string }>;
  closed: boolean;
  emit(event: Record<string, unknown>): void;
}

function fakeSocket(): FakeSocket {
  let onMessage: (raw: string) => void = () => undefined;
  const fake: FakeSocket = {
    sent: [],
    closed: false,
    emit: (event) => onMessage(JSON.stringify(event)),
    socket: {
      send: (data) => void fake.sent.push(JSON.parse(data)),
      close: () => void (fake.closed = true),
      onMessage: (cb) => void (onMessage = cb),
      onClose: () => undefined,
    },
  };
  return fake;
}

function options(patch: Partial<LiveSessionOptions> = {}): LiveSessionOptions & { audio: string[]; ends: string[]; clears: number[] } {
  const audio: string[] = [];
  const ends: string[] = [];
  const clears: number[] = [];
  return {
    socketFactory: async () => fakeSocket().socket,
    credentials: () => ({ liveUrl: "wss://example.openai.azure.com/openai/v1/live/sessions", apiKey: "k" }),
    trace: { leadId: "lead-1", recordId: "call_live", channel: "call", direction: "inbound", callId: "call_live" },
    model: "gpt-live-1",
    voice: "marin",
    instructions: "Be brief.",
    disclosure: "Hi, I am an AI assistant.",
    maxMs: 60_000,
    turnGapMs: GAP_MS,
    startTimeoutMs: 1_000,
    dialogOwnsTranscript: false,
    onAudio: (b64) => void audio.push(b64),
    onClearPlayback: () => void clears.push(Date.now()),
    onEnd: ({ reason }) => void ends.push(reason),
    ...patch,
    audio,
    ends,
    clears,
  };
}

/** A started session on a fake socket. */
async function started(patch: Partial<LiveSessionOptions> = {}) {
  const fake = fakeSocket();
  const o = options({ socketFactory: async () => fake.socket, ...patch });
  const session = new AzureLiveSession(o);
  const starting = session.start();
  await vi.advanceTimersByTimeAsync(0);
  fake.emit({ type: "session.started" });
  await starting;
  return { session, fake, o };
}

beforeEach(() => {
  vi.useFakeTimers();
  traceBus.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("barge-in drops the interrupted line's audio, and only that", () => {
  it("drops audio still arriving from the interrupted line after the browser reports a barge-in", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    fake.emit({ type: "session.output_audio.delta", delta: "spoken" });
    session.bargeIn();
    expect(o.clears).toHaveLength(1);
    fake.emit({ type: "session.output_audio.delta", delta: "stale" });
    fake.emit({ type: "session.output_transcript.delta", delta: "how can I help" });
    fake.emit({ type: "session.output_audio.delta", delta: "stale-2" });
    expect(o.audio).toEqual(["spoken"]);
  });

  it("drops stale audio after the caller speaks over the agent too", async () => {
    const { fake, o } = await started();
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    fake.emit({ type: "session.output_audio.delta", delta: "spoken" });
    fake.emit({ type: "session.input_transcript.delta", delta: "wait" });
    expect(o.clears).toHaveLength(1);
    fake.emit({ type: "session.output_audio.delta", delta: "stale" });
    expect(o.audio).toEqual(["spoken"]);
  });

  it("plays a fresh reply once the interrupted line has gone quiet", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    session.bargeIn();
    fake.emit({ type: "session.output_transcript.delta", delta: "stale words" });
    await vi.advanceTimersByTimeAsync(GAP_MS + 10);
    fake.emit({ type: "session.output_audio.delta", delta: "fresh" });
    fake.emit({ type: "session.output_transcript.delta", delta: "Sure, go ahead." });
    expect(o.audio).toEqual(["fresh"]);
    expect(session.isEnded).toBe(false);
  });

  it("never holds back output for longer than a short cap, even if the model keeps talking", async () => {
    const { session, fake, o } = await started();
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    session.bargeIn();
    for (let i = 0; i < 40; i += 1) {
      fake.emit({ type: "session.output_transcript.delta", delta: "word " });
      await vi.advanceTimersByTimeAsync(GAP_MS / 2);
    }
    fake.emit({ type: "session.output_audio.delta", delta: "later" });
    expect(o.audio).toEqual(["later"]);
  });

  it("asks Azure for nothing it does not support when the caller barges in", async () => {
    const { session, fake } = await started();
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    session.bargeIn();
    const kinds = fake.sent.map((m) => m.type);
    expect(kinds.every((k) => ["session.start", "session.instructions.append"].includes(k ?? ""))).toBe(true);
  });

  it("with a line check installed, a stale line is not checked and played as a new line", async () => {
    const guard = vi.fn((line: string) => line);
    const { session, fake, o } = await started({ guardAgentLine: guard });
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    fake.emit({ type: "session.output_audio.delta", delta: "held" });
    session.bargeIn();
    fake.emit({ type: "session.output_transcript.delta", delta: "stale words" });
    fake.emit({ type: "session.output_audio.delta", delta: "stale" });
    await vi.advanceTimersByTimeAsync(GAP_MS * 3);
    expect(guard).not.toHaveBeenCalled();
    expect(o.audio).toEqual([]);
  });
});

describe("socket setup obeys the start deadline and stop", () => {
  it("a socket factory that never resolves fails at the start deadline", async () => {
    const o = options({ socketFactory: () => new Promise<LiveSocket>(() => undefined), startTimeoutMs: 500 });
    const session = new AzureLiveSession(o);
    const starting = session.start().catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(501);
    expect(await starting).toBe("azure_start_timeout");
    expect(o.ends).toEqual(["start_timeout"]);
  });

  it("one deadline covers the socket and the session start together", async () => {
    const fake = fakeSocket();
    const o = options({
      socketFactory: () => new Promise<LiveSocket>((resolve) => setTimeout(() => resolve(fake.socket), 400)),
      startTimeoutMs: 500,
    });
    const session = new AzureLiveSession(o);
    const starting = session.start().catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(501);
    expect(await starting).toBe("azure_start_timeout");
    expect(o.ends).toEqual(["start_timeout"]);
  });

  it("stop during a pending socket setup ends the start at once, and ends the session once", async () => {
    const o = options({ socketFactory: () => new Promise<LiveSocket>(() => undefined) });
    const session = new AzureLiveSession(o);
    const starting = session.start().catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(10);
    session.stop("caller_hangup");
    await vi.advanceTimersByTimeAsync(0);
    expect(await starting).toBe("voice_session_ended");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(o.ends).toEqual(["caller_hangup"]);
  });

  it("a socket that arrives after the start gave up is closed and never sent a session start", async () => {
    const fake = fakeSocket();
    let resolveSocket: (s: LiveSocket) => void = () => undefined;
    const o = options({ socketFactory: () => new Promise<LiveSocket>((resolve) => (resolveSocket = resolve)) });
    const session = new AzureLiveSession(o);
    const starting = session.start().catch((err: Error) => err.message);
    session.stop("caller_hangup");
    await vi.advanceTimersByTimeAsync(0);
    resolveSocket(fake.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(await starting).toBe("voice_session_ended");
    expect(fake.closed).toBe(true);
    expect(fake.sent).toEqual([]);
  });

  it("an already aborted signal opens no socket at all", async () => {
    const factory = vi.fn(async () => fakeSocket().socket);
    const abort = new AbortController();
    abort.abort();
    const o = options({ socketFactory: factory, signal: abort.signal });
    const result = await new AzureLiveSession(o).start().catch((err: Error) => err.message);
    expect(result).toBe("voice_session_ended");
    expect(factory).not.toHaveBeenCalled();
    expect(o.ends).toEqual(["caller_hangup"]);
  });

  it("aborting the signal while the socket is pending stops the session and closes the late socket", async () => {
    const fake = fakeSocket();
    let resolveSocket: (s: LiveSocket) => void = () => undefined;
    const abort = new AbortController();
    const o = options({ socketFactory: () => new Promise<LiveSocket>((resolve) => (resolveSocket = resolve)), signal: abort.signal });
    const session = new AzureLiveSession(o);
    const starting = session.start().catch((err: Error) => err.message);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await starting).toBe("voice_session_ended");
    resolveSocket(fake.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.closed).toBe(true);
    expect(o.ends).toEqual(["caller_hangup"]);
  });

  it("aborting the signal after the start stops a running session", async () => {
    const abort = new AbortController();
    const { session, o } = await started({ signal: abort.signal });
    abort.abort();
    expect(session.isEnded).toBe(true);
    expect(o.ends).toEqual(["caller_hangup"]);
  });
});

describe("the stale-output drop after a barge-in is a setting", () => {
  /** After a barge-in the model keeps talking; returns how many chunks were dropped before audio passes again. */
  async function droppedChunks(staleOutputCapGaps?: 0 | 1 | 2) {
    const { session, fake, o } = await started(staleOutputCapGaps === undefined ? {} : { staleOutputCapGaps });
    fake.emit({ type: "session.output_transcript.delta", delta: "Hello there, " });
    session.bargeIn();
    let sent = 0;
    // A chunk every 20 milliseconds with transcript, so the quiet gap never ends by itself.
    for (let t = 0; t < GAP_MS * 3; t += 20) {
      fake.emit({ type: "session.output_transcript.delta", delta: "w " });
      fake.emit({ type: "session.output_audio.delta", delta: `c${sent}` });
      sent += 1;
      await vi.advanceTimersByTimeAsync(20);
    }
    return { dropped: sent - o.audio.length, sent };
  }

  it("off drops nothing", async () => {
    expect((await droppedChunks(0)).dropped).toBe(0);
  });

  it("one gap (the default) drops for at most one turn gap", async () => {
    const { dropped } = await droppedChunks(1);
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(GAP_MS / 20 + 1);
    expect((await droppedChunks()).dropped).toBe(dropped);
  });

  it("two gaps drops for longer than one gap and at most two", async () => {
    const one = (await droppedChunks(1)).dropped;
    const two = (await droppedChunks(2)).dropped;
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThanOrEqual((2 * GAP_MS) / 20 + 1);
  });

  it("the session-open trace records the setting", async () => {
    await started({ staleOutputCapGaps: 0 });
    const open = traceBus.history().find((e) => e.type === "tool_call" && e.data.tool === "voice_session_open" && e.data.success);
    expect((open?.data.inputs as Record<string, unknown>).staleOutputCapGaps).toBe(0);
  });
});

describe("a refused start", () => {
  it("is traced with the model, the voice and the instruction length, like a successful one", async () => {
    const fake = fakeSocket();
    const session = new AzureLiveSession(options({ socketFactory: async () => fake.socket }));
    const starting = session.start().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    fake.emit({ type: "error", error: { type: "server_error", code: "output_creation_failed" } });
    expect(((await starting) as Error).message).toBe("azure_session_rejected");
    const open = traceBus.history().find((e) => e.type === "tool_call" && e.data.tool === "voice_session_open");
    expect(open?.data).toMatchObject({ success: false, inputs: { model: "gpt-live-1", voice: "marin", instructionsChars: "Be brief.".length } });
    expect(JSON.stringify(open?.data)).not.toContain("Be brief.");
  });
});

describe("steer guard and reminder", () => {
  const loud = Buffer.alloc(160, 0x00).toString("base64");
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const appends = (fake: FakeSocket) => fake.sent.filter((m) => m.type === "session.instructions.append") as Array<{ content?: string }>;
  const tools = (name: string) => traceBus.history().filter((e) => e.type === "tool_call" && e.data.tool === name);

  // A low noise floor: bytes 0xF0 to 0xFD decode to a few tens of amplitude.
  const noiseFloor = Buffer.from(Array.from({ length: 160 }, (_, i) => 0xf0 + (i % 14))).toString("base64");

  it("shares one speech check: digital silence and a low noise floor are quiet, speech is speech", () => {
    expect(simulator.isSpeech).toBe(isSpeech);
    expect(simulator.muLawMagnitude).toBe(muLawMagnitude);
    expect(muLawMagnitude(0xff)).toBe(0);
    expect(muLawMagnitude(0x00)).toBe(32124);
    expect(isSpeech(silence)).toBe(false);
    expect(isSpeech(noiseFloor)).toBe(false);
    expect(isSpeech(Buffer.from(Array.from({ length: 160 }, (_, i) => (i % 2 ? 0x20 : 0xa0))).toString("base64"))).toBe(true);
    expect(isSpeech(loud)).toBe(true);
    expect(isSpeech("")).toBe(false);
  });

  it("a steer sent while Azure streams a low noise floor goes out at once, not at the cap", async () => {
    const { session, fake } = await started();
    fake.emit({ type: "session.output_audio.delta", delta: noiseFloor });
    await vi.advanceTimersByTimeAsync(STEER_QUIET_MS + 10);
    const before = appends(fake).length;
    fake.emit({ type: "session.output_audio.delta", delta: noiseFloor });
    void session.sendCallerText("hello?");
    await vi.advanceTimersByTimeAsync(0);
    expect(appends(fake).length).toBe(before + 1);
    expect(tools("steer_held_for_quiet")).toHaveLength(0);
  });

  it("a steer sent while the model is speaking goes out once it has been quiet for 600 milliseconds", async () => {
    const { session, fake } = await started();
    const before = appends(fake).length;
    fake.emit({ type: "session.output_transcript.delta", delta: "Hi there" });
    fake.emit({ type: "session.output_audio.delta", delta: loud });
    void session.sendCallerText("what does it cost?");
    await vi.advanceTimersByTimeAsync(0);
    expect(appends(fake).length).toBe(before); // held: the model is still speaking
    fake.emit({ type: "session.output_audio.delta", delta: silence }); // silence does not count as speech
    await vi.advanceTimersByTimeAsync(STEER_QUIET_MS - 50);
    expect(appends(fake).length).toBe(before);
    await vi.advanceTimersByTimeAsync(60);
    expect(appends(fake).length).toBe(before + 1);
    expect(appends(fake).at(-1)!.content).toContain("what does it cost?");
    expect(tools("steer_held_for_quiet").at(-1)!.data.inputs).toMatchObject({ count: 1, capped: false });
  });

  it("a steer sent while the model is quiet goes out at once", async () => {
    const { session, fake } = await started();
    await vi.advanceTimersByTimeAsync(STEER_QUIET_MS + 10);
    const before = appends(fake).length;
    void session.sendCallerText("hello?");
    await vi.advanceTimersByTimeAsync(0);
    expect(appends(fake).length).toBe(before + 1);
    expect(tools("steer_held_for_quiet")).toHaveLength(0);
  });

  it("a steer is never held longer than the cap, even while the model keeps speaking", async () => {
    const { session, fake } = await started();
    fake.emit({ type: "session.output_audio.delta", delta: loud });
    const before = appends(fake).length;
    void session.sendCallerText("are you there?");
    for (let t = 0; t < STEER_HOLD_CAP_MS - 100; t += 100) {
      fake.emit({ type: "session.output_audio.delta", delta: loud });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(appends(fake).length).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(appends(fake).length).toBe(before + 1);
    expect(tools("steer_held_for_quiet").at(-1)!.data.inputs).toMatchObject({ capped: true });
  });

  it("after 12 seconds with no agent words the model is reminded once, word for word for the opening", async () => {
    const { session, fake } = await started();
    const before = appends(fake).length;
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS + 10);
    expect(appends(fake).length).toBe(before + 1);
    expect(appends(fake).at(-1)!.content).toBe('The caller is waiting for your reply. Say exactly "Hi, I am an AI assistant." now.');
    expect(tools("remind_voice_model")).toHaveLength(1);
    session.remind(); // once per owed line
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS);
    expect(tools("remind_voice_model")).toHaveLength(1);
  });

  it("a reminder for a guided line keeps its meaning; with no intent it asks for a reply; none once the agent speaks", async () => {
    const guided = await started({ onCallerFinal: async () => "Ask which car they drive." });
    {
      guided.fake.emit({ type: "session.output_transcript.delta", delta: "Hi, I am an AI assistant." });
      await vi.advanceTimersByTimeAsync(GAP_MS * 2);
      guided.fake.emit({ type: "session.input_transcript.delta", delta: "I want a quote" });
      await vi.advanceTimersByTimeAsync(GAP_MS * 2 + STEER_QUIET_MS);
      guided.session.remind();
      await vi.advanceTimersByTimeAsync(0);
      expect(appends(guided.fake).at(-1)!.content).toBe('The caller is waiting for your reply. Say this in your own natural words, keeping its meaning: "Ask which car they drive."');
    }
    // A typed line with no decision guidance, after the opening was said: the plain line.
    const plain = await started();
    plain.fake.emit({ type: "session.output_transcript.delta", delta: "Hi, I am an AI assistant." });
    await vi.advanceTimersByTimeAsync(GAP_MS * 2 + STEER_QUIET_MS);
    void plain.session.sendCallerText("hello?");
    await vi.advanceTimersByTimeAsync(0);
    plain.session.remind();
    await vi.advanceTimersByTimeAsync(0);
    expect(appends(plain.fake).at(-1)!.content).toBe("The caller is waiting for your reply. Reply to them now.");
    // The agent answers: no reminder is owed any more.
    const answering = await started();
    answering.fake.emit({ type: "session.output_transcript.delta", delta: "Hi" });
    const count = tools("remind_voice_model").length;
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS + 10);
    expect(tools("remind_voice_model")).toHaveLength(count);
  });

  it("sends nothing after the session ended or before it started", async () => {
    const { session, fake } = await started();
    session.stop();
    const before = fake.sent.length;
    session.remind();
    await vi.advanceTimersByTimeAsync(REMIND_AFTER_MS + 10);
    expect(fake.sent.length).toBe(before);
    const notStarted = new AzureLiveSession(options());
    notStarted.remind();
    expect(tools("remind_voice_model").filter((e) => e.callId === "call_live")).toHaveLength(0);
  });
});
