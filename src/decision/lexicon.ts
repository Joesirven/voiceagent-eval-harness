/**
 * Keyword cues the two mock decision modules share, by answer name. A real
 * module reads the question and the answers' meanings; the mocks only look for
 * these words. A tree answer may add its own `cues`. Weight 2 marks a phrase
 * that settles the matter on its own.
 */

import { containsAsWords } from "../memory/evidence.js";

export type Cue = string | RegExp | [phrase: string | RegExp, weight: number];

export const LEXICON: Record<string, Cue[]> = {
  yes: [["yes", 2], ["yeah", 2], ["yep", 2], ["yup", 2], ["sure", 2], ["okay", 2], ["ok", 2], ["correct", 2], ["thats me", 2], ["this is", 1], ["speaking", 2], ["i am", 1], ["go ahead", 2], ["sounds good", 2], ["that works", 2], "hi", "hello", "hey"],
  no: [["no", 2], ["nope", 2], ["nah", 2], ["not me", 2], ["wrong number", 2], ["wrong person", 2], ["dont", 1], ["do not", 1], ["not really", 1], "cancel"],
  quote: [["quote", 2], ["quotes", 2], "price", "pricing", "insurance", "coverage", "auto", "car", "vehicle", "rate", "rates", "premium"],
  book: [["book", 2], ["schedule", 2], ["appointment", 2], ["set up a call", 2], "meet", "meeting"],
  message: [["leave a message", 2], ["pass along", 2], ["call me back", 2], "message", "callback", "tell him", "tell her"],
  human: [["human", 2], ["real person", 2], ["a person", 2], ["representative", 2], ["operator", 2], "someone", "producer", "manager", "speak to", "talk to"],
  objection: [["too expensive", 2], ["too much", 2], ["too high", 2], ["already have", 2], ["shop around", 2], ["think about it", 2], ["need to think", 2], "busy", "cheaper", "happy with"],
  not_interested: [["not interested", 2], ["no thanks", 2], ["no thank you", 2], ["dont want", 2], ["not looking", 2], ["no longer interested", 2]],
  do_not_call: [["do not call", 2], ["dont call", 2], ["stop calling", 2], ["remove me", 2], ["take me off", 2], ["never call", 2], ["leave me alone", 2], ["unsubscribe", 2]],
  returning_missed_calls: [["missed call", 2], ["missed calls", 2], ["you called", 2], ["called me", 2], ["returning your call", 2], ["returning a call", 2], ["calling back", 2], ["call back", 1], "returning"],
  asks_if_ai: [["are you an ai", 2], ["are you a robot", 2], ["are you a bot", 2], ["is this a robot", 2], ["is this an ai", 2], ["is this automated", 2], "robot", "automated"],
  asks_for_person: [["real person", 2], ["a human", 2], ["human", 2], ["a person", 2], ["representative", 2], ["speak to someone", 2], ["talk to someone", 2], "operator", "manager"],
  upset: [["fed up", 2], ["sick of", 2], ["this is ridiculous", 2], ["how dare", 2], ["unacceptable", 2], "angry", "furious", "harassing", "harassment"],
  asks_to_stop: [["stop calling", 2], ["do not call", 2], ["dont call", 2], ["take me off", 2], ["remove me", 2], ["leave me alone", 2], ["unsubscribe", 2]],
  // A day or a clock time the caller names. A clock time on its own is strong; a bare weekday is weak.
  accepts_time: [[/\b\d{1,2}\s?(?:am|pm)\b/, 2], ["noon", 2], "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  new_time: [[/\b\d{1,2}\s?(?:am|pm)\b/, 2], ["noon", 2], "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  year_given: [/\b(?:19|20)\d{2}\b/],
  time_given: [/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/, "noon", "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "morning", "afternoon", "evening"],
  message_given: [/\S+\s+\S+\s+\S+/],
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const NEGATION = /\b(dont|do not|not|never|cant|wont)\b/;

/** How strongly a line of caller speech matches one answer's cues (0 means not at all). */
export function matchWeight(callerText: string, answer: string, extraCues: string[] = []): number {
  const spoken = normalize(callerText);
  if (!spoken) return 0;
  // A negated line never counts as "yes": "I dont want to speak to a person" must not transfer.
  if (answer === "yes" && NEGATION.test(spoken)) return 0;
  const cues: Cue[] = [...(LEXICON[answer] ?? []), ...extraCues];
  let total = 0;
  for (const cue of cues) {
    if (cue instanceof RegExp) {
      if (cue.test(spoken)) total += 1;
    } else if (typeof cue === "string") {
      if (containsAsWords(spoken, normalize(cue))) total += 1;
    } else if (cue[0] instanceof RegExp ? cue[0].test(spoken) : containsAsWords(spoken, normalize(cue[0]))) {
      total += cue[1];
    }
  }
  return total;
}
