/**
 * The step-by-step conversation on Azure Voice Live ("keep building it"), from the five-step flow
 * shared with the Pipecat engine: src/decision-tree/five-steps.flow.yaml, a copy, unchanged, of the engine flow
 * store's five_steps_speaking (research note generates it from the engine's quote flow; the flow store version
 * leads). It is one Pipecat FlowConfig written as JSON, so JSON.parse reads it here and the engine reads it as YAML.
 * Steps are moved by the speaking model.
 *
 * This module turns each node into what one Voice Live session.update carries, since a later update replaces the
 * instructions and the whole tools list (wire check, 2026-10-21): the start node's role message (the shared core,
 * placeholders filled), the lead context, the node's task message, and a short note on how this line's tools work;
 * plus the node's tools and one function per edge. The session sends one update at each transition, none per turn.
 *
 * What differs from the engine, and why (nothing else does):
 * - Tool names. The engine's take_message runs the harness's save_message, under the engine's name so the step text
 *   and the tool match; send_quote_link runs send_text. On producer_call a day and time is booked for real
 *   (check_appointment_time, a read-back, book_producer) instead of taken as a message.
 * - The producer check and the transfer: there is no way to ask whether the producer is free, so check_producer_available
 *   goes to producer_available, where transfer_to_producer runs the harness's transfer_to_human (it rings configured
 *   Dana's cell, as the call setup dialog chooses). The transfer itself answers the question: a person took the call
 *   (transferred, and the agent's session stops), or nobody did (producer_unavailable, a message offered).
 * - The engine saves the quote numbers in the background (extract_quote_fields) and starts the quote by code once
 *   they are known (route_after_reply). Here the speaking model saves them with write_quote_field and calls
 *   request_quote, which moves the call to deliver_quote.
 * - end_call on every step but the last, so a request to stop ends the call from anywhere and is recorded.
 * - The opening: the engine says it before the flow starts; here the model says it, so the session starts on
 *   openingInstructions and moves to the start node once the opening reply is done.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallFlowStep } from "../trace/extensions.js";
import type { VoiceLiveFlowController, VoiceLiveFunctionTool } from "./azure-voice-live-session.js";

export const FIVE_STEPS_FLOW_FILE = fileURLToPath(new URL("../decision-tree/five-steps.flow.yaml", import.meta.url));

interface FlowFunction {
  name: string;
  description?: string;
  transition_to?: string | { field?: string; cases?: Record<string, string> };
  transition_only?: boolean;
}

interface FlowNode {
  role_message?: string;
  task_messages?: Array<{ role?: string; content?: string }>;
  functions?: FlowFunction[];
  pre_actions?: Array<{ type?: string }>;
  post_actions?: Array<{ type?: string }>;
  respond_immediately?: boolean;
}

export interface FiveStepsFlow {
  /** The file read, and the first 12 hexadecimal characters of its SHA-256, for the record. */
  file: string;
  hash: string;
  initialNode: string;
  nodes: Record<string, FlowNode>;
}

/** Reads the shared flow at call time (an edited file applies to the next call), refusing one with a missing node. */
export function loadFiveStepsFlow(file: string = FIVE_STEPS_FLOW_FILE): FiveStepsFlow {
  const text = readFileSync(file, "utf8");
  const data = JSON.parse(text) as { initial_node?: unknown; nodes?: unknown };
  const nodes = (data.nodes && typeof data.nodes === "object" ? data.nodes : {}) as Record<string, FlowNode>;
  if (typeof data.initial_node !== "string" || !nodes[data.initial_node]) throw new Error("voice_live_flow_invalid");
  for (const node of Object.values(nodes)) {
    for (const fn of node.functions ?? []) {
      const to = fn.transition_to;
      const targets = typeof to === "string" ? [to] : Object.values(to?.cases ?? {});
      if (targets.some((t) => !nodes[t])) throw new Error("voice_live_flow_invalid");
    }
  }
  return { file, hash: createHash("sha256").update(text).digest("hex").slice(0, 12), initialNode: data.initial_node, nodes };
}

/** The stage each engine node stands for on the console's stage strip (the same table as web/src/lib/pipecat-trace.ts). */
const NODE_STEPS: Readonly<Record<string, CallFlowStep>> = {
  greet: "disclosure",
  callback: "recognize_lead",
  wrong_person: "recognize_lead",
  collect_quote_info: "quote_fields",
  deliver_quote: "quote_fields",
  producer_available: "handoff",
  transferred: "handoff",
  producer_unavailable: "booking",
  producer_call: "booking",
  wrap_up: "booking",
  end: "booking",
};

/** The engine's tool names that run a harness tool here, under the engine's name. */
const RUNS_AS: Readonly<Record<string, string>> = { take_message: "save_message", send_quote_link: "send_text", transfer_to_producer: "transfer_to_human" };

/** Harness tools a node adds, with where a call moves (only when the tool worked), and what this line says about them. */
const ADDED: Readonly<Record<string, { tools: ReadonlyArray<{ name: string; to?: string }>; note?: string }>> = {
  collect_quote_info: {
    tools: [{ name: "write_quote_field" }, { name: "request_quote", to: "deliver_quote" }],
    note:
      "On this line you save the numbers yourself, each with write_quote_field in the same turn as your next question: the head count as employee_count, " +
      "one value such as '3 full-time, 1 part-time'; the yearly payroll as payroll, one value such as '$250,000 full-time, $40,000 part-time', saved after they confirm your read-back. " +
      "Revenue, email and EIN have no field here: just ask. When the employee count and payroll are saved and the last missing detail is given, ask \"Can we text you the quote at this number?\" as this step says; " +
      "when they answer it, call request_quote by itself: it starts the quote and moves the call on, and the next step acts on their answer.",
  },
  deliver_quote: {
    tools: [{ name: "write_quote_field" }, { name: "save_contact_detail" }],
    note:
      "On this line, when they say yes to the text: save quote_channel as 'text' with write_quote_field, then call send_quote_link with the template quote_follow_up. " +
      "For email: save quote_channel as 'email' with write_quote_field and their address with save_contact_detail, then call no_text.",
  },
  producer_call: {
    tools: [{ name: "check_appointment_time" }, { name: "book_producer", to: "wrap_up" }],
    note:
      "On this line a day and time is booked for real, not taken as a message: call check_appointment_time with it, read back the exact day, date, time and time zone it gives you, " +
      "and after their yes call book_producer; it moves the call on. Where this step says take_message for a day and time, that is the booking. " +
      "Use take_message only for a callback note when they will not pick a time.",
  },
};

/** How the tools of every step work on this line, after each node's own text. */
const TOOLS_NOTE =
  "Tools on this line. evidence_quote is the caller's own words copied exactly, nothing you said. Never name a tool, and never say 'noted' or 'saved'. " +
  "A function with nothing to fill in only moves the call on: call it by itself, without saying anything, and the next step's first line follows. " +
  "take_message carries the caller's own words, copied exactly, as its body (plus who they are when it is not the lead). " +
  "If the caller asks you to stop calling, say a short goodbye and call end_call.";

export interface VoiceLiveFlowValues {
  /** The opening line, word for word (the session asks for it once, at the start). */
  opening: string;
  firstName: string;
  producer: string;
  agency: string;
  /** The business name, or "their business" when none is on file. */
  business: string;
  /** The lead context block the one-prompt path also gets. */
  leadBlock: string;
}

function fill(text: string, v: VoiceLiveFlowValues): string {
  const values: Record<string, string> = { opening: v.opening, firstName: v.firstName, producer: v.producer, agency: v.agency, business: v.business, callContext: "" };
  return text.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

const noParameters = { type: "object", properties: {}, additionalProperties: false };

/**
 * The flow for one call: `offered` is the harness's tool list for the path (already without the tools not offered),
 * so a step never offers a tool the dispatcher cannot run.
 */
export function buildVoiceLiveFlow(flow: FiveStepsFlow, v: VoiceLiveFlowValues, offered: readonly VoiceLiveFunctionTool[]): VoiceLiveFlowController {
  const tool = (name: string) => offered.find((t) => t.name === name);
  const core = fill(flow.nodes[flow.initialNode]?.role_message ?? "", v);
  const head = [core, v.leadBlock].filter((s) => s.trim()).join("\n\n");
  type Step = { tools: VoiceLiveFunctionTool[]; calls: Map<string, { runs?: string; to?: string; failedTo?: string; onlyIfOk: boolean; transitionOnly?: boolean }> };
  const steps = new Map<string, Step>();
  const stepOf = (id: string): Step => {
    const known = steps.get(id);
    if (known) return known;
    const node = flow.nodes[id] ?? {};
    const added = ADDED[id];
    const tools: VoiceLiveFunctionTool[] = [];
    const calls: Step["calls"] = new Map();
    const offer = (def: VoiceLiveFunctionTool | undefined, as: string, call: { runs?: string; to?: string; failedTo?: string; onlyIfOk: boolean; transitionOnly?: boolean }) => {
      if (!def || calls.has(as)) return;
      tools.push({ ...def, name: as });
      calls.set(as, call);
    };
    for (const fn of node.functions ?? []) {
      const to = fn.transition_to;
      if (fn.transition_only && typeof to === "string") {
        offer({ type: "function", name: fn.name, description: fn.description ?? fn.name, parameters: noParameters }, fn.name, { to, onlyIfOk: false, transitionOnly: true });
      } else if (fn.name === "check_producer_available") {
        // No availability check here: the call goes to the step that tries the transfer, which answers the question.
        const available = typeof to === "object" ? to.cases?.true : undefined;
        if (available) offer({ type: "function", name: fn.name, description: `They ask to speak with ${v.producer} or a person now.`, parameters: noParameters }, fn.name, { to: available, onlyIfOk: false, transitionOnly: true });
      } else if (fn.name === "transfer_to_producer" && typeof to === "object" && to.cases?.true && to.cases.false) {
        // A person took the call (transferred) or nobody did (the "not available" step, which offers a message).
        offer(tool("transfer_to_human"), fn.name, { runs: "transfer_to_human", to: to.cases.true, failedTo: to.cases.false, onlyIfOk: true });
      } else if (RUNS_AS[fn.name] && typeof to === "string") {
        // The step moves on once the message is really saved, or the text really sent; otherwise it stays, to try again.
        offer(tool(RUNS_AS[fn.name]!), fn.name, { runs: RUNS_AS[fn.name], to, onlyIfOk: true });
      }
    }
    for (const extra of added?.tools ?? []) offer(tool(extra.name), extra.name, { ...(extra.to ? { to: extra.to } : {}), onlyIfOk: true });
    const ends = (node.post_actions ?? []).some((a) => a.type === "end_conversation");
    if (!ends) offer(tool("end_call"), "end_call", { onlyIfOk: false });
    const step = { tools, calls };
    steps.set(id, step);
    return step;
  };
  return {
    start: flow.initialNode,
    source: { file: flow.file.split("/").pop() ?? flow.file, hash: flow.hash },
    openingInstructions: `${head}\n\nThe call just connected. Your first line is the opening, word for word: "${v.opening}" Say it, then stop and wait for their reply.`,
    node(id) {
      const node = flow.nodes[id] ?? {};
      const task = (node.task_messages ?? []).map((m) => fill(m.content ?? "", v)).join("\n\n");
      const note = ADDED[id]?.note;
      return {
        label: id.replace(/_/g, " "),
        ...(NODE_STEPS[id] ? { flowStep: NODE_STEPS[id] } : {}),
        instructions: [head, `This step (${id}):\n${task}`, ...(note ? [note] : []), ...((node.post_actions ?? []).some((a) => a.type === "end_conversation") ? [] : [TOOLS_NOTE])].join("\n\n"),
        tools: stepOf(id).tools,
        endsCall: (node.post_actions ?? []).some((a) => a.type === "end_conversation"),
        // Pipecat Flows' default: a node speaks first on entry unless it says otherwise (the start node waits).
        respondImmediately: node.respond_immediately !== false,
      };
    },
    call(from, name) {
      return stepOf(from).calls.get(name);
    },
  };
}
