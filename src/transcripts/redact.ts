/**
 * Pattern redaction of real call text for voice_harness.transcript_turn.text_redacted.
 *
 * PROTOTYPE SAFETY SHORTCUT: names
 * are NOT masked. Only patterns are: what redactText (src/decision-models/redact.ts)
 * masks (written and spoken emails, phone numbers, tax id and card shapes, years,
 * long digit runs), plus street addresses, policy numbers, hyphenated digit groups
 * and numbers read out digit by digit. Rows carry redaction_status 'not_redacted'
 * and the quality flag PROTOTYPE_NAMES_UNMASKED so the later safety pass finds them.
 *
 * Money amounts and small counts are kept: payroll and headcount are what the
 * simulation and the judges check.
 */

import { redactText } from "../decision-models/redact.js";

export const TRANSCRIPT_REDACTION_METHOD = "harness_redact_text_v1";
/** Quality flag on every call and turn loaded under the prototype shortcut. */
export const PROTOTYPE_NAMES_UNMASKED = "prototype_names_unmasked";

const ADDRESS =
  /\b\d{1,6}\s+(?:[A-Za-zÀ-ÿ]+\.?\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|circle|cir|parkway|pkwy|highway|hwy|place|pl|terrace|trail|trl|plaza|square|loop|calle|avenida|camino)\b\.?/gi;
const POLICY_AFTER_CUE = /\b(policy|account|claim|member|license|licence|certificate)\s+(?:number|no\.?|#|id)\s*(?:is\s+|was\s+|:\s*)?((?:[A-Za-z]{0,4}[\s-]?)?\d[\dA-Za-z-]*(?:\s+\d[\dA-Za-z-]*){0,3})/gi;
const MIXED_ID = /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b|\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{6,}\b/g;
const HYPHEN_DIGITS = /\b\d{2,}(?:-\d{2,})+\b/g;
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|double|triple|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|\\d{1,4})";
const SPELLED_NUMBER = new RegExp(`\\b${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){3,}\\b`, "gi");

/** Masks the patterns in one turn. */
export function redactPatterns(text: string): string {
  // Phones and emails first, so a phone number is not split by the digit-group patterns below.
  return redactText(text)
    .replace(POLICY_AFTER_CUE, (_m, cue: string) => `${cue} number [policy]`)
    .replace(ADDRESS, "[address]")
    .replace(MIXED_ID, "[policy]")
    .replace(HYPHEN_DIGITS, "[number]")
    // Money keeps its digits: a run starting at a "$" amount is left alone.
    .replace(SPELLED_NUMBER, (m, offset: number, whole: string) => (whole[offset - 1] === "$" ? m : "[number]"));
}

/**
 * Measurement only: capitalized words that do not start a sentence and are not
 * "I" or a mask token. An upper bound on names left in the text, since carriers,
 * places and months count too.
 */
export function nameCandidates(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(?<![.!?]\s|^|\[)\b[A-Z][a-z][A-Za-z'’-]*/gm)) {
    if (!/^I['’]/.test(m[0])) n += 1;
  }
  return n;
}
