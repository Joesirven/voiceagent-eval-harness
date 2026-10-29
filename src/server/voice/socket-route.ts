/**
 * Browser side of live voice: a websocket on the local dev server at
 * /api/voice/<callId>/socket. The browser sends microphone audio (binary
 * frames of mu-law at 8 kilohertz) or typed lines; the server relays to Azure
 * and sends audio back. The browser never reaches Azure itself, so every line
 * and event passes through the trace bus.
 *
 * Messages to the browser (JSON): audio {data}, clear, status {state, reason?,
 * and on ready: sessionMode, orchestration, bargeInOwner "server" or "browser"},
 * error {code, title, detail, fix, severity, canContinue, ...} (see voice-errors.ts). From the browser (JSON text frames): text {text}, barge_in,
 * hangup.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { getActiveLeadStore } from "../../store/active-store.js";
import { buildLeadContextPacket } from "../../memory/context.js";
import { runWithTrace, traceBus, type TraceContext } from "../../trace/index.js";
import { isLoopbackRequest } from "./loopback.js";
import { openVoiceSession, voiceErrorPathFor, VoiceStartError } from "./manager.js";
import { openTransferLine, type TransferLine } from "./human-transfer.js";
import { reportVoiceError, voiceErrorFrame } from "./voice-errors.js";
import type { HarnessLiveSession } from "../../modules/open-live-session.js";
import type { CallOpening } from "../../compliance/disclosures.js";

/** What the dev server knows about a call the page started through the gated harness. */
export interface VoiceCallHandle {
  call: { callId: string; status?: string };
  leadId: string;
  direction: "inbound" | "outbound";
  /** Runs one decision step for a caller line; resolves with the decision module's reply text when there is one. */
  say(text: string): Promise<string | undefined>;
  /** The agent's first line of the call (the disclosure), as the dialog already emitted it. */
  disclosure(): string | undefined;
  /** The opening the harness fixed for the call (disclosure parts and the confirmation question), from its expected_opening row. */
  opening?: () => CallOpening | undefined;
  setupId?: string;
  /** Frees the play slot when the browser websocket closes. */
  onDisconnect?: () => void;
  /** Marks the disclosure (the opening line) as not said, when the voice session reports it cut off or missing. */
  markDisclosureNotSaid?: () => void;
  /** Stops the call's dialog once the voice session has ended; later caller lines do nothing. */
  stopDialog?: (reason: string) => void;
  /** Keeps the play call from ending as idle while a transfer to a person is bridged (human-transfer.ts). */
  holdOpen?: () => void;
}

export type VoiceCallLookup = (callId: string) => VoiceCallHandle | undefined;

/**
 * After the decision tree ends the call, the session stays open until the
 * closing line (a goodbye, or a transfer offer) has been recorded plus this
 * playback tail, so the browser finishes playing it.
 */
export const CLOSING_LINE_TAIL_MS = 1500;
/** The longest a call stays open after its disposition, closing line or not. */
export const CLOSING_LINE_CAP_MS = 8000;

/** The browser plays every audio chunk as mu-law at 8000 samples a second: one byte is one sample. */
const BROWSER_AUDIO_BYTES_PER_SECOND = 8000;
/** Audio still to play beyond this when the tail ends keeps the session open until it has played. */
const PLAYBACK_SLACK_MS = 250;

/** How long a microphone call may go without any caller audio before the page is told. */
export const MICROPHONE_WAIT_MS = 8000;

const sendJson = (ws: WebSocket, message: Record<string, unknown>): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};

export function attachVoiceSockets(
  server: Server,
  lookup: VoiceCallLookup,
  options: {
    guardAgentLine?: (line: string) => string | null | Promise<string | null>;
    microphoneWaitMs?: number;
    /** Tests shorten the closing-line wait. */
    closingLineTailMs?: number;
    closingLineCapMs?: number;
  } = {},
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = (req.url ?? "").match(/^\/api\/voice\/([\w-]+)\/socket(?:\?[\w=&]*)?$/);
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!match) return refuse("404 Not Found");
    if (!isLoopbackRequest(req)) return refuse("403 Forbidden");
    // Browsers always send Origin on a websocket; a missing one is not a browser page of ours.
    if (!req.headers.origin) return refuse("403 Forbidden");
    const handle = lookup(match[1]!);
    if (!handle) return refuse("404 Not Found");
    const url = new URL(req.url ?? "", "http://x");
    const gap = Number(url.searchParams.get("gap"));
    const turnGapMs = Number.isFinite(gap) && gap >= 300 && gap <= 3000 ? gap : undefined;
    const input = url.searchParams.get("input") === "text" ? "text" : "audio";
    const closingLine = { tailMs: options.closingLineTailMs ?? CLOSING_LINE_TAIL_MS, capMs: options.closingLineCapMs ?? CLOSING_LINE_CAP_MS };
    wss.handleUpgrade(req, socket, head, (ws) => void serve(ws, handle, options.guardAgentLine, turnGapMs, input, options.microphoneWaitMs ?? MICROPHONE_WAIT_MS, closingLine));
  });
}

async function serve(
  ws: WebSocket,
  handle: VoiceCallHandle,
  guardAgentLine: ((line: string) => string | null | Promise<string | null>) | undefined,
  turnGapMs: number | undefined,
  input: "audio" | "text",
  microphoneWaitMs: number,
  closingLine: { tailMs: number; capMs: number },
): Promise<void> {
  // Register these first: the browser may leave while the session is still starting.
  let closed = false;
  let live: HarnessLiveSession | undefined;
  // Reaches a session that is still starting, which `live` cannot.
  const left = new AbortController();
  // The wait for the closing line after a disposition: the cap, then the tail once the line is recorded.
  let closingCapTimer: NodeJS.Timeout | undefined;
  let closingTailTimer: NodeJS.Timeout | undefined;
  // When the audio already sent to the browser finishes playing. Speech synthesis on the Deepgram path
  // runs faster than speech, so a line can be reported while seconds of it are still queued in the
  // browser, which drops its queue when told the call ended.
  let playbackEndsAt = 0;
  const stopClosingWait = () => {
    clearTimeout(closingCapTimer);
    clearTimeout(closingTailTimer);
  };
  // A transfer to a person (human-transfer.ts): while it rings or is bridged it holds the call's audio both ways.
  let transfer: TransferLine | undefined;
  ws.on("error", () => ws.close());
  ws.on("close", () => {
    closed = true;
    stopClosingWait();
    left.abort();
    transfer?.close("caller_hung_up");
    live?.stop("caller_hangup");
    handle.onDisconnect?.();
  });
  const disclosure = handle.disclosure();
  if (!disclosure) {
    sendJson(ws, voiceErrorFrame(reportVoiceError("disclosure_unavailable", { callId: handle.call.callId })));
    ws.close();
    return;
  }
  const lead = await getActiveLeadStore().getLead(handle.leadId);
  if (!lead) {
    sendJson(ws, voiceErrorFrame(reportVoiceError("lead_not_found", { callId: handle.call.callId })));
    ws.close();
    return;
  }
  const trace: TraceContext = {
    leadId: lead.id,
    leadLabel: lead.name.trim().split(/\s+/)[0],
    recordId: handle.call.callId,
    channel: "call",
    direction: handle.direction,
    callId: handle.call.callId,
  };
  let session: HarnessLiveSession | undefined;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  const toBrowser = (data: string) => {
    const now = Date.now();
    playbackEndsAt = Math.max(playbackEndsAt, now) + (Buffer.byteLength(data, "base64") / BROWSER_AUDIO_BYTES_PER_SECOND) * 1000;
    sendJson(ws, { type: "audio", data });
  };
  const clearBrowser = () => {
    playbackEndsAt = Date.now();
    sendJson(ws, { type: "clear" });
  };
  transfer = openTransferLine({
    callId: handle.call.callId,
    trace,
    sendAudio: toBrowser,
    clearAudio: clearBrowser,
    status: (fields) => sendJson(ws, { type: "status", ...fields }),
    playbackEndsAt: () => playbackEndsAt,
    stopAgent: (reason) => live?.stop(reason),
    finish: (reason) => {
      sendJson(ws, { type: "status", state: "ended", reason });
      ws.close();
    },
    holdOpen: () => handle.holdOpen?.(),
  });
  if (closed) transfer.close("caller_hung_up");
  try {
    session = await openVoiceSession({
      call: handle.call,
      input,
      trace,
      leadFirstName: trace.leadLabel ?? lead.name,
      direction: handle.direction,
      disclosure,
      opening: handle.opening?.(),
      turnGapMs,
      signal: left.signal,
      packet: buildLeadContextPacket(lead),
      setupId: handle.setupId,
      guardAgentLine,
      dialogOwnsTranscript: false,
      onCallerFinal: (text) => handle.say(text),
      // While a transfer holds the caller (after the agent's handoff line) or is bridged, the caller hears ringback or the person.
      onAudio: (data) => {
        if (transfer?.passesAgentAudio(data) !== false) toBrowser(data);
      },
      onClearPlayback: () => {
        if (transfer?.passesAgentAudio() !== false) clearBrowser();
      },
      onProviderError: (_code, record) => sendJson(ws, voiceErrorFrame(record)),
      onEnd: ({ reason }) => {
        // A start that fails ends the session before this returns; the catch below sends the error first, then closes.
        if (!started) return;
        stopClosingWait();
        unsubscribe?.();
        void runWithTrace(trace, async () => handle.stopDialog?.(reason));
        // A person took the call: the agent's session is over, and the transfer closes the socket when the bridge ends.
        if (transfer?.ownsCall()) return;
        sendJson(ws, { type: "status", state: "ended", reason });
        ws.close();
      },
    });
  } catch (err) {
    // openVoiceSession has already reported the failure; only an error from outside it is reported here.
    const record = err instanceof VoiceStartError ? err.record : reportVoiceError("voice_start_failed", { trace, path: voiceErrorPathFor(input) });
    sendJson(ws, voiceErrorFrame(record));
    ws.close();
    return;
  }
  started = true;
  live = session;
  if (closed) return live.stop("caller_hangup");
  const sessionMode = (session as { sessionMode?: string }).sessionMode ?? (input === "text" ? "text_stand_in" : "live_audio");
  // Who stops agent playback when the caller talks over it: Azure Voice Live's own turn detection (the browser's loudness check stays off), or the browser.
  const bargeInOwner = sessionMode.startsWith("azure_voice_live") ? "server" : "browser";
  sendJson(ws, { type: "status", state: "ready", sessionMode, orchestration: sessionMode.startsWith("deepgram") ? "deepgram" : sessionMode.startsWith("pipecat") ? "pipecat" : "direct", bargeInOwner });
  // The decision tree reaches an end node during the decision step for the caller's line, before the
  // closing line is spoken. Close once the voice model's next line is recorded, the tail has passed
  // and the browser has played the audio it was sent, or at the cap, whichever comes first. The dev
  // server leaves an open session to this; the socket closing then finishes the play call.
  let dispositionSeen = false;
  const endCall = () => {
    // A transfer that is ringing keeps the call: the close waits for it (once bridged, the session has already ended).
    if (transfer?.ownsAudio()) {
      closingCapTimer = setTimeout(endCall, 1000);
      closingCapTimer.unref();
      return;
    }
    live?.stop("play_call_ended");
  };
  // Waits once, for the audio sent up to the moment the line was recorded: the Azure path keeps
  // streaming silence after a line, which must not hold the call open until the cap.
  const endAfterPlayback = (lineAudioEndsAt: number) => {
    const stillToPlayMs = lineAudioEndsAt - Date.now();
    if (stillToPlayMs <= PLAYBACK_SLACK_MS) return endCall();
    closingTailTimer = setTimeout(endCall, stillToPlayMs);
    closingTailTimer.unref();
  };
  unsubscribe = traceBus.subscribe((event) => {
    if (event.callId !== handle.call.callId) return;
    // A disclosure the voice session reports cut off or not spoken: the dialog's record must say so too.
    if (event.type === "tool_call" && event.data.tool === "disclosure_check" && event.data.success === false) {
      void runWithTrace(trace, async () => handle.markDisclosureNotSaid?.());
      return;
    }
    if (event.type === "disposition" && !dispositionSeen) {
      dispositionSeen = true;
      closingCapTimer = setTimeout(endCall, closingLine.capMs);
      closingCapTimer.unref();
      return;
    }
    const agentLine = (event.type === "transcript_final" || event.type === "turn") && event.data.role === "agent" && event.data.source === "voice_module";
    if (dispositionSeen && agentLine && !closingTailTimer) {
      // The line's own audio has been sent by the time it is recorded, on both paths.
      const lineAudioEndsAt = playbackEndsAt;
      closingTailTimer = setTimeout(() => endAfterPlayback(lineAudioEndsAt), closingLine.tailMs);
      closingTailTimer.unref();
    }
  });
  let callerAudioFrames = 0;
  // A microphone call with no caller audio at all is a warning: the call itself keeps going.
  let micTimer: NodeJS.Timeout | undefined;
  if (input === "audio") {
    micTimer = setTimeout(() => {
      if (callerAudioFrames === 0 && !closed) sendJson(ws, voiceErrorFrame(reportVoiceError("microphone_audio_missing", { trace, path: voiceErrorPathFor(input) })));
    }, microphoneWaitMs);
    micTimer.unref();
  }
  ws.on("close", () => clearTimeout(micTimer));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      callerAudioFrames += 1;
      if (callerAudioFrames === 1 || callerAudioFrames % 50 === 0) {
        console.log(
          `voice caller audio call=${handle.call.callId} browser_frames=${callerAudioFrames} orchestration=${sessionMode === "deepgram_pipecat" ? "pipecat_deepgram" : sessionMode.startsWith("pipecat") ? "pipecat" : "direct"}`,
        );
      }
      if (transfer?.takeCallerAudio(data as Buffer)) return;
      return live?.sendAudio((data as Buffer).toString("base64"));
    }
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; text?: unknown };
      if (msg.type === "hangup") return transfer?.ownsCall() ? transfer.close("caller_hung_up") : live?.stop("caller_hangup");
      // On hold or bridged, nothing the caller does reaches the agent.
      if (transfer?.ownsAudio()) return;
      if (msg.type === "barge_in") live?.bargeIn();
      else if (msg.type === "text" && typeof msg.text === "string" && msg.text.trim() && msg.text.length <= 2000) {
        void live?.sendCallerText(msg.text.trim()).catch(() => sendJson(ws, voiceErrorFrame(reportVoiceError("text_not_sent", { trace, path: voiceErrorPathFor(input) }))));
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on("close", () => unsubscribe?.());
}
