/**
 * Turns playbook and rule text into prompt text. The data keeps review notes, archive
 * citations and code references beside the instructions; none of that may reach the
 * voice model, so it is dropped here sentence by sentence.
 */

/** A sentence that talks about the data, the archive or the code, not about the call. */
const INTERNAL_SENTENCE =
  /pending legal research|\bthr_[a-z0-9]+|\barchive|\brewritten\b|\bharness\b|enforcement\.md|`|\bcontext \d|\bsrc\/|\bNorthwind\b|\broleplay\b|\btrainer\b|\bextract\b/i;

/** Splits on sentence ends, never inside double quotes or parentheses. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    current += ch;
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    if (inQuote || depth > 0) continue;
    const next = text[i + 1];
    const atGap = next === undefined || /\s/.test(next);
    const closesSentence =
      (/[.?!]/.test(ch) && atGap) || (ch === '"' && /[.?!]/.test(text[i - 1] ?? "") && atGap);
    if (!closesSentence) continue;
    const following = text.slice(i + 1).trimStart()[0];
    if (following !== undefined && /[a-z]/.test(following)) continue;
    out.push(current.trim());
    current = "";
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function isInternalSentence(sentence: string): boolean {
  return INTERNAL_SENTENCE.test(sentence);
}

const RULE_ID = "(?:Never|Producer-only)-\\d{2}";
const RULE_PARENTHESIS = new RegExp(`\\s*\\(${RULE_ID}(?:\\s*[,;]\\s*${RULE_ID})*\\)`, "g");

const SECTION_WORDS: Record<string, string> = {
  "5": "the gatekeeper steps",
  "6": "the discovery questions",
  "8": "the booking steps",
};

const SECTION_SENTENCES: Record<string, string> = {
  "5": "Use the gatekeeper steps.",
  "6": "Ask the discovery questions in order.",
  "8": "Follow the booking steps.",
};

/** Plain words for playbook item identifiers that appear inside other items. */
const ITEM_WORDS: Record<string, string> = {
  "Disclosure-01": "the opening line",
  "Disclosure-02": "the opening line",
  "Disclosure-07": "the Spanish lines",
  "Disclosure-09": "the authority check",
  "Discovery-09": "the reluctance line",
  "Discovery-24": "the tools questions",
  "Booking-15": "the handoff note",
  "Objection-01": 'the response to "I\'m busy"',
  "Objection-04": 'the response to "I didn\'t request this"',
  "Booking-22": "the service request line",
  "Producer-only-06": "the payment rule",
  "Producer-only-07": "the policy change rule",
  "Producer-only-08": "the certificate rule",
};

/** The sentences of a text that are about the call, joined. Rule texts keep their identifiers. */
export function dropInternalSentences(text: string): string {
  return splitSentences(text.replace(/\bthe archive's /g, "the ")).filter((s) => !isInternalSentence(s)).join(" ").replace(/\s+/g, " ").trim();
}

/** Playbook text for the prompt: internal sentences dropped, rule identifiers in parentheses dropped, references put in words. */
export function cleanText(text: string): string {
  let joined = dropInternalSentences(text);
  joined = joined.replace(RULE_PARENTHESIS, "");
  joined = joined.replace(/(^|\. )Section (\d+)\.(?= |$)/g, (whole, lead: string, n: string) => `${lead}${SECTION_SENTENCES[n] ?? whole}`);
  joined = joined.replace(/\bone segment\b/g, "one kind of business");
  joined = joined.replace(/\b[Ss]ection (\d+)\b/g, (whole, n: string) => SECTION_WORDS[n] ?? whole);
  joined = joined.replace(/\b(?:Disclosure|Discovery|Booking|Producer-only)-\d{2}\b/g, (id) => ITEM_WORDS[id] ?? id);
  return joined.replace(/\s+/g, " ").trim();
}

/** The double-quoted strings in a text, without the quotes. */
export function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

export function ensureSentenceEnd(text: string): string {
  return /[.?!"]$/.test(text) ? text : `${text}.`;
}

/** A quoted string that reads as a full line the agent would speak, not a caller phrase or a phrase to avoid. */
export function isSpokenLine(quoted: string): boolean {
  return /^[A-Z\[¿]/.test(quoted) && /[.?!]$/.test(quoted) && quoted.split(/\s+/).length >= 3;
}
