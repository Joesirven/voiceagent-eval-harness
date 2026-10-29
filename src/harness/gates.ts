/**
 * Test mode, in one place: the mode snapshot a run reads once, the destination
 * rules, the scoping of keys to a test session, and a gate runner that shows
 * every skipped gate in the trace as skipped (never passed, never silent).
 */

import { getHarnessConfig, type LegalBlocks } from "../config.js";
import { assertDestinationAllowed } from "../provider/clearance.js";
import { emitTrace, traceCheck } from "../trace/index.js";

/** Read once at the top of a call or text. Gates and the clearance use this value, never the live config. */
export interface RunMode {
  mode: LegalBlocks;
  sessionId: string;
  testPhone?: string;
}

export function readRunMode(): RunMode {
  const cfg = getHarnessConfig();
  return { mode: cfg.legalBlocks, sessionId: cfg.testSessionId, testPhone: cfg.testPhone };
}

export const SKIPPED_RESULT = "skipped: test mode";

/** Where a call or text is meant to go. "lead_number" is the lead's own number, allowed only when enforced. */
export type DestinationRequest = "lead_number" | "browser" | "simulated" | "test_phone";

/** The one destination this run may use; throws when test mode would reach anything real. */
export function resolveDestination(run: RunMode, requested: DestinationRequest | undefined, leadPhone: string): string {
  const want = requested ?? (run.mode === "enforced" ? "lead_number" : "simulated");
  let destination: string;
  if (want === "lead_number") {
    if (run.mode === "suspended") throw new Error("lead_number_refused_in_test_mode");
    destination = leadPhone;
  } else if (want === "test_phone") {
    if (!run.testPhone) throw new Error("test_phone_not_configured");
    destination = run.testPhone;
    // An allowlisted test phone that is also this lead's number would reach the lead.
    const digits = (text: string) => {
      const raw = text.replace(/\D/g, "");
      return raw.length === 10 ? `1${raw}` : raw;
    };
    if (run.mode === "suspended" && digits(destination) === digits(leadPhone)) throw new Error("lead_number_refused_in_test_mode");
  } else if (want === "browser" || want === "simulated") {
    destination = want;
  } else {
    throw new Error("unknown_destination");
  }
  assertDestinationAllowed(run.mode, destination, run.testPhone);
  return destination;
}

/** The slot and keys are scoped to the test session only while suspended, so enforced keys are unchanged. */
export function scopedSlot(run: RunMode, slot: string): string {
  return run.mode === "suspended" ? `test:${run.sessionId}:${slot}` : slot;
}

export function scopedKeyPart(run: RunMode): string {
  return run.mode === "suspended" ? `test:${run.sessionId}:` : "";
}

/** A gate that did not run. Never sets `passed: true` and never counts as a block. */
export function traceSkipped(check: string, result: string = SKIPPED_RESULT): void {
  emitTrace("compliance_check", { check, passed: null, skipped: true, result, reason: null });
}

/** Marks the run itself as test mode, once, so the trace says why gates are skipped. */
export function traceMode(run: RunMode, destination: string): void {
  if (run.mode !== "suspended") return;
  emitTrace("compliance_check", {
    check: "legal_blocks",
    passed: null,
    mode: "suspended",
    result: "suspended: test mode",
    reason: null,
    destination,
    testSessionId: run.sessionId,
  });
}

/** The compliance_check row of a Talk call whose compliance checks are switched off (HarnessConfig.complianceChecksOff). */
export const COMPLIANCE_CHECKS_OFF_RESULT = "skipped: compliance checks off for Talk calls (VOICE_HARNESS_COMPLIANCE_CHECKS=off)";

export function traceComplianceChecksOff(destination: string): void {
  emitTrace("compliance_check", { check: "compliance_checks", passed: null, skipped: true, result: COMPLIANCE_CHECKS_OFF_RESULT, reason: null, destination });
}

/** `{ skipped }` names why a gate did not run outside test mode (for example the local Talk play path). */
export type GateEntry = [
  name: string,
  run: (() => string | null | Promise<string | null>) | "skipped" | { skipped: string },
];

/** Like `firstBlock`, with entries that are shown as skipped. Enforced runs pass no skipped entries, so their trace is unchanged. */
export async function runGates(entries: GateEntry[]): Promise<string | null> {
  for (const [name, run] of entries) {
    if (run === "skipped") {
      traceSkipped(name);
      continue;
    }
    if (typeof run === "object") {
      traceSkipped(name, run.skipped);
      continue;
    }
    const reason = traceCheck(name, await run());
    if (reason) return reason;
  }
  return null;
}
