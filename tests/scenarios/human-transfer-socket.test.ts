/**
 * The voice socket route's side of a transfer to a person (src/server/voice/socket-route.ts with
 * src/server/voice/human-transfer.ts), offline: a fake voice session in place of the Azure engines, a fake Twilio
 * client, and a fake Twilio stream against the real listener. On hold the caller hears ringback and reaches nobody;
 * once a person presses 1 the agent's session stops and the same browser socket carries the call both ways.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { OpenVoiceParams } from "../../src/server/voice/manager.js";
import { armHumanTransfer, disarmHumanTransfer, setTransferRing, transferToPerson, type HumanTransferDeps } from "../../src/server/voice/human-transfer.js";
import { attachVoiceSockets, type VoiceCallHandle } from "../../src/server/voice/socket-route.js";
import type { TwilioTransferClient } from "../../src/server/voice/twilio-transfer-line.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { traceBus } from "../../src/trace/index.js";
import { baseLead } from "../helpers/fixtures.js";

const fake = vi.hoisted(() => ({
  params: undefined as OpenVoiceParams | undefined,
  session: {
    sendAudio: (() => undefined) as (b: string) => void,
    sendCallerText: (async () => undefined) as (t: string) => Promise<void>,
    bargeIn: () => undefined,
    stop: (() => undefined) as (reason?: string) => void,
    sessionMode: "direct_azure_text",
  },
}));

vi.mock("../../src/server/voice/manager.js", () => ({
  openVoiceSession: async (p: OpenVoiceParams) => {
    fake.params = p;
    return fake.session;
  },
  voiceErrorPathFor: () => "azure_gpt_live",
  VoiceStartError: class extends Error {},
}));

const ACCOUNT = `AC${"3".repeat(32)}`;
const CALL = "call_transfer_socket";
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(10);
  }
}

class FakeTwilio implements TwilioTransferClient {
  placed: Array<{ to: string; sid: string; token: string }> = [];
  hungUp: string[] = [];
  accountSid = () => ACCOUNT;
  callerId = async () => "+15550100";
  async placeCall(p: { to: string; twiml: string }) {
    const sid = `CA${String(this.placed.length + 1).padStart(32, "0")}`;
    this.placed.push({ to: p.to, sid, token: p.twiml.match(/stream\/([0-9a-f]{64})/)![1]! });
    return { sid };
  }
  async hangUp(sid: string) {
    this.hungUp.push(sid);
  }
  /** What Twilio says about each call, by call identifier; ringing unless a test sets it. */
  status = new Map<string, string>();
  async callStatus(sid: string) {
    return this.status.get(sid) ?? "ringing";
  }
}

let server: Server;
let port: number;
let twilio: FakeTwilio;
let deps: HumanTransferDeps;
let listenerPort: number;
let handle: VoiceCallHandle & { stopDialog: ReturnType<typeof vi.fn>; holdOpen: ReturnType<typeof vi.fn>; onDisconnect: ReturnType<typeof vi.fn> };
let toAgent: { audio: string[]; text: string[]; stopped: string[] };

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  resetLeadStore();
  seedLead(baseLead({ id: "lead-1" }));
  traceBus.reset();
  toAgent = { audio: [], text: [], stopped: [] };
  fake.session.sendAudio = (b) => void toAgent.audio.push(b);
  fake.session.sendCallerText = async (t) => void toAgent.text.push(t);
  fake.session.stop = (reason) => {
    toAgent.stopped.push(reason ?? "");
    fake.params?.onEnd?.({ durationMs: 0, reason: reason ?? "caller_hangup" });
  };
  handle = {
    call: { callId: CALL, status: "connected" },
    leadId: "lead-1",
    direction: "inbound",
    say: async () => undefined,
    disclosure: () => "Hi, this is an AI assistant.",
    stopDialog: vi.fn(),
    holdOpen: vi.fn(),
    onDisconnect: vi.fn(),
  };
  server = createServer();
  attachVoiceSockets(server, (id) => (id === CALL ? handle : undefined));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  twilio = new FakeTwilio();
  deps = armHumanTransfer({ twilio, listenerPort: 0, publicBase: async () => "wss://transfer.example.test", cells: () => ({ primary: "+15550101", secondary: "+15550102" }), statusPollMs: 30, answerWaitMs: 300, promptGraceMs: 200, keyWaitMs: 300, handoffQuietMs: 60 });
  listenerPort = await deps.listener.listen(0);
  setTransferRing("primary");
});

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await disarmHumanTransfer();
  await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  vi.restoreAllMocks();
});

async function browser() {
  const seen: Array<Record<string, any>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/${CALL}/socket?input=audio`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  sockets.push(ws);
  ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  await new Promise<void>((r) => ws.once("open", () => r()));
  await until(() => seen.some((m) => m.type === "status" && m.state === "ready"));
  return { ws, seen, closed };
}

describe("a transfer on the voice socket route", () => {
  it("holds the caller, then bridges the browser to the person who pressed 1 on the same socket until the caller hangs up", async () => {
    const { ws, seen, closed } = await browser();
    const result = transferToPerson(CALL, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 1);
    // The agent's one short line before the transfer still plays out; the hold (ringback) starts once the agent is quiet.
    fake.params!.onAudio("SEFORE9GRg==");
    await until(() => seen.some((m) => m.type === "audio" && m.data === "SEFORE9GRg=="));
    await until(() => seen.some((m) => m.type === "status" && m.state === "transfer_ringing") && seen.some((m) => m.type === "audio" && m.data !== "SEFORE9GRg=="));

    // On hold: the agent's audio, the caller's audio and typed lines and barge-ins all stop at the server.
    fake.params!.onAudio("QUdFTlQ=");
    ws.send(Buffer.alloc(160, 0xff));
    ws.send(JSON.stringify({ type: "text", text: "hello?" }));
    await tick(50);
    expect(seen.filter((m) => m.type === "audio").map((m) => m.data)).not.toContain("QUdFTlQ=");
    expect(toAgent).toEqual({ audio: [], text: [], stopped: [] });

    const person = new WebSocket(`ws://127.0.0.1:${listenerPort}/twilio-transfer/stream/${twilio.placed[0]!.token}`);
    sockets.push(person);
    const personGot: Array<Record<string, any>> = [];
    person.on("message", (d) => personGot.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => person.once("open", () => r()));
    person.send(JSON.stringify({ event: "start", streamSid: "MZ9", start: { accountSid: ACCOUNT, callSid: twilio.placed[0]!.sid, customParameters: { leg: twilio.placed[0]!.token } } }));
    await tick(30);
    person.send(JSON.stringify({ event: "dtmf", streamSid: "MZ9", dtmf: { digit: "1" } }));
    expect(await result).toBe(true);

    // The agent's session stopped, the socket stayed open and barge-in moved to the server.
    expect(toAgent.stopped).toEqual(["transferred_to_person"]);
    expect(handle.stopDialog).toHaveBeenCalledWith("transferred_to_person");
    expect(handle.holdOpen).toHaveBeenCalled();
    await until(() => seen.some((m) => m.type === "status" && m.state === "transfer_connected"));
    expect(seen).toContainEqual({ type: "status", state: "transfer_connected", bargeInOwner: "server" });
    expect(seen.some((m) => m.type === "status" && m.state === "ended")).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    person.send(JSON.stringify({ event: "media", streamSid: "MZ9", media: { payload: "UEVSU09O" } }));
    await until(() => seen.some((m) => m.type === "audio" && m.data === "UEVSU09O"));
    ws.send(Buffer.from([7, 7, 7]));
    await until(() => personGot.some((m) => m.event === "media"));
    expect(personGot.find((m) => m.event === "media")).toEqual({ event: "media", streamSid: "MZ9", media: { payload: Buffer.from([7, 7, 7]).toString("base64") } });

    // The caller hangs up: the browser hears the end, the cell is hung up, the call is finished as handed_off.
    ws.send(JSON.stringify({ type: "hangup" }));
    await closed;
    expect(seen.at(-1)).toEqual({ type: "status", state: "ended", reason: "caller_hangup" });
    expect(twilio.hungUp).toContain(twilio.placed[0]!.sid);
    await until(() => handle.onDisconnect.mock.calls.length > 0);
    expect(traceBus.history().filter((e) => e.callId === CALL && e.type === "disposition").map((e) => e.data.value)).toEqual(["handed_off"]);
    expect(toAgent.audio).toEqual([]);
  });

  it("gives the call back to the agent when nobody takes it", async () => {
    const { ws, seen } = await browser();
    expect(await transferToPerson(CALL, { reason: "caller_requested" })).toBe(false);
    await until(() => seen.some((m) => m.type === "status" && m.state === "transfer_no_answer"));
    fake.params!.onAudio("QUdFTlQ=");
    ws.send(Buffer.alloc(160, 0xff));
    await until(() => seen.some((m) => m.type === "audio" && m.data === "QUdFTlQ=") && toAgent.audio.length === 1);
    expect(toAgent.stopped).toEqual([]);
    ws.close();
  });
});
