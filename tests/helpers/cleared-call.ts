import { setAiCallingEnabled } from "../../src/config.js";
import { startInteractiveCall } from "../../src/decision/interactive.js";
import type { InteractiveCall } from "../../src/decision/interactive-call.js";
import { CallHarness } from "../../src/harness/call-harness.js";
import { seedLead } from "../../src/store/lead-store.js";
import { baseLead } from "./fixtures.js";

/**
 * A call the harness really cleared and connected (test mode, simulated line),
 * because a live voice session opens for nothing else. The tree's opening line
 * is already on the trace bus; callers that count lines reset the bus after this.
 */
export async function clearedTestCall(): Promise<InteractiveCall> {
  setAiCallingEnabled("agency-demo", true);
  seedLead(baseLead());
  const call = await startInteractiveCall({ leadId: "lead-1", direction: "inbound", harness: new CallHarness({ now: () => new Date("2026-10-15T14:00:00Z") }) });
  if (call.status !== "connected") throw new Error(`test_call_not_connected:${call.blockedReason ?? "unknown"}`);
  return call;
}
