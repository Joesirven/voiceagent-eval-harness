/** Billed probe (about 12 seconds each): does a session setting stop automatic responses? Prints event kinds only. */
import WebSocket from "ws";
import { loadAzureLiveCredentials } from "../src/server/voice/azure-credentials.js";

const variant = process.argv[2] ?? "baseline";
const creds = loadAzureLiveCredentials();
const ws = new WebSocket(creds.liveUrl, { headers: { "api-key": creds.apiKey } });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const counts: Record<string, number> = {};
const session: Record<string, unknown> = {
  model: "gpt-live-1",
  instructions: "You are a brief phone assistant. Reply in one short sentence.",
  audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "marin" } },
};
if (variant === "turn_detection") session.turn_detection = { create_response: false };
if (variant === "turn_detection_null") session.turn_detection = null;
if (variant === "audio_input") (session.audio as any).input = { turn_detection: { create_response: false } };
let pump: NodeJS.Timeout;
ws.on("open", () => ws.send(JSON.stringify({ type: "session.start", event_id: "s", session })));
ws.on("message", (raw) => {
  const e = JSON.parse(raw.toString());
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  if (e.type === "error") log(`error code=${String(e.error?.code ?? "?")} param=${String(e.error?.param ?? "?")}`);
  if (e.type === "session.started") {
    log("started");
    pump = setInterval(() => ws.send(JSON.stringify({ type: "session.input_audio.append", audio: Buffer.alloc(160, 0xff).toString("base64") })), 20);
    ws.send(JSON.stringify({ type: "session.instructions.append", delegation_id: null, content: 'Say exactly "Hello there." and stop.' }));
    log("appended");
    setTimeout(() => { log(`before response.create: ${JSON.stringify(counts)}`); ws.send(JSON.stringify({ type: "response.create" })); }, 5000);
  }
});
setTimeout(() => { clearInterval(pump); log(`final: ${JSON.stringify(counts)}`); ws.send(JSON.stringify({ type: "session.close" })); setTimeout(() => process.exit(0), 300); }, 12000);
