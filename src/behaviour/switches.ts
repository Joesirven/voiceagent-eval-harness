/**
 * The legal blocks switch. "enforced" (the default) keeps every legal-layer rule
 * and prompt block. "suspended" turns off only the legal layer, for the local
 * testing harness. Behaviour rules ignore this switch entirely.
 *
 * The switch is read on every check; nothing is cached. It does not decide who may
 * be dialled: the dial path (src/harness/call-harness.ts) owns that, and test mode
 * must still only ever reach an allowlisted test phone, a browser or a simulated line.
 */

import type { LegalBlocksMode } from "./types.js";

let mode: LegalBlocksMode = "enforced";

export function getLegalBlocks(): LegalBlocksMode {
  return mode;
}

export function setLegalBlocks(next: LegalBlocksMode): void {
  if (next !== "enforced" && next !== "suspended") throw new Error("legal_blocks_mode_invalid");
  mode = next;
}

export function resetLegalBlocks(): void {
  mode = "enforced";
}

/** The mode a check runs under: an explicit per-call override, else the process-wide switch. */
export function effectiveLegalBlocks(override?: LegalBlocksMode): LegalBlocksMode {
  return override ?? mode;
}
