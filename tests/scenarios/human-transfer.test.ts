/**
 * A transfer to a person from a Talk call (src/server/voice/human-transfer.ts), offline: a fake Twilio client and a
 * fake Twilio stream against the real listener on a free port. Nothing here can dial: the transfer is armed with the
 * fake, and the real client refuses under vitest (checked below).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { inboundOpeningScript } from "../../src/compliance/disclosures.js";
import { resetHarnessConfig } from "../../src/config.js";
import { createFlowDispatcher } from "../../src/flow-tools/dispatch.js";
import { RuleBasedJudge } from "../../src/judge/rule-judge.js";
import { resetLeadStore, seedLead } from "../../src/store/lead-store.js";
import { mockLeadStore } from "../../src/store/lead-store-seam.js";
import { newCallContext, runWithTrace, traceBus, type TraceContext, type TraceEvent } from "../../src/trace/events.js";
import { createFlowToolRunner, TRANSFER_NO_ANSWER_OUTPUT } from "../../src/server/voice/flow-tool-runner.js";
import {
  armHumanTransfer,
  disarmHumanTransfer,
  openTransferLine,
  setTransferRing,
  transferToPerson,
  type HumanTransferDeps,
  type TalkCallPort,
} from "../../src/server/voice/human-transfer.js";
import { realTwilioClient, SCREEN_PROMPT, type TwilioTransferClient } from "../../src/server/voice/twilio-transfer-line.js";
import { baseLead } from "../helpers/fixtures.js";

const ACCOUNT = `AC${"1".repeat(32)}`;
const PRIMARY = "+15550101";
const SECONDARY = "+15550102";
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(10);
  }
}

class FakeTwilio implements TwilioTransferClient {
  placed: Array<{ to: string; from: string; twiml: string; ringSeconds: number; sid: string; token: string }> = [];
  hungUp: string[] = [];
  failFor = new Set<string>();
  accountSid = () => ACCOUNT;
  callerId = async () => "+15550100";
  async placeCall(p: { to: string; from: string; twiml: string; ringSeconds: number }) {
    if (this.failFor.has(p.to)) throw Object.assign(new Error("twilio_21215"), { code: "twilio_21215" });
    const sid = `CA${String(this.placed.length + 1).padStart(32, "0")}`;
    const token = p.twiml.match(/stream\/([0-9a-f]{64})/)![1]!;
    this.placed.push({ ...p, sid, token });
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
  leg(to: string) {
    return this.placed.find((p) => p.to === to)!;
  }
}

/** The browser side of a Talk call, as the socket route gives it. */
function fakePort(trace: TraceContext) {
  const seen = { audio: [] as string[], clears: 0, statuses: [] as Array<Record<string, unknown>>, stopped: [] as string[], finished: [] as string[], holdOpen: 0 };
  const port: TalkCallPort = {
    callId: trace.callId!,
    trace,
    sendAudio: (b) => void seen.audio.push(b),
    clearAudio: () => void (seen.clears += 1),
    status: (f) => void seen.statuses.push(f),
    playbackEndsAt: () => 0,
    stopAgent: (r) => void seen.stopped.push(r),
    finish: (r) => void seen.finished.push(r),
    holdOpen: () => void (seen.holdOpen += 1),
  };
  return { port, seen };
}

/** Twilio's side of one leg's media stream, against the listener. */
async function stream(port: number, token: string, start: { callSid: string; accountSid?: string; leg?: string }) {
  const got: Array<Record<string, any>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio-transfer/stream/${token}`);
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject)));
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: { accountSid: start.accountSid ?? ACCOUNT, callSid: start.callSid, streamSid: "MZ1", customParameters: { leg: start.leg ?? token } } }));
  return { ws, got, send: (m: Record<string, unknown>) => ws.send(JSON.stringify({ streamSid: "MZ1", ...m })) };
}

let twilio: FakeTwilio;
let deps: HumanTransferDeps;
let listenerPort: number;
let ctx: TraceContext;
const callEvents = (): TraceEvent[] => traceBus.history().filter((e) => e.callId === ctx.callId);
const rows = (tool: string) => callEvents().filter((e) => e.type === "tool_call" && e.data.tool === tool);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  resetHarnessConfig();
  resetLeadStore();
  traceBus.reset();
  twilio = new FakeTwilio();
  deps = armHumanTransfer({
    twilio,
    listenerPort: 0,
    publicBase: async () => "wss://transfer.example.test",
    cells: () => ({ primary: PRIMARY, secondary: SECONDARY }),
    statusPollMs: 30,
    answerWaitMs: 400,
    promptGraceMs: 200,
    keyWaitMs: 250,
    handoffQuietMs: 60,
    bridgeCapMs: 5000,
  });
  listenerPort = await deps.listener.listen(0);
  // The shipped default rings primary destination only (DEFAULT_TRANSFER_RING); these cases ring both unless they choose.
  setTransferRing("both");
  ctx = newCallContext("lead-1", "inbound");
});

afterEach(async () => {
  await disarmHumanTransfer();
  vi.restoreAllMocks();
});

describe("transfer to a person from a Talk call", () => {
  it("rings both cells, bridges the first to press 1, hangs up the other, and records names and times only", async () => {
    const { port, seen } = fakePort(ctx);
    const line = openTransferLine(port);
    const result = transferToPerson(ctx.callId!, { reason: "caller_requested", note: "Wants the renewal." });
    await until(() => twilio.placed.length === 2);
    expect(twilio.placed.map((p) => p.to).sort()).toEqual([PRIMARY, SECONDARY]);
    for (const p of twilio.placed) {
      expect(p.from).toBe("+15550100");
      expect(p.twiml).toContain(`<Say>${SCREEN_PROMPT}</Say>`);
      expect(p.twiml).toContain(`<Stream url="wss://transfer.example.test/twilio-transfer/stream/${p.token}">`);
      expect(p.twiml).not.toMatch(/record/i);
      // The model's note never reaches the person's prompt.
      expect(p.twiml).not.toContain("renewal");
    }
    // On hold: ringback plays and the caller's audio goes nowhere.
    await until(() => seen.audio.length > 0);
    expect(line.ownsAudio()).toBe(true);
    expect(line.takeCallerAudio(Buffer.alloc(160, 0xff))).toBe(true);

    const secondary = await stream(listenerPort, twilio.leg(SECONDARY).token, { callSid: twilio.leg(SECONDARY).sid });
    await until(() => rows("human_transfer_picked_up").length === 1);
    secondary.send({ event: "dtmf", dtmf: { track: "inbound", digit: "1" } });
    expect(await result).toBe(true);

    expect(twilio.hungUp).toContain(twilio.leg(PRIMARY).sid);
    expect(twilio.hungUp).not.toContain(twilio.leg(SECONDARY).sid);
    expect(seen.stopped).toEqual(["transferred_to_person"]);
    expect(seen.statuses).toContainEqual({ state: "transfer_connected", bargeInOwner: "server" });
    expect(seen.clears).toBe(1);
    expect(line.ownsCall()).toBe(true);

    // The person's audio reaches the browser, and the caller's reaches the person.
    const before = seen.audio.length;
    secondary.send({ event: "media", media: { track: "inbound", payload: "AAAA" } });
    await until(() => seen.audio.length === before + 1);
    expect(seen.audio.at(-1)).toBe("AAAA");
    line.takeCallerAudio(Buffer.from([1, 2, 3]));
    await until(() => secondary.got.some((m) => m.event === "media"));
    expect(secondary.got.find((m) => m.event === "media")).toEqual({ event: "media", streamSid: "MZ1", media: { payload: Buffer.from([1, 2, 3]).toString("base64") } });

    // The person hangs up: the bridge ends, the call ends as handed_off and the browser is told.
    secondary.ws.close();
    await until(() => seen.finished.length === 1);
    expect(seen.finished).toEqual(["transfer_ended"]);
    expect(twilio.hungUp).toContain(twilio.leg(SECONDARY).sid);
    expect(rows("human_transfer_answered")[0]!.data.inputs).toEqual({ who: "secondary" });
    expect(rows("human_transfer_bridge_ended")[0]!.data.inputs).toEqual({ who: "secondary", endedBy: "person_hung_up" });
    expect(callEvents().filter((e) => e.type === "disposition").map((e) => e.data.value)).toEqual(["handed_off"]);
    const recorded = JSON.stringify(callEvents());
    for (const secret of ["5555550101", "5555550102", "8035550000", "AAAA", ACCOUNT]) expect(recorded).not.toContain(secret);
  });

  it("gives the call back to the agent when nobody picks up, and when a person picks up but never presses 1", async () => {
    const { port, seen } = fakePort(ctx);
    const line = openTransferLine(port);
    const result = transferToPerson(ctx.callId!, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 2);
    // primary destination picks up (voicemail, say) and presses nothing.
    await stream(listenerPort, twilio.leg(PRIMARY).token, { callSid: twilio.leg(PRIMARY).sid });
    expect(await result).toBe(false);
    expect(twilio.hungUp.sort()).toEqual([twilio.leg(PRIMARY).sid, twilio.leg(SECONDARY).sid].sort());
    expect(line.ownsAudio()).toBe(false);
    expect(line.takeCallerAudio(Buffer.alloc(160))).toBe(false);
    expect(seen.stopped).toEqual([]);
    expect(seen.statuses.at(-1)).toEqual({ state: "transfer_no_answer" });
    expect(rows("human_transfer_no_answer")[0]!.data).toMatchObject({ success: false, inputs: { people: ["primary", "secondary"], pickedUpWithoutKey: ["primary"] } });
  });

  it("hands the call back as soon as Twilio says every cell stopped ringing, and waits out the prompt for a late answer", async () => {
    openTransferLine(fakePort(ctx).port);
    const quick = transferToPerson(ctx.callId!, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 2);
    const began = Date.now();
    twilio.status.set(twilio.leg(PRIMARY).sid, "no-answer");
    twilio.status.set(twilio.leg(SECONDARY).sid, "busy");
    expect(await quick).toBe(false);
    expect(Date.now() - began).toBeLessThan(300);
    // Calls Twilio already ended are not hung up again.
    expect(twilio.hungUp).toEqual([]);

    // Second ring: secondary destination answers just before the last-resort timer and is still hearing the prompt when it fires.
    setTransferRing("secondary");
    const late = transferToPerson(ctx.callId!, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 3);
    const secondary = twilio.placed[2]!;
    await tick(300);
    twilio.status.set(secondary.sid, "in-progress");
    await until(() => rows("human_transfer_picked_up").length === 1);
    await tick(150);
    const leg = await stream(listenerPort, secondary.token, { callSid: secondary.sid });
    leg.send({ event: "dtmf", dtmf: { digit: "1" } });
    // The key press arrives right behind the start message: it waits for the start's check, it is not dropped.
    expect(await late).toBe(true);
    expect(twilio.hungUp).toEqual([]);
  });

  it("refuses a stream on an unknown path, one naming another call or account, and a second stream on a used path", async () => {
    openTransferLine(fakePort(ctx).port);
    const result = transferToPerson(ctx.callId!, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 2);
    const unknown = new WebSocket(`ws://127.0.0.1:${listenerPort}/twilio-transfer/stream/${"a".repeat(64)}`);
    expect(await new Promise((r) => unknown.once("unexpected-response", (_req, res) => r(res.statusCode)))).toBe(404);

    const primary = twilio.leg(PRIMARY);
    const forged = await stream(listenerPort, primary.token, { callSid: twilio.leg(SECONDARY).sid });
    await new Promise((r) => forged.ws.once("close", r));
    const again = new WebSocket(`ws://127.0.0.1:${listenerPort}/twilio-transfer/stream/${primary.token}`);
    expect(await new Promise((r) => again.once("unexpected-response", (_req, res) => r(res.statusCode)))).toBe(404);

    const secondary = twilio.leg(SECONDARY);
    const otherAccount = await stream(listenerPort, secondary.token, { callSid: secondary.sid, accountSid: `AC${"2".repeat(32)}` });
    otherAccount.send({ event: "dtmf", dtmf: { digit: "1" } });
    await new Promise((r) => otherAccount.ws.once("close", r));
    expect(await result).toBe(false);
    expect(rows("human_transfer_picked_up")).toEqual([]);
    expect(rows("human_transfer_answered")).toEqual([]);
  });

  it("rings only the chosen cell, stops ringing when the caller hangs up, and rings nobody when unarmed or not a Talk call", async () => {
    setTransferRing("primary");
    const line = openTransferLine(fakePort(ctx).port);
    const result = transferToPerson(ctx.callId!, { reason: "caller_requested" });
    await until(() => twilio.placed.length === 1);
    expect(twilio.placed[0]!.to).toBe(PRIMARY);
    line.close("caller_hung_up");
    expect(await result).toBe(false);
    expect(twilio.hungUp).toEqual([twilio.placed[0]!.sid]);
    expect(rows("human_transfer_cancelled")[0]!.data.reason).toBe("caller_hung_up");

    expect(await runWithTrace(ctx, () => transferToPerson("call_not_talk", { reason: "caller_requested" }))).toBe(false);
    await disarmHumanTransfer();
    openTransferLine(fakePort(ctx).port);
    expect(await transferToPerson(ctx.callId!, { reason: "caller_requested" })).toBe(false);
    expect(twilio.placed).toHaveLength(1);
    expect(rows("human_transfer_unavailable").map((e) => e.data.reason)).toEqual(["not_a_talk_call", "transfer_not_armed"]);
  });

  it("the real Twilio client refuses any number but the two cells, and refuses to dial at all under vitest", async () => {
    vi.stubEnv("VOICE_HARNESS_TRANSFER_PRIMARY_PHONE", PRIMARY);
    vi.stubEnv("VOICE_HARNESS_TRANSFER_SECONDARY_PHONE", SECONDARY);
    vi.stubEnv("VOICE_HARNESS_TWILIO_CALLER_ID", "+15550100");
    const client = realTwilioClient();
    const call = (to: string) => client.placeCall({ to, from: "+15550100", twiml: "<Response/>", ringSeconds: 15 });
    await expect(call("+15550199")).rejects.toThrow("not_an_allowlisted_cell");
    await expect(call(PRIMARY)).rejects.toThrow("tests_never_dial");
    await expect(client.callerId()).resolves.toBe("+15550100");
    vi.unstubAllEnvs();
  });

  it("a dry run builds the exact request, logs it with the numbers masked, sends nothing and still refuses other numbers", async () => {
    vi.stubEnv("VOICE_HARNESS_TRANSFER_PRIMARY_PHONE", PRIMARY);
    vi.stubEnv("VOICE_HARNESS_TRANSFER_SECONDARY_PHONE", SECONDARY);
    vi.stubEnv("VOICE_HARNESS_TRANSFER_DIALING", "dry_run");
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((line: unknown) => void lines.push(String(line)));
    const client = realTwilioClient();
    await expect(client.placeCall({ to: "+15550199", from: "+15550100", twiml: "<Response/>", ringSeconds: 15 })).rejects.toThrow("not_an_allowlisted_cell");
    const { sid } = await client.placeCall({ to: PRIMARY, from: "+15550100", twiml: "<Response><Say>x</Say></Response>", ringSeconds: 1 });
    expect(sid).toMatch(/^CA[0-9a-f]{32}$/);
    expect(lines).toEqual([`transfer dry_run request POST /2010-04-01/Accounts/(account)/Calls.json To=… From=… Timeout=1 sid=${sid} Twiml=<Response><Say>x</Say></Response>`]);
    expect(await client.callStatus(sid)).toBe("ringing");
    await client.hangUp(sid);
    vi.unstubAllEnvs();
  });

  it("through the dispatcher: a transfer nobody took is not done, and the model is told to offer a message", async () => {
    seedLead(baseLead({ id: "lead-1" }));
    const dispatcher = createFlowDispatcher({
      leadId: "lead-1", callId: ctx.callId!, agencyId: "agency-demo", direction: "inbound", clock: { now: () => new Date("2026-10-15T14:00:00Z") },
      gate: { judge: new RuleBasedJudge(), leadId: "lead-1", callId: ctx.callId! }, store: mockLeadStore, onStop: async () => undefined,
      humanTransfer: async () => false,
    });
    dispatcher.sayAgent(inboundOpeningScript());
    await dispatcher.hearCaller("Can I talk to a real person?");
    const runner = createFlowToolRunner({ dispatcher, trace: ctx, neutralRefusals: true });
    const out = await runner.call("transfer_to_human", { reason: "caller_requested", evidence_quote: "talk to a real person" });
    expect(out).toMatchObject({ ok: false, refusedCode: "not_done", output: TRANSFER_NO_ANSWER_OUTPUT });
    expect(rows("transfer_to_human")[0]!.data).toMatchObject({ success: false, reason: "nobody_took_the_call" });
  });
});
