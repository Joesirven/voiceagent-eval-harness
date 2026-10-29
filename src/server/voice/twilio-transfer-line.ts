/**
 * The telephone half of a transfer to a person from a Talk call (src/server/voice/human-transfer.ts): Twilio calls to
 * the two allowlisted cells, and the small listener that takes each answered call's media stream back.
 *
 * - Twilio account settings come from environment variables. No value is logged, traced or returned.
 * - Only the configured synthetic test numbers are dialled: placeCall refuses any other number, whatever its
 *   caller passes.
 * - Caller ID comes from VOICE_HARNESS_TWILIO_CALLER_ID and must use the synthetic test-number range.
 * - Nothing records. Audio is only relayed, never written anywhere.
 * - The listener is its own server on 127.0.0.1 (never the dev server's port, which holds lead data). Twilio reaches it
 *   through a public secure websocket (Twilio's firewall guidance names port 443): HARNESS_TRANSFER_PUBLIC_URL in the
 *   environment, else an ngrok tunnel to the listener's port (read from ngrok's local API), else
 *   VOICE_HARNESS_TRANSFER_PUBLIC_URL. It answers only a websocket upgrade on a live leg's one-time path.
 * - A dry run (VOICE_HARNESS_TRANSFER_DIALING=dry_run,
 *   read at each call) builds the exact call-placing request and logs it with the numbers masked, sends nothing, and
 *   reports the call ringing for its ring time, then unanswered; a stream on its path is served as a real one would be.
 * - Twilio signs its requests with the account's auth token, which the secrets folder does not hold (only the API
 *   key), so the signature is not checked. A stream is accepted instead on its 256-bit one-time path, then only when
 *   its start message names this account and the call identifier Twilio returned when that leg was placed.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
/** The caller ID is selected by its configured last four digits. */
/** The listener's port on 127.0.0.1 (HARNESS_TRANSFER_PORT overrides it); the ngrok tunnel points here. */
export const DEFAULT_TRANSFER_PORT = 4331;
/** ngrok's local API, which names the public address of each tunnel. */
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const STREAM_PATH = /^\/twilio-transfer\/stream\/([0-9a-f]{64})\/?$/;
const CALL_SID = /^CA[0-9a-f]{32}$/i;
/** What the person hears on picking up, before anything from the caller. Fixed words: nothing a model wrote. */
export const SCREEN_PROMPT = "Voice agent test transfer. A caller is asking for a licensed producer. After this message, press 1 to take the call.";

interface TwilioKeys {
  accountSid: string;
  keySid: string;
  keySecret: string;
}

function loadKeys(): TwilioKeys | undefined {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  return accountSid && keySid && keySecret ? { accountSid, keySid, keySecret } : undefined;
}

/** A Twilio failure as a fixed code only (twilio_<Twilio error code or HTTP status>), never Twilio's message, which can echo a number. */
export class TwilioTransferError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TwilioTransferError";
  }
}

export interface TwilioTransferClient {
  /** The account the streams must name; undefined when the keys are not configured. */
  accountSid(): string | undefined;
  /** The caller ID in E.164 form. */
  callerId(): Promise<string>;
  /** Places one call that runs `twiml` once answered; rings for `ringSeconds`. */
  placeCall(p: { to: string; from: string; twiml: string; ringSeconds: number }): Promise<{ sid: string }>;
  /** Ends the call in any state (ringing or in progress). */
  hangUp(sid: string): Promise<void>;
  /** The call's status now: queued, ringing, in-progress, completed, busy, failed, no-answer or canceled. */
  callStatus(sid: string): Promise<string>;
}

/** Whether calls are only built and logged, not placed: HARNESS_TRANSFER_DIALING=dry_run (environment, else the file). */
export function dialingIsDryRun(env: Record<string, string | undefined> = process.env): boolean {
  return (env.VOICE_HARNESS_TRANSFER_DIALING ?? "").trim().toLowerCase() === "dry_run";
}

/** A phone number for a log line: the country and area code, then the last four. */
export const maskNumber = (n: string): string => (n.length > 9 ? `${n.slice(0, 5)}…${n.slice(-4)}` : "…");

/** The two allowlisted cells, as configured now. */
export function allowlistedCells(): string[] {
  return [process.env.VOICE_HARNESS_TRANSFER_PRIMARY_PHONE, process.env.VOICE_HARNESS_TRANSFER_SECONDARY_PHONE].filter(
    (number): number is string => /^\+155501\d{2}$/.test(number ?? ""),
  );
}

/** The Twilio REST client, with the API key. Refuses any number but the two cells, and refuses outright under vitest. */
export function realTwilioClient(): TwilioTransferClient {
  let callerId: string | undefined;
  /** Dry-run calls: when each stops ringing unanswered. */
  const dryRuns = new Map<string, number>();
  const request = async (method: "GET" | "POST", path: string, form?: Record<string, string>, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
    // The secrets files exist on this Mac: a test that reaches this client must never ring a phone.
    if (process.env.VITEST) throw new TwilioTransferError("tests_never_dial");
    const keys = loadKeys();
    if (!keys) throw new TwilioTransferError("twilio_keys_missing");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${keys.accountSid}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${keys.keySid}:${keys.keySecret}`).toString("base64")}`,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new TwilioTransferError(`twilio_${typeof body.code === "number" ? body.code : res.status}`);
    return body;
  };
  return {
    accountSid: () => loadKeys()?.accountSid,
    async callerId() {
      if (callerId) return callerId;
      const configured = process.env.VOICE_HARNESS_TWILIO_CALLER_ID;
      if (!/^\+155501\d{2}$/.test(configured ?? "")) throw new TwilioTransferError("caller_id_not_configured");
      return (callerId = configured!);
    },
    async placeCall({ to, from, twiml, ringSeconds }) {
      // The last gate before a phone rings: exactly one of the two cells, whatever the caller of this passed.
      if (!allowlistedCells().includes(to)) throw new TwilioTransferError("not_an_allowlisted_cell");
      // No Record parameter: Twilio records nothing unless asked (Record defaults to false).
      const form = { To: to, From: from, Twiml: twiml, Timeout: String(ringSeconds) };
      if (dialingIsDryRun()) {
        const sid = `CA${randomBytes(16).toString("hex")}`;
        dryRuns.set(sid, Date.now() + (ringSeconds + 5) * 1000);
        // The request exactly as it would go, numbers masked; the one-time stream path in it serves this dry run only.
        console.log(`transfer dry_run request POST /2010-04-01/Accounts/(account)/Calls.json To=${maskNumber(form.To)} From=${maskNumber(form.From)} Timeout=${form.Timeout} sid=${sid} Twiml=${form.Twiml}`);
        return { sid };
      }
      // A long wait: a call Twilio placed must come back with its identifier, so the ring can hang it up.
      const body = await request("POST", "/Calls.json", form, 30_000);
      if (typeof body.sid !== "string" || !CALL_SID.test(body.sid)) throw new TwilioTransferError("twilio_no_call_sid");
      return { sid: body.sid };
    },
    async hangUp(sid) {
      if (dryRuns.delete(sid) || !CALL_SID.test(sid)) return;
      // completed ends a call in any state; canceled would leave one already answered.
      await request("POST", `/Calls/${sid}.json`, { Status: "completed" });
    },
    async callStatus(sid) {
      const dryUntil = dryRuns.get(sid);
      if (dryUntil !== undefined) return Date.now() < dryUntil ? "ringing" : "no-answer";
      if (!CALL_SID.test(sid)) throw new TwilioTransferError("twilio_no_call_sid");
      const body = await request("GET", `/Calls/${sid}.json`);
      return typeof body.status === "string" ? body.status : "unknown";
    },
  };
}

const xml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The TwiML a cell runs on answering: the fixed prompt, then the stream back to the listener on the leg's one-time path. */
export function screeningTwiml(publicBase: string, token: string): string {
  const url = `${publicBase}/twilio-transfer/stream/${token}`;
  return `<Response><Say>${xml(SCREEN_PROMPT)}</Say><Connect><Stream url="${xml(url)}"><Parameter name="leg" value="${xml(token)}"/></Stream></Connect></Response>`;
}

const WSS_BASE = /^wss:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * The public secure websocket base (no path) Twilio reaches the listener on.
 */
export async function publicStreamBase(
  port: number,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const fixed = env.VOICE_HARNESS_TRANSFER_PUBLIC_URL?.trim();
  if (fixed) return WSS_BASE.test(fixed) ? fixed : undefined;
  try {
    const res = await fetchImpl(NGROK_API, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { tunnels?: Array<{ public_url?: unknown; config?: { addr?: unknown } }> };
    const tunnel = (body.tunnels ?? []).find(
      (t) => typeof t.public_url === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(t.public_url) && new RegExp(`:${port}/?$`).test(String(t.config?.addr ?? "")),
    );
    if (tunnel) return String(tunnel.public_url).replace(/^https:/i, "wss:");
  } catch {
    /* no ngrok agent running */
  }
  return undefined;
}

/** What one leg is told about its stream. */
export interface LegHandlers {
  /** The call identifier Twilio returned when the leg was placed; a start naming any other call is refused. */
  callSid: Promise<string>;
  /** The stream is open and checked: the person picked up and the prompt has played. */
  onStart(): void;
  /** One frame of the person's audio, base64 mu-law at 8 kilohertz. */
  onMedia(payload: string): void;
  onDigit(digit: string): void;
  /** The stream closed (the person hung up, Twilio stopped it, or a check failed). Called at most once. */
  onEnd(): void;
}

/** The harness's side of one leg's stream. */
export interface LegStream {
  /** Sends caller audio (base64 mu-law at 8 kilohertz) to the person; dropped until the stream is open and checked. */
  send(payload: string): void;
  /** Closes the stream, if open, and retires the leg's path. */
  close(): void;
}

interface LegEntry {
  handlers: LegHandlers;
  taken: boolean;
  ws?: WebSocket;
  streamSid?: string;
}

/** The listener Twilio's streams connect to. One per process; legs register their one-time paths with expect(). */
export class TransferListener {
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private readonly legs = new Map<string, LegEntry>();

  constructor(private readonly accountSid: () => string | undefined) {}

  /** Listens on 127.0.0.1:port (0 picks a free port) once; resolves with the bound port. */
  listen(port: number): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      const server = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      server.on("upgrade", (req, socket, head) => {
        const token = (req.url ?? "").match(STREAM_PATH)?.[1];
        const leg = token ? this.legs.get(token) : undefined;
        if (!token || !leg || leg.taken) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        // One stream per path, ever: a second connection on the same path is refused even if the first failed.
        leg.taken = true;
        wss.handleUpgrade(req, socket, head, (ws) => this.serve(ws, token, leg));
      });
      server.once("error", (err) => {
        this.listening = undefined;
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve((server.address() as { port: number }).port);
      });
    });
    return this.listening;
  }

  /** Registers a leg's one-time path token (64 hexadecimal characters). */
  expect(token: string, handlers: LegHandlers): LegStream {
    const entry: LegEntry = { handlers, taken: false };
    this.legs.set(token, entry);
    return {
      send: (payload) => {
        const ws = entry.ws;
        if (ws && ws.readyState === ws.OPEN && entry.streamSid) ws.send(JSON.stringify({ event: "media", streamSid: entry.streamSid, media: { payload } }));
      },
      close: () => {
        this.legs.delete(token);
        entry.taken = true;
        entry.ws?.close();
      },
    };
  }

  private serve(ws: WebSocket, token: string, leg: LegEntry): void {
    leg.ws = ws;
    let ended = false;
    /** Settles true once the start message was checked and accepted; every later frame waits for it, in order. */
    let accepted: Promise<boolean> | undefined;
    const end = () => {
      if (ended) return;
      ended = true;
      this.legs.delete(token);
      leg.handlers.onEnd();
    };
    ws.on("close", end);
    ws.on("error", () => ws.close());
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let m: Record<string, any>;
      try {
        m = JSON.parse(raw.toString()) as Record<string, any>;
      } catch {
        return;
      }
      // Only objects: "null" or a bare number must not throw in this handler (an uncaught throw would end the process).
      if (!m || typeof m !== "object") return;
      if (m.event === "start") {
        if (accepted) return;
        const start = (m.start ?? {}) as Record<string, any>;
        accepted = leg.handlers.callSid.then(
          (sid) => {
            const ok =
              !ended &&
              typeof m.streamSid === "string" &&
              start.accountSid === this.accountSid() &&
              typeof start.callSid === "string" &&
              start.callSid === sid &&
              start.customParameters?.leg === token;
            if (!ok) {
              ws.close();
              return false;
            }
            leg.streamSid = m.streamSid as string;
            leg.handlers.onStart();
            return true;
          },
          () => (ws.close(), false),
        );
        return;
      }
      // Nothing from a stream counts before its start, and nothing after a start that failed its check.
      void accepted?.then((ok) => {
        if (!ok || ended) return;
        if (m.event === "media" && typeof m.media?.payload === "string") leg.handlers.onMedia(m.media.payload);
        else if (m.event === "dtmf" && typeof m.dtmf?.digit === "string") leg.handlers.onDigit(m.dtmf.digit);
        else if (m.event === "stop") ws.close();
      });
    });
  }

  /** Stops listening and closes every stream (tests). */
  async close(): Promise<void> {
    for (const leg of this.legs.values()) leg.ws?.close();
    this.legs.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}
