/**
 * Never-18: a call summary that leaves the call must not carry health, family
 * or legal hardship, or a named household member. Whole sentences go, not just
 * the matching word, so no half-sentence hints at what was removed.
 */

/** Words and phrases that mark a sentence as sensitive. Whole words, any case. */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Health.
  /\b(health|hospital|hospitalized|hospitalised|surgery|surgeon|illness|cancer|chemo|chemotherapy|diagnos(?:is|ed)|medical|doctor|sick|disease|terminal)\b/i,
  // Death and grief.
  /\b(funeral|death|died|dying|deceased|bereavement|passed away|passing|passed on)\b/i,
  // Family and money trouble, legal trouble.
  /\b(divorce|divorced|separated|bankruptcy|bankrupt|foreclosure|lawsuit|sued|arrest|arrested|jail|family hardship|hardship)\b/i,
  // A named household member.
  /\b(wife|husband|spouse|kids|kid|children|child|son|daughter|mother|father|mom|dad|grandmother|grandfather|grandson|granddaughter|fianc[eé]e?)\b/i,
];

function isSensitive(sentence: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(sentence));
}

/** Sentences end at . ! ? or a line break; the ending punctuation stays with its sentence. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Drops sensitive sentences from each summary and drops a summary entirely when
 * nothing is left. Order is kept. A summary with nothing sensitive comes back
 * unchanged. `removedCount` counts sentences removed, including those of dropped summaries.
 */
export function redactSensitiveSummaries(summaries: string[]): { kept: string[]; removedCount: number } {
  const kept: string[] = [];
  let removedCount = 0;
  for (const summary of summaries) {
    const sentences = splitSentences(summary);
    const clean = sentences.filter((s) => !isSensitive(s));
    removedCount += sentences.length - clean.length;
    if (clean.length === sentences.length) {
      if (summary.trim()) kept.push(summary);
    } else if (clean.length > 0) {
      kept.push(clean.join(" "));
    }
  }
  return { kept, removedCount };
}
