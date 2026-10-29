/**
 * Best-effort masking of personal details before any text leaves for a model
 * provider: e-mail addresses (written or read aloud), phone numbers, social
 * security, tax id and card shapes, four-digit years (a date of birth) and long
 * digit runs (policy numbers), plus any names the caller passes in.
 *
 * Pattern matching is not a guarantee: a spelled-out date or a name the lead
 * record does not hold gets through. The guarantee is the transport (zero data
 * retention where the provider offers it). This narrows what is seen in
 * transit. Written for the harness; it follows the same idea as the configured system's
 * redaction but shares no code with it.
 *
 * Money amounts and small counts are kept on purpose: payroll and employee
 * count are what the judges check for.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SPOKEN_EMAIL = /\b[\w.]+(?:\s+[\w.]+){0,3}\s+(?:at|arroba)\s+[\w]+\s+(?:dot|punto)\s+(?:com|net|org|edu|us|mx)\b/gi;
const SSN_OR_TAX_ID = /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const YEAR = /\b(?:19|20)\d{2}\b/g;
const LONG_DIGITS = /\b\d{7,}\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mask personal details in one string. `names` are masked as whole words, case-insensitively. */
export function redactText(text: string, names: readonly (string | null | undefined)[] = []): string {
  let out = text
    .replace(EMAIL, "[email]")
    .replace(SPOKEN_EMAIL, "[email]")
    .replace(SSN_OR_TAX_ID, "[id]")
    .replace(CARD, (m) => (m.replace(/\D/g, "").length >= 13 ? "[number]" : m))
    .replace(PHONE, "[phone]")
    .replace(LONG_DIGITS, "[number]")
    .replace(YEAR, "[year]");
  for (const raw of names) {
    for (const part of (raw ?? "").split(/\s+/)) {
      if (part.length < 2) continue;
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"), "[name]");
    }
  }
  return out;
}

/** Mask every turn's text; other fields are copied as they are. */
export function redactTurns<T extends { text: string }>(
  turns: readonly T[],
  names: readonly (string | null | undefined)[] = [],
): T[] {
  return turns.map((t) => ({ ...t, text: redactText(t.text, names) }));
}
