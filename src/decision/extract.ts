/**
 * Small, plain extractors that pull a value out of the caller's own words.
 * The value is always text the caller said, so the judge can check it.
 */

const YEAR = /\b(?:19|20)\d{2}\b/;
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_PART = /\b(morning|afternoon|evening|noon)\b/i;

export function extractYear(text: string): string | null {
  return text.match(YEAR)?.[0] ?? null;
}

/** True when the words name a time of day or a day. */
export function hasTimeExpression(text: string): boolean {
  const t = text.toLowerCase();
  return CLOCK.test(t) || /\bnoon\b/.test(t) || WEEKDAYS.some((d) => new RegExp(`\\b${d}\\b`).test(t)) || /\b(today|tomorrow)\b/.test(t) || DAY_PART.test(t);
}

/** The year, month, day and weekday (0 to 6) of an instant, as seen in a time zone. */
function localParts(instant: Date, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Wall-clock time in a zone to a timestamp string. */
function zonedToIso(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): string {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone)).toISOString();
}

export interface ExtractedTime {
  iso: string;
  /** How the agent says it back, for example "tomorrow at 3 PM". */
  words: string;
}

/**
 * A day and a clock time from the caller's words. No day named means tomorrow,
 * and the spoken-back words say so, so the caller's yes covers it. A time of
 * day with no clock time ("sometime in the morning") is not enough to book.
 */
export function extractTime(text: string, now: Date, timeZone: string): ExtractedTime | null {
  const lower = text.toLowerCase();
  let hour: number;
  let minute = 0;
  let clockWords: string;
  const clock = lower.match(CLOCK);
  if (clock) {
    hour = Number(clock[1]);
    minute = clock[2] ? Number(clock[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = clock[3]!.toLowerCase() === "pm";
    hour = (hour % 12) + (pm ? 12 : 0);
    clockWords = `${clock[1]}${clock[2] ? `:${clock[2]}` : ""} ${pm ? "PM" : "AM"}`;
  } else if (/\bnoon\b/.test(lower)) {
    hour = 12;
    clockWords = "noon";
  } else {
    return null;
  }

  const today = localParts(now, timeZone);
  let addDays = 1;
  let dayWords = "tomorrow";
  if (/\btoday\b/.test(lower)) {
    addDays = 0;
    dayWords = "today";
  } else if (!/\btomorrow\b/.test(lower)) {
    const named = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(lower));
    if (named >= 0) {
      addDays = ((named - today.weekday + 7) % 7) || 7;
      dayWords = WEEKDAYS[named]![0]!.toUpperCase() + WEEKDAYS[named]!.slice(1);
    }
  }
  const target = new Date(Date.UTC(today.y, today.m - 1, today.d + addDays));
  const iso = zonedToIso(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute, timeZone);
  return { iso, words: `${dayWords} at ${clockWords}` };
}

/** The caller details the engine collects: the caller's own name and their business's name. */
export type CallerDetail = "callerName" | "businessName";
export type CallerDetails = Partial<Record<CallerDetail, string>>;

/**
 * Words that are never part of a name or a business name, even when speech to
 * text capitalizes them at the start of a sentence ("Sure.", "Hello?").
 */
const NOT_A_NAME = new Set(
  (
    "hello hi hey yes yeah yep yup no nope nah sure okay ok oh uh um hmm well so and but or the a an i i'm im i've it it's its is " +
    "this that that's what why who how when where can could would will you you're your we we're our my me he she they them " +
    "thanks thank please sorry right fine good great alright maybe just not nothing never crazy wait hold sir ma'am there here " +
    "speaking correct exactly absolutely really again also too already owner manager today tomorrow yesterday " +
    "monday tuesday wednesday thursday friday saturday sunday morning afternoon evening insurance business company name"
  ).split(" "),
);

/**
 * Common English words that speech to text capitalizes at the start of a
 * sentence ("Pardon?", "I'm Busy.", "We're Closed."). One of these alone is
 * never taken for a name or a business. Given names that are also words
 * (Mark, Will, Grant) are left out on purpose.
 */
const COMMON_WORDS = new Set(
  (
    "pardon huh seriously honestly actually literally obviously definitely certainly totally anyway anyways " +
    "nobody somebody someone anyone everyone everybody none something anything everything whatever whoever " +
    "busy closed open done ready away out off back available unavailable working driving calling listening " +
    "confused lost tired interested retired cool nice perfect awesome excuse goodbye bye later true same " +
    "different other another person people guy man woman lady boss hang stop listen look see hear understand mean"
  ).split(" "),
);
const isCommonWord = (phrase: string) => !phrase.includes(" ") && COMMON_WORDS.has(phrase.toLowerCase());

/** Words that make a capitalized phrase a business rather than a person. */
const BUSINESS_WORDS =
  /\b(pizza|pizzeria|roofing|plumbing|construction|contracting|contractors?|electric|electrical|landscaping|services?|company|co|inc|corp|corporation|group|builders?|painting|heating|cooling|restaurant|cafe|shop|store|solutions|enterprises?|industries|trucking|transport|repair|auto|motors|bakery|deli|grill|bar|salon|cleaning|concrete|masonry|framing|drywall|flooring|remodeling|homes|partners|associates|brothers|bros|sons)\b/i;

/** Cues after which the caller gives a business name whatever its shape. */
const STRONG_BUSINESS_CUE =
  /\b(?:the business is|my business is|business is|business name is|the business name is|the company is|my company is|company is|i'm with|i am with|i work for|i own|i run|owner of)\s+/gi;
/** Cues ("from", "we're") that count only when what follows looks like a business. */
const WEAK_BUSINESS_CUE = /\b(?:from|with|at|for|we are|we're)\s+/gi;
/** Cues after which the caller gives their own name. */
const NAME_CUE = /\b(?:my name is|my name's|name is|the name is|the name's|this is|i am|i'm|it's|it is|call me)\s+/gi;
/** Filler said before a bare answer ("Sure, Pat Lee.", "It's Al's Pizza."). */
const LEADING_FILLER = /^(?:(?:sure|yeah|yes|yep|okay|ok|oh|uh|um|well|so|it's|it is|that's|that is)[\s,.!?]+)+/i;

const isCapitalized = (word: string) => /^[\p{Lu}\d]/u.test(word);
const core = (token: string) => token.replace(/^[^\p{L}\d&]+|[^\p{L}\d]+$/gu, "");
const endsSentence = (token: string) => /[.!?;:,]$/.test(token);
const isPossessive = (word: string) => /['’]s$/i.test(word);

/**
 * Reads a capitalized phrase from the start of `rest`. A name may cross one
 * full stop when the next sentence is a single capitalized word ("Pat.
 * Lee.", a speech to text split); a business may join words with "and",
 * "&" or "of". Stops at the first word that is not part of a name.
 */
function readPhrase(rest: string, kind: "name" | "business"): string | null {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const max = kind === "name" ? 3 : 5;
  for (let i = 0; i < tokens.length && words.length < max; i++) {
    const token = tokens[i]!;
    const word = core(token);
    const joiner = kind === "business" && words.length > 0 && /^(and|&|of)$/i.test(word);
    if (joiner) {
      const next = core(tokens[i + 1] ?? "");
      if (!next || !isCapitalized(next) || NOT_A_NAME.has(next.toLowerCase())) break;
      words.push(word);
      continue;
    }
    if (!word || !isCapitalized(word) || NOT_A_NAME.has(word.toLowerCase())) break;
    words.push(word);
    if (!endsSentence(token)) continue;
    // A full stop ends the phrase, except a name split over two one-word sentences.
    const next = tokens[i + 1];
    const nextWord = core(next ?? "");
    const crosses =
      kind === "name" && words.length === 1 && token.endsWith(".") && next !== undefined &&
      isCapitalized(nextWord) && !NOT_A_NAME.has(nextWord.toLowerCase()) && !isPossessive(nextWord) &&
      (endsSentence(next) || i + 1 === tokens.length - 1);
    if (!crosses) break;
  }
  return words.length ? words.join(" ") : null;
}

const looksLikeBusiness = (phrase: string) => BUSINESS_WORDS.test(phrase) || phrase.split(" ").some(isPossessive);
const sameValue = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

function afterCues(text: string, cue: RegExp): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(cue)) found.push(text.slice(m.index! + m[0].length));
  return found;
}

export interface CallerDetailsOptions {
  /** Details the agent has asked for and does not have yet. A bare answer ("Al's Pizza.") is read as one of these. */
  awaiting: CallerDetail[];
  /** Details already known, so a repeated name is not taken for a business. */
  known: CallerDetails;
}

/**
 * The caller's name and business from their own words. Phrases after a cue
 * ("my name is", "the business is", "this is Pat from Al's Pizza") count on
 * any line; a bare answer ("Pat Lee.") counts only for a detail the agent
 * is waiting for. The values are always the caller's own words.
 */
export function extractCallerDetails(text: string, options: CallerDetailsOptions): CallerDetails {
  const out: CallerDetails = {};
  for (const rest of afterCues(text, STRONG_BUSINESS_CUE)) {
    const phrase = readPhrase(rest, "business");
    if (phrase && !isCommonWord(phrase)) {
      out.businessName ??= phrase;
      break;
    }
  }
  if (!out.businessName) {
    for (const rest of afterCues(text, WEAK_BUSINESS_CUE)) {
      const phrase = readPhrase(rest, "business");
      if (phrase && looksLikeBusiness(phrase)) {
        out.businessName = phrase;
        break;
      }
    }
  }
  for (const rest of afterCues(text, NAME_CUE)) {
    const phrase = readPhrase(rest, "name");
    if (!phrase || isCommonWord(phrase)) continue;
    if (looksLikeBusiness(phrase)) out.businessName ??= readPhrase(rest, "business") ?? phrase;
    else out.callerName ??= phrase;
    if (out.callerName) break;
  }
  if (out.callerName || out.businessName) return out;

  // A bare answer: the whole line, after filler, is one capitalized phrase.
  const awaiting = options.awaiting.filter((d) => !options.known[d]);
  if (!awaiting.length) return out;
  const bare = text.trim().replace(LEADING_FILLER, "");
  // A question back ("Pardon?", "Pat?") is not an answer.
  if (bare.endsWith("?")) return out;
  const tokens = bare.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 5) return out;
  const whole = (["business", "name"] as const).map((k) => readPhrase(bare, k)).find((p) => p?.split(" ").length === tokens.length);
  if (!whole || isCommonWord(whole)) return out;
  const kind: CallerDetail = awaiting.length === 1 ? awaiting[0]! : looksLikeBusiness(whole) ? "businessName" : "callerName";
  // A name said again when the business was asked for is not the business, and the other way round.
  const other: CallerDetail = kind === "callerName" ? "businessName" : "callerName";
  if (sameValue(whole, options.known[other])) return out;
  if (kind === "callerName" && looksLikeBusiness(whole)) return out;
  out[kind] = whole;
  return out;
}
