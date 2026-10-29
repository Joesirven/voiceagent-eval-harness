import type { SortedEvent } from "../../../src/server/live-view-core.js";

export type OrbState = null | "thinking" | "listening" | "talking" | "working";

const TALK_HOLD_MS = 2500;
const THINK_HOLD_MS = 4000;
const WORK_HOLD_MS = 3000;

/** Tool rows that mean the agent is running a tool or a step for its reply. */
const WORKING_TOOLS = new Set(["voice_live_tool_call", "thinker_tool_call", "flow_tool_call", "decision_step", "thinker_delegation_updated", "steer_voice_model"]);

/**
 * What the orb shows, one of five states. Not in a call: idle (null). In a call: "talking" while the agent's words are
 * arriving, "working" right after a tool or a step ran for the reply, "thinking" right after the caller finished and a
 * decision or judge row is landing, otherwise "listening".
 */
export function orbState(sorted: SortedEvent[], inCall: boolean, nowMs: number): OrbState {
  if (!inCall) return null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    const age = nowMs - Date.parse(e.at);
    if (e.type === "transcript_partial" || e.type === "transcript_final") {
      if (e.data.role === "agent") return age <= TALK_HOLD_MS ? "talking" : "listening";
      return "listening";
    }
    if (e.type === "tool_call" && WORKING_TOOLS.has(String(e.data.tool))) {
      return age <= WORK_HOLD_MS ? "working" : "listening";
    }
    if (e.type === "decision" || e.type === "node_enter" || e.type === "judge_verdict" || e.type === "disposition") {
      return age <= THINK_HOLD_MS ? "thinking" : "listening";
    }
  }
  return "listening";
}
