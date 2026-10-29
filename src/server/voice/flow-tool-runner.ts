/**
 * The flow tool catalog as model function tools, and one call's runner for
 * them. Shared by the two voice paths whose model calls tools: the gpt-live
 * thinker (Azure runs it through a "responses" delegation) and Azure Voice
 * Live (the speaking model holds the tools itself). One tool list, one
 * dispatcher setup: every function call goes through the flow tool dispatcher
 * (evidence quote checked against the caller's own words, judge gate,
 * after-call filings), the same path the Pipecat flows use.
 */

import { FLOW_TOOL_CATALOG, isDispatched, type FlowToolCatalog, type FlowToolParameters } from "../../flow-tools/catalog.js";
import { realTransferFor, transferToPerson } from "./human-transfer.js";
import { createFlowDispatcher, type DispatchResult, type FlowDispatcher } from "../../flow-tools/dispatch.js";
import { getActionJudge } from "../../judge/index.js";
import { expectedDisclosureOf } from "../../judge/post-call.js";
import type { LeadStore } from "../../store/lead-store-seam.js";
import { emitTrace, runWithTrace, traceBus, type TraceContext } from "../../trace/index.js";
import { systemClock, type Clock } from "../../types/clock.js";

export interface FlowFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: FlowToolParameters;
}

/** The catalog tools the harness dispatcher carries out (nothing not_yet_built, nothing the console bot runs itself), as function tools. Identifiers are never parameters; the dispatcher fills them in. */
export function flowFunctionTools(catalog: FlowToolCatalog = FLOW_TOOL_CATALOG): FlowFunctionTool[] {
  return catalog.tools.filter(isDispatched).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
}

export interface FlowToolCallResult {
  /** The dispatch result as JSON text, for the `function_call_output` item. */
  output: string;
  endCall: boolean;
  /** The dispatch outcome, for the trace: whether the tool ran, and the refusal code when it did not. */
  ok: boolean;
  refusedCode?: string;
}

export interface FlowToolRunner {
  readonly tools: FlowFunctionTool[];
  /** Runs one function call through the flow tool dispatcher. Never throws. */
  call(name: string, args: unknown): Promise<FlowToolCallResult>;
  /** Releases the transcript subscription. Safe to call twice. */
  stop(): void;
}

/** A runner over a dispatcher the caller already built (tests, or a caller with its own transcript feed). */
/** What the model hears back when a tool was refused, with neutralRefusals: no judge reasons, nothing to repeat. */
export const NEUTRAL_REFUSAL_OUTPUT = JSON.stringify({ ok: false, result: "not done", instruction: "Do not say it was saved or done, and do not explain why. Carry on with the conversation." });

/** What the model hears when a quote value has a number the caller did not say. */
export const VALUE_NOT_HEARD_OUTPUT = JSON.stringify({
  ok: false,
  result: "not saved",
  instruction: "Read the number back to the caller as you heard it and ask whether it is right. Save it only after their yes.",
});

/**
 * What the model hears when a tool worked, on a path with neutral outputs: no line to read out (the dispatcher's
 * "Thank you, I have noted that." was being said word for word).
 */
export const NEUTRAL_DONE_OUTPUT = JSON.stringify({ ok: true, result: "done", instruction: "Do not mention it. Ask your next question." });

/** What the model hears when book_producer comes before the read-back and the caller's yes. */
export const NO_READ_BACK_OUTPUT = JSON.stringify({
  ok: false,
  result: "not booked yet",
  instruction: "Read the day, date, time and time zone back to the caller and ask for a yes. Call book_producer again only after the yes.",
});

/** What the model hears when transfer_to_human rang and nobody took the call. */
export const TRANSFER_NO_ANSWER_OUTPUT = JSON.stringify({
  ok: false,
  result: "nobody answered",
  instruction: "Tell the caller in one short sentence that no one could pick up right now, and offer to take a message for a licensed producer. If they want to leave one, use save_message.",
});

/** What the model hears when a person took the call (its session normally stops before this arrives). */
export const TRANSFER_CONNECTED_OUTPUT = JSON.stringify({ ok: true, result: "connected", instruction: "A licensed producer is on the line with the caller now. Say nothing more." });

export function createFlowToolRunner(deps: { dispatcher: FlowDispatcher; catalog?: FlowToolCatalog; trace?: TraceContext; onStop?: () => void; neutralRefusals?: boolean; exclude?: readonly string[] }): FlowToolRunner {
  // Tools this path cannot carry out are not offered at all, so the model never promises what nothing does.
  const tools = flowFunctionTools(deps.catalog ?? FLOW_TOOL_CATALOG).filter((t) => !deps.exclude?.includes(t.name));
  let stopped = false;
  const inTrace = <T>(fn: () => Promise<T>): Promise<T> => (deps.trace ? runWithTrace(deps.trace, fn) : fn());
  return {
    tools,
    async call(name, args) {
      let result: DispatchResult;
      try {
        result = await inTrace(() => deps.dispatcher.dispatch({ name, arguments: args }));
      } catch (err) {
        const reason = err instanceof Error && /^[a-z][a-z0-9_]{0,60}$/.test(err.message) ? err.message : "error";
        result = { ok: false, speakable: "I cannot do that right now.", refused: { code: "run_failed", reason } };
      }
      const body: Record<string, unknown> = { ok: result.ok, speakable: result.speakable };
      if (result.refused) body.refused = result.refused;
      if (result.endCall) body.endCall = true;
      // The refusal code still reaches the trace; only what the model hears changes.
      // Reads (a time check, the lead context) keep their text: the model needs what they found.
      const isRead = (deps.catalog ?? FLOW_TOOL_CATALOG).tools.find((t) => t.name === name)?.risk === "read_only";
      // A transfer that rang: the model says nobody could pick up, or nothing once a person has the call.
      const transferRang = name === "transfer_to_human" && (result.ok || result.refused?.code === "not_done");
      const output = !deps.neutralRefusals || result.endCall
        ? JSON.stringify(body)
        : transferRang
          ? result.ok ? TRANSFER_CONNECTED_OUTPUT : TRANSFER_NO_ANSWER_OUTPUT
        : !result.ok
          ? result.refused?.code === "no_read_back" ? NO_READ_BACK_OUTPUT : result.refused?.code === "value_not_heard" ? VALUE_NOT_HEARD_OUTPUT : NEUTRAL_REFUSAL_OUTPUT
          : isRead ? JSON.stringify(body) : NEUTRAL_DONE_OUTPUT;
      return { output, endCall: result.endCall === true, ok: result.ok, refusedCode: result.refused?.code };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      deps.onStop?.();
    },
  };
}

export interface FlowToolRunnerForCallParams {
  callId: string;
  leadId: string;
  agencyId: string;
  direction: "inbound" | "outbound";
  store: LeadStore;
  clock?: Clock;
  /** Defaults to the call's own context (record id equal to the call id). */
  trace?: TraceContext;
  catalog?: FlowToolCatalog;
  /** The trace tool name for a stop phrase the dispatcher hears (the tree engine owns the real stop path). */
  stopTraceTool: string;
  /** Send a refused call back as NEUTRAL_REFUSAL_OUTPUT instead of the refusal and its reason. */
  neutralRefusals?: boolean;
  /** Catalog tools not offered to the model on this call. */
  exclude?: readonly string[];
}

/**
 * A runner for one call: a flow tool dispatcher behind the action judge, fed
 * the call's spoken lines from the trace bus (caller lines so write tools can
 * check their evidence quote against the caller's own words, agent lines so a
 * confirmation text can be backed). A stop phrase the dispatcher hears is only
 * traced here.
 */
export function createFlowToolRunnerForCall(p: FlowToolRunnerForCallParams): FlowToolRunner {
  const trace: TraceContext = p.trace ?? { leadId: p.leadId, recordId: p.callId, channel: "call", direction: p.direction, callId: p.callId };
  const dispatcher = createFlowDispatcher({
    leadId: p.leadId,
    callId: p.callId,
    agencyId: p.agencyId,
    direction: p.direction,
    clock: p.clock ?? systemClock,
    gate: { judge: getActionJudge(), leadId: p.leadId, callId: p.callId },
    store: p.store,
    catalog: p.catalog,
    // In the development server, transfer_to_human can ring configured test destinations.
    ...(realTransferFor(p.callId) ? { humanTransfer: (request: { reason: string; note?: string }) => transferToPerson(p.callId, request) } : {}),
    // The disclosure this call opened with, as recorded at its start.
    expectedDisclosure: () => expectedDisclosureOf(traceBus.history().filter((e) => e.callId === p.callId)),
    onStop: async () => {
      emitTrace("tool_call", { tool: p.stopTraceTool, inputs: {}, result: null, success: true, durationMs: 0 });
    },
  });
  const unsubscribe = traceBus.subscribe((e) => {
    if (e.callId !== p.callId || (e.type !== "transcript_final" && e.type !== "turn")) return;
    const { role, text, spoken } = e.data as { role?: unknown; text?: unknown; spoken?: unknown };
    if (spoken === false || typeof text !== "string" || !text.trim()) return;
    if (role === "caller") void runWithTrace(trace, () => dispatcher.hearCaller(text)).catch(() => undefined);
    else if (role === "agent") dispatcher.sayAgent(text);
  });
  return createFlowToolRunner({ dispatcher, catalog: p.catalog, trace, onStop: unsubscribe, neutralRefusals: p.neutralRefusals, exclude: p.exclude });
}
