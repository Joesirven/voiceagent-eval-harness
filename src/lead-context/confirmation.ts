/**
 * Whether the first caller line after the disclosure confirms the named
 * person, for calls with no known stage (the console bot's single prompt
 * mode). A deliberately simple, explainable rule set by the orchestrator: a
 * yes, the name on file, or "speaking" confirms; a no, someone else, a
 * question or silence keeps the gate. A no or someone else always wins over a
 * yes, because a wrong open reveals account facts to the wrong person while a
 * wrong closed only delays them. When a stage is known, the stage decides
 * instead and this rule is not used.
 */

export interface CallerLineVerdict {
  confirmed: boolean;
  /** A short plain phrase for logs and the response; never the caller's words. */
  reason: string;
}

/** Lower case, one apostrophe, punctuation turned into spaces, single spaces. */
function normalise(line: string): string {
  return ` ${line
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const has = (text: string, phrase: string) => text.includes(` ${phrase} `);

/** Phrases that mean a no, someone else, the person being away, or a question back: the gate stays closed. */
const NEGATIVE_PHRASES = [
  "no", "nope", "nah", "not", "wrong number", "wrong person", "isn't here", "is not here", "isn't in", "is not in", "not here",
  "not available", "isn't available", "not in", "she's not", "he's not", "they're not", "she isn't", "he isn't", "she is not", "he is not",
  "can i take a message", "take a message", "who is this", "who's this", "who's calling", "who is calling", "who are you", "what is this",
  "no one by that name", "nobody by that name", "doesn't live here", "does not live here", "you have the wrong", "you've got the wrong",
  "hold on", "hang on", "let me get", "i'll get", "i will get", "one moment", "one second", "she's out", "he's out", "she's at", "he's at",
  "passed away", "my wife", "my husband", "my mom", "my mother", "my dad", "my father", "my boss", "my son", "my daughter", "my sister", "my brother",
  "her son", "her daughter", "her husband", "his wife", "his son", "his daughter", "her assistant", "his assistant", "i'm her", "i'm his", "i am her", "i am his",
  "the office", "reception", "front desk", "voicemail", "leave a message",
];

/** Yes words and identity phrases that confirm, when nothing negative is present. */
const POSITIVE_PHRASES = [
  "yes", "yeah", "yep", "yup", "yah", "ya", "sure", "correct", "right", "uh-huh", "uh huh", "mhm", "mm-hmm",
  "that's me", "that is me", "it's me", "it is me", "this is she", "this is he", "you got her", "you got him", "you've got her", "you've got him",
  "that's right", "speaking", "sí", "soy yo", "al habla",
];

export function callerLineConfirms(line: string | undefined, names: readonly string[]): CallerLineVerdict {
  if (line === undefined || !line.trim()) return { confirmed: false, reason: "no caller line yet" };
  const text = normalise(line);
  if (text.trim().length === 0) return { confirmed: false, reason: "no caller line yet" };
  const known = [...new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2 && n !== "unknown"))];
  const named = known.some((n) => has(text, n) || has(text, `${n}'s`));
  // "This is <someone>" or "it's <someone>" naming a person who is not on file is someone else answering.
  const introduced = /(?:^| )(?:this is|it's|it is|i'm|i am|my name is) ([\p{L}'-]+)/u.exec(text.trim())?.[1];
  const selfWords = new Set(["she", "he", "me", "her", "him", "speaking", "the", "a", "an", "just", "calling", "here", "fine", "good", "busy"]);
  if (introduced && !selfWords.has(introduced) && !known.includes(introduced) && !known.includes(introduced.replace(/'s$/, ""))) {
    return { confirmed: false, reason: "someone else answered" };
  }
  // "<someone> speaking" or "<someone> here" with a name that is not on file is someone else: "Janet speaking", "Bob here".
  const signed = /(?:^| )([\p{L}'-]+) (?:speaking|here)(?: |$)/u.exec(text.trim())?.[1];
  const leadIns = new Set(["yes", "yeah", "yep", "yup", "ya", "yah", "sure", "she", "he", "this", "is", "it's", "hi", "hello", "hey", "uh", "um", "ok", "okay", "sí", "right", "correct", "me", "i'm", "am"]);
  if (signed && !leadIns.has(signed) && !known.includes(signed)) return { confirmed: false, reason: "someone else answered" };
  // "<name>'s ..." (the name followed by 's) is someone talking about the person, not the person: "Jane's not here", "Jane's my wife".
  if (known.some((n) => has(text, `${n}'s`))) return { confirmed: false, reason: "someone else answered" };
  if (NEGATIVE_PHRASES.some((p) => has(text, p))) return { confirmed: false, reason: "caller said no or someone else answered" };
  if (text.trim().endsWith("?") || /\?\s*$/.test(line.trim())) {
    // A question back ("Jane?", "who's asking?") is not a confirmation.
    return { confirmed: false, reason: "caller answered with a question" };
  }
  if (named) return { confirmed: true, reason: "caller gave the name on file" };
  if (has(text, "speaking")) return { confirmed: true, reason: "caller said speaking" };
  if (POSITIVE_PHRASES.some((p) => has(text, p))) return { confirmed: true, reason: "caller said yes" };
  return { confirmed: false, reason: "no confirmation in the first caller line" };
}

/** The names the caller may give: the first word of the name on file and of the owner name on the record. */
export function confirmationNames(name: string | undefined, ownerName: string | undefined): string[] {
  return [name, ownerName].map((n) => n?.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}
