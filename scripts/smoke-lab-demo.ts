/**
 * Live demo of the lab voice agent through the Console tab's typed-text path.
 *
 * Starts one gated play call, opens the voice websocket in text mode, streams
 * mu-law silence the whole call (gpt-live-1 needs continuous input audio, as a
 * phone line would carry), types the caller lines one at a time (each after
 * the agent's reply is recorded), hangs up, and prints the transcript, the
 * watched tool calls, the lead context the agent was given, and the harness
 * run write-back status. The call is real and billed to Azure.
 *
 * Settings (all optional):
 *   VOICE_HARNESS_DEMO_URL        server base url, default http://127.0.0.1:4314
 *   VOICE_HARNESS_DEMO_LEAD       lead id, default lead-4
 *   VOICE_HARNESS_DEMO_SCRIPT     "first" (default), "owner" (answers the role question) or "second"
 *   VOICE_HARNESS_DEMO_DIRECTION  "inbound" or "outbound"; default outbound for
 *                             the first script (the agent calls Maria) and
 *                             inbound for the second (Maria calls back)
 *
 * Exit code 0 only when the call produced at least two agent lines.
 * Reads no environment file and prints nothing from one.
 */

import WebSocket from "ws";

const SCRIPTS: Record<string, string[]> = {
  first: [
    "Yes, this is Maria.",
    "Oh right, the workers comp. It renews in early December, I think.",
    "We have nine people, seven in the field and two in the office. Payroll is around four hundred thousand a year.",
    "Before that, what would it cost me, roughly?",
    "Sure, text is fine.",
    "No, that's all. Thanks, bye.",
  ],
  // The caller answers the tree's own questions (who is speaking, the role), then the quote details, a price question and the text ask.
  owner: [
    "Yes, this is Maria.",
    "I'm the owner.",
    "Oh right, the workers comp. It renews in early December, I think.",
    "We have nine people, seven in the field and two in the office. Payroll is around four hundred thousand a year.",
    "Before that, what would it cost me, roughly?",
    "Sure, text is fine.",
    "No, that's all. Thanks, bye.",
  ],
  second: [
    "Hi, it's Maria again, we talked earlier about my renewal.",
    "Can you just email it to me instead?",
    "It's maria at ortegalandscaping dot com.",
    "Great, thanks. Bye.",
  ],
};

const base = (process.env.VOICE_HARNESS_DEMO_URL ?? "http://127.0.0.1:4314").replace(/\/$/, "");
const LEAD_ID = process.env.VOICE_HARNESS_DEMO_LEAD?.trim() || "lead-4";
const SCRIPT_NAME = process.env.VOICE_HARNESS_DEMO_SCRIPT?.trim() || "first";
const CALLER_LINES = SCRIPTS[SCRIPT_NAME];
const DIRECTION = process.env.VOICE_HARNESS_DEMO_DIRECTION?.trim() || (SCRIPT_NAME === "second" ? "inbound" : "outbound");
const TOOL_PREFIXES = ["thinker_", "delegation_", "call_context_update", "write_quote_field", "send_text", "agent_context", "steer_voice_model", "book_producer", "send_email", "end_call"];
const LEAD_CONTEXT_MARK = "Lead context (read only):";
const REPLY_WAIT_MS = 25_000;
/** Quiet time after the agent's last recorded words before the next caller line goes. */
const REPLY_SETTLE_MS = 4000;
const READY_WAIT_MS = 30_000;
const RUN_WAIT_MS = 60_000;
/** 20 milliseconds of mu-law silence at 8 kilohertz. */
const SILENCE_FRAME = Buffer.alloc(160, 0xff);

interface TranscriptLine { role: string; text: string; at: string }
interface TraceEvent { type: string; at: string; data: Record<string, unknown> }
interface HarnessRecord { transcript: TranscriptLine[]; events: TraceEvent[] }
interface RunStatus { recordId: string; status: string; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function readRecord(callId: string): Promise<HarnessRecord | null> {
  const res = await fetch(`${base}/api/records/${callId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/records/${callId} -> ${res.status}`);
  return (await res.json()) as HarnessRecord;
}

/**
 * The agent's lines recorded after `sinceMs`, as a count and a signature that changes whenever any of them
 * grows or a new one lands. With `afterSteer`, only lines after the first voice-model steer at or after
 * `sinceMs` count: that steer carries the caller's line, so earlier agent words are the tail of the last reply.
 */
async function agentLinesSince(callId: string, sinceMs: number, afterSteer: boolean): Promise<{ count: number; signature: string; total: number }> {
  const record = await readRecord(callId);
  if (!record) return { count: 0, signature: "", total: 0 };
  const all = record.transcript.filter((l) => l.role === "agent");
  let from = sinceMs;
  if (afterSteer) {
    const steer = record.events.find((e) => e.type === "tool_call" && e.data.tool === "steer_voice_model" && Date.parse(e.at) >= sinceMs);
    if (!steer) return { count: 0, signature: "", total: all.length };
    from = Date.parse(steer.at);
  }
  const lines = all.filter((l) => Date.parse(l.at) >= from);
  return { count: lines.length, signature: lines.map((l) => l.text).join("\u0001"), total: all.length };
}

async function main(): Promise<number> {
  if (!CALLER_LINES) throw new Error(`unknown VOICE_HARNESS_DEMO_SCRIPT "${SCRIPT_NAME}" (use first, owner or second)`);
  if (DIRECTION !== "inbound" && DIRECTION !== "outbound") throw new Error(`unknown VOICE_HARNESS_DEMO_DIRECTION "${DIRECTION}"`);
  console.log(`base url: ${base}  lead: ${LEAD_ID}  script: ${SCRIPT_NAME}  direction: ${DIRECTION}`);
  const started = await api<{ callId: string; leadId: string; direction: string }>("/api/play/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leadId: LEAD_ID, direction: DIRECTION, voice: true }),
  });
  const callId = started.callId;
  console.log(`call started: ${callId} (lead ${started.leadId}, ${started.direction})`);

  const wsUrl = `${base.replace(/^http/, "ws")}/api/voice/${callId}/socket?input=text`;
  const ws = new WebSocket(wsUrl, { headers: { Origin: base } });
  let socketClosed = false;
  let pump: NodeJS.Timeout | undefined;
  let silenceFrames = 0;
  const stopPump = () => { clearInterval(pump); pump = undefined; };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => { socketClosed = true; stopPump(); resolve({ code, reason: reason.toString() }); });
  });
  let readyResolve: (() => void) | undefined;
  let readyReject: ((err: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "status") {
      console.log(`  socket status: ${String(msg.state)}${msg.reason ? ` (${String(msg.reason)})` : ""}${msg.sessionMode ? ` mode=${String(msg.sessionMode)}` : ""}`);
      if (msg.state === "ready") readyResolve?.();
      if (msg.state === "ended") readyReject?.(new Error(`socket ended before ready: ${String(msg.reason ?? "")}`));
    } else if (msg.type === "error") {
      console.log(`  socket error frame: ${JSON.stringify(msg).slice(0, 300)}`);
      readyReject?.(new Error(`voice error: ${String(msg.code ?? msg.error ?? "unknown")}`));
    }
  });
  ws.on("error", (err) => readyReject?.(err));
  ws.on("unexpected-response", (_req, res) => readyReject?.(new Error(`socket refused: HTTP ${res.statusCode}`)));

  /**
   * Waits for the agent's reply to what happened at `sinceMs` (the call opening, or a caller line), then
   * until its lines stay unchanged for REPLY_SETTLE_MS (one spoken reply can be recorded as several lines),
   * or the wait runs out, or the call ends.
   */
  const waitForAgentReply = async (sinceMs: number, afterSteer: boolean): Promise<void> => {
    const deadline = Date.now() + REPLY_WAIT_MS;
    let last = await agentLinesSince(callId, sinceMs, afterSteer);
    let changedAt = Date.now();
    while (Date.now() < deadline && !socketClosed) {
      await sleep(500);
      const now = await agentLinesSince(callId, sinceMs, afterSteer);
      if (now.signature !== last.signature) { last = now; changedAt = Date.now(); continue; }
      if (now.count > 0 && Date.now() - changedAt >= REPLY_SETTLE_MS) return;
    }
    if (!socketClosed && last.count === 0) console.log(`  (no agent reply recorded within ${REPLY_WAIT_MS / 1000} seconds)`);
  };

  let hungUp = false;
  try {
    await Promise.race([ready, sleep(READY_WAIT_MS).then(() => { throw new Error("socket not ready in time"); })]);
    // A phone line is never silent on the wire: 20 millisecond frames of mu-law silence until hangup.
    pump = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(SILENCE_FRAME, { binary: true });
      silenceFrames += 1;
    }, 20);
    await waitForAgentReply(0, false); // the agent opens the call
    for (const line of CALLER_LINES) {
      if (socketClosed) { console.log("  (call ended before every caller line was sent)"); break; }
      console.log(`caller> ${line}`);
      const sentAt = Date.now() - 250;
      ws.send(JSON.stringify({ type: "text", text: line }));
      await waitForAgentReply(sentAt, true);
    }
    if (!socketClosed) {
      stopPump();
      ws.send(JSON.stringify({ type: "hangup" }));
      hungUp = true;
    }
    const result = await Promise.race([closed, sleep(20_000).then(() => null)]);
    if (result) console.log(`socket closed: code ${result.code}${result.reason ? ` ${result.reason}` : ""}`);
    else { console.log("socket did not close within 20 seconds; closing it here"); ws.close(); }
  } catch (err) {
    console.log(`demo error: ${err instanceof Error ? err.message : String(err)}`);
    stopPump();
    if (!hungUp && !socketClosed) {
      try { ws.send(JSON.stringify({ type: "hangup" })); } catch { /* socket may be gone */ }
      await Promise.race([closed, sleep(5000)]);
    }
    try { await api(`/api/play/${callId}/hangup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* already ended */ }
  }
  stopPump();
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  console.log(`silence frames sent: ${silenceFrames}`);

  // Give the record a moment to flush the closing line and outcome.
  await sleep(2000);
  const record = await readRecord(callId);
  console.log("\n--- transcript ---");
  const transcript = record?.transcript ?? [];
  for (const line of transcript) console.log(`${line.role}: ${line.text}`);
  const agentCount = transcript.filter((l) => l.role === "agent").length;
  console.log(`(${agentCount} agent lines, ${transcript.filter((l) => l.role === "caller").length} caller lines)`);

  console.log("\n--- watched tools ---");
  const events = record?.events ?? [];
  const tools = events.filter((e) => e.type === "tool_call" && typeof e.data.tool === "string" && TOOL_PREFIXES.some((p) => (e.data.tool as string).startsWith(p)));
  if (tools.length === 0) console.log("(none of the watched tools appear in the trace)");
  for (const e of tools) {
    const inputs = e.data.inputs && typeof e.data.inputs === "object" ? (e.data.inputs as Record<string, unknown>) : {};
    const name = typeof inputs.name === "string" ? ` name=${inputs.name}` : "";
    console.log(`${String(e.data.tool)}${name} success=${String(e.data.success)}${e.data.reason ? ` reason=${String(e.data.reason)}` : ""}`);
  }

  console.log("\n--- lead context given to the agent ---");
  const contextEvent = events.find((e) => e.type === "tool_call" && e.data.tool === "agent_context");
  const contextText = (contextEvent?.data.result as { text?: unknown } | null | undefined)?.text;
  if (typeof contextText !== "string") console.log("(no agent_context event with text in the trace)");
  else {
    const at = contextText.indexOf(LEAD_CONTEXT_MARK);
    console.log(at >= 0 ? contextText.slice(at) : `(agent_context text has no "${LEAD_CONTEXT_MARK}" section; ${contextText.length} characters)`);
  }

  console.log("\n--- outcome ---");
  const outcome = [...events].reverse().find((e) => e.type === "call_outcome");
  console.log(outcome ? JSON.stringify(outcome.data) : "(no call outcome event)");

  console.log("\n--- run write-back ---");
  const deadline = Date.now() + RUN_WAIT_MS;
  let run: RunStatus | undefined;
  let enabled: boolean | undefined;
  while (Date.now() < deadline) {
    const body = await api<{ enabled: boolean; runs: RunStatus[] }>("/api/setups/runs");
    enabled = body.enabled;
    run = body.runs.find((r) => r.recordId === callId);
    if (run && run.status !== "pending") break;
    await sleep(2000);
  }
  console.log(`write-back enabled: ${String(enabled)}`);
  console.log(run ? `run ${run.recordId}: ${run.status}${run.error ? ` (${run.error})` : ""}` : `run ${callId}: no status after ${RUN_WAIT_MS / 1000} seconds`);

  return agentCount >= 2 ? 0 : 1;
}

main().then(
  (code) => { console.log(`\nexit ${code}`); process.exit(code); },
  (err) => { console.error(`smoke-lab-demo failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); },
);
