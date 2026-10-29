/**
 * Node's side of the Pipecat Flows runtime (src/orchestration-modules/pipecat/flows_runtime.py) for one call.
 * The runtime runs the compiled decision tree flow and reports here as JSON lines; Node keeps the tree
 * state, the records and the judge. This bridge:
 * - turns node_enter and decision into the same trace events the tree panel reads (src/decision/engine.ts,
 *   enter() and emitDecision()), with module and router "pipecat_flows";
 * - answers judge_request by running the harness judge through guardedAction, as the engine gates a
 *   gated answer, and replies {allow, reason}. Verdict only: nothing runs here, so a reply that comes
 *   after the runtime's timeout cannot act while the flow took the blocked case;
 * - answers tool_call with the flow dispatcher's result (src/flow-tools/dispatch.ts);
 * - passes caller_turn to dispatcher.hearCaller (the stop rule: a stop phrase calls the dispatcher's
 *   onStop, which ends the call) and agent_turn to dispatcher.sayAgent, so the judge sees the transcript.
 * Replies go out through `send` as {"type":"flow_reply","requestId","result"}. Not wired into the
 * Deepgram session yet.
 */

import { readFileSync } from "node:fs";
import { FULL_TREE_FILE } from "../../decision/tree-source.js";
import type { FlowDispatcher } from "../../flow-tools/dispatch.js";
import { guardedAction, type GateContext } from "../../judge/gate.js";
import { JUDGE_ACTIONS, type JudgeAction, type JudgePayload, type JudgeRequest } from "../../judge/types.js";
import { emitTrace } from "../../trace/events.js";
import type { CallFlowStep } from "../../trace/extensions.js";
import type { Clock } from "../../types/clock.js";

export const FLOW_ROUTER = "pipecat_flows";
/** The engine's node id for the interrupt check (src/decision/engine.ts, INTERRUPTS_NODE_ID). */
const INTERRUPTS_NODE_ID = "interrupts";
const INTERRUPT_FUNCTION = "interrupt";

export interface FlowReply {
  type: "flow_reply";
  requestId: string;
  result: unknown;
}

export interface FlowRuntimeBridgeDeps {
  dispatcher: FlowDispatcher;
  gate: GateContext;
  direction: "inbound" | "outbound";
  clock: Clock;
  send: (message: FlowReply) => void;
  /** Which dispositions are durable; defaults to the full tree's list. */
  dispositions?: ReadonlyArray<{ name: string; durable: boolean }>;
}

export interface FlowRuntimeBridge {
  /** One message from the runtime. Returns false for a message it does not know. */
  handle(message: unknown): Promise<boolean>;
}

interface GateAction {
  type?: string;
  reason?: string;
  field?: string;
  kind?: string;
  body?: string;
  from?: string;
}

let fullTreeDispositions: Array<{ name: string; durable: boolean }> | undefined;
function defaultDispositions(): Array<{ name: string; durable: boolean }> {
  fullTreeDispositions ??= (JSON.parse(readFileSync(FULL_TREE_FILE, "utf8")) as { dispositions: Array<{ name: string; durable: boolean }> }).dispositions;
  return fullTreeDispositions;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The judge payload for a gated answer's action, as the engine's runAction builds it. Values the engine
 * takes from the call's variables (an action's `from`) are not known on this side yet, so they are empty.
 */
function actionPayload(action: GateAction): JudgePayload {
  switch (action.type) {
    case "transfer":
      return { reason: action.reason ?? "caller_requested" };
    case "save_quote_field":
      return { field: action.field, value: "" };
    case "save_details":
      return { kind: action.kind, body: "" };
    case "book":
      return { slotIso: "" };
    case "send_text":
      return { body: action.body };
    default:
      return {};
  }
}

export function createFlowRuntimeBridge(deps: FlowRuntimeBridgeDeps): FlowRuntimeBridge {
  const dispositions = deps.dispositions ?? defaultDispositions();
  /** Judged actions the flow took, added to the dispatcher's own for the judge's "completed". */
  const completed: JudgeAction[] = [];
  /**
   * Allowed actions waiting for the runtime's judge_verdict, by function and answer: they count as done only
   * once the runtime confirms it took the answer, since an allow that came after its timeout was not taken.
   */
  const awaiting = new Map<string, JudgeAction[]>();
  const awaitKey = (m: Record<string, unknown>) => `${String(m.function)}:${String(m.answer)}`;
  let nodeId = "flow";
  let flowStep: CallFlowStep | undefined;

  const reply = (requestId: unknown, result: unknown) => {
    if (typeof requestId === "string") deps.send({ type: "flow_reply", requestId, result });
  };

  async function judged(action: JudgeAction, treeNode: string, payload: JudgePayload, earlier: JudgeAction[]) {
    const state = deps.dispatcher.state;
    const request: JudgeRequest = {
      action,
      nodeId: treeNode,
      direction: deps.direction,
      transcript: state.transcript,
      completed: [...state.completed, ...completed, ...earlier],
      payload,
      now: deps.clock.now(),
    };
    return guardedAction(deps.gate, request, async () => true);
  }

  async function judge(m: Record<string, unknown>): Promise<{ allow: boolean; reason: string }> {
    const treeNode = str(m.treeNode) ?? nodeId;
    const action = (m.action && typeof m.action === "object" ? m.action : undefined) as GateAction | undefined;
    const disposition = str(m.disposition);
    if (!action && !disposition) return { allow: false, reason: "the gated answer names no action and no disposition" };
    const steps: Array<{ action: JudgeAction; payload: JudgePayload }> = [];
    if (action) {
      if (!(JUDGE_ACTIONS as readonly string[]).includes(action.type ?? "")) {
        return { allow: false, reason: `the judge has no action ${String(action.type)}` };
      }
      steps.push({ action: action.type as JudgeAction, payload: actionPayload(action) });
    }
    if (disposition) {
      const durable = dispositions.find((d) => d.name === disposition)?.durable ?? false;
      steps.push({ action: "end_with_disposition", payload: { disposition, durable } });
    }
    let reason = "every check passed";
    // As the engine does: an ending after an action is judged with that action already counted as done.
    const passed: JudgeAction[] = [];
    for (const step of steps) {
      const outcome = await judged(step.action, treeNode, step.payload, passed);
      if (!outcome.allowed) return { allow: false, reason: outcome.verdict.reason };
      passed.push(step.action);
      reason = outcome.verdict.reason;
    }
    awaiting.set(awaitKey(m), passed);
    return { allow: true, reason };
  }

  async function handleOnce(m: Record<string, unknown>): Promise<boolean> {
    switch (m.type) {
      case "node_enter": {
        const id = str(m.treeNode);
        if (!id) return true;
        nodeId = id;
        flowStep = str(m.flowStep) as CallFlowStep | undefined;
        deps.dispatcher.setNode(id);
        emitTrace("node_enter", { nodeId: id, label: str(m.label) ?? id, flowNode: str(m.node) ?? id }, flowStep ? { flowStep } : {});
        return true;
      }
      case "decision": {
        const fn = str(m.function) ?? "";
        const decisionNode = fn === INTERRUPT_FUNCTION ? INTERRUPTS_NODE_ID : (str(m.treeNode) ?? nodeId);
        const answer = str(m.answer) ?? "";
        const step = flowStep ?? "discovery";
        emitTrace(
          "decision",
          {
            nodeId: decisionNode,
            function: fn,
            flowNode: str(m.node) ?? null,
            answer,
            reason: "chosen by the language model through the flow's decision function",
            module: FLOW_ROUTER,
            router: FLOW_ROUTER,
            routed: "proceed",
            ...(typeof m.latencyMs === "number" ? { latencyMs: m.latencyMs } : {}),
          },
          {
            flowStep: step,
            decision: { step: decisionNode, noticed: "the language model called " + fn, chose: answer, ruleOrPlaybookItem: `flow:${decisionNode}:${answer}` },
          },
        );
        return true;
      }
      case "judge_request": {
        let result: { allow: boolean; reason: string };
        try {
          result = await judge(m);
        } catch {
          result = { allow: false, reason: "the judge could not run, so the answer was refused" };
        }
        reply(m.requestId, result);
        return true;
      }
      case "judge_verdict": {
        const taken = awaiting.get(awaitKey(m));
        awaiting.delete(awaitKey(m));
        if (m.allowed === true && taken) completed.push(...taken);
        // guardedAction already traced the verdict; only a verdict the runtime stopped waiting for is new.
        if (m.timedOut === true) emitTrace("judge_error", { action: "flow_gate", code: "judge_timed_out", function: str(m.function) ?? null });
        return true;
      }
      case "tool_call":
        reply(m.requestId, await deps.dispatcher.dispatch({ name: str(m.name) ?? "", arguments: m.arguments }));
        return true;
      case "caller_turn":
        if (typeof m.text === "string") await deps.dispatcher.hearCaller(m.text);
        return true;
      case "agent_turn":
        if (typeof m.text === "string") deps.dispatcher.sayAgent(m.text);
        return true;
      case "disposition": {
        const value = str(m.disposition);
        if (value) emitTrace("disposition", { value, nodeId, flowNode: str(m.node) ?? null });
        return true;
      }
      default:
        return false;
    }
  }

  return {
    async handle(message) {
      if (!message || typeof message !== "object") return false;
      return handleOnce(message as Record<string, unknown>);
    },
  };
}
