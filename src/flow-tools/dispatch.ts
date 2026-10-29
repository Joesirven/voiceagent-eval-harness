/**
 * The flow tool dispatcher: one per call. It keeps the call's own state (the
 * spoken transcript, the judged actions already done, the current node), runs
 * the catalog's tools in a fixed order of checks and never throws for bad
 * input. Three rules hold here and nowhere else:
 * - a stop is recorded only when hearCaller hears a stop phrase, never from a tool call;
 * - every write tool's quote is checked against the caller's spoken turns before the judge;
 * - read-only tools never reach the judge, and a refusing judge means nothing runs.
 * During the call every action stays in harness memory; lasting CRM
 * writes are queued as filings for after the call.
 */

import { readFileSync } from "node:fs";
import { getHarnessConfig } from "../config.js";
import { detectStopRequest, STOP_REPLY } from "../compliance/stop.js";
import { storeActionPort, type ActionPort, type ActionPortDeps } from "../decision/actions.js";
import { FULL_TREE_FILE } from "../decision/tree-source.js";
import { guardedAction, type GateContext } from "../judge/gate.js";
import { JUDGE_ACTIONS, type JudgeAction, type JudgePayload, type JudgeRequest } from "../judge/types.js";
import { findQuoteInCallerWords, quoteSpanIn } from "./quotes.js";
import type { TranscriptTurn } from "../provider/interface.js";
import type { LeadStore } from "../store/lead-store-seam.js";
import { ALREADY_BOOKED, toolReadLeadContext } from "../tools/agent-tools.js";
import { emitTrace, errorCode, traceTool } from "../trace/events.js";
import type { Clock } from "../types/clock.js";
import { FLOW_TOOL_CATALOG, isDispatched, validateToolArguments, type FlowTool, type FlowToolCatalog } from "./catalog.js";
import { createCrmStub, type CrmClient } from "./crm-stub.js";
import { filingFor, followUpFor, type AfterCallFiling, type ProducerFollowUp } from "./filings.js";
import {
  checkAppointmentTime,
  checkQuoteStatus,
  listAvailableProducers,
  READ_UNAVAILABLE,
  slotInRange,
  type ReadDb,
  type ReadResult,
} from "./reads.js";

export interface FlowDispatcherDeps {
  leadId: string;
  callId: string;
  agencyId: string;
  direction: "inbound" | "outbound";
  clock: Clock;
  gate: GateContext;
  store: LeadStore;
  /** The harness actions; defaults to storeActionPort over `store`. */
  actions?: ActionPort;
  /** The harness's text path for the default action port; missing means a text is never sent. */
  sendText?: ActionPortDeps["sendText"];
  /** CRM actions. The local recording stub is used when a caller does not supply an integration. */
  crm?: CrmClient;
  /** Select-only reads of the development project through the service role key; missing means those reads refuse. */
  db?: ReadDb;
  /**
   * A real transfer to a person (src/server/voice/human-transfer.ts), which the call runner passes in: true once a person
   * took the call, false when nobody did. Missing (tests, simulators) means the harness-only transfer, a trace step.
   */
  humanTransfer?: (request: { reason: string; note?: string }) => Promise<boolean>;
  /** The harness's stop path. Called once, from hearCaller only. */
  onStop: (callerText: string) => Promise<void>;
  /** Which dispositions are durable; defaults to the full tree's list. */
  dispositions?: ReadonlyArray<{ name: string; durable: boolean }>;
  catalog?: FlowToolCatalog;
  /** This call's disclosure as recorded when it started, for the judge's disclosure check; absent means the judge's default. */
  expectedDisclosure?: () => string[] | undefined;
}

export interface DispatchResult {
  ok: boolean;
  speakable: string;
  refused?: { code: string; reason: string };
  endCall?: boolean;
}

export interface FlowCallState {
  transcript: TranscriptTurn[];
  completed: JudgeAction[];
  nodeId: string;
  stopped: boolean;
  ended: boolean;
  disposition?: string;
  /** Lines for the handoff note. Never the caller's quote. */
  notes: string[];
  filings: AfterCallFiling[];
  followUps: ProducerFollowUp[];
}

export interface FlowDispatcher {
  /** The runnable catalog names, one handler each. */
  readonly entries: readonly string[];
  hearCaller(text: string): Promise<void>;
  sayAgent(text: string): void;
  setNode(nodeId: string): void;
  dispatch(call: { name: string; arguments: unknown }): Promise<DispatchResult>;
  readonly state: FlowCallState;
}

const PRODUCER_FOLLOWS_UP = "A licensed producer will follow up with you about that.";
const NOT_DONE = "I cannot do that right now. A licensed producer will follow up with you.";
const GOODBYE = "Thank you for your time. Goodbye.";
const NOTED = "Thank you, I have noted that.";

let fullTreeDispositions: Array<{ name: string; durable: boolean }> | undefined;
function defaultDispositions(): Array<{ name: string; durable: boolean }> {
  fullTreeDispositions ??= (JSON.parse(readFileSync(FULL_TREE_FILE, "utf8")) as { dispositions: Array<{ name: string; durable: boolean }> }).dispositions;
  return fullTreeDispositions;
}

/** A CRM app call as a gate step's run: traced, and false (not done) when CRM refuses or cannot be reached. */
async function crmStep(tool: string, run: (() => Promise<{ ok: boolean; message?: string }>) | undefined): Promise<boolean> {
  if (run === undefined) return false;
  const started = Date.now();
  const outcome = await run().catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : "CRM could not be reached" }));
  emitTrace("tool_call", { tool: `crm_${tool}`, inputs: {}, result: { message: outcome.message ?? null }, success: outcome.ok, durationMs: Date.now() - started });
  return outcome.ok;
}

/** The real transfer as a gate step's run, traced as transfer_to_human: a success only when a person took the call. */
async function humanTransferStep(run: NonNullable<FlowDispatcherDeps["humanTransfer"]>, reason: string, note: string | undefined): Promise<boolean> {
  const started = Date.now();
  const connected = await run({ reason, ...(note ? { note } : {}) }).catch(() => false);
  emitTrace("tool_call", { tool: "transfer_to_human", inputs: { reason }, result: connected, success: connected, durationMs: Date.now() - started, ...(connected ? {} : { reason: "nobody_took_the_call" }) });
  return connected;
}

/** One judged step of a write tool: the action, its payload and what runs when it is allowed. */
interface GateStep {
  action: JudgeAction;
  payload: JudgePayload;
  run: () => Promise<boolean>;
  /** The argument this step saves, kept out of the filing when the step did not run. */
  argument?: string;
}

interface WritePlan {
  steps: GateStep[];
  done: string;
  notes?: string[];
}

/** Each confirmation text and the tool that must have completed in this call before it can be sent. */
const TEMPLATE_BACKED_BY: Record<string, string> = {
  appointment_confirmed: "book_producer",
  callback_time_confirmed: "book_callback",
};

/** The quote follow-up text goes out only after the caller agreed to a text, saved as quote_channel = text. */
const QUOTE_FOLLOW_UP_TEMPLATE = "quote_follow_up";

const digits = (text: string) => text.replace(/\D/g, "");
/** An email as letters, digits, "@" and ".", with the spoken words "at" and "dot" read as those signs. */
const squashEmail = (text: string) =>
  text.toLowerCase().replace(/\bat\b/g, "@").replace(/\bdot\b/g, ".").replace(/[^a-z0-9@.]/g, "");

/**
 * The value a contact tool saves must be inside the caller's quote, so a model
 * cannot quote one number and save another: a phone by its last ten digits, an
 * email as it is spelled or spoken, any other field as whole words.
 */
function valueInQuote(tool: string, a: Record<string, string>, quote: string): boolean {
  if (tool === "add_callback_number") {
    const phone = digits(a.phone ?? "");
    return phone.length >= 10 && digits(quote).includes(phone.slice(-10));
  }
  if (tool !== "save_contact_detail") return true;
  if (a.field === "email") {
    const email = squashEmail(a.value ?? "");
    return email.includes("@") && squashEmail(quote).includes(email);
  }
  return quoteSpanIn(quote, a.value ?? "") !== null;
}

const refuse = (code: string, reason: string, speakable = NOT_DONE): DispatchResult => ({ ok: false, speakable, refused: { code, reason } });
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, none: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, million: 1_000_000 };

/**
 * The head count a saved employee_count stands for, or undefined with no figure: the full-time and part-time figures
 * added up ("3 full-time, 1 part-time" is 4), never an "in the field" figure, since field workers are already counted.
 * The saved value keeps the caller's own figures, because a total they never said would be refused as not heard.
 */
export function headcountIn(value: string): number | undefined {
  const parts = value.split(/[;,]|\band\b/i).filter((part) => !/\bfield\b/i.test(part));
  const figures = parts.flatMap((part) => numbersIn(part));
  return figures.length ? figures.reduce((sum, n) => sum + n, 0) : undefined;
}

/** The annual payroll a saved payroll stands for: every figure in it added up ("$250,000 full-time, $40,000 part-time"). */
export function payrollIn(value: string): number | undefined {
  const figures = numbersIn(value);
  return figures.length ? figures.reduce((sum, n) => sum + n, 0) : undefined;
}

/**
 * The numbers in a line, as plain values: digits with their separators removed ("300,000", "$300k"), and spoken
 * numbers ("two", "three hundred thousand", "none"). For comparing what a caller said with what a model saves.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const tokens = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?|[a-z]+/g) ?? [];
  let current: number | undefined;
  let total = 0;
  const flush = () => {
    if (current !== undefined || total) out.push(total + (current ?? 0));
    current = undefined;
    total = 0;
  };
  for (const t of tokens) {
    if (/^\d/.test(t)) {
      flush();
      current = Number(t);
    } else if (t in NUMBER_WORDS && !(t === "no" && current !== undefined)) {
      if (current !== undefined && NUMBER_WORDS[t]! >= 10 && current % 100 !== 0) flush();
      current = (current ?? 0) + NUMBER_WORDS[t]!;
    } else if (t in SCALES && (current !== undefined || total)) {
      if (t === "hundred") current = (current ?? 1) * 100;
      else {
        total += (current ?? 1) * SCALES[t]!;
        current = undefined;
      }
    } else if (t !== "and" && t !== "a") flush();
  }
  flush();
  return out;
}

/** A caller's yes to a read-back. */
const READ_BACK_YES = /\b(yes|yeah|yep|yup|correct|right|sure|sounds good|that works|okay|ok|perfect|great)\b/i;

export function createFlowDispatcher<T extends FlowDispatcherDeps>(deps: T): FlowDispatcher {
  const catalog = deps.catalog ?? FLOW_TOOL_CATALOG;
  const known = new Map(catalog.tools.map((t) => [t.name, t]));
  const entries = catalog.tools.filter(isDispatched).map((t) => t.name);
  const actions =
    deps.actions ??
    storeActionPort({ store: deps.store, leadId: deps.leadId, callId: deps.callId, sendText: deps.sendText ?? (async () => ({ status: "not_sent" })) });
  const crm = deps.crm ?? createCrmStub();
  const dispositions = deps.dispositions ?? defaultDispositions();

  const transcript: TranscriptTurn[] = [];
  /** How many transcript lines there were when check_appointment_time last ran; book_producer needs a read-back and a yes after it. */
  let lastAppointmentCheck: number | undefined;
  const completed: JudgeAction[] = [];
  /** The tools whose every judged step completed in this call, so a confirmation text can be backed. */
  const completedTools = new Set<string>();
  /** The quote fields write_quote_field saved in this call, by field name, filled only when the write step completed. */
  const savedQuoteFields = new Map<string, string>();
  const notes: string[] = [];
  const filings: AfterCallFiling[] = [];
  const followUps: ProducerFollowUp[] = [];
  let nodeId = "flow";
  let stopped = false;
  let ended = false;
  let disposition: string | undefined;

  const callerTexts = () => transcript.filter((t) => t.role === "caller" && t.spoken !== false).map((t) => t.text);
  /** The caller's own words for a quote, ignoring case and punctuation; null when the caller never said it. */
  const callerSpan = (quote: string | undefined) => (quote?.trim() ? findQuoteInCallerWords(callerTexts(), quote) : null);

  /** Whether the action judge and the evidence checks are switched off (HarnessConfig.actionJudgeOff). */
  const judgeOff = () => getHarnessConfig().actionJudgeOff === true;

  /** Through the judge gate; the step's run is called only when the verdict allows it. With the judge off, it runs at once. */
  async function gated(step: GateStep): Promise<{ done: true } | { done: false; code: string; reason: string }> {
    if (judgeOff()) {
      if (!(await step.run())) return { done: false, code: "not_done", reason: "the action did not complete" };
      completed.push(step.action);
      return { done: true };
    }
    const request: JudgeRequest = {
      action: step.action,
      nodeId,
      direction: deps.direction,
      transcript: transcript.map((t) => ({ ...t })),
      completed: [...completed],
      payload: step.payload,
      now: deps.clock.now(),
      ...(deps.expectedDisclosure?.() ? { expectedDisclosure: deps.expectedDisclosure() } : {}),
    };
    const outcome = await guardedAction(deps.gate, request, step.run);
    if (!outcome.allowed) return { done: false, code: "judge_refused", reason: outcome.verdict.reason };
    if (!outcome.value) return { done: false, code: "not_done", reason: "the action was allowed but did not complete" };
    completed.push(step.action);
    return { done: true };
  }

  function writePlan(tool: FlowTool, a: Record<string, string>): WritePlan | undefined {
    const quote = a.evidence_quote!;
    switch (tool.name) {
      case "write_quote_field":
        return { done: NOTED, steps: [{ action: "save_quote_field", payload: { field: a.field, value: a.value, evidenceSpan: quote }, run: () => actions.saveQuoteField(a.field!, a.value!, quote, callerTexts()) }] };
      // Keep the note in harness memory, then record the action in the configured CRM client.
      case "save_contact_detail":
        return { done: NOTED, steps: [{ action: "save_details", payload: { kind: "contact_field", body: quote }, run: async () =>
          (await actions.saveDetails("contact_field", `${a.field}: ${a.value}`)) && (await crmStep("save_contact_detail", () => crm.crmSaveContactDetail(a.field!, a.value!, quote))) }] };
      case "add_callback_number":
        return { done: "Thank you, I have noted that number.", steps: [{ action: "save_details", payload: { kind: "phone", body: quote }, run: async () =>
          (await actions.saveDetails("phone", `${a.label ?? "other"}: ${a.phone}`)) && (await crmStep("add_callback_number", () => crm.crmAddCallbackNumber(a.phone!, a.label))) }] };
      case "email_document":
        return { done: "I have emailed that to you.", steps: [{ action: "send_email", payload: { document: a.document, evidenceSpan: quote }, run: () =>
          crmStep("email_document", async () => ({ ok: (await crm.crmEmailDocument(a.document!)).status === "sent" })) }] };
      case "record_decision_maker": {
        const field = (name: string, value: string, argument: string): GateStep => ({
          action: "save_quote_field", payload: { field: name, value, evidenceSpan: quote }, argument, run: () => actions.saveQuoteField(name, value, quote, callerTexts()),
        });
        const steps = [field("decision_maker_name", a.name!, "name"), ...(a.phone ? [field("decision_maker_phone", a.phone, "phone")] : [])];
        return { done: "Thank you, I have noted who makes the decision.", steps, notes: [`Decision maker's role, as the caller gave it: ${a.role}.`] };
      }
      case "save_message":
        return { done: "Your message is saved, and a licensed producer will follow up.", steps: [{ action: "save_details", payload: { kind: a.kind, body: a.body }, run: () => actions.saveDetails(a.kind!, a.body!) }] };
      case "book_producer":
        // Book in harness memory, then record the booking in the configured CRM client.
        return { done: "Your producer time is booked.", steps: [{ action: "book", payload: { slotIso: a.slot_iso, slotWords: a.slot_words }, run: async () =>
          (await actions.book(a.slot_iso!)) && (await crmStep("book_producer", () => crm.crmBookAppointment(a.slot_iso!))) }] };
      case "request_quote": {
        // The employee count and payroll saved in this call, when both are plain numbers; else CRM uses the record's.
        const employees = headcountIn(savedQuoteFields.get("employee_count") ?? "");
        const payroll = payrollIn(savedQuoteFields.get("payroll") ?? "");
        const workforce = employees !== undefined && payroll !== undefined ? { employees, payroll } : undefined;
        return { done: "I have started your quote, and a licensed producer will go over it with you.", steps: [{ action: "start_quote", payload: { line: "workers_compensation", evidenceSpan: quote }, run: () =>
          crmStep("request_quote", () => crm.crmRequestQuote(workforce)) }] };
      }
      // On a Talk call the transfer rings Dana's or Chris's cell and bridges the caller to whoever takes it; elsewhere a trace step.
      case "transfer_to_human":
        return {
          done: deps.humanTransfer ? "You are through to a licensed producer now." : "I have asked a licensed producer to take this over, and they will follow up with you.",
          steps: [{ action: "transfer", payload: { reason: a.reason }, run: () =>
            deps.humanTransfer ? humanTransferStep(deps.humanTransfer, a.reason!, a.note_for_producer) : actions.transfer(a.reason!) }],
          notes: a.note_for_producer ? [`Note for the producer on the transfer: ${a.note_for_producer}`] : [],
        };
      case "send_text": {
        const body = catalog.templates[a.template!] ?? "";
        // CRM holds every text 10 seconds for undo: accepted is not yet sent.
        return { done: "I'm sending you that text now.", steps: [{ action: "send_text", payload: { body }, run: () => actions.sendText(body) }] };
      }
      default:
        return undefined;
    }
  }

  /** Why a step that was allowed did not complete, in words the agent can say. */
  async function notDoneSpeakable(tool: FlowTool): Promise<string> {
    if (tool.name === "send_text") return "I could not send the text just now. A licensed producer will follow up with you.";
    if (tool.name === "email_document") return "I could not send that email just now. A licensed producer will follow up with you.";
    if (tool.name === "transfer_to_human") return "No one could pick up just now. I can take a message for a licensed producer, if you like.";
    if (tool.name !== "book_producer") return NOT_DONE;
    const lead = await deps.store.getLead(deps.leadId);
    return lead?.bookings.some((b) => b.callId === deps.callId) ? ALREADY_BOOKED : NOT_DONE;
  }

  /**
   * A booking only after the agent read the time back and the caller said yes to it, after the last check of the
   * time. Kept with the judge off too: on Voice Live the judge was the only other check (call_mvhtrmc3cb91ec booked a
   * garbled time with no read-back).
   */
  function readBackHeard(): boolean {
    if (lastAppointmentCheck === undefined) return false;
    const after = transcript.slice(lastAppointmentCheck);
    const agentAt = after.findIndex((t) => t.role === "agent");
    if (agentAt < 0) return false;
    return after.slice(agentAt + 1).some((t) => t.role === "caller" && READ_BACK_YES.test(t.text));
  }

  async function runWrite(tool: FlowTool, args: Record<string, string>): Promise<DispatchResult> {
    // Even with the judge off: a number the caller did not say is never saved (call_mvhz6q5af896b9 saved "600,000"
    // after the caller said "300,000"). The model is told to read the number back and ask.
    if (tool.name === "write_quote_field" && args.field !== "x_date") {
      const heard = new Set(transcript.filter((t) => t.role === "caller").slice(-6).flatMap((t) => numbersIn(t.text)));
      const missing = numbersIn(args.value ?? "").filter((n) => !heard.has(n));
      if (missing.length) {
        emitTrace("tool_call", { tool: "value_not_heard", inputs: { field: args.field ?? null, value: (args.value ?? "").slice(0, 80) }, result: null, success: false, durationMs: 0, reason: "value_not_heard" });
        return refuse("value_not_heard", "the value has a number the caller did not say in their recent lines");
      }
    }
    if (tool.name === "book_producer" && !readBackHeard()) {
      return refuse("no_read_back", "the time was not read back to the caller and confirmed with a yes after the last check");
    }
    // Step 5: the quote must be the caller's own spoken words, before any judge. From here on
    // the quote is the caller's text itself, so the store's evidence rule and the judge see it as said.
    // With the judge off the model's quote is kept as it is, recorded but not checked.
    const span = judgeOff() ? (args.evidence_quote ?? "") : callerSpan(args.evidence_quote);
    if (span === null) {
      return refuse("evidence_not_in_caller_words", "the quote is not inside anything the caller said");
    }
    const a: Record<string, string> = { ...args, evidence_quote: span };
    // Step 6: checks the harness can make itself before the gate.
    if (!judgeOff() && !valueInQuote(tool.name, a, a.evidence_quote!)) {
      return refuse("value_not_in_quote", "the value to save is not inside the caller's quote");
    }
    const backing = tool.name === "send_text" ? TEMPLATE_BACKED_BY[a.template!] : undefined;
    if (backing && !completedTools.has(backing)) {
      return refuse("template_not_backed", `the text confirms what ${backing} does, and it has not completed in this call`);
    }
    if (tool.name === "send_text" && a.template === QUOTE_FOLLOW_UP_TEMPLATE && savedQuoteFields.get("quote_channel") !== "text") {
      return refuse("template_not_backed", "the quote follow-up text needs the caller's yes to a text, saved as quote_channel = text in this call");
    }
    const slot = tool.name === "book_producer" ? a.slot_iso : tool.name === "book_callback" ? a.at : undefined;
    if (slot !== undefined && !slotInRange(Date.parse(slot), deps.clock.now())) {
      return refuse("slot_out_of_range", "the time is not five minutes to sixty days ahead", "That time cannot be booked. It needs to be at least five minutes and at most sixty days from now.");
    }
    // The reach check is a do-not-call and suppression check: with the compliance checks off (CRM_COMPLIANCE_CHECKS=off) it does not run.
    if (tool.name === "add_callback_number" && deps.store.finalReachCheck && !getHarnessConfig().complianceChecksOff) {
      const reach = await deps.store.finalReachCheck(deps.leadId, "call", a.phone).catch(() => ({ allowed: false, reason: "reach_check_failed" }));
      emitTrace("tool_call", { tool: "callback_number_reach_check", inputs: {}, result: { allowed: reach.allowed, reason: reach.allowed ? null : reach.reason ?? null }, success: reach.allowed, durationMs: 0 });
      if (!reach.allowed) return refuse("number_not_reachable", reach.reason, "A licensed producer will confirm that number with you.");
    }
    // Step 7: a judge action the judge does not know yet is never stood in for by another.
    if (!(JUDGE_ACTIONS as readonly string[]).includes(tool.judgeAction ?? "")) {
      return refuse("judge_action_missing", `the judge has no action ${String(tool.judgeAction)} yet`);
    }
    const plan = writePlan(tool, a);
    if (!plan) return refuse("not_built", "no handler is wired for this tool");
    const saved = new Set<string>();
    for (const step of plan.steps) {
      const outcome = await gated(step);
      if (!outcome.done) {
        if (saved.size > 0) fileAfterCall(tool, a, plan, saved);
        const speakable = outcome.code === "not_done" ? await notDoneSpeakable(tool) : NOT_DONE;
        return refuse(outcome.code, outcome.reason, speakable);
      }
      if (step.argument) saved.add(step.argument);
    }
    completedTools.add(tool.name);
    if (tool.name === "write_quote_field") savedQuoteFields.set(a.field!, a.value!);
    fileAfterCall(tool, a, plan, saved);
    return { ok: true, speakable: plan.done };
  }

  /** Step 8: the handoff note lines, and one filing for a queued tool, with only the arguments that were saved. */
  function fileAfterCall(tool: FlowTool, a: Record<string, string>, plan: WritePlan, saved: Set<string>): void {
    notes.push(...(plan.notes ?? []));
    if (tool.status !== "queued_after_call") return;
    const unsaved = plan.steps.flatMap((s) => (s.argument && !saved.has(s.argument) ? [s.argument] : []));
    const args = Object.fromEntries(Object.entries(a).filter(([k]) => !unsaved.includes(k)));
    filings.push(filingFor(tool, args, deps, deps.clock.now()));
  }

  async function runRead(tool: FlowTool, a: Record<string, string>): Promise<DispatchResult> {
    if (tool.name === "read_lead_context") return { ok: true, speakable: (await toolReadLeadContext(deps.store, deps.leadId)).speakable };
    const read = async (): Promise<ReadResult | undefined> => {
      switch (tool.name) {
        case "check_appointment_time":
          lastAppointmentCheck = transcript.length;
          return checkAppointmentTime(deps.store, deps.leadId, a.day!, a.time!, deps.clock.now());
        case "list_available_producers":
          return deps.db ? listAvailableProducers(deps.db, deps.agencyId, deps.clock.now()) : undefined;
        case "check_quote_status":
          return deps.db ? checkQuoteStatus(deps.db, deps.agencyId, deps.leadId) : undefined;
        default:
          return { ok: false, code: "not_built", reason: "no handler is wired for this tool", speakable: READ_UNAVAILABLE };
      }
    };
    const result = await traceTool(tool.trace, { ...a }, read).catch((err: unknown) => ({
      ok: false as const, code: "read_failed", reason: errorCode(err), speakable: READ_UNAVAILABLE,
    }));
    if (!result) return refuse("not_connected", "no development project database client is connected", READ_UNAVAILABLE);
    return result.ok ? { ok: true, speakable: result.speakable } : refuse(result.code, result.reason, result.speakable);
  }

  /** Step 9: the hang-up always happens; only the disposition is judged, and a stop is never written here. */
  async function endTheCall(a: Record<string, string>): Promise<DispatchResult> {
    if (ended) return { ok: true, speakable: GOODBYE, endCall: true };
    ended = true;
    if (stopped) return { ok: true, speakable: STOP_REPLY, endCall: true };
    const name = a.disposition!;
    const durable = dispositions.find((d) => d.name === name)?.durable ?? false;
    let refusal: { code: string; reason: string } | undefined;
    if (name === "do_not_contact") {
      refusal = { code: "stop_not_heard", reason: "a stop is recorded only from the caller's own words, and none was heard" };
    } else if (!judgeOff() && (durable || a.evidence_quote !== undefined) && callerSpan(a.evidence_quote) === null) {
      refusal = { code: "evidence_not_in_caller_words", reason: "the quote is not inside anything the caller said" };
    } else {
      try {
        const outcome = await gated({ action: "end_with_disposition", payload: { disposition: name, durable }, run: () => actions.endWithDisposition(name, durable) });
        if (!outcome.done) refusal = { code: outcome.code, reason: outcome.reason };
      } catch (err) {
        refusal = { code: "run_failed", reason: errorCode(err) };
      }
    }
    disposition = refusal ? "talked" : name;
    emitTrace("disposition", { value: disposition, nodeId });
    if (!refusal) return { ok: true, speakable: GOODBYE, endCall: true };
    notes.push(`The ending ${name} was refused (${refusal.reason}), so the call ended as talked.`);
    return { ok: false, speakable: GOODBYE, refused: refusal, endCall: true };
  }

  async function dispatchOnce(call: { name: string; arguments: unknown }): Promise<DispatchResult> {
    // Step 1: only catalog tools with a handler.
    const tool = known.get(call?.name);
    if (!tool) return refuse("unknown_tool", "no tool has that name");
    if (!isDispatched(tool)) return refuse(tool.status === "runs_in_console" ? "console_tool" : "not_built", tool.status === "runs_in_console" ? "the console bot carries out this tool itself" : "no handler is wired for this tool yet");
    // Step 2: the schema; identifiers come from the dispatcher, never from the model.
    const problems = validateToolArguments(tool, call.arguments);
    if (problems.length > 0) return refuse("invalid_arguments", problems.join("; "));
    const a = call.arguments as Record<string, string>;
    if (tool.name === "end_call") return endTheCall(a);
    if (ended) return refuse("call_ended", "the call has ended");
    // After a stop nothing else runs: no read, no follow-up, no write that could lead to contact.
    if (stopped) return refuse("call_stopped", "the caller asked to stop being contacted", STOP_REPLY);
    // Step 3: a credential the harness does not hold.
    if (tool.status === "needs_seat_session" || tool.status === "needs_admin_machine_credential") {
      followUps.push(followUpFor(tool, a, deps.clock.now()));
      return refuse("needs_credential", `this needs the ${tool.credential}`, PRODUCER_FOLLOWS_UP);
    }
    // Step 4: read-only tools never reach the judge.
    if (tool.risk === "read_only") return runRead(tool, a);
    return runWrite(tool, a);
  }

  return {
    entries,
    async hearCaller(text) {
      transcript.push({ role: "caller", text, turnIndex: transcript.length, spoken: true });
      if (stopped || !detectStopRequest(text)) return;
      // The only place a stop is recorded: the stop-phrase code, as the engine does it.
      stopped = true;
      disposition = "do_not_contact";
      emitTrace("disposition", { value: "do_not_contact", nodeId });
      await deps.onStop(text);
    },
    sayAgent(text) {
      transcript.push({ role: "agent", text, turnIndex: transcript.length, spoken: true });
    },
    setNode(id) {
      nodeId = id;
    },
    async dispatch(call) {
      try {
        return await dispatchOnce(call);
      } catch (err) {
        return { ...refuse("run_failed", errorCode(err)), ...(call?.name === "end_call" ? { endCall: true } : {}) };
      }
    },
    get state(): FlowCallState {
      return {
        transcript: transcript.map((t) => ({ ...t })),
        completed: [...completed],
        nodeId,
        stopped,
        ended,
        disposition,
        notes: [...notes],
        filings: filings.map((f) => ({ ...f, arguments: { ...f.arguments } })),
        followUps: followUps.map((f) => ({ ...f, arguments: { ...f.arguments } })),
      };
    },
  };
}
