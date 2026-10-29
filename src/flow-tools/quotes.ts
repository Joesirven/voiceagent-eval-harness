/**
 * Matching a model's quote against what the caller said. Case, whitespace and
 * punctuation are ignored on both sides, so "yes that works" matches "Yes,
 * that works.", but the words must still appear whole and in the same order.
 * A match returns the caller's own text for that span, so the checks further
 * down (the store's evidence rule, the judge) see the words exactly as said.
 */

import { callerLineWindows, canonicalWords } from "../memory/evidence.js";

interface Normalized {
  text: string;
  /** For each character of `text`, its index in the original. */
  from: number[];
}

function normalizeWithMap(original: string): Normalized {
  let text = "";
  const from: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < original.length; i += 1) {
    const ch = original[i]!.toLowerCase();
    if (ch === "'" || ch === "’") continue;
    if (/[a-z0-9]/.test(ch)) {
      if (pendingSpace && text.length > 0) {
        text += " ";
        from.push(i);
      }
      pendingSpace = false;
      text += ch;
      from.push(i);
    } else {
      pendingSpace = true;
    }
  }
  return { text, from };
}

/** Lowercase letters and digits with single spaces between words; apostrophes dropped. */
export function normalizeQuote(text: string): string {
  return normalizeWithMap(text).text;
}

/** The caller's own words for `quote` inside `turn`, or null when the words are not there whole and in order. */
export function quoteSpanIn(turn: string, quote: string): string | null {
  const needle = normalizeQuote(quote);
  if (!needle) return null;
  const hay = normalizeWithMap(turn);
  let at = hay.text.indexOf(needle);
  while (at >= 0) {
    const end = at + needle.length;
    const before = at === 0 || hay.text[at - 1] === " ";
    const after = end === hay.text.length || hay.text[end] === " ";
    if (before && after) return turn.slice(hay.from[at], hay.from[end - 1]! + 1);
    at = hay.text.indexOf(needle, at + 1);
  }
  return null;
}

/**
 * The caller's own words for the quote; null when they are not there. First inside one caller turn; then inside a
 * few consecutive turns joined (a sentence often arrives as several lines); then, last, with amounts compared as
 * digits ("8" for "eight", "700,000" for "seven hundred thousand"), which returns the caller's whole line or lines.
 */
export function findQuoteInCallerWords(callerTurns: string[], quote: string): string | null {
  const windows = callerLineWindows(callerTurns);
  for (const turn of windows) {
    const span = quoteSpanIn(turn, quote);
    if (span !== null) return span;
  }
  const want = canonicalWords(quote);
  if (!want) return null;
  return windows.find((turn) => ` ${canonicalWords(turn)} `.includes(` ${want} `)) ?? null;
}
