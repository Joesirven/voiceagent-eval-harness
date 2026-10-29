/**
 * One short real session with Azure gpt-live-1 (under 30 seconds, billed to
 * CRM). Sends one typed caller line, waits for audio and a transcript,
 * and prints only counts, event kinds, durations and the spoken lines. Needs
 * VOICE_HARNESS_DEV_ENV_FILE; never prints any value from it.
 */

import { CallHarness } from "../src/harness/call-harness.js";
import { setAiCallingEnabled, setLegalBlocks } from "../src/config.js";
import { seedLead } from "../src/store/lead-store.js";
import { inboundOpeningScript } from "../src/compliance/disclosures.js";
import { openVoiceSession } from "../src/server/voice/manager.js";
import { buildLeadContextPacket } from "../src/memory/context.js";
import { traceBus } from "../src/trace/index.js";
import { baseLead } from "../tests/helpers/fixtures.js";

const WINDOW_MS = 25_000;
// A live session opens only for a call the harness cleared: test mode, browser line, a synthetic lead.
setAiCallingEnabled("agency-demo", true);
setLegalBlocks("suspended");
seedLead(baseLead());
const call = await new CallHarness().startInteractiveCall("lead-1", "inbound", undefined, "browser");
if (call.status !== "connected") throw new Error("smoke_call_not_cleared");
const trace = { leadId: "lead-1", leadLabel: "Jane", recordId: call.callId, channel: "call" as const, direction: "inbound" as const, callId: call.callId };
let audioChunks = 0;
let audioBytes = 0;
const lines: string[] = [];
traceBus.subscribe((e) => {
  if (e.callId !== call.callId) return;
  if (e.type === "transcript_final") lines.push(`${String(e.data.role)}: ${String(e.data.text)}`);
  if (e.type === "tool_call") console.log(`tool ${String(e.data.tool)} success=${String(e.data.success)} ms=${String(e.data.durationMs)}${e.data.reason ? ` reason=${String(e.data.reason)}` : ""}`);
});

const began = Date.now();
try {
  const session = await openVoiceSession({
    call,
    input: "text",
    trace,
    leadFirstName: "Jane",
    direction: "inbound",
    disclosure: inboundOpeningScript(),
    packet: buildLeadContextPacket(baseLead()),
    dialogOwnsTranscript: false,
    onAudio: (b64) => {
      audioChunks += 1;
      audioBytes += Buffer.from(b64, "base64").length;
    },
    onClearPlayback: () => undefined,
  });
  // A phone line is never silent on the wire: stream 20 millisecond frames of mu-law silence, as the microphone would.
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const marks: string[] = [];
  const mark = setInterval(() => {
    const k = (session as unknown as { eventKinds: Record<string, number> }).eventKinds;
    marks.push(`${((Date.now() - began) / 1000).toFixed(0)}s audio=${k["session.output_audio.delta"] ?? 0} text=${k["session.output_transcript.delta"] ?? 0}`);
  }, 2000);
  const pump = setInterval(() => session.sendAudio(silence), 20);
  const waitFor = async (pred: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  };
  await waitFor(() => lines.some((l) => l.startsWith("agent:")), 12_000);
  marks.push("typed-line-sent");
  await session.sendCallerText("Hi, this is Jane. I would like a quote for my car.");
  await waitFor(() => lines.filter((l) => l.startsWith("agent:")).length >= 2, Math.max(1000, WINDOW_MS - (Date.now() - began)));
  const kinds = (session as unknown as { eventKinds: Record<string, number> }).eventKinds;
  clearInterval(pump);
  clearInterval(mark);
  console.log(marks.join(" | "));
  session.stop("caller_hangup");
  console.log(`audio chunks=${audioChunks} bytes=${audioBytes}`);
  console.log(`event kinds=${JSON.stringify(kinds)}`);
  for (const l of lines) console.log(l);
  console.log(`total seconds=${((Date.now() - began) / 1000).toFixed(1)}`);
} catch (err) {
  console.error(`smoke failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exitCode = 1;
} finally {
  await call.hangUp();
}
setTimeout(() => process.exit(process.exitCode ?? 0), 500);
