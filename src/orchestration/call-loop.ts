import { OUTBOUND_AI_TRUTHFUL_ANSWER } from "../compliance/disclosures.js";
import type { LeadContextPacket, InCallState } from "../memory/context.js";
import { createInCallState as createState } from "../memory/context.js";
import {
  toolBookProducer,
  toolReadLeadContext,
  toolSaveMessage,
} from "../tools/agent-tools.js";
import { detectStopRequest, STOP_REPLY } from "../compliance/stop.js";
import { containsAsWords } from "../memory/evidence.js";
import type { LeadStore } from "../store/lead-store-seam.js";
import type { TranscriptEvent, TranscriptTurn } from "../provider/interface.js";

/** First agent line on scripted outbound harness calls; matches `runOutboundCallLoop`. */
export const OUTBOUND_SCRIPTED_OPENING = "Thanks for taking our callback.";

const SYSTEM_TURN_INDEX = -2;

/** One system turn so transcripts and replay carry the same agent instructions as live voice. */
export function systemInstructionTurn(systemInstruction: string): TranscriptTurn {
  return { role: "system", text: systemInstruction, turnIndex: SYSTEM_TURN_INDEX, spoken: true };
}

export function prependSystemInstruction(
  systemInstruction: string,
  script: TranscriptTurn[],
): TranscriptTurn[] {
  return [systemInstructionTurn(systemInstruction), ...script];
}

/**
 * Pipecat-style behavior: on barge-in, drop unspoken agent audio from context;
 * only spoken words remain in the in-call transcript.
 */
export function applyBargeIn(
  committed: TranscriptTurn[],
  agentTurnInFlight: TranscriptTurn | null,
  spokenPrefix: string,
): TranscriptTurn[] {
  const next = [...committed];
  if (agentTurnInFlight) {
    const spoken: TranscriptTurn = {
      ...agentTurnInFlight,
      text: spokenPrefix,
      spoken: true,
    };
    if (spoken.text.trim()) {
      next.push(spoken);
    }
  }
  return next;
}

export function mergeTranscriptFromEvents(
  script: TranscriptTurn[],
  bargeInAtTurn?: number,
  spokenAgentPrefix?: string,
): TranscriptTurn[] {
  const committed: TranscriptTurn[] = [];
  for (const turn of script) {
    if (turn.role === "system") {
      committed.push({ ...turn, spoken: true });
      continue;
    }
    if (
      bargeInAtTurn !== undefined &&
      turn.turnIndex === bargeInAtTurn &&
      turn.role === "agent"
    ) {
      return applyBargeIn(committed, turn, spokenAgentPrefix ?? "");
    }
    committed.push({ ...turn, spoken: turn.role === "caller" ? true : turn.spoken ?? true });
  }
  return committed;
}

export function eventsFromScript(
  script: TranscriptTurn[],
  bargeInAtTurn?: number,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const turn of script) {
    events.push({ type: "partial", turn: { ...turn } });
    events.push({ type: "final", turn: { ...turn, spoken: true } });
    if (bargeInAtTurn !== undefined && turn.turnIndex === bargeInAtTurn) {
      events.push({ type: "barge_in" });
      events.push({ type: "playback_cleared" });
    }
  }
  return events;
}

export function collectFinalTranscript(
  events: TranscriptEvent[],
  spokenAgentPrefixOnBarge?: string,
): TranscriptTurn[] {
  let committed: TranscriptTurn[] = [];
  let pendingAgent: TranscriptTurn | null = null;

  for (const ev of events) {
    if (ev.type === "final" && ev.turn) {
      if (ev.turn.role === "caller" || ev.turn.role === "system") {
        if (pendingAgent) {
          committed.push({ ...pendingAgent, spoken: true });
          pendingAgent = null;
        }
        committed.push({ ...ev.turn, spoken: true });
      } else if (ev.turn.role === "agent") {
        if (pendingAgent) {
          committed.push({ ...pendingAgent, spoken: true });
        }
        pendingAgent = ev.turn;
      }
    }
    if (ev.type === "barge_in" && pendingAgent) {
      committed = applyBargeIn(committed, pendingAgent, spokenAgentPrefixOnBarge ?? "");
      pendingAgent = null;
    }
  }
  if (pendingAgent) {
    committed.push({ ...pendingAgent, spoken: true });
  }
  return committed;
}

export interface BargeInOptions {
  interruptAtTurnIndex: number;
  spokenAgentPrefix: string;
}

export interface InboundLoopResult {
  script: TranscriptTurn[];
  inCall: InCallState;
}

function callerTurns(script: TranscriptTurn[]): TranscriptTurn[] {
  return script.filter((t) => t.role === "caller");
}

function findEvidenceSpanForValue(script: TranscriptTurn[], value: string): string | null {
  for (const turn of script) {
    if (turn.role !== "caller") continue;
    if (turn.text.toLowerCase().includes(value.toLowerCase())) {
      return turn.text;
    }
  }
  return null;
}

/** Asked before the scripted agent books, saves a message or writes a quote field; false means the judge refused. */
export type ScriptedGuard = (
  action: "book" | "save_details" | "save_quote_field",
  payload: { slotIso?: string; slotWords?: string; kind?: string; body?: string; field?: string; value?: string; evidenceSpan?: string },
  transcript: TranscriptTurn[],
) => Promise<boolean>;

async function nextInboundAgentReply(
  store: LeadStore,
  leadId: string,
  callId: string,
  packet: LeadContextPacket,
  utterance: string,
  inCall: InCallState,
  priorCallerCount: number,
  script: TranscriptTurn[],
  guard?: ScriptedGuard,
): Promise<string> {
  if (detectStopRequest(utterance)) return STOP_REPLY;
  const lower = utterance.toLowerCase();
  const firstName = packet.name.split(" ")[0] ?? packet.name;

  if (priorCallerCount === 1) {
    const ctx = await toolReadLeadContext(store, leadId);
    inCall.pendingToolResults.push(ctx.speakable);
    if (lower.includes("quote") || lower.includes("auto")) {
      inCall.intent = "quote";
    }
    if (lower.includes("book") || lower.includes("appointment")) {
      inCall.intent = "book";
    }
    if (lower.includes("message") || lower.includes("callback")) {
      inCall.intent = "message";
    }
    return `I see your record, ${firstName}. How can I help you today?`;
  }

  const yearMatch = utterance.match(/\b(19|20)\d{2}\b/);
  if (inCall.intent === "quote" && yearMatch) {
    const year = yearMatch[0];
    inCall.slotFills.vehicle_year = year;
    const span = findEvidenceSpanForValue(
      [{ role: "caller", text: utterance, turnIndex: 0 }],
      year,
    );
    if (span) {
      inCall.evidenceBackedFields.vehicle_year = { value: year, evidenceSpan: span };
    }
    inCall.callerWanted = "Auto quote";
    inCall.promised = "email your quote";
    inCall.openQuestions = ["Coverage limits"];
    return `Got it, a ${year} vehicle. We will email your quote. Any coverage limits in mind?`;
  }

  if (inCall.intent === "book") {
    const slotIso = "2026-10-20T15:00:00.000Z";
    if (guard && !(await guard("book", { slotIso }, script))) {
      return "I could not book that, so a person will follow up with you.";
    }
    const booked = await toolBookProducer(store, leadId, callId, slotIso);
    inCall.pendingToolResults.push(booked.speakable);
    inCall.callerWanted = "Book producer";
    inCall.promised = "producer time is booked";
    inCall.openQuestions = [];
    return booked.speakable;
  }

  if (inCall.intent === "message") {
    if (guard && !(await guard("save_details", { kind: "message", body: utterance }, script))) {
      return "I could not save that message, so a person will follow up with you.";
    }
    const saved = await toolSaveMessage(store, leadId, callId, utterance);
    inCall.pendingToolResults.push(saved.speakable);
    inCall.callerWanted = "Leave a message";
    inCall.promised = "message is saved";
    inCall.openQuestions = [];
    return saved.speakable;
  }

  if (lower.includes("deductible")) {
    const amountMatch = utterance.match(/(\d+)\s*dollar/i);
    if (amountMatch) {
      const deductible = amountMatch[1];
      inCall.slotFills.deductible = deductible;
      inCall.evidenceBackedFields.deductible = {
        value: deductible,
        evidenceSpan: utterance,
      };
    }
    inCall.callerWanted = "Quote";
    inCall.promised = "noted your deductible preference";
    return "I noted your deductible preference.";
  }

  return "Thank you for calling. Is there anything else I can help with?";
}

/** Rule-based inbound dialog driven by caller utterances (not a pre-baked transcript). */
export async function runInboundCallLoop(
  store: LeadStore,
  leadId: string,
  callId: string,
  packet: LeadContextPacket,
  callerUtterances: string[],
  systemInstruction: string,
  bargeIn?: BargeInOptions,
  guard?: ScriptedGuard,
): Promise<InboundLoopResult> {
  const inCall = createState();
  const script: TranscriptTurn[] = [systemInstructionTurn(systemInstruction)];
  let turnIndex = 0;

  for (const utterance of callerUtterances) {
    script.push({ role: "caller", text: utterance, turnIndex, spoken: true });
    turnIndex += 1;

    const priorCallerCount = callerTurns(script).length;
    const agentText = await nextInboundAgentReply(
      store,
      leadId,
      callId,
      packet,
      utterance,
      inCall,
      priorCallerCount,
      script,
      guard,
    );

    const agentTurn: TranscriptTurn = {
      role: "agent",
      text: agentText,
      turnIndex,
    };

    if (bargeIn && turnIndex === bargeIn.interruptAtTurnIndex) {
      agentTurn.turnIndex = bargeIn.interruptAtTurnIndex;
      script.push(agentTurn);
    } else {
      script.push({ ...agentTurn, spoken: true });
    }
    turnIndex += 1;
    // A request to stop ends the dialog: nothing more is asked or promised.
    if (detectStopRequest(utterance)) break;
  }

  return { script, inCall };
}

/** Ways a caller asks whether they are talking to a machine. Whole words only. */
const ARE_YOU_AN_AI_PHRASES = [
  "are you an ai",
  "are you ai",
  "are you a robot",
  "are you a bot",
  "is this an ai",
  "is this a robot",
  "is this a bot",
  "is this automated",
  "am i talking to a person",
  "am i talking to a real person",
  "am i speaking to a person",
  "real person",
  "automated",
];

export function asksIfAi(utterance: string): boolean {
  const spoken = utterance.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return ARE_YOU_AN_AI_PHRASES.some((phrase) => containsAsWords(spoken, phrase));
}

export function runOutboundCallLoop(
  callerUtterances: string[],
  systemInstruction: string,
): { script: TranscriptTurn[]; inCall: InCallState } {
  const inCall = createState();
  const script: TranscriptTurn[] = [systemInstructionTurn(systemInstruction)];
  let turnIndex = 0;
  for (const utterance of callerUtterances) {
    script.push({ role: "caller", text: utterance, turnIndex, spoken: true });
    turnIndex += 1;
    let agentText = OUTBOUND_SCRIPTED_OPENING;
    if (detectStopRequest(utterance)) {
      script.push({ role: "agent", text: STOP_REPLY, turnIndex, spoken: true });
      break;
    }
    if (asksIfAi(utterance)) {
      agentText = OUTBOUND_AI_TRUTHFUL_ANSWER;
      inCall.callerWanted = utterance;
      inCall.promised = OUTBOUND_AI_TRUTHFUL_ANSWER;
      inCall.openQuestions = [];
    } else if (utterance.toLowerCase().includes("quote") || utterance.toLowerCase().includes("callback")) {
      inCall.callerWanted = utterance;
      inCall.promised = "send your quote today";
      inCall.openQuestions = [];
      agentText = "Thanks for taking our callback. We will send your quote today.";
    }
    script.push({ role: "agent", text: agentText, turnIndex, spoken: true });
    turnIndex += 1;
  }
  return { script, inCall };
}
