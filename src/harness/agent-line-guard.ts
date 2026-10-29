/**
 * The hook for the behaviour-layers workstream's `guardAgentLine(text, ctx)`.
 * It runs on every agent line before the line is committed to the transcript or
 * played. Until that workstream merges, the default does nothing. The opening
 * disclosure is never rewritten: the harness owns it.
 */

export interface AgentLineContext {
  leadId: string;
  callId: string;
  direction: "inbound" | "outbound";
  /** The decision-tree node the line belongs to; absent for the scripted loop. */
  nodeId?: string;
  turnIndex: number;
  /** True for the opening disclosure. A guard must return it unchanged. */
  isDisclosure: boolean;
  /** The prompt setup in force. */
  promptSetupId: string;
}

export interface GuardedAgentLine {
  /** The text to commit and play. */
  text: string;
  verdict: "unchanged" | "rewritten" | "replaced";
  /** The enforcement rule that fired, when one did. */
  rule?: string;
  reason?: string;
}

export type GuardAgentLine = (text: string, ctx: AgentLineContext) => GuardedAgentLine;

export const noopGuardAgentLine: GuardAgentLine = (text) => ({ text, verdict: "unchanged" });

let guard: GuardAgentLine = noopGuardAgentLine;

export function getAgentLineGuard(): GuardAgentLine {
  return guard;
}

/** The behaviour-layers module installs its guard here. Pass null to restore the no-op. */
export function setAgentLineGuard(next: GuardAgentLine | null): void {
  guard = next ?? noopGuardAgentLine;
}
