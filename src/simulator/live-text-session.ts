/**
 * A whole call where the agent under test speaks its own live words (Pat,
 * 2026-10-20: "live words always"), driven by typed lead lines, in the batch
 * runner's own process. It wires the call exactly as Talk does
 * (src/server/dev-server.ts sayOnPlayed and voiceHandle, src/server/voice/socket-route.ts):
 *
 *   - the interactive call starts with intended-line mode on, so the tree's
 *     lines are recorded as intended lines and the live model's words are the
 *     transcript;
 *   - the disclosure is the call's first intended line;
 *   - a live text session opens through `openVoiceSession` with the chosen
 *     prompt setup and the lead's context packet; each caller line goes to the
 *     tree first (`call.say`), and the intended lines the tree emitted steer the
 *     live model.
 *
 * Its parameters and result follow `runWholeCall` (src/judging/offline/whole-call.ts),
 * so `gradeWholeCall` and the persona grade take either.
 *
 * The 5-minute session cap stays: a call that reaches it ends "session_cap"
 * and is not retried. One session at a time: `openVoiceSession` holds a single
 * slot, so this waits for each session's end before it returns.
 *
 * The agent-line guard is not installed here, as on the live Talk path today
 * (gap G17): no `guardAgentLine` is passed.
 */

import { isSpeech } from "../modules/azure-live-session.js";
import { startInteractiveCall } from "../decision/interactive.js";
import { setIntendedLineMode } from "../decision/engine.js";
import type { CallHarness } from "../harness/call-harness.js";
import { buildLeadContextPacket } from "../memory/context.js";
import { loadAzureCatalog } from "../modules/azure-catalog.js";
import { getModuleRegistry } from "../modules/registry.js";
import type { HarnessLiveSession } from "../modules/open-live-session.js";
import type { CallDirection } from "../provider/interface.js";
import { openVoiceSession, selectTalkOrchestrator, selectVoicePath, selectedTalkOrchestrator, selectedVoicePath } from "../server/voice/manager.js";
import { getLead } from "../store/lead-store.js";
import { errorCode, recordStore, traceBus, type HarnessRecord, type TraceContext, type TraceEvent, type TranscriptLine } from "../trace/index.js";
import type { SimulatedLead } from "../judging/offline/types.js";

export type LiveWholeCallEnd =
  | "agent_ended"
  | "lead_hung_up"
  | "turn_limit"
  /** The live session reached its 5-minute cap. */
  | "session_cap"
  /** The agent said nothing within the reply timeout. */
  | "reply_timeout"
  /** The live session closed or failed on its own. */
  | "session_closed"
  /** The batch was cancelled during this call. */
  | "cancelled";

export interface LiveSetup {
  /** Only the direct Azure orchestrator has a text route today. */
  orchestratorId: "direct";
  voicePathId: "azure_gpt_live";
  /** A prompt setup id from the behaviour registry, never "default". */
  promptSetupId: string;
  /** Quiet time that closes an agent turn. Default 900 milliseconds. */
  turnGapMs?: number;
  /** The longest wait for the agent's reply to one line. Default 30 seconds. */
  replyTimeoutMs?: number;
  /** Time after the last agent line before the lead answers, to catch a reply in two parts. Default 1500 milliseconds. */
  settleMs?: number;
  /** Agent audio without speech for this long before the lead's line is sent. Default 600 milliseconds. */
  speechQuietMs?: number;
  /** Settle after the agent's opening (the disclosure), which may come in two parts. Default 4 seconds. */
  openingSettleMs?: number;
  /** Silence on one turn before the live model is reminded once, when the session supports it. Default 12 seconds. */
  remindAfterMs?: number;
  /** Time after a disposition for the agent's goodbye. Default 3 seconds. */
  goodbyeGraceMs?: number;
}

export interface RunLiveWholeCallParams {
  lead: SimulatedLead;
  harness: CallHarness;
  leadId: string;
  direction: CallDirection;
  setup: LiveSetup;
  /** The most lead lines before the call is hung up. Default 25. */
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface LiveWholeCallRun {
  status: "completed" | "blocked" | "failed";
  blockedReason?: string;
  /** A fixed code when the session could not start. */
  failureCode?: string;
  recordId: string;
  endedBy?: LiveWholeCallEnd;
  leadTurns: number;
  transcript: TranscriptLine[];
  events: TraceEvent[];
  record?: HarnessRecord;
  /** What actually ran, read back from the harness (not what was asked for). */
  ran: { orchestratorId: string; voicePathId: string; voiceModuleId: string; dialogueModel: string; promptSetupId: string };
  /** Milliseconds from each lead line to the agent's first reply line. */
  replyLatenciesMs: number[];
  /** How the live session reported its end. */
  sessionEndReason?: string;
  /** Turns on which the live model had to be reminded to answer. */
  reminders?: number;
  /** Agent lines that arrived after the settle, while the lead was answering; the lead never heard them. */
  lateFragments?: number;
  /** Per lead line, how long the lead waited for the agent's audio to fall silent. */
  silenceWaitsMs?: number[];
  /** Lead lines sent because the 15-second wait ran out, not because the agent fell silent. */
  silenceWaitLimitHits?: number;
  /** Agent audio chunks judged to carry speech; zero would mean the silence test never fires on real audio. */
  speechChunks?: number;
  /** The call was cut short by the transport or a cancel, not ended by the agent or the lead: not a verdict on the agent. */
  interrupted?: boolean;
}

const VOICE_MODULE_ID = "azure-gpt-live";

/** Endings that say nothing about the agent: the call was cut short. */
export const INTERRUPTED: ReadonlySet<LiveWholeCallEnd> = new Set(["cancelled", "reply_timeout", "session_closed", "session_cap"]);

function intendedText(e: TraceEvent): string | undefined {
  const text = (e.data.result as { text?: unknown } | null)?.text;
  return e.type === "tool_call" && e.data.tool === "intended_agent_line" && typeof text === "string" ? text : undefined;
}

/** Whether a base64 mu-law chunk carries speech: the one check, shared with the live session's steer guard. */
export { isSpeech, muLawMagnitude, SPEECH_FLOOR } from "../modules/azure-live-session.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export async function runLiveWholeCall(params: RunLiveWholeCallParams): Promise<LiveWholeCallRun> {
  const { lead, harness, leadId, direction, setup, maxTurns = 25, signal } = params;
  const replyTimeoutMs = setup.replyTimeoutMs ?? 30_000;
  const settleMs = setup.settleMs ?? 1500;
  const goodbyeGraceMs = setup.goodbyeGraceMs ?? 3000;
  const remindAfterMs = setup.remindAfterMs ?? 12_000;
  const openingSettleMs = setup.openingSettleMs ?? 4000;
  const speechQuietMs = setup.speechQuietMs ?? 600;
  let reminders = 0;
  if (setup.promptSetupId === "default") throw new Error("prompt_setup_must_be_named");

  selectTalkOrchestrator(setup.orchestratorId);
  selectVoicePath(setup.voicePathId);
  // This process never listed the deployments at startup; the open refuses a model it has not seen listed.
  await loadAzureCatalog();
  const voiceModule = getModuleRegistry().get(VOICE_MODULE_ID) as { getConfig(): { model?: string } };
  const ran = {
    orchestratorId: selectedTalkOrchestrator(),
    voicePathId: selectedVoicePath(),
    voiceModuleId: VOICE_MODULE_ID,
    dialogueModel: String(voiceModule.getConfig().model ?? ""),
    promptSetupId: setup.promptSetupId,
  };

  const buffered: TraceEvent[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = traceBus.subscribe((event) => {
    if (event.channel === "call" && event.leadId === leadId) {
      buffered.push(event);
      wake?.();
    }
  });
  const waitForEvent = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  let session: (HarnessLiveSession & { remind?: () => void }) | undefined;
  let sessionEnd: { reason: string } | undefined;
  // Pending only once a session is open: a start that fails before any session exists never calls onEnd.
  let sessionEnded: Promise<void> = Promise.resolve();
  let call: Awaited<ReturnType<typeof startInteractiveCall>> | undefined;
  let hungUp = false;
  const hangUp = async () => {
    if (!call || hungUp || call.status === "blocked") return;
    hungUp = true;
    // Waits for the harness run to finish, so the record holds the post-call score.
    await call.hangUp();
  };
  try {
    setIntendedLineMode(true);
    try {
      call = await startInteractiveCall({ leadId, direction, harness });
    } finally {
      setIntendedLineMode(false);
    }
    const live = call;
    const mine = () => buffered.filter((e) => e.callId === live.callId);
    const base = { recordId: live.callId, ran, replyLatenciesMs: [] as number[] };
    if (live.status === "blocked") {
      return { ...base, status: "blocked", blockedReason: live.blockedReason, leadTurns: 0, transcript: [], events: mine() };
    }

    const disclosure = mine().map(intendedText).find((t) => t !== undefined);
    // The in-memory store the batch seeds (the harness runs on mockLeadStore), never a CRM lead record.
    const record = getLead(leadId);
    if (!disclosure || !record) {
      await hangUp();
      return { ...base, status: "failed", failureCode: !disclosure ? "disclosure_unavailable" : "lead_not_found", leadTurns: 0, transcript: [], events: mine() };
    }
    const trace: TraceContext = { leadId, leadLabel: record.name.trim().split(/\s+/)[0], recordId: live.callId, channel: "call", direction, callId: live.callId };

    // The tree's intended lines for one caller line: what steers the live model, as sayOnPlayed does for Talk.
    const say = async (text: string): Promise<string | undefined> => {
      const from = buffered.length;
      await live.say(text);
      return buffered.slice(from).filter((e) => e.callId === live.callId).map(intendedText).filter(Boolean).join(" ").trim() || undefined;
    };

    /** When the agent's audio last carried speech: Azure keeps streaming silence between lines. */
    let lastSpeechAt = 0;
    let speechChunks = 0;
    let resolveEnd: () => void = () => undefined;
    const ended = new Promise<void>((r) => (resolveEnd = r));
    const ownerName = record.briefing?.ownerName;
    try {
      session = await openVoiceSession({
        call: live,
        input: "text",
        trace,
        // Only a real first name: a business-only or unknown record gives none rather than a surname or "Unknown".
        leadFirstName: ownerName ? ownerName.trim().split(/\s+/)[0]! : "",
        direction,
        disclosure,
        turnGapMs: setup.turnGapMs,
        signal,
        packet: buildLeadContextPacket(record),
        setupId: setup.promptSetupId,
        dialogOwnsTranscript: false,
        onCallerFinal: (text) => say(text),
        onAudio: (b64) => {
          if (isSpeech(b64)) {
            lastSpeechAt = Date.now();
            speechChunks += 1;
          }
        },
        onClearPlayback: () => undefined,
        onEnd: ({ reason }) => {
          sessionEnd = { reason };
          resolveEnd();
        },
      });
    } catch (err) {
      await hangUp();
      return { ...base, status: "failed", failureCode: errorCode(err), leadTurns: 0, transcript: [], events: mine() };
    }
    sessionEnded = ended;
    const open = session;

    // Measured 2026-10-20: in this process gpt-live-1 sent no output at all until caller audio streamed, so feed
    // mu-law silence (0xFF) in 100 millisecond frames for the whole session. The browser's Talk text mode sends no
    // audio (src/server/voice/voice-client.js streams only with the microphone), so why Talk text replies without
    // it is not yet known, and the silence stream may itself cause the occasional skipped turn.
    const silence = Buffer.alloc(800, 0xff).toString("base64");
    const feed = setInterval(() => {
      if (!sessionEnd) open.sendAudio(silence);
    }, 100);
    feed.unref();
    void sessionEnded.then(() => clearInterval(feed));

    const agentLines = () => mine().filter((e) => e.type === "transcript_final" && e.data.role === "agent" && e.data.source === "voice_module");
    const disposed = () => mine().some((e) => e.type === "disposition") || live.status === "ended";
    /** Trace order of the last agent line handed to the lead; later lines are new. */
    let heardSeq = 0;
    let lateFragments = 0;
    const words = (t: string) => new Set(t.toLowerCase().match(/[a-z']{4,}/g) ?? []);
    /** Share of the disclosure's longer words the agent has spoken so far (0 to 1). */
    const disclosureCovered = () => {
      const want = words(disclosure);
      if (!want.size) return 1;
      const got = words(agentLines().map((e) => String(e.data.text)).join(" "));
      let hit = 0;
      for (const w of want) if (got.has(w)) hit += 1;
      return hit / want.size;
    };
    /**
     * Waits for agent lines after trace position `fromSeq`, then until none has arrived for `settle`
     * milliseconds (a deadline from the last line). `done` can end the wait early. Returns the new agent text,
     * or null on a timeout or a session end.
     */
    const awaitReply = async (fromSeq: () => number, sentAt: number, latencies: number[] | undefined, settle = settleMs, done?: () => boolean): Promise<string | null> => {
      const deadline = Date.now() + replyTimeoutMs;
      const remindAt = Date.now() + remindAfterMs;
      let reminded = false;
      const fresh = () => agentLines().filter((e) => e.seq > Math.max(heardSeq, fromSeq()));
      while (fresh().length === 0) {
        if (sessionEnd || signal?.aborted || Date.now() >= deadline) return null;
        // gpt-live-1 sometimes lets a steer pass without speaking; one reminder per turn, when the session offers it.
        if (!reminded && Date.now() >= remindAt && open.remind) {
          reminded = true;
          reminders += 1;
          open.remind();
        }
        await waitForEvent(Math.min(250, Math.max(0, deadline - Date.now())));
      }
      latencies?.push(Date.now() - sentAt);
      let count = fresh().length;
      let quietUntil = Date.now() + settle;
      while (Date.now() < quietUntil && !sessionEnd && !done?.()) {
        await waitForEvent(Math.max(1, Math.min(250, quietUntil - Date.now())));
        if (fresh().length !== count) {
          count = fresh().length;
          quietUntil = Date.now() + settle;
        }
      }
      const lines = fresh();
      heardSeq = lines.at(-1)!.seq;
      return lines.map((e) => String(e.data.text)).join(" ");
    };

    const latencies = base.replyLatenciesMs;
    const silenceWaitsMs: number[] = [];
    let silenceWaitLimitHits = 0;
    let endedBy: LiveWholeCallEnd = "turn_limit";
    let leadTurns = 0;
    // The opening is the disclosure: gpt-live-1 may say it in parts seconds apart, so wait until its words are
    // spoken (or the opening settle passes with nothing new) before the lead speaks.
    let agentLine = await awaitReply(() => 0, Date.now(), undefined, openingSettleMs, () => disclosureCovered() >= 0.9);
    for (;;) {
      if (signal?.aborted) {
        endedBy = "cancelled";
        break;
      }
      // An ending the tree filed wins over a silent or closed session: the agent ended the call.
      if (disposed()) {
        if (agentLine !== null) await sleep(goodbyeGraceMs);
        endedBy = "agent_ended";
        break;
      }
      if (agentLine === null) {
        endedBy = sessionEnd?.reason === "session_cap" ? "session_cap" : sessionEnd ? "session_closed" : "reply_timeout";
        break;
      }
      if (leadTurns >= maxTurns) break;
      const said = await lead.next(agentLine);
      if (said === null) {
        endedBy = "lead_hung_up";
        break;
      }
      // A caller speaks once the agent has stopped talking: wait for its audio to fall silent (at most 15 seconds).
      const waitFrom = Date.now();
      const quietBy = waitFrom + 15_000;
      while (Date.now() - lastSpeechAt < speechQuietMs && Date.now() < quietBy && !sessionEnd) await sleep(100);
      silenceWaitsMs.push(Date.now() - waitFrom);
      if (Date.now() >= quietBy) silenceWaitLimitHits += 1;
      const sentAt = Date.now();
      const sentSeq = buffered.at(-1)?.seq ?? 0;
      // The reply to this line is what the agent says after the tree's steer for it; anything the agent says
      // before that (the end of its previous turn) the lead never heard: counted, not passed on.
      const steerSeq = () => mine().find((e) => e.seq > sentSeq && e.type === "tool_call" && e.data.tool === "steer_voice_model")?.seq ?? Number.MAX_SAFE_INTEGER;
      try {
        await open.sendCallerText(said);
      } catch (err) {
        endedBy = errorCode(err) === "call_ended" || disposed() ? "agent_ended" : sessionEnd?.reason === "session_cap" ? "session_cap" : "session_closed";
        break;
      }
      leadTurns += 1;
      const before = agentLines().filter((e) => e.seq > heardSeq && e.seq < steerSeq()).length;
      // With no steer (a call the tree ended inside say), the reply is anything after the send.
      const replyFrom = () => (steerSeq() === Number.MAX_SAFE_INTEGER && disposed() ? sentSeq : steerSeq());
      agentLine = await awaitReply(replyFrom, sentAt, latencies);
      lateFragments += before;
    }

    // Decided before the hang-up: after it the call always reads as ended.
    const interrupted = INTERRUPTED.has(endedBy) && !mine().some((e) => e.type === "disposition");
    open.stop("caller_hangup");
    await sessionEnded;
    await hangUp();
    const stored = recordStore.read(live.callId);
    return {
      ...base,
      status: "completed",
      endedBy,
      interrupted,
      leadTurns,
      transcript: stored?.transcript ?? [],
      events: mine(),
      record: stored,
      sessionEndReason: sessionEnd?.reason,
      reminders,
      lateFragments,
      silenceWaitsMs,
      silenceWaitLimitHits,
      speechChunks,
    };
  } finally {
    setIntendedLineMode(false);
    if (session && !sessionEnd) session.stop("server_stop");
    await sessionEnded;
    // A lead that threw mid-call (a model error, the ask cap) must not leave the harness call open.
    await hangUp().catch(() => undefined);
    unsubscribe();
  }
}
