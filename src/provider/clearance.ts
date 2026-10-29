/**
 * Call clearance: proof that the harness ran every compliance gate for this
 * exact call. Modules accept only a clearance, and only one issuer exists, so
 * a direct startInboundCall or startOutboundCall cannot place a call.
 */

import type { CallDirection } from "./interface.js";

/** The run's legal-blocks mode, fixed when the clearance is issued. */
export type ClearanceMode = "enforced" | "suspended";

/** Lines that never reach a real telephone number. */
export const SAFE_DESTINATIONS = ["browser", "simulated"] as const;

function isSafeLine(destination: string): boolean {
  return (SAFE_DESTINATIONS as readonly string[]).includes(destination);
}

/**
 * While suspended, the only destinations allowed are the browser line, the
 * simulated line, and the single number allowlisted for testing. Anything else,
 * a lead's real number above all, throws. Enforced runs dial the lead's number.
 */
export function assertDestinationAllowed(mode: ClearanceMode, destination: string, testPhone?: string): void {
  if (mode === "enforced") return;
  if (isSafeLine(destination)) return;
  if (testPhone && /^\+155501\d{2}$/.test(testPhone) && destination === testPhone) return;
  throw new Error("destination_not_allowed_in_test_mode");
}

declare const clearanceBrand: unique symbol;

export interface CallClearance {
  readonly [clearanceBrand]: true;
  readonly leadId: string;
  readonly direction: CallDirection;
  readonly idempotencyKey: string;
  /** Legal-blocks mode of the run that issued this clearance. */
  readonly mode: ClearanceMode;
  /**
   * The only place a module may dial or answer from: "browser", "simulated", the
   * allowlisted test number, or (enforced only) the lead's own number.
   */
  readonly destination: string;
}

export type IssueClearance = (
  leadId: string,
  direction: CallDirection,
  idempotencyKey: string,
  route: { mode: ClearanceMode; destination: string; testPhone?: string },
) => CallClearance;

const issued = new WeakSet<object>();
const redeemed = new WeakSet<object>();
let issuerTaken = false;

/** Callable once per process. CallHarness takes it at load time. */
export function takeClearanceIssuer(): IssueClearance {
  if (issuerTaken) throw new Error("clearance_issuer_already_taken");
  issuerTaken = true;
  return (leadId, direction, idempotencyKey, route) => {
    // Checked again here, so no route can produce a clearance for a real number in test mode.
    assertDestinationAllowed(route.mode, route.destination, route.testPhone);
    const clearance = Object.freeze({ leadId, direction, idempotencyKey, mode: route.mode, destination: route.destination });
    issued.add(clearance);
    return clearance as unknown as CallClearance;
  };
}

/** Throws unless the clearance is genuine, unused, and for exactly this call. */
export function redeemClearance(
  clearance: CallClearance | undefined,
  expected: { leadId: string; direction: CallDirection; idempotencyKey: string },
): void {
  if (!clearance || !issued.has(clearance)) throw new Error("call_not_cleared");
  if (redeemed.has(clearance)) throw new Error("clearance_already_used");
  if (
    clearance.leadId !== expected.leadId ||
    clearance.direction !== expected.direction ||
    clearance.idempotencyKey !== expected.idempotencyKey
  ) {
    throw new Error("clearance_mismatch");
  }
  redeemed.add(clearance);
}

/**
 * A module calls this with the number it is about to dial (or answer from).
 * It must be exactly the clearance's destination: a lead's number passed in
 * test mode throws, and so does anything else that differs.
 */
export function assertDialsClearedDestination(clearance: CallClearance, number: string): void {
  if (!issued.has(clearance)) throw new Error("call_not_cleared");
  if (number !== clearance.destination) throw new Error("destination_not_cleared");
}
