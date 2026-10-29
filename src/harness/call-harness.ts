import { getHarnessConfig, isAiCallingEnabled } from "../config.js";
import { checkOutboundCallConsent, checkSmsConsent } from "../compliance/consent.js";
import { checkOutboundSchedule } from "../compliance/outbound-schedule.js";
import {
  callOpening,
  findInboundDisclosure,
  inboundOpeningScript,
  openingFactsFor,
  openingLine,
  outboundDisclosureFirst,
  type CallOpening,
} from "../compliance/disclosures.js";
import { checkQuietHours } from "../compliance/quiet-hours.js";
import { findStopRequest, detectStopRequest, STOP_PROMISE, type StopRequest } from "../compliance/stop.js";
import { checkStopAndSuppressionLists, checkSuppression } from "../compliance/suppression.js";
import { buildHandoffNote, rejectUnsupportedFields } from "../memory/handoff.js";
import { buildLeadContextPacket } from "../memory/context.js";
import { installBehaviourPromptBuilder } from "../behaviour/install-prompt.js";
import { buildHarnessAgentSystemInstruction } from "../modules/agent-instructions.js";

installBehaviourPromptBuilder();
import { getModuleRegistry, type ModuleRegistry } from "../modules/registry.js";
import {
  collectFinalTranscript,
  OUTBOUND_SCRIPTED_OPENING,
  prependSystemInstruction,
  runInboundCallLoop,
  type ScriptedGuard,
  runOutboundCallLoop,
  type BargeInOptions,
} from "../orchestration/call-loop.js";
import { assertDialsClearedDestination, takeClearanceIssuer, type CallClearance } from "../provider/clearance.js";
import {
  readRunMode,
  resolveDestination,
  runGates,
  scopedKeyPart,
  scopedSlot,
  traceMode,
  traceComplianceChecksOff,
  traceSkipped,
  type DestinationRequest,
  type GateEntry,
  type RunMode,
} from "./gates.js";
import { getAgentLineGuard } from "./agent-line-guard.js";
import { hasTestStop, recordTestStop } from "./test-stops.js";
import { REAL_RUN_SOURCE, TEST_RUN_SOURCE, type HarnessRunRow, type HarnessRunStatus } from "../store/harness-runs.js";
import type {
  CallDirection,
  CallSession,
  DialOutcome,
  TranscriptEvent,
  TranscriptTurn,
  VoiceProvider,
} from "../provider/interface.js";
import {
  emitTrace,
  errorCode,
  firstBlock,
  newCallContext,
  newTextContext,
  runWithTrace,
  setTraceLead,
  traceCheck,
  traceTool,
  currentTrace,
  type TraceContext,
} from "../trace/index.js";
import { logCommunication, type CallLogEntry } from "../store/call-log.js";
import type { LeadRecord, StopResult } from "../store/lead-store.js";
import { getActiveLeadStore } from "../store/active-store.js";
import type { LeadStore } from "../store/lead-store-seam.js";
import type { Clock } from "../types/clock.js";
import { systemClock } from "../types/clock.js";
import { storeActionPort } from "../decision/actions.js";
import { TreeDialog } from "../decision/engine.js";
import {
  BlockedInteractiveCall,
  CallerQueue,
  ClearedInteractiveCall,
  sourceFromLines,
  type CallerSource,
  type InteractiveCall,
} from "../decision/interactive-call.js";
import type { InCallState } from "../memory/context.js";
import { MAX_UNANSWERED_ATTEMPTS, countUnansweredAttempts } from "../decision/outbound-attempts.js";
import { CallDecisionRecorder } from "../decision/recorder.js";
import { getDecisionRegistry, type DecisionModuleRegistry } from "../decision/registry.js";
import { loadActiveTree } from "../decision/tree-source.js";
import { knownLeadStart, type DecisionTree } from "../decision/tree.js";
import { getActionJudge, getPostCallJudge, guardedAction } from "../judge/index.js";
import { EXPECTED_OPENING_TOOL, expectedDisclosureOf, inboundDisclosureHeard } from "../judge/post-call.js";
import type { Judge } from "../judge/types.js";
import type { PostCallJudge } from "../trace/extensions.js";
import { recordStore, type HarnessRecord } from "../trace/records.js";

/** Only this file can issue clearances, so only CallHarness can start a call. */
const issueClearance = takeClearanceIssuer();

/** Leads with an AI call in progress: a second call to the same lead waits its turn. */
const leadsInFlight = new Set<string>();

/** Local Talk page only: drop a stuck in-flight slot after the prior play call was hung up. */

/** The tree dialog of each call in progress, by call id, for the live voice session to reach. */
export const liveTreeDialogs = new Map<string, TreeDialog>();
export function clearLeadInFlightForPlay(leadId: string): void {
  leadsInFlight.delete(leadId);
}

/**
 * Suppression gates for enforced runs. The local Talk play path skips only the
 * do-not-call check, shown in the trace as skipped; the stop list and the
 * suppression list always run, whatever the do-not-call status.
 */
/** Whether this call skips its compliance checks: a Talk call while HarnessConfig.complianceChecksOff is on. */
function complianceChecksOffFor(playTalk?: boolean): boolean {
  return playTalk === true && getHarnessConfig().complianceChecksOff === true;
}

function enforcedSuppressionGates(lead: LeadRecord, playTalk?: boolean): GateEntry[] {
  if (!playTalk) return [["suppression", () => checkSuppression(lead)]];
  return [
    ["suppression", () => checkStopAndSuppressionLists(lead)],
    ["do_not_call", { skipped: "skipped: local Talk play path" }],
  ];
}

export type ModuleSnapshot = NonNullable<CallSession["moduleSnapshot"]>;

export interface RunInboundResult {
  status: "ai_handled" | "normal_answering" | "abandoned";
  /** The voice module's own call id. The record's id is `recordId`. */
  callId?: string;
  /** The durable record this run wrote (one file per call attempt). */
  recordId?: string;
  moduleId?: string;
  moduleSnapshot?: ModuleSnapshot;
  disclosures?: string[];
  transcript?: TranscriptTurn[];
}

export interface RunOutboundResult {
  /** "not_answered": the line rang out or reached voicemail; the call was hung up and nothing was said. */
  status: "placed" | "blocked" | "skipped_duplicate" | "not_answered" | "abandoned";
  dialOutcome?: DialOutcome;
  /** The attempt number this run was (1 or 2). */
  attempt?: number;
  /** The agreed slot this attempt belongs to. */
  slot?: string;
  /** The voice module's own call id. The record's id is `recordId`. */
  callId?: string;
  /** The durable record this run wrote (one file per call attempt). */
  recordId?: string;
  moduleId?: string;
  moduleSnapshot?: ModuleSnapshot;
  reason?: string;
  transcript?: TranscriptTurn[];
}

export interface SendTextResult {
  /** "recorded": every gate passed and the text was logged, but no sender is connected, so nothing went out. */
  status: "recorded" | "blocked" | "skipped_duplicate";
  reason?: string;
  /** The durable record this text was written to (one file per lead's text thread). */
  recordId?: string;
  messageId?: string;
}

/** Runs one call or text inside its trace; every run ends with an outcome event, even when it throws. */
async function withOutcome<
  R extends { status: string; reason?: string; callId?: string; moduleId?: string; dialOutcome?: DialOutcome; attempt?: number; slot?: string },
>(
  ctx: TraceContext,
  fn: () => Promise<R>,
  /** Called once the outcome event is written, whether the run finished or threw. Must not throw. */
  onDone?: (result: R | undefined, error?: unknown) => Promise<void>,
): Promise<R> {
  return runWithTrace(ctx, async () => {
    try {
      const result = await fn();
      if (ctx.channel === "call") {
        emitTrace("call_outcome", {
          status: result.status,
          // Reasons like "call_start_failed:<message>" carry raw error text after the colon; keep the code only.
          reason: (result.reason ?? ctx.lastBlock)?.split(":")[0] ?? null,
          moduleId: result.moduleId ?? null,
          providerCallId: result.callId ?? null,
          ...(result.dialOutcome ? { dialOutcome: result.dialOutcome, attempt: result.attempt ?? null, slot: result.slot ?? null } : {}),
        });
      }
      await onDone?.(result);
      return { ...result, recordId: ctx.recordId, ...(ctx.messageId ? { messageId: ctx.messageId } : {}) };
    } catch (err) {
      emitTrace(ctx.channel === "call" ? "call_outcome" : "text", {
        status: "failed",
        reason: errorCode(err),
      });
      await onDone?.(undefined, err);
      throw err;
    }
  });
}

/** One conversation-turn event per spoken turn of the final transcript. */
function emitTurns(transcript: TranscriptTurn[]): void {
  for (const t of transcript) {
    emitTrace("turn", { role: t.role, text: t.text, turnIndex: t.turnIndex, spoken: t.spoken !== false });
  }
}

export interface ReceiveTextResult {
  status: "stop_recorded" | "no_action" | "duplicate";
  recorded?: StopResult["recorded"];
}

export interface ScenarioRunOptions {
  /** The caller's or webhook's own key. Kept for tracing; the harness derives the key it claims. */
  idempotencyKey: string;
  /** Caller lines only; the harness runs the inbound loop to produce agent turns. */
  callerUtterances?: string[];
  scheduledReason?: string;
  bargeIn?: BargeInOptions;
  /** "decision_tree" lets the decision tree drive the agent. The default keeps the scripted loop. */
  agent?: "scripted" | "decision_tree";
  /** Outbound: which attempt this is (1 or 2). Never taken from the lead; the harness checks it against the records. */
  attempt?: number;
  /** Mock telephony: how an outbound dial ends. Defaults to answered. */
  dialOutcome?: DialOutcome;
  /** Live caller lines instead of a fixed list (play a lead). Used with agent "decision_tree". */
  callerSource?: CallerSource;
  /** Behaviour prompt setup id; defaults to the harness registry selection via `"default"`. */
  promptSetupId?: string;
  /** Lets the caller of a run know the call id before the run finishes. */
  traceContext?: TraceContext;
  /** Called once the call is connected. Carries ids only, never a clearance. */
  onConnected?: (connected: ConnectedCall) => void;
  /** Dev Talk: skip do-not-call suppression only; every other gate still runs. */
  playTalk?: boolean;
  /**
   * Where the call or text is meant to go. Enforced runs default to the lead's own
   * number; test mode defaults to "simulated" and refuses "lead_number".
   */
  destination?: DestinationRequest;
}

/** The mode and destination a run's clearances are issued for. */
interface ClearanceRoute {
  mode: RunMode["mode"];
  destination: string;
  testPhone?: string;
}

export interface ConnectedCall {
  callId: string;
  leadId: string;
  direction: CallDirection;
  idempotencyKey: string;
  /** Mode and destination the run's clearances are bound to (no clearance itself). */
  route: ClearanceRoute;
}

/** Swappable parts of the tree-driven agent. Anything missing falls back to the shared default. */
export interface TreeDependencies {
  decisions?: DecisionModuleRegistry;
  judge?: Judge;
  postCallJudge?: PostCallJudge;
  tree?: DecisionTree;
}

/**
 * The key a call is claimed under. Outbound: one call per lead per agreed slot,
 * whatever key the job or webhook supplied. Inbound: the telephony event id.
 */
export function deriveCallKey(
  direction: CallDirection,
  lead: Pick<LeadRecord, "id" | "scheduledOutboundAt">,
  requestKey: string,
  attempt = 1,
): string {
  const slot = direction === "outbound" ? (lead.scheduledOutboundAt ?? "no-slot") : requestKey;
  // Attempt 1 keeps the original key; a later attempt at the same slot is its own call.
  return `${direction}:${lead.id}:${slot}${direction === "outbound" && attempt > 1 ? `:attempt-${attempt}` : ""}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function callerTurnTexts(transcript: TranscriptTurn[]): string[] {
  return transcript.filter((t) => t.role === "caller" && t.spoken !== false).map((t) => t.text);
}

export class CallHarness {
  constructor(
    private readonly clock: Clock = systemClock,
    private readonly explicitStore?: LeadStore,
    private readonly registry: ModuleRegistry = getModuleRegistry(),
    private readonly treeDeps: TreeDependencies = {},
  ) {}

  /** Resolved per call, so switching the store takes effect immediately. */
  private get store(): LeadStore {
    return this.explicitStore ?? getActiveLeadStore();
  }

  async runInbound(leadId: string, fromNumber: string, opts: ScenarioRunOptions): Promise<RunInboundResult> {
    const ctx = opts.traceContext ?? newCallContext(leadId, "inbound");
    return withOutcome(ctx, () => this.inboundRun(leadId, fromNumber, opts), (r, e) => this.recordRun(ctx, r, e));
  }

  async runOutbound(leadId: string, ignoredNumber: string, opts: ScenarioRunOptions): Promise<RunOutboundResult> {
    const ctx = opts.traceContext ?? newCallContext(leadId, "outbound");
    return withOutcome(ctx, () => this.outboundRun(leadId, ignoredNumber, opts), (r, e) => this.recordRun(ctx, r, e));
  }

  /**
   * Play a lead. The call goes through exactly the same run as any other
   * (`runInbound` or `runOutbound`), so every gate runs first and the
   * disclosure is the agent's first turn. The handle returned for a connected
   * call is built from a fresh single-use clearance; a refused start returns
   * the reason and nothing else.
   */
  async startInteractiveCall(
    leadId: string,
    direction: CallDirection,
    scheduledReason = "text_agreed_callback",
    destination?: DestinationRequest,
    playTalk = false,
  ): Promise<InteractiveCall> {
    const ctx = newCallContext(leadId, direction);
    const queue = new CallerQueue();
    let onConnected!: (c: ConnectedCall) => void;
    const connected = new Promise<ConnectedCall>((resolve) => {
      onConnected = resolve;
    });
    const opts: ScenarioRunOptions = {
      idempotencyKey: `interactive-${ctx.callId}`,
      agent: "decision_tree",
      scheduledReason,
      callerSource: queue,
      traceContext: ctx,
      onConnected,
      playTalk,
      ...(destination ? { destination } : {}),
    };
    const run = direction === "inbound" ? this.runInbound(leadId, "interactive", opts) : this.runOutbound(leadId, "", opts);
    const done = run.then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    const first = await Promise.race([connected.then((c) => ({ c })), done.then((d) => ({ d }))]);
    if ("c" in first) {
      const c = first.c;
      // The clearance is minted here and redeemed by the handle at once; it never leaves the harness.
      return new ClearedInteractiveCall({
        clearance: issueClearance(leadId, direction, c.idempotencyKey, c.route),
        callId: ctx.callId!,
        leadId,
        direction,
        idempotencyKey: c.idempotencyKey,
        queue,
        done,
      });
    }
    const thrown = first.d.error ? errorCode(first.d.error) : undefined;
    const reason = (ctx.lastBlock ?? (first.d.result as { reason?: string } | undefined)?.reason ?? thrown ?? "not_started").split(":")[0]!;
    return new BlockedInteractiveCall(ctx.callId!, reason);
  }

  private async inboundRun(leadId: string, fromNumber: string, opts: ScenarioRunOptions): Promise<RunInboundResult> {
    const base = { leadId, channel: "call", direction: "inbound", requestKey: opts.idempotencyKey } as const;
    const log = (outcome: CallLogEntry["outcome"], reason: string, extra: Partial<CallLogEntry> = {}) =>
      logCommunication({ ...base, outcome, reason, ...extra });
    const fallback = (reason: string): RunInboundResult => {
      log("skipped", reason);
      return { status: "normal_answering" };
    };

    const run = readRunMode();
    const lead = await this.store.getLead(leadId);
    setTraceLead(lead?.name);
    if (traceCheck("lead_found", lead ? null : "lead_not_found")) {
      log("blocked", "lead_not_found");
      throw new Error("lead_not_found");
    }
    if (!lead) throw new Error("lead_not_found");
    // Inbound: the number the caller comes from. Test mode never takes it from the caller.
    // In test mode the lead's own number is what a test phone must not be, whatever number the caller came from.
    const destination = resolveDestination(run, opts.destination, run.mode === "suspended" ? lead.phone : fromNumber);
    const route: ClearanceRoute = { mode: run.mode, destination, testPhone: run.testPhone };
    // A Talk call with the compliance checks switched off records one row instead of the legal blocks and the gates.
    const checksOff = complianceChecksOffFor(opts.playTalk);
    if (checksOff) traceComplianceChecksOff(destination);
    else traceMode(run, destination);
    if (!checksOff && traceCheck("ai_calling_enabled", isAiCallingEnabled(lead.agencyId) ? null : "ai_calling_disabled")) {
      return fallback("ai_calling_disabled_normal_answering");
    }
    const provider = this.registry.activeModule();
    if (!provider) {
      traceCheck("voice_module_available", "no_voice_module_enabled");
      return fallback("no_voice_module_enabled_normal_answering");
    }
    traceCheck("voice_module_available", null);
    const gate = checksOff
      ? null
      : run.mode === "enforced"
        ? await runGates([
            ...enforcedSuppressionGates(lead, opts.playTalk),
            ["quiet_hours", () => checkQuietHours(lead, this.clock)],
          ])
        : await runGates([
            ["suppression", () => checkStopAndSuppressionLists(lead)],
            ["do_not_call", "skipped"],
            ["test_session_stop", () => (hasTestStop(run.sessionId, leadId) ? "test_session_stop" : null)],
            ["quiet_hours", "skipped"],
          ]);
    if (gate) return fallback(`${gate}_inbound_normal_answering`);

    if (traceCheck("one_call_at_a_time", leadsInFlight.has(leadId) ? "call_in_flight_for_lead" : null)) {
      return fallback("call_in_flight_for_lead");
    }
    leadsInFlight.add(leadId);
    const key = deriveCallKey("inbound", lead, `${scopedKeyPart(run)}${opts.idempotencyKey}`);
    try {
      const claimed = await this.store.tryClaimIdempotency(key);
      if (traceCheck("duplicate_guard", claimed ? null : "duplicate_idempotency_key")) {
        return fallback("duplicate_idempotency_key");
      }
      log("placed", "inbound_ai_session_start", { idempotencyKey: key });

      const contextPacket = this.packetFor(lead, route);
      // Resolved once, so the opening, the agent's instructions and the dialog follow the same tree.
      const dialogTree = opts.agent === "decision_tree" ? (this.treeDeps.tree ?? loadActiveTree()) : undefined;
      const opening = fixOpening(lead, "inbound", dialogTree, opts.playTalk);
      const systemInstruction = await this.bindAgentSystemInstruction(lead, contextPacket, "inbound", opts, opening);
      let session: CallSession;
      try {
        session = await traceTool(
          "start_inbound_call",
          { moduleId: provider.id },
          () => {
            const clearance = issueClearance(leadId, "inbound", key, route);
            assertDialsClearedDestination(clearance, destination);
            return provider.startInboundCall({
              leadId,
              fromNumber: destination,
              idempotencyKey: key,
              contextPacket,
              systemInstruction,
              clearance,
            });
          },
          (s) => ({ providerCallId: s.callId }),
        );
      } catch (err) {
        await this.store.releaseIdempotency(key);
        log("blocked", `call_start_failed:${errorMessage(err)}`, { idempotencyKey: key });
        return { status: "normal_answering" };
      }
      log("answered", `inbound_ai_connected:${provider.id}`, { callId: session.callId, idempotencyKey: key });
      recordOpening(opening, "inbound");

      let finalTranscript: TranscriptTurn[] = [];
      try {
        const tree = opts.agent === "decision_tree";
        let script: TranscriptTurn[];
        let inCall: InCallState;
        if (tree) {
          // The dialog puts the harness's own disclosure first and emits every turn as it happens.
          ({ script, inCall } = await this.runTreeDialog(lead, session, "inbound", key, opts, route, systemInstruction, opening, dialogTree));
        } else {
          const loop = await runInboundCallLoop(
            this.store,
            leadId,
            session.callId,
            contextPacket,
            opts.callerUtterances ?? [],
            systemInstruction,
            opts.bargeIn,
            this.scriptedGuard(lead.id, session.callId, opening),
          );
          inCall = loop.inCall;
          // The harness, not the module, puts the disclosure first.
          script = [
            { role: "agent", text: inboundOpeningScript(opening), turnIndex: -1, spoken: true },
            ...this.guardScript(loop.script, lead.id, session.callId, "inbound"),
          ];
        }
        assertDisclosureFirst(script, opening.disclosure);
        finalTranscript = await this.consume(provider, session, script, opts.bargeIn?.spokenAgentPrefix);
        if (!complianceChecksOffFor(opts.playTalk)) ensureDisclosureFirst(finalTranscript, opening.disclosure);
        if (!tree) emitTurns(finalTranscript);

        const stop = findStopRequest(finalTranscript);
        if (stop) {
          await this.handleStop(leadId, session.callId, finalTranscript, stop, "inbound", log, run);
        } else {
          const accepted = await this.persistSlotFills(leadId, session.callId, inCall, finalTranscript, this.scriptedGuard(lead.id, session.callId, opening));
          const note = buildHandoffNote(
            session.callId,
            finalTranscript,
            inCall.callerWanted,
            inCall.promised,
            inCall.openQuestions,
            accepted,
          );
          if (note) {
            const filed = { ...note, direction: "inbound" as const };
            await traceTool("append_handoff_note", { callId: session.callId }, () => this.store.appendHandoffNote(leadId, filed));
            emitTrace("handoff", { filed: true, note: filed }, { flowStep: "handoff" });
          } else if (inCall.callerWanted || inCall.promised || inCall.openQuestions.length) {
            traceCheck("handoff_claims_supported", "handoff_rejected_unsupported_claims");
            log("blocked", "handoff_rejected_unsupported_claims", { callId: session.callId });
          }
        }
      } catch (err) {
        // The call connected, so the key stays claimed: a retry must never dial again.
        log("blocked", `call_failed:${errorMessage(err)}`, { callId: session.callId, idempotencyKey: key });
        await provider.endCall(session, finalTranscript).catch(() => undefined);
        throw err;
      }

      await traceTool("end_call", { providerCallId: session.callId }, () => provider.endCall(session, finalTranscript), () => "ended");
      log("ended", "inbound_ai_session_end", { callId: session.callId });
      // With the action judge off, the call is not scored here (scoring is done after the call, in the console).
      if (opts.agent === "decision_tree" && !getHarnessConfig().actionJudgeOff) await this.scoreCall();
      return {
        status: opts.callerSource?.abandoned ? "abandoned" : "ai_handled",
        callId: session.callId,
        moduleId: provider.id,
        moduleSnapshot: session.moduleSnapshot,
        transcript: finalTranscript,
        disclosures: [...opening.disclosure],
      };
    } finally {
      leadsInFlight.delete(leadId);
    }
  }

  private async outboundRun(leadId: string, _ignoredNumber: string, opts: ScenarioRunOptions): Promise<RunOutboundResult> {
    const base = { leadId, channel: "call", direction: "outbound", requestKey: opts.idempotencyKey } as const;
    const log = (outcome: CallLogEntry["outcome"], reason: string, extra: Partial<CallLogEntry> = {}) =>
      logCommunication({ ...base, outcome, reason, ...extra });
    const block = (reason: string, outcome: CallLogEntry["outcome"] = "blocked"): RunOutboundResult => {
      log(outcome, reason);
      return { status: "blocked", reason };
    };

    const run = readRunMode();
    const lead = await this.store.getLead(leadId);
    setTraceLead(lead?.name);
    if (traceCheck("lead_found", lead ? null : "lead_not_found") || !lead) return block("lead_not_found");
    // Resolved once: the clearance, the dial and the context packet all use this destination.
    const destination = resolveDestination(run, opts.destination, lead.phone);
    const route: ClearanceRoute = { mode: run.mode, destination, testPhone: run.testPhone };
    const checksOff = complianceChecksOffFor(opts.playTalk);
    if (checksOff) traceComplianceChecksOff(destination);
    else traceMode(run, destination);
    if (!checksOff && traceCheck("ai_calling_enabled", isAiCallingEnabled(lead.agencyId) ? null : "ai_calling_disabled")) {
      log("skipped", "ai_calling_disabled_outbound_not_placed");
      return { status: "blocked", reason: "ai_calling_disabled" };
    }
    const provider = this.registry.activeModule();
    if (traceCheck("voice_module_available", provider ? null : "no_voice_module_enabled") || !provider) {
      return block("no_voice_module_enabled");
    }
    // The caller-supplied number is never dialled: only the number on the lead.
    if (traceCheck("phone_on_file", lead.phone?.trim() ? null : "no_phone")) return block("no_phone");
    const attempt = opts.attempt ?? 1;
    const slot = scopedSlot(run, lead.scheduledOutboundAt ?? "no-slot");
    const suspended = run.mode === "suspended";
    // With the compliance checks off, only the plumbing gate stays (no real dial while develop writes are off).
    // The develop-writes hold stops real dials. A browser or simulated line dials nothing, and the store keeps
    // its claims and notes in memory while writes are off, so a Talk call to a development lead goes ahead.
    const developWrites = () => (destination === "browser" || destination === "simulated" ? null : this.store.outboundHold?.() ?? null);
    const gate = checksOff ? await runGates([["develop_writes", developWrites]]) : await runGates([
      ...(suspended
        ? ([["suppression", () => checkStopAndSuppressionLists(lead)]] satisfies GateEntry[])
        : enforcedSuppressionGates(lead, opts.playTalk)),
      ...(suspended
        ? ([
            ["do_not_call", "skipped"],
            ["test_session_stop", () => (hasTestStop(run.sessionId, leadId) ? "test_session_stop" : null)],
            ["consent", "skipped"],
            ["artificial_voice_consent", "skipped"],
            ["quiet_hours", "skipped"],
          ] satisfies GateEntry[])
        : ([
            ["consent", () => checkOutboundCallConsent(lead)],
            ["quiet_hours", () => checkQuietHours(lead, this.clock)],
          ] satisfies GateEntry[])),
      ["outbound_schedule", () => checkOutboundSchedule(lead, this.clock, opts.scheduledReason)],
      ["unanswered_attempts", () => this.attemptGate(lead, slot, attempt)],
      ["store_reach_rules", suspended ? "skipped" : () => this.finalReach(leadId, "call")],
      ["develop_writes", developWrites],
    ]);
    if (gate) return block(gate);

    const duplicate = (reason: string): RunOutboundResult => {
      log("skipped", reason);
      return { status: "skipped_duplicate", reason };
    };
    if (traceCheck("one_call_at_a_time", leadsInFlight.has(leadId) ? "call_in_flight_for_lead" : null)) {
      return duplicate("call_in_flight_for_lead");
    }
    leadsInFlight.add(leadId);
    const key = deriveCallKey("outbound", { id: lead.id, scheduledOutboundAt: slot }, opts.idempotencyKey, attempt);
    try {
      const claimed = await this.store.tryClaimIdempotency(key);
      if (traceCheck("duplicate_guard", claimed ? null : "duplicate_idempotency_key")) {
        return duplicate("duplicate_idempotency_key");
      }
      log("placed", "outbound_ai_dial", { idempotencyKey: key });

      const contextPacket = this.packetFor(lead, route);
      const opening = fixOpening(lead, "outbound", undefined, opts.playTalk);
      const systemInstruction = await this.bindAgentSystemInstruction(lead, contextPacket, "outbound", opts, opening);
      let session: CallSession;
      try {
        session = await traceTool(
          "start_outbound_call",
          { moduleId: provider.id },
          () => {
            const clearance = issueClearance(leadId, "outbound", key, route);
            // Modules dial only the clearance's destination, never the lead's number in test mode.
            assertDialsClearedDestination(clearance, destination);
            return provider.startOutboundCall({
              leadId,
              toNumber: destination,
              idempotencyKey: key,
              contextPacket,
              systemInstruction,
              scheduledReason: opts.scheduledReason,
              simulatedOutcome: opts.dialOutcome,
              clearance,
            });
          },
          (s) => ({ providerCallId: s.callId }),
        );
      } catch (err) {
        await this.store.releaseIdempotency(key);
        return block(`call_start_failed:${errorMessage(err)}`);
      }
      const dial = session.dialOutcome ?? "answered";
      if (dial !== "answered") {
        // Voicemail or nobody home: hang up and say nothing. No message is left in an artificial voice.
        log("ended", `outbound_${dial}_hung_up_no_message`, { callId: session.callId, idempotencyKey: key });
        emitTrace("disposition", { value: dial === "voicemail" ? "voicemail_no_message" : "no_answer", nodeId: "dial" });
        await traceTool("end_call", { providerCallId: session.callId }, () => provider.endCall(session, []), () => "ended");
        return {
          status: "not_answered",
          dialOutcome: dial,
          attempt,
          slot,
          callId: session.callId,
          moduleId: provider.id,
          moduleSnapshot: session.moduleSnapshot,
          reason: dial,
        };
      }
      log("answered", `outbound_connected:${provider.id}`, { callId: session.callId, idempotencyKey: key });
      recordOpening(opening, "outbound");

      let finalTranscript: TranscriptTurn[] = [];
      try {
        const tree = opts.agent === "decision_tree";
        const { script, inCall } = tree
          ? await this.runTreeDialog(lead, session, "outbound", key, opts, route, systemInstruction, opening)
          : (() => {
              const loop = runOutboundCallLoop(opts.callerUtterances ?? [], systemInstruction);
              return { ...loop, script: this.guardScript(loop.script, lead.id, session.callId, "outbound") };
            })();
        if (tree) this.checkOutboundDisclosure(script, opening.disclosure);
        finalTranscript = await this.consume(provider, session, script);
        if (!tree) emitTurns(finalTranscript);
        const stop = findStopRequest(finalTranscript);
        if (stop) {
          await this.handleStop(leadId, session.callId, finalTranscript, stop, "outbound", log, run);
        } else if (inCall.callerWanted || inCall.promised) {
          const note = buildHandoffNote(
            session.callId,
            finalTranscript,
            inCall.callerWanted,
            inCall.promised,
            inCall.openQuestions,
            {},
          );
          if (note) {
            const filed = { ...note, direction: "outbound" as const };
            await traceTool("append_handoff_note", { callId: session.callId }, () => this.store.appendHandoffNote(leadId, filed));
            emitTrace("handoff", { filed: true, note: filed }, { flowStep: "handoff" });
          }
        }
      } catch (err) {
        // The call connected, so the key stays claimed: a retry must never dial again.
        log("blocked", `call_failed:${errorMessage(err)}`, { callId: session.callId, idempotencyKey: key });
        await provider.endCall(session, finalTranscript).catch(() => undefined);
        throw err;
      }

      await traceTool("end_call", { providerCallId: session.callId }, () => provider.endCall(session, finalTranscript), () => "ended");
      log("ended", "outbound_session_end", { callId: session.callId });
      // With the action judge off, the call is not scored here (scoring is done after the call, in the console).
      if (opts.agent === "decision_tree" && !getHarnessConfig().actionJudgeOff) await this.scoreCall();
      return {
        status: opts.callerSource?.abandoned ? "abandoned" : "placed",
        callId: session.callId,
        moduleId: provider.id,
        moduleSnapshot: session.moduleSnapshot,
        transcript: finalTranscript,
      };
    } finally {
      leadsInFlight.delete(leadId);
    }
  }

  async sendText(
    leadId: string,
    body: string,
    idempotencyKey: string,
    opts: { destination?: DestinationRequest } = {},
  ): Promise<SendTextResult> {
    const ctx = newTextContext(leadId);
    return withOutcome(ctx, () => this.textRun(leadId, body, idempotencyKey, opts.destination), (r, e) => this.recordRun(ctx, r, e));
  }

  private async textRun(
    leadId: string,
    body: string,
    idempotencyKey: string,
    requested?: DestinationRequest,
  ): Promise<SendTextResult> {
    const run = readRunMode();
    const log = (outcome: CallLogEntry["outcome"], reason: string, extra: Partial<CallLogEntry> = {}) =>
      logCommunication({
        leadId,
        channel: "sms",
        outcome,
        reason,
        requestKey: idempotencyKey,
        ...extra,
      });
    const lead = await this.store.getLead(leadId);
    setTraceLead(lead?.name);
    const suspended = run.mode === "suspended";
    let destination = "";
    if (lead) {
      // The same destination rule as a call: test mode never texts the lead's own number.
      destination = resolveDestination(run, requested, lead.phone);
    }
    const gate = !lead
      ? traceCheck("lead_found", "lead_not_found")
      : (traceCheck("lead_found", null),
        traceMode(run, destination),
        traceCheck("phone_on_file", lead.phone?.trim() ? null : "no_phone") ??
          (await runGates(
            suspended
              ? [
                  ["suppression", () => checkStopAndSuppressionLists(lead)],
                  ["do_not_call", "skipped"],
                  ["test_session_stop", () => (hasTestStop(run.sessionId, leadId) ? "test_session_stop" : null)],
                  ["consent", "skipped"],
                  ["quiet_hours", "skipped"],
                  ["store_reach_rules", "skipped"],
                  ["develop_writes", () => this.store.outboundHold?.() ?? null],
                ]
              : [
                  ["suppression", () => checkSuppression(lead)],
                  ["consent", () => checkSmsConsent(lead)],
                  ["quiet_hours", () => checkQuietHours(lead, this.clock)],
                  ["store_reach_rules", () => this.finalReach(leadId, "text")],
                  ["develop_writes", () => this.store.outboundHold?.() ?? null],
                ],
          )));
    if (gate) {
      log("message_blocked", gate);
      emitTrace("text", { status: "blocked", reason: gate, body });
      return { status: "blocked", reason: gate };
    }
    const key = `sms:${leadId}:${scopedKeyPart(run)}${idempotencyKey}`;
    const claimed = await this.store.tryClaimIdempotency(key);
    if (traceCheck("duplicate_guard", claimed ? null : "duplicate_idempotency_key")) {
      log("skipped", "duplicate_idempotency_key", { idempotencyKey: key });
      emitTrace("text", { status: "skipped", reason: "duplicate_idempotency_key", body });
      return { status: "skipped_duplicate", reason: "duplicate_idempotency_key" };
    }
    // No sender is connected to the harness, so the text is recorded as passing every gate, never as sent.
    log("message_sent", "sms_recorded_no_sender", { idempotencyKey: key });
    emitTrace("text", { status: "recorded", reason: null, body, ...(suspended ? { destination } : {}) });
    return { status: "recorded" };
  }

  /**
   * A person asked to stop. Record it at once (suppression plus consent
   * revocation, in the store), log it, and file a note a person will read.
   * If the store could only hold it in memory, the note says it still needs
   * recording by a person.
   */
  private async handleStop(
    leadId: string,
    callId: string,
    transcript: TranscriptTurn[],
    stop: StopRequest,
    direction: CallDirection,
    log: (outcome: CallLogEntry["outcome"], reason: string, extra?: Partial<CallLogEntry>) => unknown,
    run: RunMode,
    source: "voice_call" | "text" = "voice_call",
  ): Promise<StopResult> {
    const occurredAt = this.clock.now().toISOString();
    // Test mode: the STOP is recorded here and in the harness table only. It must never reach
    // an external STOP function, which could revoke a shared lead.
    const result: StopResult =
      run.mode === "suspended"
        ? await traceTool(
            "record_stop",
            { source, matched: stop.matched, callerWords: stop.callerWords, testMode: true, recordedIn: "local_records_and_harness_table" },
            async (): Promise<StopResult> => {
              recordTestStop({ leadId, sessionId: run.sessionId, callId, source, matched: stop.matched, occurredAt });
              return { recorded: "local_test", note: "test_mode_not_sent_to_crm" };
            },
          )
        : await traceTool(
            "record_stop",
            { source, matched: stop.matched, callerWords: stop.callerWords },
            () =>
              this.store.recordStop({
                leadId,
                callId,
                source,
                matched: stop.matched,
                callerWords: stop.callerWords,
                occurredAt,
              }),
          );
    log("blocked", `stop_recorded_${result.recorded}`, { callId });
    const note = buildHandoffNote(callId, transcript, stop.callerWords, STOP_PROMISE, [], {});
    if (note) {
      const status =
        result.recorded === "local_test"
          ? "TEST MODE: recorded in the local test records only. Nothing was sent to CRM, and no person needs to act."
          : result.recorded === "memory"
            ? `NOT yet recorded in CRM (${result.note ?? "held in memory"}): a person must record it.`
            : "Recorded as a consent revocation and a blocklist entry.";
      const filed = {
        ...note,
        direction,
        narrative: `STOP requested: "${stop.callerWords}". ${status}\n${note.narrative}`,
      };
      await traceTool("append_handoff_note", { callId }, () => this.store.appendHandoffNote(leadId, filed));
      emitTrace("handoff", { filed: true, note: filed }, { flowStep: "handoff" });
    }
    return result;
  }

  /** A text from a lead. A STOP is recorded at once; anything else is left for a person. */
  async receiveText(leadId: string, body: string, requestKey: string): Promise<ReceiveTextResult> {
    const ctx = newTextContext(leadId, "inbound");
    return withOutcome(ctx, () => this.receiveTextRun(leadId, body, requestKey), (r, e) => this.recordRun(ctx, r, e));
  }

  private async receiveTextRun(leadId: string, body: string, requestKey: string): Promise<ReceiveTextResult> {
    const run = readRunMode();
    const log = (outcome: CallLogEntry["outcome"], reason: string, extra: Partial<CallLogEntry> = {}) =>
      logCommunication({ leadId, channel: "sms", direction: "inbound", requestKey, outcome, reason, ...extra });
    const lead = await this.store.getLead(leadId);
    setTraceLead(lead?.name);
    if (traceCheck("lead_found", lead ? null : "lead_not_found")) {
      log("blocked", "lead_not_found");
      emitTrace("text", { status: "received", reason: "lead_not_found", stop: false, body });
      return { status: "no_action" };
    }
    const stop = detectStopRequest(body);
    if (!stop) {
      log("skipped", "inbound_text_not_a_stop");
      emitTrace("text", { status: "received", reason: "inbound_text_not_a_stop", stop: false, body });
      return { status: "no_action" };
    }
    const key = `sms-in:${leadId}:${scopedKeyPart(run)}${requestKey}`;
    const claimed = await this.store.tryClaimIdempotency(key);
    if (traceCheck("duplicate_guard", claimed ? null : "duplicate_idempotency_key")) {
      log("skipped", "duplicate_idempotency_key", { idempotencyKey: key });
      emitTrace("text", { status: "received", reason: "duplicate_idempotency_key", stop: true, body });
      return { status: "duplicate" };
    }
    emitTrace("text", { status: "received", reason: null, stop: true, body });
    const turns: TranscriptTurn[] = [
      { role: "caller", text: body, turnIndex: 0, spoken: true },
      { role: "agent", text: "Understood. I will not contact you again.", turnIndex: 1, spoken: true },
    ];
    const result = await this.handleStop(leadId, `text_${requestKey}`, turns, stop, "inbound", log, run, "text");
    emitTrace("text", { status: "stop_recorded", reason: null, recorded: result.recorded });
    return { status: "stop_recorded", recorded: result.recorded };
  }

  /**
   * Writes the harness table row for one finished call or text, when the store has a table
   * and writes are on. Never stops or fails a run: the local records already hold everything.
   */
  private async recordRun(ctx: TraceContext, result: { status: string; reason?: string; moduleId?: string } | undefined, error?: unknown): Promise<void> {
    const write = this.store.recordHarnessRun?.bind(this.store);
    if (!write) return;
    try {
      const record = recordStore.read(ctx.recordId);
      if (!record) return;
      await write(this.runRow(ctx, record, result, error));
    } catch {
      /* a failed table write is no reason to fail a call */
    }
  }

  private runRow(
    ctx: TraceContext,
    record: HarnessRecord,
    result: { status: string; reason?: string; moduleId?: string } | undefined,
    error: unknown,
  ): HarnessRunRow {
    const cfg = getHarnessConfig();
    const isText = ctx.channel === "sms";
    const mine = isText ? record.events.filter((e) => e.messageId === ctx.messageId) : record.events;
    const texts = isText ? record.texts.filter((t) => t.messageId === ctx.messageId) : [];
    const status = result?.status ?? "failed";
    const mapped: Record<string, HarnessRunStatus> = {
      ai_handled: "answered",
      abandoned: "answered",
      placed: isText ? "placed" : "answered",
      not_answered: "placed",
      sent: "placed",
      stop_recorded: "answered",
      blocked: "blocked",
      skipped_duplicate: "skipped",
      duplicate: "skipped",
      normal_answering: "skipped",
      no_action: "skipped",
      failed: "failed",
    };
    const dispositionEvent = [...mine].reverse().find((e) => e.type === "disposition");
    return {
      attemptId: ctx.callId ?? ctx.messageId ?? ctx.recordId,
      recordId: ctx.recordId,
      kind: isText ? "text" : "call",
      direction: ctx.direction,
      leadId: ctx.leadId,
      status: mapped[status] ?? "failed",
      detailStatus: status,
      reason: result?.reason ?? ctx.lastBlock ?? (error ? errorCode(error) : null),
      transcript: isText ? [] : record.transcript,
      outcome: isText ? (texts[0] ? { ...texts[0] } : null) : (record.outcome ?? null),
      disposition: typeof dispositionEvent?.data.value === "string" ? dispositionEvent.data.value : null,
      handoffNote: isText ? null : (record.handoffNote ?? null),
      traceRef: `${ctx.recordId}.jsonl`,
      testRunTag: cfg.legalBlocks === "suspended" ? TEST_RUN_SOURCE : REAL_RUN_SOURCE,
      testSessionId: cfg.legalBlocks === "suspended" ? cfg.testSessionId : null,
      voiceSetupId: result?.moduleId ?? null,
      decisionSetupId: (this.treeDeps.decisions ?? getDecisionRegistry()).selectedModuleId(),
      promptSetupId: cfg.promptSetupId,
      stopRequested: mine.some((e) => e.type === "tool_call" && e.data.tool === "record_stop"),
      recordedAt: new Date().toISOString(),
    };
  }

  /** The store's own reach rules as the very last gate; null when allowed or the store has none. */
  private async finalReach(leadId: string, channel: "call" | "text"): Promise<string | null> {
    if (!this.store.finalReachCheck) return null;
    try {
      const verdict = await this.store.finalReachCheck(leadId, channel);
      return verdict.allowed ? null : `reach_${verdict.reason}`;
    } catch {
      return "reach_check_failed";
    }
  }

  /** At most two outbound attempts may go unanswered for one agreed slot, counted from the durable records. */
  private async attemptGate(lead: LeadRecord, slot: string, attempt: number): Promise<string | null> {
    const prior = countUnansweredAttempts(lead.id, slot);
    // The store's own claims count too, so purging the record files cannot reset the limit.
    let claimed = 0;
    if (this.store.hasClaim) {
      for (let n = 1; n <= MAX_UNANSWERED_ATTEMPTS; n += 1) {
        // The same scoped slot the claim was made under, so test-session claims count too.
        if (await this.store.hasClaim(deriveCallKey("outbound", { id: lead.id, scheduledOutboundAt: slot }, "", n))) claimed += 1;
      }
    }
    if (attempt > MAX_UNANSWERED_ATTEMPTS || Math.max(prior, claimed) >= MAX_UNANSWERED_ATTEMPTS) return "unanswered_attempt_limit_reached";
    // Order counts only unanswered attempts: a claim also exists for an answered call, which must not open the next attempt.
    if (attempt > 1 && prior < attempt - 1) return "attempt_out_of_order";
    return null;
  }

  /** The context packet for a module. In test mode the lead's real number is replaced by the run's destination. */
  private packetFor(lead: LeadRecord, route: ClearanceRoute) {
    const packet = buildLeadContextPacket(lead);
    return route.mode === "suspended" ? { ...packet, phone: route.destination } : packet;
  }

  /** The scripted loop's agent lines go through the same guard as the tree's, before they are committed. */
  private guardScript(script: TranscriptTurn[], leadId: string, callId: string, direction: CallDirection): TranscriptTurn[] {
    const guard = getAgentLineGuard();
    return script.map((t) => {
      if (t.role !== "agent" || t.turnIndex < 0) return t;
      const out = guard(t.text, {
        leadId,
        callId,
        direction,
        turnIndex: t.turnIndex,
        isDisclosure: false,
        promptSetupId: getHarnessConfig().promptSetupId,
      });
      if (out.verdict !== "unchanged") {
        emitTrace("compliance_check", { check: "agent_line_guard", passed: true, reason: null, verdict: out.verdict, rule: out.rule ?? null, detail: out.reason ?? null });
      }
      return out.text === t.text ? t : { ...t, text: out.text };
    });
  }

  /** Standing rules plus lead packet; traced once and stored on the session. */
  private async bindAgentSystemInstruction(
    lead: LeadRecord,
    packet: ReturnType<typeof buildLeadContextPacket>,
    direction: CallDirection,
    opts: ScenarioRunOptions,
    opening: CallOpening,
  ): Promise<string> {
    // The tree's dialog says the call's opening; the scripted outbound loop has its own first line.
    const disclosure = direction === "inbound" || opts.agent === "decision_tree" ? openingLine(opening) : OUTBOUND_SCRIPTED_OPENING;
    const setupId = opts.promptSetupId ?? "default";
    const systemInstruction = buildHarnessAgentSystemInstruction(setupId, direction, lead, packet, disclosure, opening);
    await traceTool(
      "bind_agent_system_instruction",
      { setupId, direction },
      () => systemInstruction,
      () => ({ charCount: systemInstruction.length, systemInstruction }),
    );
    return systemInstruction;
  }

  /** The judge for the scripted agent's destructive tools (booking, saving a message, writing a quote field), so no agent acts without it. */
  private scriptedGuard(leadId: string, callId: string, opening: CallOpening): ScriptedGuard {
    const judge = this.treeDeps.judge ?? getActionJudge();
    return async (action, payload, turns) => {
      const disclosure: TranscriptTurn = { role: "agent", text: inboundOpeningScript(opening), turnIndex: -1, spoken: true };
      const transcript = turns[0]?.role === "agent" && turns[0].text === disclosure.text ? turns : [disclosure, ...turns];
      const outcome = await guardedAction(
        { judge, leadId, callId },
        {
          action,
          nodeId: "scripted",
          direction: "inbound",
          transcript,
          completed: [],
          payload,
          now: this.clock.now(),
          expectedDisclosure: opening.disclosure,
        },
        async () => true,
      );
      return outcome.allowed;
    };
  }

  /** Runs the decision tree against the caller's lines; every turn is emitted as it happens. */
  private async runTreeDialog(
    lead: LeadRecord,
    session: CallSession,
    direction: CallDirection,
    claimedKey: string,
    opts: ScenarioRunOptions,
    route: ClearanceRoute,
    systemInstruction: string,
    opening: CallOpening,
    tree?: DecisionTree,
  ): Promise<{ script: TranscriptTurn[]; inCall: InCallState }> {
    const judge = this.treeDeps.judge ?? getActionJudge();
    const dialog = new TreeDialog({
      tree: tree ?? this.treeDeps.tree ?? loadActiveTree(),
      decisions: this.treeDeps.decisions ?? getDecisionRegistry(),
      gate: { judge, leadId: lead.id, callId: session.callId },
      actions: storeActionPort({
        store: this.store,
        leadId: lead.id,
        callId: session.callId,
        sendText: (id, body, key) => this.sendText(id, body, key),
      }),
      recorder: new CallDecisionRecorder(),
      direction,
      // A known lead is greeted by the name the lead context gives; otherwise the record's own name.
      firstName: openingFactsFor(lead, direction, { knownLead: opts.playTalk }).leadFirstName ?? lead.name.split(/\s+/)[0] ?? lead.name,
      opening,
      timeZone: lead.timezone ?? "UTC",
      clock: this.clock,
      guardLine: (text, ctx) =>
        getAgentLineGuard()(text, { ...ctx, leadId: lead.id, callId: session.callId, promptSetupId: getHarnessConfig().promptSetupId }),
      // The same scoped slot the outbound attempts were recorded under, so test-mode misses count.
      missedCalls: direction === "inbound" ? countUnansweredAttempts(lead.id, scopedSlot(readRunMode(), lead.scheduledOutboundAt ?? "no-slot")) : 0,
      // What the record says, so the decision model can tell when the caller names a different business.
      lead: { name: lead.name, business: lead.briefing?.business },
    });
    // The voice session reaches the dialog by call id (a cut-off disclosure, the session ending).
    const liveKey = currentTrace()?.callId ?? session.callId;
    liveTreeDialogs.set(liveKey, dialog);
    try {
      const said = await dialog.open();
      // Checked before a single caller line is handled, so a bad tree cannot act under a missing disclosure.
      if (direction === "outbound") this.checkOutboundDisclosure([{ role: "agent", text: said, turnIndex: -1, spoken: true }], opening.disclosure);
      else if (!findInboundDisclosure([{ role: "agent", text: said }], opening.disclosure)) {
        traceCheck("disclosure_first", "inbound_disclosure_not_first");
        throw new Error("inbound_disclosure_not_first");
      }
      opts.onConnected?.({
        callId: currentTrace()?.callId ?? session.callId,
        leadId: lead.id,
        direction,
        idempotencyKey: claimedKey,
        route,
      });
      const source = opts.callerSource ?? sourceFromLines(opts.callerUtterances ?? []);
      for (let line = await source.next(); line !== null; line = await source.next()) {
        if ((await dialog.step(line)).ended) break;
      }
      return { script: prependSystemInstruction(systemInstruction, dialog.transcript), inCall: dialog.inCall };
    } finally {
      if (liveTreeDialogs.get(liveKey) === dialog) liveTreeDialogs.delete(liveKey);
    }
  }

  /** The outbound opening must start with the call's disclosure, word for word, before anything else. */
  private checkOutboundDisclosure(script: TranscriptTurn[], expected: string[]): void {
    const first = script.find((t) => t.role === "agent");
    const ok = outboundDisclosureFirst(first?.text, expected);
    if (traceCheck("disclosure_first", ok ? null : "outbound_disclosure_not_first")) throw new Error("outbound_disclosure_not_first");
  }

  /** Scores the finished call with the post-call judge and records the score. Never stops a call. */
  private async scoreCall(): Promise<void> {
    const ctx = currentTrace();
    const record = ctx ? recordStore.read(ctx.recordId) : undefined;
    if (!record) return;
    try {
      const score = await (this.treeDeps.postCallJudge ?? getPostCallJudge()).judge(record);
      emitTrace("judge_score", { ...score });
    } catch {
      /* a failed score is no reason to fail a call */
    }
  }

  private async consume(
    provider: VoiceProvider,
    session: CallSession,
    script: TranscriptTurn[],
    spokenAgentPrefix?: string,
  ): Promise<TranscriptTurn[]> {
    const events: TranscriptEvent[] = [];
    for await (const ev of provider.streamTranscript(session, script)) events.push(ev);
    return collectFinalTranscript(events, spokenAgentPrefix);
  }

  /** Stores only fields the caller actually said; returns the ones stored. */
  private async persistSlotFills(
    leadId: string,
    callId: string,
    inCall: {
      slotFills: Record<string, string>;
      evidenceBackedFields: Record<string, { value: string; evidenceSpan: string }>;
    },
    transcript: TranscriptTurn[],
    guard: ScriptedGuard,
  ): Promise<Record<string, { value: string; evidenceSpan: string }>> {
    const callerTurns = callerTurnTexts(transcript);
    const candidates = Object.entries(inCall.slotFills).map(([field, value]) => ({
      field,
      value,
      evidenceSpan: inCall.evidenceBackedFields[field]?.evidenceSpan ?? "",
    }));
    const { accepted, rejected } = rejectUnsupportedFields(candidates, callerTurns);
    const stored: Record<string, { value: string; evidenceSpan: string }> = {};
    const reject = (field: string, why: string) => {
      traceCheck(why === "field_rejected_no_evidence" ? "evidence_supports_field" : "store_accepts_field", why, { field });
      logCommunication({
        leadId,
        callId,
        channel: "call",
        direction: "inbound",
        outcome: "blocked",
        reason: `${why}:${field}`,
      });
    };
    for (const r of rejected) reject(r.field, "field_rejected_no_evidence");
    for (const a of accepted) {
      // Evidence in the caller's words is necessary but not enough: the judge decides every write.
      if (!(await guard("save_quote_field", { field: a.field, value: a.value, evidenceSpan: a.evidenceSpan }, transcript))) continue;
      const written = await traceTool(
        "write_quote_field",
        { field: a.field, value: a.value, evidenceSpan: a.evidenceSpan },
        () => this.store.writeQuoteField(leadId, a.field, a.value, a.evidenceSpan, callerTurns),
      );
      if (written) {
        stored[a.field] = { value: a.value, evidenceSpan: a.evidenceSpan };
      } else {
        reject(a.field, "field_rejected_by_store");
      }
    }
    return stored;
  }
}

/**
 * The opening of one call, fixed as the call starts: the recording notice
 * setting is read here, once. An inbound call keeps the confirmation question
 * only when its dialog asks it, a tree with a known-lead start (`dialogTree`);
 * the scripted agent and a tree without that start greet the caller instead,
 * so the recorded opening, the agent's instructions and the dialog agree.
 */
function fixOpening(lead: LeadRecord, direction: CallDirection, dialogTree?: DecisionTree, playTalk = false): CallOpening {
  // A Talk call always plays a call to a lead it knows, so it asks for the lead by name in both directions.
  const opening = callOpening(openingFactsFor(lead, direction, { knownLead: playTalk }));
  if (direction === "inbound" && opening.confirm && !(dialogTree && knownLeadStart(dialogTree))) return { disclosure: opening.disclosure };
  return opening;
}

/**
 * Records the call's opening in the trace once the call is connected, before
 * the agent says anything, so the post-call judge compares the record against
 * the same words the live checks used.
 */
function recordOpening(opening: CallOpening, direction: CallDirection): void {
  emitTrace("tool_call", {
    tool: EXPECTED_OPENING_TOOL,
    inputs: { direction },
    result: { disclosure: opening.disclosure, ...(opening.confirm ? { confirm: opening.confirm } : {}) },
    success: true,
    durationMs: 0,
  });
}

/**
 * Every inbound call opens with the call's disclosure (the artificial intelligence sentence and,
 * while the recording notice is on, the recording sentence). The rule
 * (`findInboundDisclosure`, shared with the live rule judge and the post-call
 * judge): both parts, the artificial intelligence sentence and the recording sentence, are spoken
 * word for word and in that order before the first other agent line. One line
 * or two: a caller line between the two parts is allowed, an agent line other
 * than the second part between them is not, and a part cut off (spoken false)
 * fails. A paraphrase fails.
 */
function assertDisclosureFirst(turns: TranscriptTurn[], expected: string[]): void {
  if (!findInboundDisclosure(turns, expected)) {
    throw new Error("inbound_disclosure_not_first");
  }
}

/**
 * The same check at the end of the call, recorded in the trace as passed or
 * blocked. A missing disclosure in the harness's transcript throws. Then the
 * record is read, since on the live path it holds what the voice model really
 * said (the disclosure may come as two lines with the caller speaking between
 * them); a disclosure the record shows as not said first, or cut off (a part
 * marked not spoken, or a failed disclosure check), is recorded as failed
 * without throwing, so the call still ends, gets its outcome and is scored.
 */
function ensureDisclosureFirst(turns: TranscriptTurn[], expected: string[]): void {
  try {
    assertDisclosureFirst(turns, expected);
  } catch (err) {
    traceCheck("disclosure_first", "inbound_disclosure_not_first");
    throw err;
  }
  const ctx = currentTrace();
  traceCheck("disclosure_first", disclosureHeardAtEnd(turns, ctx ? recordStore.read(ctx.recordId) : undefined, expected));
}

/**
 * The end-of-call reading, given a harness transcript that opens with the
 * disclosure: null when the caller heard it, else the failure reason. The
 * disclosure check events are read against the shape the record's transcript
 * shows (one line or two); with no agent line recorded yet, the harness's own.
 */
export function disclosureHeardAtEnd(
  turns: TranscriptTurn[],
  record?: Pick<HarnessRecord, "transcript" | "events">,
  expected: string[] | undefined = expectedDisclosureOf(record?.events ?? []),
): string | null {
  const events = record?.events ?? [];
  const ownCutOff = findInboundDisclosure(turns, expected)?.parts.some((t) => t.spoken === false) ?? true;
  const recorded = record?.transcript.some((t) => t.role === "agent")
    ? inboundDisclosureHeard(record.transcript, events, expected)
    : inboundDisclosureHeard(turns, events, expected);
  if (recorded === "not_first") return "inbound_disclosure_not_first";
  return !ownCutOff && recorded === "heard" ? null : "inbound_disclosure_cut_off";
}
