import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { traceBus, type TraceEvent } from "../../src/trace/index.js";
import { DeepgramLiveSession, type DeepgramSessionOptions } from "../../src/server/voice/deepgram-voice-session.js";
import { DeepgramVoiceRuntime } from "../../src/server/voice/deepgram-voice-runtime.js";

const fakeSidecar = fileURLToPath(new URL("../helpers/fake-deepgram-sidecar.mjs", import.meta.url));
let callId = "call_dg";
let callCount = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(15);
  }
}

let events: TraceEvent[];
let unsubscribe: () => void;
let logFile: string;

beforeEach(() => {
  callId = `call_dg_${(callCount += 1)}`;
  events = [];
  unsubscribe = traceBus.subscribe((e) => {
    if (e.callId === callId) events.push(e);
  });
  logFile = join(mkdtempSync(join(tmpdir(), "dg-fake-")), "received.jsonl");
});
afterEach(() => unsubscribe());

const received = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const tools = (name: string) => events.filter((e) => e.type === "tool_call" && e.data.tool === name);
const lines = (role: string) => events.filter((e) => (e.type === "transcript_final" || e.type === "turn") && e.data.role === role);

function make(mode = "", patch: Partial<DeepgramSessionOptions> = {}, env: Record<string, string> = {}) {
  const audio: string[] = [];
  const clears: number[] = [];
  const ends: string[] = [];
  const errors: string[] = [];
  const session = new DeepgramLiveSession({
    trace: { leadId: "lead-1", recordId: callId, channel: "call", direction: "inbound", callId },
    instructions: "Be brief.",
    disclosure: "Hi, I am an AI assistant.",
    maxMs: 60_000,
    turnGapMs: 100,
    startTimeoutMs: 1500,
    dialogOwnsTranscript: false,
    onAudio: (b) => void audio.push(b),
    onClearPlayback: () => void clears.push(Date.now()),
    onProviderError: (c) => void errors.push(c),
    onEnd: ({ reason }) => void ends.push(reason),
    runtime: new DeepgramVoiceRuntime(() => ({
      command: process.execPath,
      args: [fakeSidecar],
      env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_MODE: mode, ...env },
    })),
    ...patch,
  });
  return { session, audio, clears, ends, errors };
}

/** The disclosure is protected until its audio has played plus a short margin; the fake's disclosure is a few milliseconds long. */
async function pastDisclosure(): Promise<void> {
  await until(() => lines("agent").length >= 1);
  await wait(400);
}

describe("Deepgram live session against a fake sidecar", () => {
  it("does not record the disclosure until the sidecar reports it, and a cut-off disclosure is not marked spoken", async () => {
    const t = make("cut_disclosure");
    await t.session.start();
    await until(() => lines("agent").length === 1);
    expect(lines("agent")[0]!.data).toMatchObject({ text: "Hi, I am", spoken: false });
    expect(tools("spoken_vs_intended")).toHaveLength(0);
    t.session.stop();
  });

  it("records nothing as spoken when the sidecar never reports the disclosure", async () => {
    const t = make("never_ready", { startTimeoutMs: 200 });
    await expect(t.session.start()).rejects.toThrow();
    expect(lines("agent")).toHaveLength(0);
  });

  it("checks the reported disclosure against the expected text", async () => {
    const t = make("wrong_disclosure");
    await t.session.start();
    await until(() => tools("disclosure_check").length === 1);
    expect(tools("disclosure_check")[0]!.data).toMatchObject({ success: false, reason: "disclosure_text_mismatch" });
    t.session.stop();
  });

  it("flags a disclosure with a sales pitch added to it", async () => {
    const t = make("padded_disclosure");
    await t.session.start();
    await until(() => tools("disclosure_check").length === 1);
    expect(tools("disclosure_check")[0]!.data).toMatchObject({ success: false, reason: "disclosure_text_mismatch" });
    t.session.stop();
  });

  it("accepts the disclosure line only once", async () => {
    const t = make("double_disclosure");
    await t.session.start();
    await until(() => tools("disclosure_check").length === 2);
    expect(lines("agent").map((e) => e.data.text)).toEqual(["Hi, I am an AI assistant."]);
    expect(tools("disclosure_check").map((e) => [e.data.success, e.data.reason ?? null])).toEqual([[true, null], [false, "duplicate_disclosure_line"]]);
    t.session.stop();
  });

  it("a guard that never answers does not block later lines", async () => {
    const t = make("two_lines", { guardAgentLine: (line) => (line.startsWith("Sure") ? new Promise<string>(() => undefined) : line) });
    await t.session.start();
    await t.session.sendCallerText("hello");
    await until(() => lines("agent").length === 3, 6000);
    expect(lines("agent").map((e) => e.data.text)).toEqual(["Hi, I am an AI assistant.", "Sure, tell me more.", "Second line."]);
    expect(tools("guard_agent_line").map((e) => e.data.reason ?? null)).toEqual(["guard_timeout", null]);
    t.session.stop();
  }, 10_000);

  it("records agent lines in arrival order even when the guard is slow for the first", async () => {
    const t = make("two_lines", { guardAgentLine: async (line) => (line.startsWith("Sure") ? (await wait(120), line) : line) });
    await t.session.start();
    await t.session.sendCallerText("hello");
    await until(() => lines("agent").length === 3);
    expect(lines("agent").map((e) => e.data.text)).toEqual(["Hi, I am an AI assistant.", "Sure, tell me more.", "Second line."]);
    // The fake sidecar logs what it received asynchronously; wait for both verdicts to be written.
    await until(() => received().filter((m) => m.type === "line_verdict").length === 2);
    expect(received().filter((m) => m.type === "line_verdict").map((m) => m.line_id)).toEqual([1, 2]);
    t.session.stop();
  });

  it("traces the sidecar's stale-audio drop count", async () => {
    const t = make("stale_report");
    await t.session.start();
    await pastDisclosure();
    t.session.bargeIn();
    await until(() => tools("drop_stale_agent_audio").length === 1);
    expect(tools("drop_stale_agent_audio")[0]!.data).toMatchObject({ inputs: { chunks: 3 }, success: true });
    t.session.stop();
  });

  it("sends the start configuration, plays and records the opening disclosure, and traces the open", async () => {
    const t = make("", { staleOutputCapGaps: 2 });
    await t.session.start();
    await until(() => t.audio.length === 1);
    expect(received()[0]).toMatchObject({ type: "start", instructions: "Be brief.", disclosure: "Hi, I am an AI assistant.", turn_gap_ms: 100, stale_output_cap_gaps: 2, guard: false });
    await until(() => lines("agent").length === 1);
    expect(lines("agent")[0]!.data).toMatchObject({ text: "Hi, I am an AI assistant.", spoken: true, source: "voice_module", turnIndex: 0 });
    // Scored against what the sidecar reports it said, not assumed.
    expect(tools("spoken_vs_intended")[0]!.data.inputs).toMatchObject({ spoken: "Hi, I am an AI assistant.", overlap: 1 });
    expect(tools("voice_session_open")[0]!.data).toMatchObject({ success: true, inputs: { provider: "deepgram", staleOutputCapGaps: 2 } });
    t.session.stop();
    await until(() => t.ends.length === 1);
    expect(t.ends).toEqual(["caller_hangup"]);
    expect(tools("voice_session_close")).toHaveLength(1);
    expect(t.session.isEnded).toBe(true);
  });

  it("runs the decision hook on a finished caller line and sends its meaning back as guidance", async () => {
    const heard: string[] = [];
    const t = make("", { dialogOwnsTranscript: true, onCallerFinal: async (text) => (heard.push(text), "Ask for the zip code.") });
    await t.session.start();
    for (let i = 0; i < 3; i++) t.session.sendAudio(Buffer.from([0xff, 0x7f]).toString("base64"));
    await until(() => received().some((m) => m.type === "guidance"));
    expect(heard).toEqual(["I need a quote"]);
    expect(received().find((m) => m.type === "guidance")).toEqual({ type: "guidance", turn: 1, text: "Ask for the zip code." });
    await until(() => lines("agent").length === 2);
    // The dialog owns the transcript: agent lines are turn events and the caller line is not duplicated.
    expect(events.filter((e) => e.type === "turn")).toHaveLength(2);
    expect(lines("caller")).toHaveLength(0);
    expect(tools("steer_voice_model")).toHaveLength(1);
    expect(tools("spoken_vs_intended")).toHaveLength(2);
    t.session.stop();
  });

  it("sends the call context beside the guidance, never inside it, and only when it changed", async () => {
    let n = 0;
    const t = make("", {
      dialogOwnsTranscript: true,
      onCallerFinal: async () => "Ask for the zip code.",
      contextUpdate: async () => (n++ === 0 ? "Call context update (information for you, not lines to say):\nCall stage: quote_fields." : undefined),
    });
    await t.session.start();
    await t.session.sendCallerText("first");
    await until(() => received().filter((m) => m.type === "guidance").length === 1);
    await t.session.sendCallerText("second");
    await until(() => received().filter((m) => m.type === "guidance").length === 2);
    const [one, two] = received().filter((m) => m.type === "guidance");
    expect(one).toMatchObject({ text: "Ask for the zip code.", context: expect.stringContaining("Call stage: quote_fields") });
    expect(String(one!.text)).not.toContain("Call stage");
    expect(two).not.toHaveProperty("context");
    t.session.stop();
  });

  it("records the caller line itself and replies without guidance when no decision hook is installed; typed text takes the same path", async () => {
    const t = make();
    await t.session.start();
    await t.session.sendCallerText("hello there");
    await until(() => received().some((m) => m.type === "guidance"));
    expect(received().find((m) => m.type === "caller_text")).toEqual({ type: "caller_text", text: "hello there" });
    expect(received().find((m) => m.type === "guidance")).toMatchObject({ turn: 1, text: null });
    expect(lines("caller")[0]!.data).toMatchObject({ text: "hello there", source: "voice_module" });
    t.session.stop();
  });

  it("still sends null guidance when the decision hook throws", async () => {
    const t = make("", { onCallerFinal: async () => { throw new Error("boom"); } });
    await t.session.start();
    await t.session.sendCallerText("hi");
    await until(() => received().some((m) => m.type === "guidance"));
    expect(received().find((m) => m.type === "guidance")).toMatchObject({ text: null });
    expect(tools("decision_step")[0]!.data).toMatchObject({ success: false, reason: "decision_step_failed" });
    t.session.stop();
  });

  it("applies the line guard and sends the verdict; a blocked line is never recorded", async () => {
    const t = make("", { guardAgentLine: (line) => (line.startsWith("Sure") ? null : line) });
    await t.session.start();
    await t.session.sendCallerText("hello");
    await until(() => received().some((m) => m.type === "line_verdict"));
    expect(received()[0]).toMatchObject({ type: "start", guard: true });
    expect(received().find((m) => m.type === "line_verdict")).toEqual({ type: "line_verdict", line_id: 1, text: null });
    expect(lines("agent").map((e) => e.data.text)).toEqual(["Hi, I am an AI assistant."]);
    expect(tools("guard_agent_line")[0]!.data).toMatchObject({ success: false, reason: "agent_line_blocked" });
    t.session.stop();
  });

  it("a browser barge-in clears playback, tells the sidecar, relays the sidecar's cleared within 400 milliseconds, and traces it once", async () => {
    const t = make("long_disclosure");
    await t.session.start();
    await until(() => lines("agent").length === 1);
    // One second of disclosure audio plus the margin.
    await wait(1400);
    // Audio played within the last four seconds, so the agent is still audible and Node clears at once.
    t.session.bargeIn();
    expect(t.clears).toHaveLength(1);
    await until(() => t.clears.length === 2);
    expect(received().filter((m) => m.type === "barge_in")).toHaveLength(1);
    // The sidecar's cleared (reason host_barge_in) is relayed to the browser, but records no second trace.
    expect(t.clears[1]! - t.clears[0]!).toBeLessThan(400);
    expect(tools("clear_playback").map((e) => (e.data.inputs as { reason: string }).reason)).toEqual(["browser_loudness"]);
    t.session.stop();
  }, 10_000);

  it("traces each sidecar cleared with the reason it carries", async () => {
    const t = make("clear_reasons");
    await t.session.start();
    await pastDisclosure();
    await t.session.sendCallerText("hello");
    await until(() => t.clears.length === 4);
    expect(tools("clear_playback").map((e) => (e.data.inputs as { reason: string }).reason)).toEqual(["interim_transcript", "final_transcript", "typed_text", "reply_failed"]);
    t.session.stop();
  });

  it("holds a sidecar cleared that arrives while the browser still plays the disclosure, and the audio after it, until the disclosure ends", async () => {
    const order: string[] = [];
    const clears: number[] = [];
    const began = Date.now();
    const t = make("cleared_in_disclosure", {
      onAudio: (b) => void order.push(`audio:${Buffer.from(b, "base64")[0]}`),
      onClearPlayback: () => void (clears.push(Date.now()), order.push("clear")),
    });
    await t.session.start();
    // Traced at once, with the sidecar's reason.
    await until(() => tools("clear_playback").length === 1);
    expect(tools("clear_playback")[0]!.data).toMatchObject({ inputs: { reason: "final_transcript" } });
    expect(clears).toHaveLength(0);
    // One second of disclosure audio plus the margin: the browser is not cleared before it has played.
    await until(() => clears.length === 1, 4000);
    expect(clears[0]! - began).toBeGreaterThanOrEqual(1200);
    await until(() => order.length === 4);
    // Disclosure, the stale audio before the cleared, the clear, then the fresh audio after it.
    expect(order).toEqual(["audio:127", "audio:17", "clear", "audio:34"]);
    expect(tools("clear_playback")).toHaveLength(1);
    expect(lines("agent")[0]!.data).toMatchObject({ text: "Hi, I am an AI assistant.", spoken: true });
    t.session.stop();
  });

  it("traces a failed disclosure check when the sidecar reports an empty line 0, and records nothing as said", async () => {
    const t = make("silent_disclosure");
    await t.session.start();
    await until(() => tools("disclosure_check").length === 1);
    expect(tools("disclosure_check")[0]!.data).toMatchObject({ success: false, reason: "disclosure_not_spoken" });
    await wait(100);
    expect(lines("agent")).toHaveLength(0);
    expect(tools("spoken_vs_intended")).toHaveLength(0);
    t.session.stop();
  });

  it("a barge-in the sidecar detects itself clears playback with its reason", async () => {
    const t = make("self_barge_in");
    await t.session.start();
    t.session.sendAudio(Buffer.from([1]).toString("base64"));
    await until(() => t.clears.length === 1);
    expect(tools("clear_playback")[0]!.data).toMatchObject({ inputs: { reason: "interim_transcript" } });
    t.session.stop();
  });

  it("ignores a browser barge-in before the sidecar reports the disclosure and while its audio is still playing", async () => {
    const t = make("late_disclosure");
    await t.session.start();
    await until(() => t.audio.length === 1);
    // Before agent_line 0.
    t.session.bargeIn();
    await until(() => lines("agent").length === 1);
    // After agent_line 0, but inside its audible window.
    t.session.bargeIn();
    await wait(100);
    expect(t.clears).toHaveLength(0);
    expect(tools("clear_playback")).toHaveLength(0);
    expect(received().filter((m) => m.type === "barge_in")).toHaveLength(0);
    expect(tools("barge_in_ignored")).toHaveLength(1);
    expect(tools("barge_in_ignored")[0]!.data).toMatchObject({ reason: "disclosure_playing" });
    expect(lines("agent")[0]!.data).toMatchObject({ text: "Hi, I am an AI assistant.", spoken: true });
    // Once the disclosure has played (one second of audio from the start, plus the margin), a barge-in reaches the sidecar.
    await wait(1000);
    t.session.bargeIn();
    await until(() => received().some((m) => m.type === "barge_in"));
    t.session.stop();
  });

  it("ignores a browser barge-in for the whole of a long disclosure", async () => {
    const t = make("long_disclosure");
    await t.session.start();
    await until(() => lines("agent").length === 1);
    t.session.bargeIn();
    await wait(500);
    t.session.bargeIn();
    await wait(100);
    expect(t.clears).toHaveLength(0);
    expect(received().filter((m) => m.type === "barge_in")).toHaveLength(0);
    t.session.stop();
  });

  it("answers a caller line held during the disclosure once the disclosure stops", async () => {
    const t = make("late_disclosure");
    await t.session.start();
    await until(() => t.audio.length === 1);
    await t.session.sendCallerText("hold on are you there");
    await wait(200);
    // Held: no caller line and no guidance while line 0 is playing.
    expect(lines("caller")).toHaveLength(0);
    expect(received().filter((m) => m.type === "guidance")).toHaveLength(0);
    await until(() => lines("agent").length === 2);
    const order = events.filter((e) => e.type === "transcript_final").map((e) => `${e.data.role}:${e.data.text}`);
    expect(order).toEqual(["agent:Hi, I am an AI assistant.", "caller:hold on are you there", "agent:Sure, tell me more."]);
    expect(received().filter((m) => m.type === "guidance")).toEqual([{ type: "guidance", turn: 1, text: null }]);
    expect(t.clears).toHaveLength(0);
    t.session.stop();
  });

  it("traces a non-fatal warning with a fixed code and keeps the session going", async () => {
    const t = make("warning");
    await t.session.start();
    await t.session.sendCallerText("hello");
    await until(() => tools("voice_provider_warning").length === 2 && lines("agent").length === 2);
    // A code that is not a fixed name is replaced, never traced as sent.
    expect(tools("voice_provider_warning").map((e) => [e.data.success, e.data.reason])).toEqual([[false, "azure_rate_limited"], [false, "deepgram_warning"]]);
    expect(JSON.stringify(events)).not.toContain("quota");
    expect(lines("agent")[1]!.data).toMatchObject({ text: "Sorry, could you say that again?", spoken: true });
    expect(t.session.isEnded).toBe(false);
    expect(t.ends).toEqual([]);
    expect(t.errors).toEqual([]);
    expect(tools("voice_provider_error")).toHaveLength(0);
    // The next turn still works.
    await t.session.sendCallerText("again");
    await until(() => lines("agent").length === 3);
    t.session.stop();
    await until(() => t.ends.length === 1);
    expect(t.ends).toEqual(["caller_hangup"]);
  });

  it("traces well-formed metrics per turn and drops malformed ones", async () => {
    const t = make("metrics");
    await t.session.start();
    await t.session.sendCallerText("hello");
    await until(() => lines("agent").length === 2);
    expect(tools("voice_metrics").map((e) => e.data.inputs)).toEqual([
      { turn: 1, stage: "reply", kind: "time_to_first_byte", milliseconds: 412 },
      { turn: 1, stage: "text_to_speech", kind: "processing", milliseconds: 95 },
    ]);
    expect(JSON.stringify(events)).not.toContain("provider said");
    t.session.stop();
  });

  it("logs caller_partial timing and a word count, never the words, and logs the sidecar's stats", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const t = make("partial");
      await t.session.start();
      await until(() => t.audio.length === 1);
      t.session.sendAudio(Buffer.from([1]).toString("base64"));
      await until(() => log.mock.calls.some((c) => String(c[0]).includes("voice deepgram stats")));
      const logged = log.mock.calls.map((c) => String(c[0]));
      const partial = logged.find((l) => l.includes("voice deepgram caller_partial"));
      expect(partial).toMatch(new RegExp(`call=${callId} words=3 since_agent_audio_ms=\\d+$`));
      expect(logged.join("\n")).not.toContain("secret caller words");
      expect(logged.find((l) => l.includes("voice deepgram stats"))).toBe(`voice deepgram stats call=${callId} audio_in=1 stt_final=0 tts_chunks=1`);
      t.session.stop();
    } finally {
      log.mockRestore();
    }
  });

  it("forwards the sidecar's standard error to the dev log with every credential and the Azure host scrubbed, cut to length", async () => {
    const key = "dgtestkey0123456789abcdef";
    const azureKey = "aztestkey9876543210fedcba";
    const host = "scrub-check-resource.invalid";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const t = make("stderr_secrets", {}, { DEEPGRAM_API_KEY: key, AZURE_FOUNDRY_KEY: azureKey, AZURE_FOUNDRY_URL: `https://${host}/openai/v1` });
      await t.session.start();
      await until(() => warn.mock.calls.length >= 3);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged).toHaveLength(3);
      for (const line of logged) {
        expect(line.startsWith("voice deepgram sidecar stderr: ")).toBe(true);
        expect(line).not.toContain(key);
        expect(line).not.toContain(azureKey);
        expect(line).not.toContain(host);
        expect(line).not.toContain("scrub-check");
        expect(line).not.toContain("abcdefghijklmnop0123");
        expect(line.length).toBeLessThan(400);
      }
      expect(logged[0]).toContain("[redacted]");
      t.session.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("rate limits a noisy sidecar's standard error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const t = make("stderr_flood");
      await t.session.start();
      await wait(300);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.length).toBeLessThanOrEqual(21);
      t.session.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("a sidecar error ends the session with a provider error code", async () => {
    const t = make("error_on_audio");
    await t.session.start();
    t.session.sendAudio(Buffer.from([1]).toString("base64"));
    await until(() => t.ends.length === 1);
    expect(t.errors).toEqual(["deepgram_failed"]);
    expect(t.ends).toEqual(["deepgram_error"]);
    expect(tools("voice_provider_error")[0]!.data).toMatchObject({ reason: "deepgram_failed" });
  });

  it("start fails with a fixed code when the sidecar exits or never becomes ready", async () => {
    const dead = make("die_before_ready");
    await expect(dead.session.start()).rejects.toThrow(/^deepgram_closed$/);
    expect(dead.ends).toEqual(["start_failed"]);
    const slow = make("never_ready", { startTimeoutMs: 300 });
    await expect(slow.session.start()).rejects.toThrow("deepgram_start_timeout");
    expect(slow.ends).toEqual(["start_timeout"]);
  });

  it("ends at the session cap and when the browser leaves", async () => {
    const capped = make("", { maxMs: 150 });
    await capped.session.start();
    await until(() => capped.ends.length === 1);
    expect(capped.ends).toEqual(["session_cap"]);
    const left = new AbortController();
    const gone = make("", { signal: left.signal });
    await gone.session.start();
    left.abort();
    await until(() => gone.ends.length === 1);
    expect(gone.ends).toEqual(["caller_hangup"]);
  });
});
