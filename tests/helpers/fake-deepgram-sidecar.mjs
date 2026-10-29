// Stands in for the Python Deepgram sidecar. Follows the stdio protocol in
// docs/orchestration-modules.md and logs every line it receives to FAKE_LOG.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_LOG;
const mode = process.env.FAKE_MODE ?? "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let guard = false;
let frames = 0;
let turn = 0;
let lineId = 0;
let disclosurePlaying = false;
const held = [];
const speak = (text) => {
  lineId += 1;
  out({ type: "audio_out", data: Buffer.from(text).toString("base64") });
  out({ type: "agent_line", line_id: lineId, text });
};

if (mode === "die_before_ready") process.exit(3);
// Dies on the first start only (FAKE_COUNTER names a file that marks the first run), so a second start works.
if (mode === "die_first_start" && process.env.FAKE_COUNTER && !existsSync(process.env.FAKE_COUNTER)) {
  writeFileSync(process.env.FAKE_COUNTER, "1");
  process.exit(3);
}
if (mode === "never_ready") setInterval(() => undefined, 1000);
// Writes the credentials of its environment to standard error, as a careless library might.
if (mode === "stderr_secrets") {
  const host = new URL(process.env.AZURE_FOUNDRY_URL).host;
  process.stderr.write(`WARNING key=${process.env.DEEPGRAM_API_KEY} host ${host}\n`);
  process.stderr.write(`ERROR posting to ${process.env.AZURE_FOUNDRY_URL}/chat api-key: ${process.env.AZURE_FOUNDRY_KEY}\n`);
  process.stderr.write(`ERROR Authorization: Bearer abcdefghijklmnop0123 ${"x".repeat(2000)}\n`);
}
if (mode === "stderr_flood") for (let i = 0; i < 200; i++) process.stderr.write(`WARNING noisy line ${i}\n`);


createInterface({ input: process.stdin }).on("line", (raw) => {
  const m = JSON.parse(raw);
  if (log) appendFileSync(log, raw + "\n");
  switch (m.type) {
    case "start":
      guard = m.guard;
      if (mode === "never_ready") break;
      out({ id: 0, type: "ready" });
      // A long disclosure is one second of audio (8000 mu-law bytes at 8 kilohertz); the late one is long too.
      out({ type: "audio_out", data: (mode === "long_disclosure" || mode === "late_disclosure" || mode === "cleared_in_disclosure" ? Buffer.alloc(8000, 0x7f) : Buffer.from(m.disclosure)).toString("base64") });
      if (mode === "silent_disclosure") {
        // Text to speech failed before any word: line 0 is still reported, empty and cut off.
        out({ type: "agent_line", line_id: 0, text: "", interrupted: true });
        break;
      }
      if (mode === "late_disclosure") {
        // Like the real sidecar: a caller line typed during the disclosure is held until line 0 is reported.
        disclosurePlaying = true;
        setTimeout(() => {
          disclosurePlaying = false;
          // One write, so Node reads line 0 and the held caller line in the same chunk, as it can from the real sidecar.
          const lines = [{ type: "agent_line", line_id: 0, text: m.disclosure, interrupted: false }, ...held.splice(0).map((text) => ({ type: "caller_final", turn: ++turn, text }))];
          process.stdout.write(lines.map((l) => JSON.stringify(l) + "\n").join(""));
        }, 600);
        break;
      }
      out({
        type: "agent_line",
        line_id: 0,
        text: mode === "cut_disclosure" ? "Hi, I am" : mode === "wrong_disclosure" ? "Totally different words, buy now" : mode === "padded_disclosure" ? `${m.disclosure} Also, our premium policy is cheaper this week, sign today.` : m.disclosure,
        interrupted: mode === "cut_disclosure",
      });
      if (mode === "double_disclosure") out({ type: "agent_line", line_id: 0, text: "Totally different words, buy now" });
      if (mode === "cleared_in_disclosure") {
        // A caller interrupts the next reply right after the sidecar's own disclosure window, while the browser still plays line 0.
        setTimeout(() => {
          out({ type: "audio_out", data: Buffer.alloc(800, 0x11).toString("base64") });
          out({ type: "cleared", reason: "final_transcript" });
          out({ type: "audio_out", data: Buffer.alloc(800, 0x22).toString("base64") });
        }, 100);
      }
      break;
    case "audio_in":
      frames += 1;
      if (frames === 3) out({ type: "caller_final", turn: ++turn, text: "I need a quote" });
      break;
    case "caller_text":
      if (disclosurePlaying) {
        held.push(m.text);
        break;
      }
      if (mode === "clear_reasons") {
        for (const reason of ["interim_transcript", "final_transcript", "typed_text", "reply_failed"]) out({ type: "cleared", reason });
        break;
      }
      if (mode === "metrics") {
        out({ type: "metrics", turn: 1, stage: "reply", kind: "time_to_first_byte", milliseconds: 412 });
        out({ type: "metrics", turn: 1, stage: "text_to_speech", kind: "processing", milliseconds: 95 });
        // Malformed: dropped, never traced.
        out({ type: "metrics", turn: 1, stage: "provider said something", kind: "processing", milliseconds: 7 });
        out({ type: "metrics", turn: 1, stage: "reply", kind: "processing", milliseconds: "12" });
      }
      out({ type: "caller_final", turn: ++turn, text: m.text });
      break;
    case "guidance":
      if (mode === "warning") {
        // A reply model that fails without being fatal: a warning, then the fallback line, and the call goes on.
        out({ type: "warning", code: "azure_rate_limited" });
        out({ type: "warning", code: "Provider Said: quota exceeded" });
        speak("Sorry, could you say that again?");
        break;
      }
      speak(m.text ?? "Sure, tell me more.");
      if (mode === "two_lines") speak("Second line.");
      break;
    case "barge_in":
      out({ type: "cleared", reason: "host_barge_in" });
      if (mode === "stale_report") out({ type: "stale_dropped", chunks: 3 });
      break;
    case "line_verdict":
      break;
    case "end":
    case "cancel":
      out({ type: "ended" });
      process.exit(0);
  }
  if (mode === "error_on_audio" && m.type === "audio_in") out({ type: "error", code: process.env.FAKE_ERROR_CODE ?? "deepgram_failed" });
  if (mode === "self_barge_in" && m.type === "audio_in" && frames === 1) out({ type: "cleared", reason: "interim_transcript" });
  if (mode === "partial" && m.type === "audio_in" && frames === 1) {
    out({ type: "caller_partial", text: "secret caller words" });
    out({ type: "stats", audio_in: 1, stt_final: 0, tts_chunks: 1 });
  }
  void guard;
});
