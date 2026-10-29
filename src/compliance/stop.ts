/**
 * Detecting a caller's or texter's request to stop being contacted. Whole
 * words and phrases only, so "bus stop" or "stopwatch" never match.
 */

import { containsAsWords } from "../memory/evidence.js";
import type { TranscriptTurn } from "../provider/interface.js";

/**
 * Each phrase must name what is to stop. "Never call" alone is left out: "you never
 * call me back" is a complaint, not a request. "Take me off" is only a request
 * with its object ("take me off hold" is a request to wait).
 */
const PHRASES = [
  "please stop",
  "stop please",
  "stop it",
  "stop calling",
  "stop texting",
  "stop messaging",
  "stop contacting",
  "do not call",
  "do not call me",
  "do not text",
  "do not contact",
  "dont call",
  "dont text",
  "dont contact",
  "never call me again",
  "never call this number again",
  "no more calls",
  "no more texts",
  "remove my number",
  "take me off your list",
  "take me off the list",
  "take me off this list",
  "take me off your calling list",
  "remove me from",
  "unsubscribe",
  "leave me alone",
];

/** A whole message made of just one of these is a carrier-style opt-out. */
const KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface StopRequest {
  matched: string;
  /** What the person actually said, verbatim. */
  callerWords: string;
}

export function detectStopRequest(text: string): StopRequest | null {
  const spoken = normalize(text);
  if (!spoken) return null;
  if (KEYWORDS.has(spoken)) return { matched: spoken, callerWords: text.trim() };
  const phrase = PHRASES.find((p) => containsAsWords(spoken, p));
  return phrase ? { matched: phrase, callerWords: text.trim() } : null;
}

/** First caller turn in a finished transcript that asks to stop. */
export function findStopRequest(transcript: TranscriptTurn[]): StopRequest | null {
  for (const turn of transcript) {
    if (turn.role !== "caller" || turn.spoken === false) continue;
    const stop = detectStopRequest(turn.text);
    if (stop) return stop;
  }
  return null;
}

export const STOP_REPLY = "Understood. I will not contact you again.";
/** The part of STOP_REPLY recorded as the promise, so it is a phrase the agent really said. */
export const STOP_PROMISE = "will not contact you again";
