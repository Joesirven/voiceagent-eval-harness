/**
 * The persona adapter: turns one synthetic persona from the training
 * archive's lead-scripts.json into everything a whole-call simulation needs.
 *
 *   - The direction, from the persona's own call-origin note. Every persona in
 *     the file today says "Inbound", including gatekeepers, the screener and
 *     the wrong numbers; a note that names neither direction is refused.
 *   - The lead the harness calls, built from the persona's own
 *     `setup.lead_record_on_file` and never from its `truth`, so the agent holds
 *     what the lead record would hold and must collect the rest. "No record under the
 *     caller's number" gives a lead with no record. A record that does not
 *     parse is refused, never filled in from the truth.
 *   - The lead's facts for a simulated lead, from the persona's `truth`.
 *   - How many unanswered outbound attempts come before the call: two for a
 *     callback after missed calls, so the tree takes the callback start.
 *   - The batch clock, from the file's own `today_for_all_dates`: the persona
 *     dates are written relative to that day.
 *
 * Nothing here reads an external lead record. The scripts file is read from
 * outside this repository (VOICE_HARNESS_LEAD_SCRIPTS_FILE) and is never copied in.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LeadFacts } from "../judging/offline/types.js";
import type { LeadBriefing } from "../memory/briefing.js";
import type { CallDirection } from "../provider/interface.js";
import { DEFAULT_LEAD_SCRIPTS_FILE, LEAD_SCRIPTS_ENV, type ScriptPersona } from "../setups/persona-card.js";
import type { LeadRecord } from "../store/lead-store.js";

export interface PersonaExpected {
  best_disposition: string;
  acceptable_alternatives?: string[];
  judge_gated_actions?: Array<{ action: string; when: string; judge_should: "approve" | "refuse" }>;
  must_not?: string[];
  handoff_note_must_contain?: string[];
}

export interface PersonaDecisionQuestion {
  question: string;
  answer: string;
  at: string;
}

/** A persona as the simulator reads it: the persona card's fields plus the grading fields. */
export interface SimPersona extends ScriptPersona {
  setup?: ScriptPersona["setup"] & { lead_record_on_file?: string };
  expected: PersonaExpected;
  decision_questions?: PersonaDecisionQuestion[];
}

export interface PersonaFile {
  path: string;
  /** SHA-256 of the file's bytes, recorded on every batch. */
  sha256: string;
  /** The day every persona date is written against, as YYYY-MM-DD. */
  today: string;
  personas: SimPersona[];
  /** The file's closed answer lists for the typed decision questions. */
  typedQuestions: Record<string, string[]>;
  /** The file's disposition names. */
  dispositions: string[];
  /** The file's own rules for a simulated lead ("how_a_simulated_lead_uses_a_persona"). */
  leadRules: string[];
}

export function personaFilePath(): string {
  return process.env[LEAD_SCRIPTS_ENV] ?? DEFAULT_LEAD_SCRIPTS_FILE;
}

/** Reads the whole persona file. Throws a fixed code when it is missing or not the expected shape. */
export function loadPersonaFile(path: string = personaFilePath()): PersonaFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("persona_file_unavailable");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("persona_file_unreadable");
  }
  const today = /^(\d{4}-\d{2}-\d{2})\b/.exec(String(parsed.today_for_all_dates ?? ""))?.[1];
  if (!today) throw new Error("persona_file_no_today");
  if (!Array.isArray(parsed.personas)) throw new Error("persona_file_unreadable");
  const personas = (parsed.personas as SimPersona[]).filter(
    (p) => p && typeof p.id === "string" && typeof p.situation === "string" && p.expected && typeof p.expected.best_disposition === "string",
  );
  if (personas.length !== parsed.personas.length) throw new Error("persona_file_bad_persona");
  const vocab = (parsed.vocabularies ?? {}) as { typed_questions?: Record<string, string[]>; dispositions?: Record<string, string> };
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    today,
    personas,
    typedQuestions: vocab.typed_questions ?? {},
    dispositions: Object.keys(vocab.dispositions ?? {}),
    leadRules: Array.isArray(parsed.how_a_simulated_lead_uses_a_persona)
      ? (parsed.how_a_simulated_lead_uses_a_persona as unknown[]).filter((r): r is string => typeof r === "string")
      : [],
  };
}

/** The persona's direction from its own call-origin note. */
export function directionOf(persona: SimPersona): CallDirection {
  const note = persona.setup?.call_origin_note?.trim() ?? "";
  if (/^inbound\b/i.test(note)) return "inbound";
  if (/^outbound\b/i.test(note)) return "outbound";
  throw new Error(`persona_direction_unknown:${persona.id}`);
}

/**
 * The batch clock: 18:00 universal time on the file's day, which is 11 in the
 * morning in California (where every persona's area code is) and inside the
 * calling window.
 */
export function batchClockFor(today: string): { now: () => Date; iso: string } {
  const iso = `${today}T18:00:00.000Z`;
  return { now: () => new Date(iso), iso };
}

export const PERSONA_TIMEZONE = "America/Los_Angeles";

/* ------------------------------------------------------ the lead record */

export type LeadRecordParse =
  | { kind: "record"; briefing: LeadBriefing; phone?: string; existingClient: boolean }
  /** The caller's number has no lead record. A possible match elsewhere is not something the agent holds. */
  | { kind: "no_record" }
  | { kind: "unparsed"; reason: string };

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Parses the persona's lead-record sentence. The shapes in the file:
 *   "<Business>, owner <Name>, mobile +15550101, public-record renewal 2026-12-14, carrier on file '<Carrier>'."
 *   "Existing policyholder <Business>; renewal 2026-12-15."
 *   "A lead record lists the number for a former contractor, '<Business>', no longer valid."
 *   "No record under her number. ..."
 * Anything else is "unparsed", and the persona is reported, not guessed at.
 */
export function parseLeadRecord(text: string | undefined): LeadRecordParse {
  const s = text?.trim() ?? "";
  if (!s) return { kind: "unparsed", reason: "no_lead_record_on_file" };
  if (/^no record under (?:his|her|their|the) number\b/i.test(s)) return { kind: "no_record" };

  let business: string | undefined;
  let existingClient = false;
  const policyholder = /^existing policyholder ([^;.]+?)(?:[;.]|$)/i.exec(s);
  const formerNumber = /^a lead record lists the number for [^,']*,?\s*'([^']+)'/i.exec(s);
  if (policyholder) {
    business = policyholder[1]!.trim();
    existingClient = true;
  } else if (formerNumber) {
    business = formerNumber[1]!.trim();
  } else {
    const first = s.split(",")[0]!.trim();
    if (/^\p{Lu}[\p{L}\p{N}'&.-]*(?:[ -][\p{L}\p{N}'&.-]+)*$/u.test(first) && !/\b(?:record|number|lead)\b/i.test(first)) business = first;
  }
  if (!business) return { kind: "unparsed", reason: "no_business_name" };

  const owners = /\bco-owners ([^,]+)|\bowner ([^,]+)/i.exec(s);
  const ownerName = (owners?.[1] ?? owners?.[2])?.trim();
  const renewal = /\brenewal (\d{4}-\d{2}-\d{2})/i.exec(s)?.[1] ?? (existingClient ? DATE.exec(s)?.[1] : undefined);
  // A carrier name may hold an apostrophe ("Golden Gate Workers' Insurance"): the closing quote is the one before a comma, a full stop or the end.
  const carrier = /\bcarrier on file '(.+?)'(?=\s*(?:[,.;]|$))/i.exec(s)?.[1];
  const phone = /\+155501\d{2}/.exec(s)?.[0];

  const briefing: LeadBriefing = {
    business,
    ...(ownerName ? { ownerName } : {}),
    ...(renewal ? { xDate: { date: renewal, line: "workers' compensation", ...(carrier ? { carrier } : {}) } } : {}),
    carriersCurrent: carrier ? [carrier] : [],
    priorCalls: [],
    priorTexts: [],
    missedOutboundCalls: [],
    // The record's own words, so a detail the parser does not model (stale filing, existing policy) still reaches the agent.
    producerNote: s,
  };
  return { kind: "record", briefing, existingClient, ...(phone ? { phone } : {}) };
}

/* ------------------------------------------------------ the simulation case */

export interface PersonaCase {
  persona: SimPersona;
  direction: CallDirection;
  /** The harness lead id, stable per persona. */
  leadId: string;
  lead: LeadRecord;
  record: LeadRecordParse;
  facts: LeadFacts;
  /** Unanswered outbound attempts the runner places before the call: 0 or 2. */
  missedAttempts: 0 | 2;
  /** The caller rings from a number other than the record's, so the agent holds no record. */
  callerNumberMismatch?: boolean;
  language: string;
  /** False for Spanish and mixed-language personas: the disclosures and gates are English only. How to handle them is a test call. */
  languageSupported: boolean;
}

function dollars(v: unknown): string | undefined {
  return typeof v === "number" ? `${v.toLocaleString("en-US")} dollars` : typeof v === "string" && v ? v : undefined;
}

/** The facts a simulated lead plays from: the persona's truth. `sourceCallId` names the persona, never a call. */
export function personaFacts(persona: SimPersona): LeadFacts {
  const truth = (persona.truth ?? {}) as Record<string, unknown>;
  const xDate = typeof truth.x_date === "string" && DATE.test(truth.x_date) ? truth.x_date : undefined;
  return {
    sourceCallId: `persona:${persona.id}`,
    ...(persona.persona.trade ? { businessType: persona.persona.trade } : {}),
    ...(xDate ? { renewalDate: xDate } : {}),
    ...(dollars(truth.annual_payroll) ? { annualPayroll: dollars(truth.annual_payroll) } : {}),
    ...(typeof truth.employees_full_time === "number" ? { employeeCount: truth.employees_full_time } : {}),
    ...(typeof truth.carrier === "string" && truth.carrier ? { currentCarrier: truth.carrier } : {}),
    language: persona.persona.language ?? "en",
    objections: [...(persona.objections ?? [])].sort((a, b) => a.order - b.order).map((o) => o.line),
    ...(persona.persona.temperament ? { temperament: persona.persona.temperament } : {}),
  };
}

function missedAttemptsFor(persona: SimPersona): 0 | 2 {
  if (persona.situation === "callback_after_missed_calls") return 2;
  return /\brang (?:him|her|them) twice\b/i.test(persona.setup?.lead_record_on_file ?? "") ? 2 : 0;
}

/** A fictional number for a lead with none on file, stable per persona. */
function fictionalPhone(personaId: string): string {
  const n = createHash("sha256").update(personaId).digest().readUInt16BE(0) % 10000;
  return `+1555010${String(n).padStart(4, "0")}`;
}

/**
 * One simulation case per persona. Throws a fixed code when the persona's
 * direction or lead record cannot be read; the runner reports the persona and
 * moves on.
 */
/**
 * The lead as the inbound callback sees it, after the missed calls: the text agreement existed only so the
 * system could dial, and is not something the caller agreed to. The scheduled dial time stays: the harness
 * counts the missed calls under it (call-harness.ts, countUnansweredAttempts), and the tree's callback start needs that count.
 */
export function withoutDialAgreement(lead: LeadRecord): LeadRecord {
  const { textAgreementAt: _t, ...rest } = lead;
  return rest;
}

/** A stage direction written as an opening line ("(silence for six seconds, then a muffled 'hello?')"): the quoted words only. */
export function spokenOpening(line: string | undefined): string | undefined {
  const s = line?.trim();
  if (!s || !/^[([]/.test(s)) return s;
  const quoted = /['"‘“]([^'"’”]+)['"’”]/.exec(s)?.[1]?.trim();
  return quoted || undefined;
}

export function buildPersonaCase(persona: SimPersona, opts: { agencyId: string; today: string }): PersonaCase {
  const direction = directionOf(persona);
  const parsed = parseLeadRecord(persona.setup?.lead_record_on_file);
  if (parsed.kind === "unparsed") throw new Error(`persona_lead_record_unparsed:${persona.id}:${parsed.reason}`);
  // A caller ringing from a number that is not the record's is not matched to the record: the agent holds nothing.
  const callerNumber = /\+155501\d{2}/.exec(persona.setup?.call_origin_note ?? "")?.[0];
  const callerMismatch = !!callerNumber && parsed.kind === "record" && parsed.phone !== callerNumber;
  const record: LeadRecordParse = callerMismatch ? { kind: "no_record" } : parsed;
  const leadId = `persona-${persona.id}`.slice(0, 60);
  // Consent dated the day before the batch, only where the system dialled (the two missed calls of a callback):
  // the outbound gates need it to place them. Nothing the persona never gave reaches the agent's packet.
  const at = `${opts.today}T00:00:00.000Z`;
  const consentAt = new Date(Date.parse(at) - 24 * 3600 * 1000).toISOString();
  const missedAttempts = missedAttemptsFor(persona);
  const dialConsent =
    missedAttempts === 2
      ? { voiceConsentAt: consentAt, artificialVoiceConsent: { at: consentAt, basis: "agency_attestation" as const }, textAgreementAt: consentAt, scheduledOutboundAt: consentAt }
      : {};
  const name = record.kind === "record" ? (record.briefing.ownerName ?? record.briefing.business) : "Unknown caller";
  const lead: LeadRecord = {
    id: leadId,
    agencyId: opts.agencyId,
    name,
    phone: (record.kind === "record" ? record.phone : undefined) ?? fictionalPhone(persona.id),
    timezone: PERSONA_TIMEZONE,
    ...dialConsent,
    dncStatus: "clear",
    priorCallSummaries: [],
    quoteFields: {},
    handoffNotes: [],
    messages: [],
    bookings: [],
    ...(record.kind === "record" ? { briefing: structuredClone(record.briefing) } : {}),
  };
  const language = persona.persona.language ?? "en";
  return {
    persona,
    direction,
    leadId,
    lead,
    record,
    facts: personaFacts(persona),
    missedAttempts,
    callerNumberMismatch: callerMismatch,
    language,
    languageSupported: language === "en",
  };
}
