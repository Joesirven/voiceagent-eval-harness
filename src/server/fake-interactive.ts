/**
 * TEST ONLY. A local stand-in for the decision module's interactive call. It
 * implements the same interface and emits the same view events (partial and
 * final transcript lines, node entries, decisions, judge verdicts,
 * dispositions). It runs no compliance check and never claims one ran: the
 * dev server does not use it (see play-wiring.ts). Keyword matching only.
 */

import { newCallContext, emitTrace, runWithTrace, traceTool, type TraceContext } from "../trace/index.js";
import type { TreeJson } from "./live-view-core.js";

export interface InteractiveCall {
  callId: string;
  /** Set by the real start: "blocked" means a compliance check refused it and `blockedReason` says which. */
  status?: "connected" | "ended" | "blocked";
  blockedReason?: string;
  say(callerText: string): Promise<void>;
  /** `abandoned` marks a call the page stopped because nobody spoke for too long. */
  hangUp(reason?: "abandoned"): Promise<void>;
}

export interface StartInteractiveCall {
  (opts: { leadId: string; direction: "inbound" | "outbound" }): Promise<InteractiveCall>;
}

export const fakeLeads = [
  { id: "lead-1", label: "Jane (all consents)" },
  { id: "lead-2", label: "Marcus (asked about a renewal)" },
  { id: "lead-3", label: "Priya (no text consent)" },
];

export const fakeTree: TreeJson = {
  start: "greeting",
  dispositions: ["booked", "callback_requested", "not_interested", "wrong_number", "transferred", "do_not_contact", "hung_up"],
  nodes: [
    { id: "greeting", label: "Greeting and disclosure", question: "Is this the right person?", minConfidence: 0.6,
      edges: [{ answer: "yes", to: "interest" }, { answer: "no", to: "wrong_number" }, { answer: "stop", to: "do_not_contact" }] },
    { id: "interest", label: "What do they need?", question: "What is the caller asking for?", minConfidence: 0.6,
      edges: [{ answer: "quote", to: "details" }, { answer: "existing_policy", to: "transfer" }, { answer: "not_interested", to: "declined" }] },
    { id: "details", label: "Collect quote details", question: "Did they give quote details?", minConfidence: 0.7,
      edges: [{ answer: "gave_details", to: "booking" }, { answer: "declined_details", to: "callback" }] },
    { id: "booking", label: "Offer a producer time", question: "Did they accept a time?", minConfidence: 0.7,
      edges: [{ answer: "accepts", to: "booked" }, { answer: "declines", to: "callback" }] },
    { id: "booked", label: "End: booked", disposition: "booked", edges: [] },
    { id: "callback", label: "End: call back later", disposition: "callback_requested", edges: [] },
    { id: "declined", label: "End: not interested", disposition: "not_interested", edges: [] },
    { id: "wrong_number", label: "End: wrong number", disposition: "wrong_number", edges: [] },
    { id: "transfer", label: "Hand to a person", disposition: "transferred", edges: [] },
    { id: "do_not_contact", label: "End: stop contact", disposition: "do_not_contact", edges: [] },
  ],
};

const ASKS: Record<string, string> = {
  interest: "Thanks. Are you after a new quote, or asking about a policy you already have?",
  details: "Sure. What are you looking to cover, and for whom?",
  booking: "Thanks, that helps. Would tomorrow afternoon work for a call with a producer?",
};
const CLOSING: Record<string, string> = {
  booked: "Booked. A producer will call you tomorrow afternoon. Goodbye.",
  callback: "No problem. We will call you back at a better time. Goodbye.",
  declined: "Understood, thank you for your time. Goodbye.",
  wrong_number: "Sorry to have bothered you. Goodbye.",
  transfer: "Let me pass you to a person who can help with your policy.",
  do_not_contact: "Understood. We will not contact you again. Goodbye.",
};

let paceMs = 40;
/** Pause between emitted steps so a page can show lines arriving; tests set 0. */
export function setFakePaceMs(ms: number): void {
  paceMs = ms;
}
const pause = () => (paceMs > 0 ? new Promise<void>((r) => setTimeout(r, paceMs)) : Promise.resolve());

interface Classified { answer: string; confidence: number; reason: string }

const STOP = /\b(stop|do not call|don't call|remove me|unsubscribe)\b/i;

function classify(nodeId: string, text: string): Classified {
  const t = text.toLowerCase();
  const hit = (answer: string, confidence: number, reason: string): Classified => ({ answer, confidence, reason });
  if (STOP.test(text)) return hit("stop", 0.98, "caller asked to stop being contacted");
  switch (nodeId) {
    case "greeting":
      return /\b(wrong|not me|no)\b/.test(t) ? hit("no", 0.85, "caller said this is not them") : hit("yes", 0.9, "caller engaged");
    case "interest":
      if (/not interested|no thanks/.test(t)) return hit("not_interested", 0.9, "caller declined");
      if (/policy|claim|renew/.test(t)) return hit("existing_policy", 0.85, "caller mentioned an existing policy");
      if (/quote|price|insurance|cover|car|home|auto/.test(t)) return hit("quote", 0.9, "caller asked for a quote");
      return hit("quote", 0.4, "no clear request");
    case "details":
      if (/rather not|prefer not|no\b/.test(t)) return hit("declined_details", 0.8, "caller would not share details");
      if (/\d|honda|toyota|ford|house|apartment|car|truck|driver/.test(t)) return hit("gave_details", 0.9, "caller named what to cover");
      return hit("gave_details", 0.45, "unclear whether details were given");
    default:
      if (/\b(no|later|not now)\b/.test(t)) return hit("declines", 0.85, "caller turned down the time");
      if (/\b(yes|yeah|sure|ok|okay|works|tomorrow|fine)\b/.test(t)) return hit("accepts", 0.9, "caller agreed to a time");
      return hit("accepts", 0.4, "unclear whether the time works");
  }
}

function emitLine(role: "caller" | "agent", text: string, turnIndex: number, partial: boolean): void {
  emitTrace(partial ? "transcript_partial" : "transcript_final", { role, text, turnIndex });
}

/** Speaks a line the way a live call does: a partial first, then the final. */
async function speak(role: "caller" | "agent", text: string, turnIndex: number): Promise<void> {
  const words = text.split(" ");
  emitLine(role, words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(" "), turnIndex, true);
  await pause();
  emitLine(role, text, turnIndex, false);
}

class FakeCall implements InteractiveCall {
  private nodeId = fakeTree.start;
  private turn = 0;
  private ended = false;
  private disposition: string | null = null;
  private closed = false;

  constructor(readonly callId: string, private readonly ctx: TraceContext, private readonly textConsent: boolean) {}

  async open(inbound: boolean, name: string): Promise<void> {
    await runWithTrace(this.ctx, async () => {
      await traceTool("read_lead_context", { leadId: this.ctx.leadId }, async () => true);
      emitTrace("node_enter", { nodeId: this.nodeId, label: node(this.nodeId).label });
      await pause();
      const hello = inbound
        ? "Thanks for calling Northwind Insurance Agency. I am an AI assistant and this call may be recorded. Who am I speaking with?"
        : `Hi, this is Northwind Insurance Agency's AI assistant, and this call may be recorded. Am I speaking with ${name}?`;
      await speak("agent", hello, this.turn++);
    });
  }

  say(callerText: string): Promise<void> {
    return runWithTrace(this.ctx, async () => {
      if (this.closed) throw new Error("call_already_ended");
      const caller = this.turn++;
      await speak("caller", callerText, caller);
      if (this.ended) {
        await speak("agent", "This call is wrapping up. Goodbye.", this.turn++);
        return;
      }
      const n = node(this.nodeId);
      const c = classify(this.nodeId, callerText);
      const routed = c.confidence >= (n.minConfidence ?? 0.6) ? "proceed" : "clarify";
      await traceTool("decide", { nodeId: n.id }, async () => c.answer);
      emitTrace("decision", {
        nodeId: n.id, question: n.question ?? n.label, answers: n.edges.map((e) => e.answer), answer: c.answer,
        confidence: c.confidence, reason: c.reason, module: "fake-keyword", minConfidence: n.minConfidence ?? 0.6, routed,
      });
      await pause();
      if (routed === "clarify") {
        await speak("agent", "Sorry, I am not sure I followed. Could you say that another way?", this.turn++);
        return;
      }
      const next = n.edges.find((e) => e.answer === c.answer)?.to ?? null;
      if (!next) return;
      await this.verdictFor(n.id, c.answer);
      this.nodeId = next;
      const target = node(next);
      emitTrace("node_enter", { nodeId: target.id, label: target.label });
      if (target.disposition) {
        this.ended = true;
        this.disposition = target.disposition;
        emitTrace("disposition", { value: target.disposition, nodeId: target.id });
        await this.verdict("end_with_disposition", true, `disposition ${target.disposition} matches what the caller said`);
        if (target.disposition === "callback_requested") {
          const ok = this.textConsent;
          await this.verdict("send_text", ok, ok ? "caller agreed to texts" : "no text consent on file");
        }
        await speak("agent", CLOSING[target.id] ?? "Goodbye.", this.turn++);
      } else {
        await speak("agent", ASKS[target.id] ?? "Go on.", this.turn++);
      }
    });
  }

  private async verdictFor(nodeId: string, answer: string): Promise<void> {
    if (nodeId === "details" && answer === "gave_details") await this.verdict("save_quote_field", true, "the caller's own words support it");
    if (nodeId === "booking" && answer === "accepts") await this.verdict("book", true, "caller accepted the offered time");
    if (nodeId === "interest" && answer === "existing_policy") await this.verdict("transfer", true, "existing policy questions go to a person");
  }

  private async verdict(action: string, allowed: boolean, reason: string): Promise<void> {
    emitTrace("judge_verdict", {
      action, allowed, reason,
      scores: [{ criterion: "stays within what the caller said", score: allowed ? 1 : 0, note: reason }],
    });
    await pause();
  }

  hangUp(reason?: "abandoned"): Promise<void> {
    return runWithTrace(this.ctx, async () => {
      if (this.closed) return;
      this.closed = true;
      if (!this.disposition) {
        this.disposition = "hung_up";
        emitTrace("disposition", { value: "hung_up", nodeId: this.nodeId });
      }
      const status = reason === "abandoned" ? "abandoned" : this.ctx.direction === "inbound" ? "ai_handled" : "placed";
      emitTrace("call_outcome", { status });
      const good = this.disposition !== "hung_up";
      emitTrace("judge_score", {
        judgedAt: new Date().toISOString(),
        score: good ? 0.9 : 0.5,
        criteria: [{ criterion: "reached a clear outcome", score: good ? 1 : 0, note: good ? "call reached an end node" : "caller hung up first" }],
      });
    });
  }
}

const node = (id: string) => fakeTree.nodes.find((n) => n.id === id)!;

export const startInteractiveCall: StartInteractiveCall = async ({ leadId, direction }) => {
  const lead = fakeLeads.find((l) => l.id === leadId);
  if (!lead) throw new Error("unknown_lead");
  const ctx = newCallContext(leadId, direction);
  ctx.leadLabel = lead.label.split(" ")[0];
  const call = new FakeCall(ctx.callId!, ctx, leadId !== "lead-3");
  await call.open(direction === "inbound", ctx.leadLabel!);
  return call;
};
