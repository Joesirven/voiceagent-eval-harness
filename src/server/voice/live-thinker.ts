/**
 * The thinker for the direct Azure gpt-live path (no Pipecat): a fast reasoning
 * model that Azure runs itself through the live protocol's "responses"
 * delegation. gpt-live-1 stays the speaker and keeps answering simple turns from
 * its steps and the lead facts; when it needs a tool, or would have to guess a
 * fact, it opens a delegation and Azure runs the thinker with the harness flow
 * tool catalog as its tools. Every function call the thinker makes is carried
 * out here by the flow tool dispatcher (judge gate, evidence checks, after-call
 * filings), the same path the Pipecat flows use. This mirrors the console bot's
 * gpt_live.py (console-standard/bot), written fresh for the Node session.
 *
 * Protocol, as probed on 2026-10-20: session.start carries
 * `session.delegation = {type:"responses", responses:{model, instructions,
 * reasoning:{effort}, tools, tool_choice}}`; the thinker's events come back
 * wrapped as `response.event`; a function result goes back as
 * `response.item.create` with a `function_call_output` item, then
 * `response.create`; `session.update` with a new delegation replaces the
 * thinker's instructions and tools mid-call. The session module
 * (src/modules/azure-live-session.ts) speaks that protocol; this module builds
 * the delegation and runs the calls.
 */

import { loadAzureCredentials, type ConnectorEnv } from "../../connectors/credentials.js";
import { FLOW_TOOL_CATALOG, type FlowToolCatalog } from "../../flow-tools/catalog.js";
import type { FlowDispatcher } from "../../flow-tools/dispatch.js";
import type { LeadStore } from "../../store/lead-store-seam.js";
import type { TraceContext } from "../../trace/index.js";
import type { Clock } from "../../types/clock.js";
import { DEFAULT_DECISION_CHAT_DEPLOYMENT } from "../live-judge-wiring.js";
import { createFlowToolRunner, createFlowToolRunnerForCall, flowFunctionTools, type FlowFunctionTool, type FlowToolCallResult, type FlowToolRunner } from "./flow-tool-runner.js";

/**
 * Unset or "off": no thinker. "on": the default deployment (AZURE_REPLY_DEPLOYMENT,
 * else AZURE_FAST_DEPLOYMENT, else the decision layer's default chat deployment).
 * Anything else: the deployment name to use.
 */
export const LIVE_THINKER_ENV = "VOICE_HARNESS_LIVE_THINKER";

/** How long a function result waits for a second call of the same turn before `response.create` goes out. */
export const THINKER_RESULT_SETTLE_MS = 250;

export interface LiveThinkerStatus {
  enabled: boolean;
  deployment?: string;
  /** The catalog tools the thinker may call, names only. */
  tools: string[];
}

/** The default thinker deployment, from the credentials file when it is configured and readable; never a credential value. */
function defaultThinkerDeployment(env: ConnectorEnv): string {
  try {
    const creds = loadAzureCredentials(env);
    return creds.replyDeployment || creds.fastDeployment || DEFAULT_DECISION_CHAT_DEPLOYMENT;
  } catch {
    return DEFAULT_DECISION_CHAT_DEPLOYMENT;
  }
}

/** What /api/state shows: whether the thinker is on, which deployment, which tool names. */
export function liveThinkerStatus(env: ConnectorEnv = process.env): LiveThinkerStatus {
  const raw = env[LIVE_THINKER_ENV]?.trim() ?? "";
  if (!raw || raw.toLowerCase() === "off") return { enabled: false, tools: [] };
  const deployment = raw.toLowerCase() === "on" ? defaultThinkerDeployment(env) : raw;
  return { enabled: true, deployment, tools: thinkerTools().map((t) => t.name).filter((n) => !TOOLS_NOT_OFFERED.includes(n)) };
}

export type ThinkerTool = FlowFunctionTool;

/**
 * Catalog tools neither Azure path offers its model (gpt-live-1's thinker and Voice Live alike), because they refuse
 * on this harness today: book_callback, cancel_appointment, mark_not_eligible, list_available_producers and
 * check_quote_status (a seat session, an admin credential or a database client is needed), email_document (no test
 * address configured yet). A callback request goes to save_message instead. send_text and request_quote run through
 * External CRM actions can run on both Azure paths. transfer_to_human rings configured test destinations and
 * bridges the caller (src/server/voice/human-transfer.ts), offered on both Azure paths too.
 */
export const TOOLS_NOT_OFFERED: readonly string[] = [
  "book_callback", "cancel_appointment", "email_document", "mark_not_eligible",
  "list_available_producers", "check_quote_status",
];

/** The catalog tools the harness dispatcher carries out, in the shape the responses delegation takes (the shared list in flow-tool-runner.ts). */
export function thinkerTools(catalog: FlowToolCatalog = FLOW_TOOL_CATALOG): ThinkerTool[] {
  return flowFunctionTools(catalog);
}

const THINKER_PREAMBLE =
  "You are the thinking half of a phone agent: you decide what the agent says next, and a voice model says it in its own words. " +
  "Write only what the agent should say in its next turn (one short spoken turn, plain sentences, no markdown, no lists, no labels, no stage directions), or call a tool. " +
  "Tools: call a write tool only after the caller said the fact in their own words, and pass their exact words as evidence_quote. " +
  "Never say something is saved, booked, sent or ended until the tool result says so. " +
  "When instructions below conflict, the latest one wins.";

/**
 * The thinker's instructions: the preamble, the agent's full instructions (lead context included), then the current
 * step guidance when there is one, then the latest call context note (the objectives update) when there is one.
 */
export function thinkerInstructions(agentInstructions: string, guidance?: string, note?: string): string {
  const parts = [THINKER_PREAMBLE, agentInstructions.trim()];
  const step = guidance?.trim();
  if (step) parts.push(`Current step guidance from the decision module: ${step}`);
  const context = note?.trim();
  if (context) parts.push(context);
  return parts.join("\n\n");
}

/**
 * Appended to the speaker's session instructions when the thinker is on. Softer
 * than the console bot's speaker instructions : on this path
 * gpt-live-1 answers simple turns itself from the steps and the facts, and asks
 * its thinker only for tools and unknown facts. Nothing here asks the speaker to
 * repeat lines word for word; that wording tripped Azure moderation.
 */
export function thinkerSpeakerNote(guided: boolean): string {
  return (
    `Tools on this call. ${guided ? "The decision module's guidance still decides what you say; you never take over the conversation. " : ""}` +
    "When a step needs a tool (saving a fact the caller just stated, recording their yes to the quote by text, noting a number or an email, checking or booking a time, taking a message, sending the one text they said yes to, starting their quote, ending the call with its outcome), delegate it, and pass the caller's own words. " +
    "Read a dollar amount back and wait for the caller's yes before you delegate saving it. For a time, delegate the check, read back once the exact day, date, time and time zone that come back, and delegate the booking only after the caller's yes. " +
    `While a tool runs, acknowledge in two or three words ("Got it.") and carry on${guided ? " with the guidance" : ""}. ` +
    "Never read out markdown, lists or labels. Never say that something is saved, booked, sent or ended until you are told it is done."
  );
}

/** The note with the decision tree on; without it  the speaker runs the call and thinkerSpeakerNote(false) drops the guidance wording. */
export const THINKER_SPEAKER_NOTE = thinkerSpeakerNote(true);

export type LiveThinkerCallResult = FlowToolCallResult;

export interface LiveThinker {
  /** The `session.delegation` object for session.start and session.update, with the current step guidance and the latest context note folded into the instructions. */
  delegation(guidance?: string, note?: string): Record<string, unknown>;
  /** Runs one of the thinker's function calls through the flow tool dispatcher. Never throws. */
  call(name: string, args: unknown): Promise<LiveThinkerCallResult>;
  /** Releases the transcript subscription. */
  stop(): void;
}

export interface LiveThinkerDeps {
  deployment: string;
  /** The speaker's full system prompt, lead context included. */
  agentInstructions: string;
  dispatcher: FlowDispatcher;
  catalog?: FlowToolCatalog;
  effort?: "low" | "minimal";
  /** The call's trace, so the dispatcher's own trace events land on the call record. */
  trace?: TraceContext;
  /** Called once from stop(). */
  onStop?: () => void;
}

export function createLiveThinker(deps: LiveThinkerDeps): LiveThinker {
  return thinkerOver(createFlowToolRunner({ dispatcher: deps.dispatcher, catalog: deps.catalog, trace: deps.trace, onStop: deps.onStop }), deps);
}

/** The delegation around a tool runner: the runner carries out the calls, the delegation hands Azure its tools. */
function thinkerOver(runner: FlowToolRunner, deps: { deployment: string; agentInstructions: string; effort?: "low" | "minimal" }): LiveThinker {
  return {
    delegation(guidance, note) {
      return {
        type: "responses",
        responses: {
          model: deps.deployment,
          instructions: thinkerInstructions(deps.agentInstructions, guidance, note),
          reasoning: { effort: deps.effort ?? "low" },
          tools: runner.tools,
          tool_choice: "auto",
        },
      };
    },
    call: (name, args) => runner.call(name, args),
    stop: () => runner.stop(),
  };
}

export interface LiveThinkerForCallParams {
  callId: string;
  leadId: string;
  agencyId: string;
  direction: "inbound" | "outbound";
  agentInstructions: string;
  deployment: string;
  store: LeadStore;
  clock?: Clock;
  /** Defaults to the call's own context (record id equal to the call id). */
  trace?: TraceContext;
  catalog?: FlowToolCatalog;
  /** How the thinker uses its tools (the rules both Azure paths share), after the agent's instructions. */
  toolRules?: string;
  /** Catalog tools not offered (TOOLS_NOT_OFFERED on the live paths). */
  exclude?: readonly string[];
  /** Refusals and plain successes go back as short neutral results, as on Voice Live (flow-tool-runner.ts). */
  neutralRefusals?: boolean;
}

/**
 * A thinker for one call: a flow tool dispatcher behind the action judge, fed
 * the call's spoken lines from the trace bus (caller lines so write tools can
 * check their evidence quote against the caller's own words, agent lines so a
 * confirmation text can be backed). The tree engine owns the real stop path; a
 * stop phrase the dispatcher hears is only traced here.
 */
export function createLiveThinkerForCall(p: LiveThinkerForCallParams): LiveThinker {
  const runner = createFlowToolRunnerForCall({
    callId: p.callId,
    leadId: p.leadId,
    agencyId: p.agencyId,
    direction: p.direction,
    store: p.store,
    clock: p.clock,
    trace: p.trace,
    catalog: p.catalog,
    stopTraceTool: "thinker_stop_heard",
    neutralRefusals: p.neutralRefusals,
    exclude: p.exclude,
  });
  const rules = p.toolRules?.trim();
  return thinkerOver(runner, { deployment: p.deployment, agentInstructions: rules ? `${p.agentInstructions}\n\n${rules}` : p.agentInstructions });
}
