/**
 * Play a lead. `startInteractiveCall` starts a call through the harness, so
 * every compliance gate runs first, the disclosure is the agent's first turn,
 * and each caller line then runs one tree step against the mock decision
 * module. The agent's reply, decisions and judge verdicts arrive as trace
 * events (`transcript_final`, `node_enter`, `decision`, `judge_verdict`,
 * `disposition`), each with `atMs`.
 */

import { CallHarness } from "../harness/call-harness.js";
import type { DestinationRequest } from "../harness/gates.js";
import type { CallDirection } from "../provider/interface.js";
import type { InteractiveCall } from "./interactive-call.js";

export { BlockedInteractiveCall, ClearedInteractiveCall, type InteractiveCall } from "./interactive-call.js";

export interface StartInteractiveParams {
  leadId: string;
  direction: CallDirection;
  /** Defaults to a harness on the system clock and the active lead store. */
  harness?: CallHarness;
  /** Outbound only: why the call is being placed. The lead's text agreement and agreed time are still checked. */
  scheduledReason?: string;
  /** Dev Talk on the control page: skip do-not-call suppression only. */
  playTalk?: boolean;
  /** Where the call goes: "browser", "simulated", "test_phone", or (enforced only) "lead_number". Test mode defaults to "simulated". */
  destination?: DestinationRequest;
}

export function startInteractiveCall(params: StartInteractiveParams): Promise<InteractiveCall> {
  return (params.harness ?? new CallHarness()).startInteractiveCall(params.leadId, params.direction, params.scheduledReason, params.destination, params.playTalk);
}
