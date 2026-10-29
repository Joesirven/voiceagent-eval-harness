/**
 * A real transfer to a person from a Talk call. When transfer_to_human runs, the harness rings the
 * configured primary destination, secondary destination, or both
 * once, as chosen in the call setup dialog (default both). No other number is ever dialled. Each cell hears a short
 * fixed prompt and is connected only once the person presses 1, so a voicemail that picks up is never bridged; the
 * first person to press 1 takes the call and every other cell is hung up.
 *
 * While the cells ring the caller is on hold: the browser hears ringback (after the agent's own line has played),
 * nothing the caller says or types reaches the agent, and the agent's audio is held back. Twilio rings each cell for
 * about 20 seconds, and each cell's call status is read every 2 seconds, so the agent gets the call back as soon as
 * every cell has stopped ringing unanswered; a cell that was answered gets the prompt and then 10 seconds to press 1.
 * If nobody takes it, every cell is hung up and the tool says nobody answered, so the agent offers to take a message.
 * Once a person takes it,
 * the agent's session stops and the browser socket carries the call both ways: mu-law at 8 kilohertz on both sides,
 * relayed as it is, never recorded and never written anywhere. The bridge ends when either side hangs up, or at five
 * minutes; the call then ends as handed_off.
 *
 * Trace rows (who, by name, and how long; never a number and never audio): human_transfer_ringing,
 * human_transfer_picked_up, human_transfer_answered (the person pressed 1), human_transfer_no_answer,
 * human_transfer_cancelled, human_transfer_leg_failed, human_transfer_bridge_ended, and human_transfer_unavailable
 * when nothing could be rung.
 *
 * Only the dev server arms this (armHumanTransfer, from its main block). Imported by tests it is unarmed, and the real
 * Twilio client refuses under vitest as well.
 */

import { randomBytes } from "node:crypto";
import { emitTrace, runWithTrace, type TraceContext } from "../../trace/index.js";
import {
  DEFAULT_TRANSFER_PORT,
  dialingIsDryRun,
  publicStreamBase,
  realTwilioClient,
  screeningTwiml,
  TransferListener,
  TwilioTransferError,
  type LegStream,
  type TwilioTransferClient,
} from "./twilio-transfer-line.js";

export const TRANSFER_RING_CHOICES = ["primary", "secondary", "both"] as const;
export type TransferRingChoice = (typeof TRANSFER_RING_CHOICES)[number];
type Person = "primary" | "secondary";

/** How long Twilio rings each cell (it may add about 5 seconds): short of most carriers' voicemail. */
export const RING_SECONDS = 15;
/** How often each ringing cell's call status is read from Twilio: a cell that stopped ringing unanswered is done at once. */
export const STATUS_POLL_MS = 2000;
/** The last resort when the status cannot be read: a cell neither picked up nor streaming by then is hung up. */
export const ANSWER_WAIT_MS = 40_000;
/** A cell Twilio reports answered is playing the prompt: this long for the prompt, then the key wait. */
export const PROMPT_GRACE_MS = 12_000;
/** A person who heard the prompt has this long to press 1. */
export const KEY_WAIT_MS = 10_000;
/** Twilio call statuses after which a cell that never streamed rings no more. */
const CALL_OVER = new Set(["busy", "failed", "no-answer", "canceled", "completed"]);
/** The longest a bridged call lasts. */
export const BRIDGE_CAP_MS = 5 * 60_000;
/** Rings per call: the first, and one more after nobody answered. */
export const MAX_ATTEMPTS = 2;
/** How often a bridged call tells the dev server it is still in use, so its idle timer does not end it. */
const HOLD_OPEN_EVERY_MS = 60_000;

/** A transfer rings the primary destination unless the call setup says otherwise. */
export const DEFAULT_TRANSFER_RING: TransferRingChoice = "primary";

let ringChoice: TransferRingChoice = DEFAULT_TRANSFER_RING;

/** Which configured destination a transfer rings. */
export function transferRingChoice(): TransferRingChoice {
  return ringChoice;
}

export function setTransferRing(choice: unknown): TransferRingChoice {
  if (!(TRANSFER_RING_CHOICES as readonly unknown[]).includes(choice)) throw new Error("bad_transfer_ring");
  return (ringChoice = choice as TransferRingChoice);
}

export interface HumanTransferDeps {
  twilio: TwilioTransferClient;
  listener: TransferListener;
  /** The listener's port on 127.0.0.1 (0 picks a free one, for tests). */
  listenerPort: number;
  /** The public secure websocket base Twilio reaches the listener on. */
  publicBase: () => Promise<string | undefined>;
  /** The two cells in E.164 form, or null when one is not configured. */
  cells: () => Record<Person, string | null>;
  ringSeconds: number;
  statusPollMs: number;
  answerWaitMs: number;
  promptGraceMs: number;
  keyWaitMs: number;
  handoffQuietMs: number;
  handoffCapMs: number;
  bridgeCapMs: number;
  maxAttempts: number;
}

let armed: HumanTransferDeps | undefined;

/** Arms real transfers. The dev server's main block calls this; tests pass fakes. Unarmed, transfer_to_human rings nobody. */
export function armHumanTransfer(patch: Partial<HumanTransferDeps> = {}): HumanTransferDeps {
  const twilio = patch.twilio ?? realTwilioClient();
  const listenerPort = patch.listenerPort ?? (Number(process.env.VOICE_HARNESS_TRANSFER_PORT) || DEFAULT_TRANSFER_PORT);
  armed = {
    twilio,
    listener: patch.listener ?? new TransferListener(() => twilio.accountSid()),
    listenerPort,
    publicBase: () => publicStreamBase(listenerPort),
    cells: () => ({
      primary: /^\+155501\d{2}$/.test(process.env.VOICE_HARNESS_TRANSFER_PRIMARY_PHONE ?? "") ? process.env.VOICE_HARNESS_TRANSFER_PRIMARY_PHONE! : null,
      secondary: /^\+155501\d{2}$/.test(process.env.VOICE_HARNESS_TRANSFER_SECONDARY_PHONE ?? "") ? process.env.VOICE_HARNESS_TRANSFER_SECONDARY_PHONE! : null,
    }),
    ringSeconds: RING_SECONDS,
    statusPollMs: STATUS_POLL_MS,
    answerWaitMs: ANSWER_WAIT_MS,
    promptGraceMs: PROMPT_GRACE_MS,
    keyWaitMs: KEY_WAIT_MS,
    handoffQuietMs: HANDOFF_QUIET_MS,
    handoffCapMs: HANDOFF_CAP_MS,
    bridgeCapMs: BRIDGE_CAP_MS,
    maxAttempts: MAX_ATTEMPTS,
    ...patch,
  };
  return armed;
}

/** Ends every transfer, stops the listener and disarms (tests). */
export async function disarmHumanTransfer(): Promise<void> {
  const deps = armed;
  armed = undefined;
  ringChoice = DEFAULT_TRANSFER_RING;
  for (const line of [...lines.values()]) line.close("disarmed");
  lines.clear();
  await deps?.listener.close();
}

/** What the voice socket (socket-route.ts) gives a call's transfer line. */
export interface TalkCallPort {
  callId: string;
  trace: TraceContext;
  /** Sends audio to the browser (base64 mu-law at 8 kilohertz), keeping the socket's playback clock. */
  sendAudio(base64: string): void;
  /** Drops the audio still queued in the browser. */
  clearAudio(): void;
  /** Sends a status frame to the browser. */
  status(fields: Record<string, unknown>): void;
  /** When the audio already sent to the browser finishes playing (epoch milliseconds). */
  playbackEndsAt(): number;
  /** Stops the agent's voice session; the socket stays open while the line owns the call. */
  stopAgent(reason: string): void;
  /** Tells the browser the call ended and closes the socket. */
  finish(reason: string): void;
  /** Keeps the dev server's play call from ending as idle. */
  holdOpen(): void;
}

export interface TransferLine {
  /** Ringing or bridged: the line holds the caller's audio, typed lines and barge-ins. */
  ownsAudio(): boolean;
  /**
   * Whether this piece of agent audio (or, with none, a playback clear) goes to the browser: yes before a transfer and
   * while the agent finishes its handoff line; no once the caller is on hold (ringback) or bridged.
   */
  passesAgentAudio(base64?: string): boolean;
  /** Bridged: the agent's session is over and the line owns the browser socket. */
  ownsCall(): boolean;
  /** One browser microphone frame: relayed to the person when bridged, held while ringing. True when the line took it. */
  takeCallerAudio(frame: Buffer): boolean;
  /** The browser hung up or the socket closed: rings stop, a bridge ends. Safe to call twice. */
  close(reason?: string): void;
}

const lines = new Map<string, Line>();

/** Whether transfer_to_human on this call is a real transfer: armed, and the call is a Talk call with an open line. */
export function realTransferFor(callId: string): boolean {
  const line = lines.get(callId);
  return armed !== undefined && line !== undefined && line.state !== "ended";
}

/** Registers a Talk call's transfer line (one per call). */
export function openTransferLine(port: TalkCallPort): TransferLine {
  lines.get(port.callId)?.close("replaced");
  const line = new Line(port);
  lines.set(port.callId, line);
  return line;
}

/**
 * transfer_to_human's run on a Talk call: rings the chosen cells and resolves true once a person pressed 1 and the
 * bridge is up (the agent's session has stopped by then), false when nobody took the call or nothing could be rung.
 */
export async function transferToPerson(callId: string, request: { reason: string; note?: string }): Promise<boolean> {
  const line = lines.get(callId);
  const unavailable = (reason: string): false => {
    traceRow(line?.port.trace, "human_transfer_unavailable", { reason }, false, reason);
    return false;
  };
  const deps = armed;
  if (!deps) return unavailable("transfer_not_armed");
  if (!line || line.state === "ended") return unavailable("not_a_talk_call");
  if (line.state !== "idle") return unavailable("transfer_in_progress");
  if (line.attempts >= deps.maxAttempts) return unavailable("attempts_used");
  const cells = deps.cells();
  const chosen: Person[] = ringChoice === "both" ? ["primary", "secondary"] : [ringChoice];
  const people = chosen.filter((p) => cells[p]);
  if (!people.length) return unavailable("test_phone_not_configured");
  let base: string | undefined;
  let from: string;
  try {
    await deps.listener.listen(deps.listenerPort);
    base = await deps.publicBase();
    if (!base) return unavailable("no_public_address");
    from = await deps.twilio.callerId();
  } catch (err) {
    return unavailable(codeOf(err));
  }
  // The call may have ended, or another transfer started, while the listener and the caller ID were checked.
  const now: string = line.state;
  if (now === "ended") return unavailable("not_a_talk_call");
  if (now !== "idle") return unavailable("transfer_in_progress");
  return line.ring(deps, people, cells, base, from, request.reason);
}

function codeOf(err: unknown): string {
  if (err instanceof TwilioTransferError) return err.code;
  return (err as { code?: unknown } | null)?.code === "EADDRINUSE" ? "listener_port_busy" : "transfer_setup_failed";
}

function traceRow(ctx: TraceContext | undefined, tool: string, inputs: Record<string, unknown>, success: boolean, reason?: string, durationMs = 0): void {
  const emit = async () => void emitTrace("tool_call", { tool, inputs, result: null, success, durationMs, ...(reason ? { reason } : {}) });
  void (ctx ? runWithTrace(ctx, emit) : emit());
  // One server log line per step: the call, who and how long, never a number.
  const who = typeof inputs.who === "string" ? ` who=${inputs.who}` : Array.isArray(inputs.people) ? ` people=${inputs.people.join(",")}` : "";
  console.log(`transfer ${tool.replace(/^human_transfer_/, "")} call=${ctx?.callId ?? "none"}${who}${reason ? ` reason=${reason}` : ""}${durationMs ? ` ms=${durationMs}` : ""}`);
}

/** North American ringback as mu-law at 8 kilohertz: 440 and 480 hertz together, two seconds on and four off. */
const RINGBACK = ringback();
/** Ringback goes to the browser in 200 millisecond pieces, never more than this far ahead of what has played. */
const RINGBACK_CHUNK = 1600;
const RINGBACK_AHEAD_MS = 300;
/** The agent's handoff line plays out first: hold starts once the agent has been quiet this long, or at the cap. */
export const HANDOFF_QUIET_MS = 700;
export const HANDOFF_CAP_MS = 8000;
/** Agent audio below this level (of 32767) counts as quiet: gpt-live-1 keeps streaming silence after a line. */
const QUIET_LEVEL = 800;

function muLawLevel(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 7;
  return (((u & 0x0f) << 3) + 0x84 << exponent) - 0x84;
}

function isQuiet(base64: string): boolean {
  for (const byte of Buffer.from(base64, "base64")) if (muLawLevel(byte) > QUIET_LEVEL) return false;
  return true;
}

function muLaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const s = Math.min(Math.abs(Math.round(sample)), 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ringback(): Buffer {
  const rate = 8000;
  const out = Buffer.alloc(rate * 6, 0xff);
  const ramp = rate / 100;
  for (let i = 0; i < rate * 2; i += 1) {
    const edge = Math.min(1, i / ramp, (rate * 2 - i) / ramp);
    const t = i / rate;
    out[i] = muLaw(edge * 2600 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)));
  }
  return out;
}

interface Leg {
  who: Person;
  stream: LegStream;
  sid?: string;
  /** When Twilio reported it answered, or its stream opened, whichever came first. */
  pickedUpAt?: number;
  /** The stream is open: the prompt has played. */
  streaming?: boolean;
  /** A status read is in flight. */
  polling?: boolean;
  done: boolean;
  keyTimer?: NodeJS.Timeout;
}

class Line implements TransferLine {
  state: "idle" | "ringing" | "bridged" | "ended" = "idle";
  attempts = 0;
  private deps: HumanTransferDeps | undefined;
  private cancelRing: ((why: string) => void) | undefined;
  private bridge: { leg: Leg; began: number; capTimer: NodeJS.Timeout; holdTimer: NodeJS.Timeout } | undefined;
  private ringbackTimer: NodeJS.Timeout | undefined;
  /** On hold: ringback plays and the agent's audio is held back. */
  private holding = false;
  private holdCheckFrom = 0;
  private lastLoudAgentAt = 0;

  constructor(readonly port: TalkCallPort) {}

  ownsAudio(): boolean {
    return this.state === "ringing" || this.state === "bridged";
  }

  passesAgentAudio(base64?: string): boolean {
    if (this.state === "bridged") return false;
    if (this.state !== "ringing") return true;
    if (this.holding) return false;
    // The agent's one short line before the transfer still plays (gpt-live-1 streams it at the pace of speech).
    if (base64 !== undefined && !isQuiet(base64)) this.lastLoudAgentAt = Date.now();
    return true;
  }

  ownsCall(): boolean {
    return this.state === "bridged";
  }

  takeCallerAudio(frame: Buffer): boolean {
    if (this.state === "bridged") {
      this.bridge?.leg.stream.send(frame.toString("base64"));
      return true;
    }
    return this.state === "ringing";
  }

  close(reason = "caller_hung_up"): void {
    if (this.state === "ringing") this.cancelRing?.(reason);
    else if (this.state === "bridged") this.endBridge(reason);
    this.state = "ended";
    this.stopRingback();
    if (lines.get(this.port.callId) === this) lines.delete(this.port.callId);
  }

  private row(tool: string, inputs: Record<string, unknown>, success: boolean, reason?: string, durationMs = 0): void {
    traceRow(this.port.trace, tool, inputs, success, reason, durationMs);
  }

  ring(deps: HumanTransferDeps, people: Person[], cells: Record<Person, string | null>, base: string, from: string, reason: string): Promise<boolean> {
    this.deps = deps;
    this.state = "ringing";
    this.attempts += 1;
    const began = Date.now();
    this.port.status({ state: "transfer_ringing" });
    this.startRingback(deps);
    this.row("human_transfer_ringing", { ring: ringChoice, people, reason, attempt: this.attempts, ...(dialingIsDryRun() ? { dryRun: true } : {}) }, true);
    return new Promise<boolean>((resolve) => {
      const legs: Leg[] = [];
      let settled = false;
      const hangUp = (leg: Leg) => {
        leg.done = true;
        clearTimeout(leg.keyTimer);
        leg.stream.close();
        // A leg still being placed is hung up as soon as Twilio names it (below).
        if (leg.sid) void deps.twilio.hangUp(leg.sid).catch(() => undefined);
      };
      const finish = (taken: Leg | undefined, why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(answerTimer);
        clearInterval(statusPoll);
        this.cancelRing = undefined;
        for (const leg of legs) if (leg !== taken && !leg.done) hangUp(leg);
        const ringMs = Date.now() - began;
        if (taken) {
          this.connect(deps, taken, ringMs);
          return resolve(true);
        }
        this.stopRingback();
        if (why === "no_answer") {
          const pickedUpWithoutKey = legs.filter((l) => l.pickedUpAt !== undefined).map((l) => l.who);
          this.row("human_transfer_no_answer", { people, pickedUpWithoutKey }, false, "no_answer", ringMs);
        } else {
          this.row("human_transfer_cancelled", { people, by: why }, false, why, ringMs);
        }
        if (this.state === "ringing") {
          // The agent has the call back.
          this.state = "idle";
          this.port.status({ state: "transfer_no_answer" });
        }
        resolve(false);
      };
      const settleIfAllDone = () => {
        if (legs.every((l) => l.done)) finish(undefined, "no_answer");
      };
      /** The cell was answered (Twilio says so, or its stream opened): it has until the timer to press 1. */
      const pickedUp = (leg: Leg, waitMs: number) => {
        if (leg.pickedUpAt === undefined) {
          leg.pickedUpAt = Date.now();
          this.row("human_transfer_picked_up", { who: leg.who }, true, undefined, leg.pickedUpAt - began);
        }
        clearTimeout(leg.keyTimer);
        leg.keyTimer = setTimeout(() => {
          if (settled || leg.done) return;
          hangUp(leg);
          settleIfAllDone();
        }, waitMs);
      };
      // Each cell's status while it rings: one that stopped ringing unanswered is done, one answered is playing the prompt.
      const statusPoll = setInterval(() => {
        for (const leg of legs) {
          if (leg.done || leg.streaming || leg.polling || !leg.sid) continue;
          leg.polling = true;
          deps.twilio
            .callStatus(leg.sid)
            .then((status) => {
              if (settled || leg.done || leg.streaming) return;
              if (CALL_OVER.has(status)) {
                leg.done = true;
                clearTimeout(leg.keyTimer);
                leg.stream.close();
                settleIfAllDone();
              } else if (status === "in-progress" && leg.pickedUpAt === undefined) {
                pickedUp(leg, deps.promptGraceMs + deps.keyWaitMs);
              }
            })
            .catch(() => undefined)
            .finally(() => (leg.polling = false));
        }
      }, deps.statusPollMs);
      const answerTimer = setTimeout(() => {
        // The last resort: cells still not answered stop ringing; a person who did answer keeps the rest of their wait.
        for (const leg of legs) if (leg.pickedUpAt === undefined && !leg.done) hangUp(leg);
        settleIfAllDone();
      }, deps.answerWaitMs);
      this.cancelRing = (why) => finish(undefined, why);

      for (const who of people) {
        const to = cells[who]!;
        const token = randomBytes(32).toString("hex");
        let named!: (sid: string) => void;
        let notPlaced!: (err: unknown) => void;
        const callSid = new Promise<string>((res, rej) => {
          named = res;
          notPlaced = rej;
        });
        callSid.catch(() => undefined);
        const leg: Leg = { who, done: false } as Leg;
        leg.stream = deps.listener.expect(token, {
          callSid,
          onStart: () => {
            if (settled || leg.done) return;
            // The prompt has played: the key wait starts now.
            leg.streaming = true;
            console.log(`transfer stream_open call=${this.port.callId} who=${who}`);
            pickedUp(leg, deps.keyWaitMs);
          },
          onDigit: (digit) => {
            if (digit === "1" && !settled && !leg.done) finish(leg, "taken");
          },
          onMedia: (payload) => {
            if (this.bridge?.leg === leg) this.port.sendAudio(payload);
          },
          onEnd: () => {
            if (this.bridge?.leg === leg) return this.endBridge("person_hung_up");
            if (settled || leg.done) return;
            hangUp(leg);
            settleIfAllDone();
          },
        });
        legs.push(leg);
        deps.twilio.placeCall({ to, from, twiml: screeningTwiml(base, token), ringSeconds: deps.ringSeconds }).then(
          ({ sid }) => {
            leg.sid = sid;
            named(sid);
            if (leg.done) void deps.twilio.hangUp(sid).catch(() => undefined);
          },
          (err: unknown) => {
            notPlaced(err);
            this.row("human_transfer_leg_failed", { who }, false, codeOf(err));
            if (settled || leg.done) return;
            hangUp(leg);
            settleIfAllDone();
          },
        );
      }
    });
  }

  private connect(deps: HumanTransferDeps, leg: Leg, ringMs: number): void {
    this.stopRingback();
    this.state = "bridged";
    const capTimer = setTimeout(() => this.endBridge("bridge_cap"), deps.bridgeCapMs);
    const holdTimer = setInterval(() => this.port.holdOpen(), HOLD_OPEN_EVERY_MS);
    capTimer.unref();
    holdTimer.unref();
    this.bridge = { leg, began: Date.now(), capTimer, holdTimer };
    this.port.holdOpen();
    // The ringback still queued in the browser goes; from here the browser plays the person, and the server owns barge-in.
    this.port.clearAudio();
    this.port.status({ state: "transfer_connected", bargeInOwner: "server" });
    this.row("human_transfer_answered", { who: leg.who }, true, undefined, ringMs);
    // The agent's part is over: its session stops, and the socket stays open for the bridge (socket-route.ts).
    this.port.stopAgent("transferred_to_person");
  }

  private endBridge(by: string): void {
    const bridge = this.bridge;
    if (this.state !== "bridged" || !bridge) return;
    this.state = "ended";
    this.bridge = undefined;
    clearTimeout(bridge.capTimer);
    clearInterval(bridge.holdTimer);
    bridge.leg.done = true;
    bridge.leg.stream.close();
    if (bridge.leg.sid) void this.deps?.twilio.hangUp(bridge.leg.sid).catch(() => undefined);
    this.row("human_transfer_bridge_ended", { who: bridge.leg.who, endedBy: by }, true, undefined, Date.now() - bridge.began);
    // The call's outcome, once the bridge is over: a disposition with no voice session open finishes the play call.
    void runWithTrace(this.port.trace, async () => void emitTrace("disposition", { value: "handed_off", nodeId: "human_transfer" }));
    this.port.finish(by === "caller_hung_up" ? "caller_hangup" : "transfer_ended");
    if (lines.get(this.port.callId) === this) lines.delete(this.port.callId);
  }

  /** The hold: once the agent's handoff line is over (quiet, or at the cap), its audio is held and ringback plays after it. */
  private startRingback(deps: HumanTransferDeps): void {
    this.stopRingback();
    this.holding = false;
    this.holdCheckFrom = this.lastLoudAgentAt = Date.now();
    let at = 0;
    this.ringbackTimer = setInterval(() => {
      const now = Date.now();
      if (!this.holding) {
        if (now - this.lastLoudAgentAt < deps.handoffQuietMs && now - this.holdCheckFrom < deps.handoffCapMs) return;
        this.holding = true;
      }
      // After what the browser still has queued (the end of the agent's line).
      if (this.port.playbackEndsAt() - now > RINGBACK_AHEAD_MS) return;
      this.port.sendAudio(RINGBACK.subarray(at, at + RINGBACK_CHUNK).toString("base64"));
      at = (at + RINGBACK_CHUNK) % RINGBACK.length;
    }, 100);
    this.ringbackTimer.unref();
  }

  private stopRingback(): void {
    clearInterval(this.ringbackTimer);
    this.ringbackTimer = undefined;
    this.holding = false;
  }
}
