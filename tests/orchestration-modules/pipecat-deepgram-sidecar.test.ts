import { afterEach, describe, expect, it } from "vitest";
import { fakeAzureChat } from "../helpers/fake-azure-chat.js";
import { fakeDeepgram } from "../helpers/fake-deepgram.js";
import { callerFrame, defaultStart, pythonPath, sleep, startSidecar, withReadyWait } from "../helpers/deepgram-sidecar.js";

const DEEPGRAM_KEY = "test-deepgram-key-not-real";
const AZURE_KEY = "test-azure-key-not-real";
const FALLBACK_LINE = "Sorry, could you say that again?";

type Sidecar = ReturnType<typeof startSidecar>;
let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function rig(opts: { speechChunks?: number; chunksFor?: (text: string) => number; speechChunkMs?: number; ignoreClear?: boolean; reply?: (m: unknown) => string; replyDelayMs?: number } = {}) {
  const dg = await fakeDeepgram({ apiKey: DEEPGRAM_KEY, ...opts });
  const az = await fakeAzureChat({ apiKey: AZURE_KEY, reply: opts.reply ?? (() => "Sure, I can help with that quote."), delayMs: opts.replyDelayMs });
  const sidecar: Sidecar = startSidecar({
    DEEPGRAM_API_KEY: DEEPGRAM_KEY,
    DEEPGRAM_BASE_URL: dg.baseUrl,
    AZURE_FOUNDRY_URL: az.url,
    AZURE_FOUNDRY_KEY: AZURE_KEY,
  });
  cleanup.push(() => sidecar.kill(), () => az.close(), () => dg.close());
  return { dg, az, sidecar };
}

describe.skipIf(!pythonPath)("pipecat deepgram sidecar", () => {
  it("starts, says the disclosure word for word and sends mu-law speech", async () => {
    const { dg, sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out", 3);
    expect(dg.seen.spoken.join("")).toContain("Hi Jane, this is an automated assistant calling for the agency.");
    const audio = sidecar.ofType("audio_out");
    // Three 100 millisecond pieces of 16-bit speech become 800 mu-law bytes each.
    expect(Buffer.from(String(audio[0]!.data), "base64").length).toBe(800);
    // The fake was reached (the library would otherwise fall back to the real service).
    expect(dg.seen.listenUrls[0]).toMatch(/model=nova-3-general/);
    expect(dg.seen.listenUrls[0]).toMatch(/encoding=linear16/);
    expect(dg.seen.listenUrls[0]).toMatch(/sample_rate=8000/);
    expect(dg.seen.speakUrls[0]).toMatch(/model=aura-2-thalia-en/);
    expect(dg.seen.speakUrls[0]).toMatch(/encoding=linear16/);
    expect(dg.seen.speakUrls[0]).toMatch(/sample_rate=8000/);
    expect(dg.seen.wrongKey).toBe(0);
  }, withReadyWait(30_000));

  it("turns a spoken caller line into a reply: decision guidance in, Azure reply, speech out", async () => {
    const { dg, az, sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out", 3);
    // Caller audio reaches speech to text as 16-bit samples (21 bytes of mu-law become 42).
    for (let i = 0; i < 10; i += 1) sidecar.send({ type: "audio_in", data: callerFrame });
    await sidecar.waitFor(() => dg.seen.listenBytes >= 420);
    expect(dg.seen.listenBytes).toBe(420);

    dg.sendTranscript("I want a quote");
    const [final] = await sidecar.waitForType("caller_final");
    expect(final).toMatchObject({ turn: 1, text: "I want a quote" });
    sidecar.send({ type: "guidance", turn: 1, text: "Ask what vehicle they drive." });

    // Line 0 is the opening disclosure; this is the first reply.
    const line = (await sidecar.waitForType("agent_line", 2))[1];
    expect(line).toMatchObject({ line_id: 1, text: "Sure, I can help with that quote.", interrupted: false });
    expect(dg.seen.spoken.join("")).toContain("Sure, I can help with that quote.");

    const request = az.requests[0]!;
    expect(request.model).toBe("gpt-5.6-luna");
    expect(request.stream).toBe(true);
    const text = request.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n");
    expect(text).toContain("system: STANDING RULES. Lead packet: Jane, auto quote.");
    expect(text).toContain("assistant: Hi Jane, this is an automated assistant calling for the agency.");
    expect(text).toContain("user: I want a quote");
    expect(text).toContain("Say this in your own natural words, keeping its meaning: \"Ask what vehicle they drive.\"");
    expect(az.wrongKey).toBe(0);
  }, withReadyWait(30_000));

  it("replies without guidance when the host does not answer in time", async () => {
    const { az, sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line"); // The opening has been said...
    await sleep(500); // ...and has played, so typing now does not interrupt it.
    sidecar.send({ type: "caller_text", text: "hello there" });
    await sidecar.waitForType("caller_final");
    await sidecar.waitForType("agent_line", 2, 15_000);
    const sent = JSON.stringify(az.requests[0]!.messages);
    expect(sent).toContain("hello there");
    expect(sent).not.toContain("decision module");
  }, withReadyWait(30_000));

  it("uses a null guidance answer to reply naturally at once", async () => {
    const { az, sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line"); // The opening has been said...
    await sleep(500); // ...and has played, so typing now does not interrupt it.
    sidecar.send({ type: "caller_text", text: "hello there" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sidecar.waitForType("agent_line", 2);
    expect(JSON.stringify(az.requests[0]!.messages)).not.toContain("decision module");
  }, withReadyWait(30_000));

  /** A reply that is still playing: many pieces of speech, sent faster than they play. */
  async function playingReply(extra: Parameters<typeof rig>[0] = {}) {
    const r = await rig({ chunksFor: (t) => (t.startsWith("Hi ") ? 2 : 40), speechChunkMs: 5, ...extra });
    r.sidecar.send(defaultStart({ turn_gap_ms: 300 }));
    await r.sidecar.waitForType("ready");
    // Let the disclosure finish so the next audio belongs to the reply.
    await r.sidecar.waitFor(() => r.dg.seen.flushes >= 1);
    await sleep(500);
    r.sidecar.send({ type: "caller_text", text: "tell me more" });
    await r.sidecar.waitForType("caller_final");
    r.sidecar.send({ type: "guidance", turn: 1, text: null });
    await r.sidecar.waitFor(() => r.dg.seen.flushes >= 2);
    await r.sidecar.waitFor(() => r.sidecar.ofType("audio_out").length > 0);
    return r;
  }

  it("clears speech on a browser barge-in and reports what was actually said", async () => {
    const { dg, sidecar } = await playingReply();
    const before = sidecar.lines.length;
    sidecar.send({ type: "barge_in" });
    const [cleared] = await sidecar.waitForType("cleared");
    expect(cleared).toEqual({ type: "cleared", reason: "host_barge_in" });
    expect(dg.seen.clears).toBeGreaterThanOrEqual(1);
    const line = (await sidecar.waitForType("agent_line", 2))[1];
    expect(line).toMatchObject({ line_id: 1, interrupted: true });
    expect(String(line!.text)).toContain("Sure, I can help");
    expect(sidecar.lines.length).toBeGreaterThan(before);
    // The session keeps working: a new line gets a reply.
    sidecar.send({ type: "caller_text", text: "sorry, go on" });
    await sidecar.waitForType("caller_final", 2);
    sidecar.send({ type: "guidance", turn: 2, text: null });
    await sidecar.waitForType("agent_line", 3, 8000);
  }, withReadyWait(30_000));

  it("ignores a barge-in when nothing is playing", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out", 3);
    await sleep(500); // The disclosure is short; let it finish playing.
    sidecar.send({ type: "barge_in" });
    await sleep(300);
    expect(sidecar.ofType("cleared")).toHaveLength(0);
  }, withReadyWait(30_000));

  it("detects a barge-in itself from an interim transcript of two words while the agent is audible", async () => {
    const { dg, sidecar } = await playingReply();
    dg.sendTranscript("wait please", { final: false, speechFinal: false });
    const [cleared] = await sidecar.waitForType("cleared");
    expect(cleared).toEqual({ type: "cleared", reason: "interim_transcript" });
    expect(sidecar.ofType("caller_partial")[0]).toMatchObject({ text: "wait please" });
    expect(dg.seen.clears).toBeGreaterThanOrEqual(1);
  }, withReadyWait(30_000));

  it("lets a one-word interim during a reply pass, but a final transcript interrupts", async () => {
    const { dg, sidecar } = await playingReply();
    dg.sendTranscript("wait", { final: false, speechFinal: false });
    await sidecar.waitForType("caller_partial");
    await sleep(500);
    expect(sidecar.ofType("cleared")).toHaveLength(0);
    expect(dg.seen.clears).toBe(0);
    dg.sendTranscript("wait", { final: true, speechFinal: false });
    const [cleared] = await sidecar.waitForType("cleared");
    expect(cleared).toEqual({ type: "cleared", reason: "final_transcript" });
  }, withReadyWait(30_000));

  it("lets a two-word interim pass while a reply is being prepared but not yet audible, and clears once it is", async () => {
    const { dg, sidecar } = await rig({ chunksFor: (t) => (t.startsWith("Hi ") ? 2 : 40), speechChunkMs: 5, replyDelayMs: 1500 });
    sidecar.send(defaultStart({ turn_gap_ms: 300 }));
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    // Past the disclosure's audible window (two pieces of 100 milliseconds).
    await sleep(500);
    sidecar.send({ type: "caller_text", text: "tell me more" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sleep(200);
    // The reply is active (the model is still answering) but nothing of it is audible yet.
    const audioBefore = sidecar.ofType("audio_out").length;
    dg.sendTranscript("wait please", { final: false, speechFinal: false });
    await sidecar.waitForType("caller_partial");
    await sleep(300);
    expect(sidecar.ofType("audio_out")).toHaveLength(audioBefore);
    expect(sidecar.ofType("cleared")).toHaveLength(0);
    await sidecar.waitFor(() => sidecar.ofType("audio_out").length > audioBefore, 15_000);
    dg.sendTranscript("wait please", { final: false, speechFinal: false });
    const [cleared] = await sidecar.waitForType("cleared");
    expect(cleared).toEqual({ type: "cleared", reason: "interim_transcript" });
  }, withReadyWait(40_000));

  it("interrupts a playing reply for typed caller text", async () => {
    const { sidecar } = await playingReply();
    sidecar.send({ type: "caller_text", text: "hold on" });
    const [cleared] = await sidecar.waitForType("cleared");
    expect(cleared).toEqual({ type: "cleared", reason: "typed_text" });
    expect((await sidecar.waitForType("caller_final", 2))[1]).toMatchObject({ turn: 2, text: "hold on" });
  }, withReadyWait(30_000));

  it("protects the disclosure from every interruption and answers the caller once it stops", async () => {
    // A long disclosure: 60 pieces of 100 milliseconds, sent over about 2.4 seconds.
    const { dg, sidecar } = await rig({ chunksFor: (t) => (t.startsWith("Hi ") ? 60 : 3), speechChunkMs: 40 });
    sidecar.send(defaultStart({ turn_gap_ms: 300 }));
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out");
    // Line 0 is current: none of these may cut it.
    dg.sendTranscript("hold on", { final: false, speechFinal: false });
    await sidecar.waitForType("caller_partial");
    dg.sendTranscript("hold on please", { final: true, speechFinal: false });
    sidecar.send({ type: "barge_in" });
    // Longer than the 300 millisecond gap: the gap timer fires during the disclosure.
    await sleep(600);
    sidecar.send({ type: "caller_text", text: "are you there" });
    const [opening] = await sidecar.waitForType("agent_line", 1, 15_000);
    expect(opening).toEqual({ type: "agent_line", line_id: 0, text: "Hi Jane, this is an automated assistant calling for the agency.", interrupted: false });
    // The caller line was held, not answered over line 0, and is answered once it stops.
    const [final] = await sidecar.waitForType("caller_final");
    expect(final).toMatchObject({ turn: 1, text: "hold on please are you there" });
    const order = sidecar.lines.map((l) => l.type);
    expect(order.indexOf("caller_final")).toBeGreaterThan(order.indexOf("agent_line"));
    // The disclosure is still audible after its stop frame; still protected.
    dg.sendTranscript("one moment", { final: false, speechFinal: false });
    await sleep(300);
    expect(sidecar.ofType("cleared")).toHaveLength(0);
    expect(dg.seen.clears).toBe(0);
    sidecar.send({ type: "guidance", turn: 1, text: null });
    expect((await sidecar.waitForType("agent_line", 2))[1]).toMatchObject({ line_id: 1, text: "Sure, I can help with that quote.", interrupted: false });
    expect(sidecar.ofType("caller_final")).toHaveLength(1);
  }, withReadyWait(30_000));

  it("forwards time to first byte and processing time per stage as numbers only", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    await sleep(500);
    sidecar.send({ type: "caller_text", text: "hello there" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sidecar.waitForType("agent_line", 2);
    await sidecar.waitFor(() => sidecar.ofType("metrics").some((m) => m.turn === 1 && m.stage === "reply"));
    const metrics = sidecar.ofType("metrics");
    for (const m of metrics) {
      expect(Object.keys(m).sort()).toEqual(["kind", "milliseconds", "stage", "turn", "type"]);
      expect(["speech_to_text", "reply", "text_to_speech"]).toContain(m.stage);
      expect(["time_to_first_byte", "processing"]).toContain(m.kind);
      expect(Number.isInteger(m.milliseconds) && Number(m.milliseconds) >= 0).toBe(true);
      expect(Number.isInteger(m.turn)).toBe(true);
    }
    expect(metrics.some((m) => m.turn === 1 && m.stage === "reply" && m.kind === "time_to_first_byte")).toBe(true);
    expect(metrics.some((m) => m.turn === 1 && m.stage === "text_to_speech" && m.kind === "time_to_first_byte")).toBe(true);
  }, withReadyWait(30_000));

  it.each([0, 1, 2] as const)(
    "sends no speech of an interrupted reply after cleared, even when the speech service keeps sending (cap %i)",
    async (cap) => {
      const { dg, sidecar } = await rig({ chunksFor: (t) => (t.startsWith("Hi ") ? 2 : 60), speechChunkMs: 20, ignoreClear: true });
      sidecar.send(defaultStart({ turn_gap_ms: 300, stale_output_cap_gaps: cap }));
      await sidecar.waitForType("ready");
      await sleep(500);
      sidecar.send({ type: "caller_text", text: "tell me more" });
      await sidecar.waitForType("caller_final");
      sidecar.send({ type: "guidance", turn: 1, text: null });
      await sidecar.waitFor(() => dg.seen.flushes >= 2);
      await sidecar.waitFor(() => sidecar.ofType("audio_out").length > 30);
      sidecar.send({ type: "barge_in" });
      await sidecar.waitForType("cleared");
      const atClear = sidecar.lines.findIndex((l) => l.type === "cleared");
      expect(sidecar.lines.slice(0, atClear).filter((l) => l.type === "audio_out").length).toBeGreaterThan(0);
      // The fake sends the rest of its 60 pieces after Clear; none may reach the host.
      await sleep(1500);
      expect(sidecar.lines.slice(atClear + 1).filter((l) => l.type === "audio_out")).toHaveLength(0);
    },
    withReadyWait(30_000),
  );

  it("reports the opening disclosure as line 0 once it has been spoken, and never lets a barge-in cut it", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    const [line] = await sidecar.waitForType("agent_line");
    expect(line).toEqual({ type: "agent_line", line_id: 0, text: "Hi Jane, this is an automated assistant calling for the agency.", interrupted: false });

    const cut = await rig({ chunksFor: () => 60, speechChunkMs: 20 });
    cut.sidecar.send(defaultStart());
    await cut.sidecar.waitForType("ready");
    await cut.sidecar.waitForType("audio_out", 5);
    cut.sidecar.send({ type: "barge_in" });
    const [whole] = await cut.sidecar.waitForType("agent_line", 1, 15_000);
    expect(whole).toMatchObject({ line_id: 0, interrupted: false });
    expect(cut.sidecar.ofType("agent_line")).toHaveLength(1);
    expect(cut.sidecar.ofType("cleared")).toHaveLength(0);
    expect(cut.dg.seen.clears).toBe(0);
  }, withReadyWait(30_000, 2));

  it("plays the next reply in full after an interruption", async () => {
    const { dg, sidecar } = await playingReply({ ignoreClear: true });
    sidecar.send({ type: "barge_in" });
    await sidecar.waitForType("cleared");
    sidecar.send({ type: "caller_text", text: "actually, one more thing" });
    await sidecar.waitForType("caller_final");
    const clearedAt = sidecar.lines.findIndex((l) => l.type === "cleared");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sidecar.waitFor(() => dg.seen.flushes >= 3);
    await sidecar.waitFor(() => sidecar.lines.slice(clearedAt + 1).filter((l) => l.type === "audio_out").length > 5);
    await sidecar.waitForType("agent_line", 3);
    expect(sidecar.ofType("agent_line").some((l) => l.interrupted === false && l.line_id === 2)).toBe(true);
  }, withReadyWait(30_000));

  describe("with the line check on", () => {
    it("sends no speech for a reply before the verdict, then speaks the edited line", async () => {
      const { dg, sidecar } = await rig();
      sidecar.send(defaultStart({ guard: true }));
      await sidecar.waitForType("ready");
      // The disclosure is not checked.
      await sidecar.waitForType("audio_out", 3);
      const [opening] = await sidecar.waitForType("agent_line");
      expect(opening).toMatchObject({ line_id: 0 });
      const audioBefore = sidecar.ofType("audio_out").length;
      const spokenBefore = dg.seen.spoken.length;

      sidecar.send({ type: "caller_text", text: "hello there" });
      await sidecar.waitForType("caller_final");
      sidecar.send({ type: "guidance", turn: 1, text: null });
      const announced = (await sidecar.waitForType("agent_line", 2))[1]!;
      expect(announced).toMatchObject({ line_id: 1, text: "Sure, I can help with that quote.", interrupted: false });
      await sleep(600);
      expect(sidecar.ofType("audio_out")).toHaveLength(audioBefore);
      expect(dg.seen.spoken).toHaveLength(spokenBefore);

      sidecar.send({ type: "line_verdict", line_id: 1, text: "Sure, one moment." });
      await sidecar.waitFor(() => dg.seen.spoken.length > spokenBefore);
      expect(dg.seen.spoken.slice(spokenBefore).join("")).toContain("Sure, one moment.");
      expect(dg.seen.spoken.slice(spokenBefore).join("")).not.toContain("help with that quote");
      await sidecar.waitFor(() => sidecar.ofType("audio_out").length > audioBefore);
      // Reported once, before speech: no second report when it finishes.
      await sleep(300);
      expect(sidecar.ofType("agent_line")).toHaveLength(2);
    }, withReadyWait(30_000));

    it("says nothing for a blocked line", async () => {
      const { dg, sidecar } = await rig();
      sidecar.send(defaultStart({ guard: true }));
      await sidecar.waitForType("ready");
      await sidecar.waitForType("agent_line");
      await sleep(300);
      const audioBefore = sidecar.ofType("audio_out").length;
      const spokenBefore = dg.seen.spoken.length;
      sidecar.send({ type: "caller_text", text: "hello there" });
      await sidecar.waitForType("caller_final");
      sidecar.send({ type: "guidance", turn: 1, text: null });
      await sidecar.waitForType("agent_line", 2);
      sidecar.send({ type: "line_verdict", line_id: 1, text: null });
      await sleep(800);
      expect(sidecar.ofType("audio_out")).toHaveLength(audioBefore);
      expect(dg.seen.spoken).toHaveLength(spokenBefore);
      // The session is still usable afterwards.
      sidecar.send({ type: "caller_text", text: "are you there" });
      await sidecar.waitForType("caller_final", 2);
      sidecar.send({ type: "guidance", turn: 2, text: null });
      await sidecar.waitForType("agent_line", 3);
    }, withReadyWait(30_000));

    it("allows the line after two seconds without a verdict", async () => {
      const { dg, sidecar } = await rig();
      sidecar.send(defaultStart({ guard: true }));
      await sidecar.waitForType("ready");
      await sidecar.waitForType("agent_line");
      const spokenBefore = dg.seen.spoken.length;
      sidecar.send({ type: "caller_text", text: "hello there" });
      await sidecar.waitForType("caller_final");
      sidecar.send({ type: "guidance", turn: 1, text: null });
      await sidecar.waitForType("agent_line", 2);
      await sidecar.waitFor(() => dg.seen.spoken.length > spokenBefore, 5000);
      expect(dg.seen.spoken.slice(spokenBefore).join("")).toContain("Sure, I can help");
    }, withReadyWait(30_000));
  });

  it("joins spoken pieces with spaces the way Pipecat's aggregator does", async () => {
    const { sidecar } = await rig({ reply: () => "Sure, I can help with that. Could you tell me the vehicle?" });
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    await sleep(500);
    sidecar.send({ type: "caller_text", text: "hello there" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    const line = (await sidecar.waitForType("agent_line", 2))[1]!;
    // Text to speech reports each sentence as its own piece, without the space between them.
    expect(line.text).toBe("Sure, I can help with that. Could you tell me the vehicle?");
    expect(String(line.text)).not.toContain("that.Could");
  }, withReadyWait(30_000));

  it("refuses a bad first message, an unknown voice and an unknown command with fixed codes", async () => {
    const bad = await rig();
    bad.sidecar.send({ type: "audio_in", data: callerFrame });
    await bad.sidecar.waitFor(() => bad.sidecar.lines.length > 0);
    expect(bad.sidecar.lines[0]).toEqual({ id: 0, error: "failed" });
    expect(await bad.sidecar.exited).toBe(1);

    const voice = await rig();
    voice.sidecar.send(defaultStart({ voice: "aura-2-thalia-en&model=x" }));
    await voice.sidecar.waitFor(() => voice.sidecar.lines.length > 0);
    expect(voice.sidecar.lines[0]).toEqual({ id: 0, error: "failed" });

    for (const malformed of ["aura-2-Thalia-en", "aura-1-thalia-en", "aura-2-thalia-es", "aura-2--en", 7]) {
      const refused = await rig();
      refused.sidecar.send(defaultStart({ voice: malformed }));
      await refused.sidecar.waitFor(() => refused.sidecar.lines.length > 0);
      expect(refused.sidecar.lines[0]).toEqual({ id: 0, error: "failed" });
    }

    const named = await rig();
    named.sidecar.send(defaultStart({ voice: "aura-2-orion-en" }));
    await named.sidecar.waitForType("ready");
    await named.sidecar.waitFor(() => named.dg.seen.speakUrls.length > 0);
    expect(named.dg.seen.speakUrls[0]).toMatch(/model=aura-2-orion-en/);

    // A voice the Deepgram catalog can list that the old fixed list did not have.
    const newer = await rig();
    newer.sidecar.send(defaultStart({ voice: "aura-2-estrella-en" }));
    await newer.sidecar.waitForType("ready");
    await newer.sidecar.waitFor(() => newer.dg.seen.speakUrls.length > 0);
    expect(newer.dg.seen.speakUrls[0]).toMatch(/model=aura-2-estrella-en/);

    const late = await rig();
    late.sidecar.send(defaultStart());
    await late.sidecar.waitForType("ready");
    late.sidecar.send({ type: "mystery" });
    const [error] = await late.sidecar.waitForType("error");
    expect(error).toEqual({ type: "error", code: "protocol_error" });
    await late.sidecar.waitForType("ended");
    expect(await late.sidecar.exited).toBe(0);
  }, withReadyWait(30_000, 10));

  it("runs the Pipecat Flows router: after the disclosure the flow enters the inbound start and a caller line is reported", async () => {
    const r = await rig();
    r.sidecar.send(defaultStart({ decision_router: "pipecat_flows" }));
    await r.sidecar.waitForType("ready");
    const [entered] = await r.sidecar.waitForType("node_enter");
    expect(entered).toMatchObject({ type: "node_enter", treeNode: "open.greeting" });
    r.sidecar.send({ type: "caller_text", text: "Hi, you called me earlier." });
    const [turn] = await r.sidecar.waitForType("caller_turn");
    expect(turn).toEqual({ type: "caller_turn", text: "Hi, you called me earlier." });
  }, withReadyWait(30_000));

  it("accepts the decision model router, and refuses an unknown router, a router module that is missing and a bad direction", async () => {
    for (const start of [defaultStart({ decision_router: "mystery" }), defaultStart({ decision_router: "pipecat_classifier" }), defaultStart({ direction: "sideways" })]) {
      const refused = await rig();
      refused.sidecar.send(start);
      await refused.sidecar.waitFor(() => refused.sidecar.lines.length > 0);
      expect(refused.sidecar.lines[0]).toEqual({ id: 0, error: "failed" });
    }
    // The default router keeps today's path; a flow reply means nothing to it.
    const plain = await rig();
    plain.sidecar.send(defaultStart({ decision_router: "decision_model", direction: "outbound" }));
    await plain.sidecar.waitForType("ready");
    plain.sidecar.send({ type: "flow_reply", id: 1 });
    const [error] = await plain.sidecar.waitForType("error");
    expect(error).toEqual({ type: "error", code: "protocol_error" });
  }, withReadyWait(30_000, 4));

  it("reports a Deepgram failure with its fixed code", async () => {
    const dg = await fakeDeepgram({ apiKey: "a-different-key" });
    const az = await fakeAzureChat({ apiKey: AZURE_KEY, reply: () => "x" });
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: DEEPGRAM_KEY, DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: az.url, AZURE_FOUNDRY_KEY: AZURE_KEY });
    cleanup.push(() => sidecar.kill(), () => az.close(), () => dg.close());
    sidecar.send(defaultStart());
    // The fake accepts the connection but flags the key; make it refuse instead by closing the service.
    await dg.close();
    const [error] = await sidecar.waitForType("error", 1, 20_000);
    expect(error!.code).toBe("deepgram_failed");
    await sidecar.waitForType("ended");
  }, withReadyWait(40_000));

  it("keeps the call going when Azure cannot be reached, with a warning and a fallback line", async () => {
    const dg = await fakeDeepgram({ apiKey: DEEPGRAM_KEY });
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: DEEPGRAM_KEY, DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: "http://127.0.0.1:1/openai/v1", AZURE_FOUNDRY_KEY: AZURE_KEY });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    // A refused connection is not permanent in Pipecat's terms: the reply model stays usable.
    const [warning] = await sidecar.waitForType("warning", 1, 30_000);
    expect(warning).toEqual({ type: "warning", code: "azure_failed" });
    await sidecar.waitFor(() => sidecar.ofType("agent_line").some((l) => l.text === FALLBACK_LINE), 15_000);
    expect(sidecar.ofType("error")).toHaveLength(0);
    sidecar.send({ type: "end" });
    await sidecar.waitForType("ended");
    expect(await sidecar.exited).toBe(0);
  }, withReadyWait(60_000));

  it("never writes either key to its output, and ends cleanly on end", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sidecar.waitForType("agent_line", 2);
    sidecar.send({ type: "end" });
    await sidecar.waitForType("ended");
    expect(await sidecar.exited).toBe(0);
    const everything = JSON.stringify(sidecar.lines) + sidecar.stderr;
    expect(everything).not.toContain(DEEPGRAM_KEY);
    expect(everything).not.toContain(AZURE_KEY);
  }, withReadyWait(30_000));

  it("stops at once on cancel", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    sidecar.send({ type: "cancel" });
    await sidecar.waitForType("ended");
    expect(await sidecar.exited).toBe(0);
  }, withReadyWait(30_000));
});
