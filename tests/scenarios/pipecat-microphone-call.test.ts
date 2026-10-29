import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { InteractiveCall } from "../../src/decision/interactive-call.js";
import type { HarnessLiveSession } from "../../src/modules/open-live-session.js";
import { clearedTestCall } from "../helpers/cleared-call.js";
import { resolvePipecatPython } from "../../src/orchestration-modules/pipecat-config.js";
import {
  openVoiceSession,
  resetTalkOrchestrator,
  resetVoiceDeps,
  selectTalkOrchestrator,
  setVoiceDeps,
} from "../../src/server/voice/manager.js";

const pythonPath = resolvePipecatPython();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(20);
}

/**
 * Stands in for Azure gpt-live-1 on a local port: answers session.start, then
 * streams agent audio every 20 milliseconds the way a phone line does (silence
 * included), and counts the caller audio it is sent.
 */
async function fakeAzure() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const heard = { appends: 0 };
  wss.on("connection", (ws) => {
    let stream: NodeJS.Timeout | undefined;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as { type?: string };
      if (m.type === "session.start") {
        ws.send(JSON.stringify({ type: "session.started" }));
        const delta = Buffer.alloc(160, 0xff).toString("base64");
        stream = setInterval(() => ws.send(JSON.stringify({ type: "session.output_audio.delta", delta })), 20);
      } else if (m.type === "session.input_audio.append") heard.appends += 1;
    });
    ws.on("close", () => clearInterval(stream));
  });
  const { port } = wss.address() as AddressInfo;
  const close = () =>
    new Promise<void>((r) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => r());
    });
  return { url: `ws://127.0.0.1:${port}/`, heard, close };
}

describe("pipecat microphone call", () => {
  let session: HarnessLiveSession | undefined;
  let azure: Awaited<ReturnType<typeof fakeAzure>> | undefined;

  let cleared: InteractiveCall | undefined;

  afterEach(async () => {
    await cleared?.hangUp();
    cleared = undefined;
    session?.stop("caller_hangup");
    session = undefined;
    await azure?.close();
    azure = undefined;
    resetVoiceDeps();
    resetTalkOrchestrator();
  });

  it.skipIf(!pythonPath)(
    "keeps sending caller audio to Azure after the caller talks over the agent",
    async () => {
      const fake = await fakeAzure();
      azure = fake;
      setVoiceDeps({ credentials: () => ({ liveUrl: fake.url, apiKey: "test-only" }) });
      selectTalkOrchestrator("pipecat");
      let agentAudio = 0;
      const errors: string[] = [];
      const call = await clearedTestCall();
      cleared = call;
      const live = await openVoiceSession({
        call,
        input: "audio",
        trace: { leadId: "lead-1", recordId: call.callId, channel: "call", direction: "inbound", callId: call.callId },
        leadFirstName: "Jane",
        direction: "inbound",
        disclosure: "Hi",
        packet: {
          leadId: "lead-1",
          name: "Jane",
          agencyId: "agency-1",
          phone: "+15550100",
          priorCallSummaries: [],
          quoteFields: {},
          consentSnapshot: {},
        },
        dialogOwnsTranscript: false,
        onAudio: () => void (agentAudio += 1),
        onClearPlayback: () => undefined,
        onProviderError: (code) => void errors.push(code),
      });
      session = live;
      expect(live.sessionMode).toBe("pipecat_microphone");

      // The page sends 21-byte mu-law frames (128 samples at 48 kilohertz, cut to 8 kilohertz).
      const frame = Buffer.alloc(21, 0xff).toString("base64");
      const speak = async (frames: number) => {
        for (let i = 0; i < frames; i += 4) {
          for (let k = 0; k < 4; k += 1) live.sendAudio(frame);
          await sleep(10);
        }
      };
      await speak(100);
      await waitFor(() => fake.heard.appends >= 100 && agentAudio > 0);
      expect(fake.heard.appends).toBeGreaterThanOrEqual(100);

      // The caller says hello while agent audio plays: the page sends barge_in on every loud frame.
      for (let i = 0; i < 5; i += 1) {
        live.bargeIn();
        live.sendAudio(frame);
        await sleep(20);
      }
      const atBargeIn = fake.heard.appends;
      await speak(200);
      await waitFor(() => fake.heard.appends - atBargeIn >= 200);
      expect(fake.heard.appends - atBargeIn).toBeGreaterThanOrEqual(200);
      expect(errors).toEqual([]);
      expect(live.isEnded).toBe(false);
    },
    30_000,
  );
});
