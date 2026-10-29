/**
 * Evidence rule for quote fields: a value is stored only when the span that
 * backs it is something a caller said, and the value is in that span. Matching
 * is on whole words, so "50" is not supported by "2019" or "500". The one
 * exception is quote_channel, where the span is the caller's agreement, not the value.
 */

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `needle` appears in `haystack` bounded by non-word characters. */
export function containsAsWords(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  if (!n) return false;
  return new RegExp(`(?<!\\w)${escapeRegExp(n)}(?!\\w)`).test(normalize(haystack));
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
const isNumberWord = (w: string) => w in UNITS || w in TENS || w in SCALES;

/**
 * Text with amounts written one way, for comparing what a caller said with what a model saved: lowercase letters
 * and digits only, spoken numbers as digits ("eight" is "8", "seven hundred thousand" is "700000"), digit groups
 * joined ("$700,000" is "700000") and "k" after a number read as thousands. Used only to compare, never stored.
 */
export function canonicalWords(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\b(\d+(?:\.\d+)?)k\b/g, (_m, n: string) => String(Math.round(Number(n) * 1000)))
    .replace(/['’]/g, "")
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isNumberWord(tokens[i]!)) {
      out.push(tokens[i]!);
      continue;
    }
    let total = 0;
    let current = 0;
    let j = i;
    for (; j < tokens.length; j += 1) {
      const w = tokens[j]!;
      // "a" and "and" belong to a spoken number only between number words ("a hundred", "one hundred and five").
      if ((w === "and" || w === "a") && j + 1 < tokens.length && isNumberWord(tokens[j + 1]!) && (w === "a" ? j === i : j > i)) continue;
      if (w in UNITS) current += UNITS[w]!;
      else if (w in TENS) current += TENS[w]!;
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w in SCALES) {
        total += (current || 1) * SCALES[w]!;
        current = 0;
      } else break;
    }
    out.push(String(total + current));
    i = j - 1;
  }
  return out.join(" ");
}

/** Whether every word of `needle` (in canonicalWords form) appears in `haystack`, in order and whole, or at least each one somewhere. */
function wordsSupported(haystack: string, needle: string, inOrder: boolean): boolean {
  const h = canonicalWords(haystack);
  const n = canonicalWords(needle);
  if (!n) return false;
  if (` ${h} `.includes(` ${n} `)) return true;
  if (inOrder) return false;
  const have = new Set(h.split(" "));
  return n.split(" ").every((w) => have.has(w));
}

/**
 * The caller's lines one by one, then runs of up to four consecutive ones joined: a caller's sentence often
 * arrives as several lines ("Probably around..." then "$700,000"), and its words are still the caller's own.
 */
export function callerLineWindows(callerTurns: string[], maxJoined = 4): string[] {
  const windows = [...callerTurns];
  for (let size = 2; size <= maxJoined; size += 1) {
    for (let i = 0; i + size <= callerTurns.length; i += 1) windows.push(callerTurns.slice(i, i + size).join(" "));
  }
  return windows;
}

/** The caller's plain ways of saying yes to a text, matched as whole words inside the span. */
const PLAIN_YES = ["yes", "yeah", "yep", "sure", "okay", "ok", "that works", "sounds good", "please do", "go ahead"];

/**
 * quote_channel is the caller's agreement on how the quote reaches them, so the value is a
 * channel name the caller need not have said: "text" is backed by a plain yes to the agent's
 * offer or by the caller mentioning a text, "email" only by the caller mentioning email.
 */
function quoteChannelSupported(value: string, evidenceSpan: string): boolean {
  if (value === "text") return containsAsWords(evidenceSpan, "text") || PLAIN_YES.some((yes) => containsAsWords(evidenceSpan, yes));
  if (value === "email") return containsAsWords(evidenceSpan, "email");
  return false;
}

export function evidenceSupportsValue(
  value: string,
  evidenceSpan: string,
  callerTurns: string[],
  field?: string,
): boolean {
  if (!value.trim() || !evidenceSpan.trim()) return false;
  // The value inside the span: as written, or with amounts compared as digits ("8" for "eight", "700000" for
  // "$700,000"), or every word of the value somewhere in the span ("8 full time, 6 part time").
  const supported =
    field === "quote_channel"
      ? quoteChannelSupported(value, evidenceSpan)
      : containsAsWords(evidenceSpan, value) || wordsSupported(evidenceSpan, value, false);
  if (!supported) return false;
  // The span inside what the caller said: one line, or a few consecutive lines of the same sentence.
  return callerLineWindows(callerTurns).some((turn) => containsAsWords(turn, evidenceSpan) || wordsSupported(turn, evidenceSpan, true));
}
