import { ASSISTANT_WORDS, getHarnessConfig } from "../config.js";

export const INBOUND_AI_DISCLOSURE =
  "This call is handled by an AI assistant.";

export const INBOUND_RECORDING_DISCLOSURE =
  "Calls with this assistant are recorded and may be reviewed to improve service.";

export const OUTBOUND_AI_TRUTHFUL_ANSWER =
  "Yes, you are speaking with an AI assistant on behalf of the agency.";

/** Who the opening names. Each field is absent when not known; never "unknown" or empty. */
export interface OpeningFacts {
  /** The producer's first name ("Pat"). */
  producerFirstName?: string;
  agencyName?: string;
  /** The lead's first name. Present only when the call knows who it means to reach. */
  leadFirstName?: string;
}

/**
 * The opening of one call, fixed when the call starts and recorded with it so
 * every check compares against the same words. `disclosure` holds the parts
 * spoken word for word, in order: the artificial intelligence sentence, then
 * the recording sentence when the recording notice is on. `confirm` is the
 * question that follows them for a known lead.
 */
export interface CallOpening {
  disclosure: string[];
  confirm?: string;
}

/** A value from the lead's record that counts as known: not missing, not empty, not "unknown". */
export function knownValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

/**
 * The artificial intelligence sentence, filled for this call:
 * "Hi, this is {producerFirstName}'s AI assistant with {agencyName}.", or "Hi,
 * this is the AI assistant with {agencyName}." with no producer name, or
 * INBOUND_AI_DISCLOSURE with no agency name. Spoken and checked word for word.
 * "AI assistant" is ASSISTANT_WORDS (src/config.ts).
 */
export function aiDisclosureSentence(facts: Pick<OpeningFacts, "producerFirstName" | "agencyName"> = {}): string {
  const agency = knownValue(facts.agencyName);
  if (!agency) return INBOUND_AI_DISCLOSURE;
  const producer = knownValue(facts.producerFirstName);
  return producer ? `Hi, this is ${producer}'s ${ASSISTANT_WORDS} with ${agency}.` : `Hi, this is the ${ASSISTANT_WORDS} with ${agency}.`;
}

/** The question that confirms a known lead before anything about the account is said. */
export function knownLeadConfirmation(leadFirstName: string): string {
  return `Is this ${leadFirstName}?`;
}

/** Whether the opening says the recording sentence; the harness setting, read when a call starts. */
export function recordingNoticeEnabled(): boolean {
  return getHarnessConfig().recordingNoticeEnabled === true;
}

/** The opening for a call with these facts. A lead first name makes it a known-lead opening with a confirmation question. */
export function callOpening(facts: OpeningFacts = {}, { recordingNotice = recordingNoticeEnabled() }: { recordingNotice?: boolean } = {}): CallOpening {
  const disclosure = [aiDisclosureSentence(facts), ...(recordingNotice ? [INBOUND_RECORDING_DISCLOSURE] : [])];
  const lead = knownValue(facts.leadFirstName);
  return lead ? { disclosure, confirm: knownLeadConfirmation(lead) } : { disclosure };
}

/**
 * The disclosure sentences of a call, as one line. Without an opening, the
 * plain one: INBOUND_AI_DISCLOSURE, then INBOUND_RECORDING_DISCLOSURE when the
 * recording notice is on.
 */
export function inboundOpeningScript(opening: CallOpening = callOpening()): string {
  return opening.disclosure.join(" ");
}

/** The whole first agent turn: the disclosure, then the confirmation question when there is one. */
export function openingLine(opening: CallOpening): string {
  return [...opening.disclosure, ...(opening.confirm ? [opening.confirm] : [])].join(" ");
}

/**
 * Stands in for the lead context module that will live in src/lead-context/
 * (its fields producerName, agencyName and the lead's name, "unknown" when
 * missing); that module replaces this function. Today the facts are read from
 * the lead record or its briefing, and "unknown", empty or missing counts as
 * absent. The lead's name comes from the briefing (the lead's real record)
 * only, because an inbound lead record without one may stand in for a caller
 * nobody knows. An outbound call dials the number on the lead's record, so
 * there the record's own name also counts, and so it does for a known lead
 * (`knownLead`: a Talk call, which always plays a call to a lead it knows).
 * The harness's opening identity (src/config.ts), when set, names the producer
 * and agency for every lead, whatever the record says.
 */
export function openingFactsFor(
  lead: { name: string; producerName?: string; agencyName?: string; briefing?: { business?: string; ownerName?: string; producerName?: string; agencyName?: string } },
  direction: "inbound" | "outbound",
  { knownLead = false }: { knownLead?: boolean } = {},
): OpeningFacts {
  const firstWord = (v: string | undefined) => v?.split(/\s+/)[0];
  const identity = getHarnessConfig().openingIdentity;
  const producerFirstName = firstWord(knownValue(identity?.producerFirstName) ?? knownValue(lead.producerName) ?? knownValue(lead.briefing?.producerName));
  const agencyName = knownValue(identity?.agencyName) ?? knownValue(lead.agencyName) ?? knownValue(lead.briefing?.agencyName);
  const leadName = knownValue(lead.briefing?.ownerName) ?? (direction === "outbound" || knownLead ? knownValue(lead.name) : undefined);
  return {
    ...(producerFirstName ? { producerFirstName } : {}),
    ...(agencyName ? { agencyName } : {}),
    ...(leadName ? { leadFirstName: firstWord(leadName) } : {}),
  };
}

/** Said before an outbound entry line that does not itself say it is an artificial intelligence assistant. */
export const OUTBOUND_DISCLOSURE = "Hello, this is an AI assistant calling on behalf of the agency.";

/** The disclosure part of the outbound opening: the entry line itself when it says it is an artificial intelligence assistant (the literal words "AI assistant"), else the fixed outbound disclosure. */
export function outboundDisclosure(entryLine?: string): string {
  return entryLine && /\bAI assistant\b/.test(entryLine) ? entryLine : OUTBOUND_DISCLOSURE;
}

/** The outbound opening, placeholders unfilled: the artificial intelligence disclosure comes first, whatever the tree's entry line says. */
export function outboundOpeningScript(entryLine?: string): string {
  if (!entryLine) return OUTBOUND_DISCLOSURE;
  return outboundDisclosure(entryLine) === entryLine ? entryLine : `${OUTBOUND_DISCLOSURE} ${entryLine}`;
}

/** The words of a line, lower case, so punctuation and spacing never decide a match (a paraphrase still fails). */
function wordsOf(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

/** The line's words begin with all of the expected words (whole words, so "Insurance" never matches "Insurances"). */
function beginsWith(text: string, expected: string): boolean {
  const said = wordsOf(text);
  const want = wordsOf(expected);
  return want.length > 0 && (said === want || said.startsWith(`${want} `));
}

/** The lines of the inbound disclosure as they were said: one whole line, or its two parts. */
export interface InboundDisclosureLines<T> {
  split: boolean;
  parts: T[];
  /** The line holding the last part goes on past it (the confirmation question, for a known lead). */
  continues: boolean;
}

/**
 * Finds the disclosure at the start of a transcript. The rule, shared by the
 * harness checks, the live rule judge and the post-call judge: every part of
 * the call's disclosure (`expected`, the artificial intelligence sentence and,
 * when the recording notice is on, the recording sentence) is spoken word for
 * word and in that order, before any other agent line. Two parts may come as
 * one line, or as two lines when the voice model pauses between them; a caller
 * line between the two is allowed, an agent line other than the second part
 * between them is not. The line with the last part may go on past it (the
 * confirmation question). Returns null when the transcript does not open that
 * way. Whether each part was heard whole (not cut off) is for the caller of
 * this function to check on `parts`. System lines are skipped. Without
 * `expected`, the plain disclosure under the current recording notice setting.
 */
export function findInboundDisclosure<T extends { role: string; text: string }>(
  transcript: T[],
  expected: string[] = callOpening().disclosure,
): InboundDisclosureLines<T> | null {
  const agentLines = transcript.filter((t) => t.role === "agent");
  const [first, second] = agentLines;
  if (!first || !expected.length) return null;
  const whole = expected.join(" ");
  if (beginsWith(first.text, whole)) return { split: false, parts: [first], continues: wordsOf(first.text) !== wordsOf(whole) };
  if (expected.length !== 2 || wordsOf(first.text) !== wordsOf(expected[0]!)) return null;
  if (!second || !beginsWith(second.text, expected[1]!)) return null;
  return { split: true, parts: [first, second], continues: wordsOf(second.text) !== wordsOf(expected[1]!) };
}

/**
 * The outbound rule: the first agent line opens with the call's disclosure,
 * word for word, and may go on (the confirmation question). With nothing
 * recorded for the call, an older record, it only has to contain the literal
 * words "AI assistant".
 */
export function outboundDisclosureFirst(firstAgentText: string | undefined, expected?: string[]): boolean {
  if (firstAgentText === undefined) return false;
  if (expected?.length) return beginsWith(firstAgentText, expected.join(" "));
  return /\bAI assistant\b/.test(firstAgentText);
}
