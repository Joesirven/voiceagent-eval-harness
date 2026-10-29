/**
 * The persona card: a short sheet of who Pat is pretending to be on a test
 * call. The real lead supplies the facts (business, trade, carrier, X-date,
 * headcount, payroll when CRM has it). The lead script supplies the
 * temperament, the objections in order, how to react to what the agent does,
 * and the facts CRM does not hold (general liability, subcontractors).
 *
 * The scripts file is read at runtime from a path outside this repository
 * (VOICE_HARNESS_LEAD_SCRIPTS_FILE) and is never copied here. Without it the card
 * still lists the lead's facts, with no script lines.
 *
 * Each fact says whether it is already in the agent's context packet, so Pat
 * can tell a fact the agent should confirm from one it should collect.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { LeadBriefing } from "../memory/briefing.js";

export const LEAD_SCRIPTS_ENV = "VOICE_HARNESS_LEAD_SCRIPTS_FILE";
/** Where the training archive's workflow wrote the scripts on this host. */
export const DEFAULT_LEAD_SCRIPTS_FILE = "";

export type RevealPolicy = "volunteers" | "if_asked" | "after_trust" | "never" | "does_not_know";

export interface ScriptPersona {
  id: string;
  title: string;
  adversarial?: string | null;
  situation: string;
  persona: { name?: string; role?: string; business?: string; trade?: string; temperament?: string; language?: string; speech?: string };
  setup?: { why_calling?: string; call_origin_note?: string };
  opening_line?: string;
  truth?: Record<string, unknown>;
  reveal?: Record<string, RevealPolicy>;
  objections?: Array<{ order: number; class: string; line: string }>;
  branch_behaviour?: Array<{ if: string; then: string }>;
  hidden_facts?: string[];
}

export interface LeadScripts {
  personas: ScriptPersona[];
  rules: string[];
}

export interface PersonaFact {
  label: string;
  value: string;
  reveal: RevealPolicy | "unscripted";
  source: "lead_record" | "script";
  /** True when the agent's context packet already holds this fact (so the agent confirms rather than collects). */
  inAgentPacket: boolean;
}

export interface PersonaCard {
  /** Absent when no script was available: the card then lists the lead's facts only. */
  personaId?: string;
  title?: string;
  situation?: string;
  language: string;
  adversarial?: string;
  you: { name: string; role?: string; business: string; trade?: string; temperament?: string; speech?: string };
  whyYouAreCalling?: string;
  callOrigin?: string;
  openingLine?: string;
  /** The two missed calls you saw, when there is a callback to play. */
  missedCalls: Array<{ at: string; simulated: boolean }>;
  facts: PersonaFact[];
  objections: Array<{ order: number; class: string; line: string }>;
  reactions: Array<{ if: string; then: string }>;
  traits: string[];
  /** Script lines left out because they quote numbers that now disagree with the real record. */
  droppedScriptTraits: number;
  howToPlay: string[];
}

interface Cached {
  mtimeMs: number;
  scripts: LeadScripts;
}
const cache = new Map<string, Cached>();

export function loadLeadScripts(path: string = process.env[LEAD_SCRIPTS_ENV] ?? DEFAULT_LEAD_SCRIPTS_FILE): LeadScripts {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    throw new Error("lead_scripts_unavailable");
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.scripts;
  let parsed: { personas?: unknown; how_a_simulated_lead_uses_a_persona?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("lead_scripts_unreadable");
  }
  if (!Array.isArray(parsed.personas)) throw new Error("lead_scripts_unreadable");
  const scripts: LeadScripts = {
    personas: (parsed.personas as ScriptPersona[]).filter((p) => p && typeof p.id === "string" && typeof p.situation === "string"),
    rules: Array.isArray(parsed.how_a_simulated_lead_uses_a_persona)
      ? (parsed.how_a_simulated_lead_uses_a_persona as unknown[]).filter((r): r is string => typeof r === "string")
      : [],
  };
  cache.set(path, { mtimeMs, scripts });
  return scripts;
}

export function listPersonas(scripts: LeadScripts): Array<{ id: string; title: string; situation: string; language: string }> {
  return scripts.personas.map((p) => ({ id: p.id, title: p.title, situation: p.situation, language: p.persona.language ?? "en" }));
}

function stableIndex(seed: string, size: number): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % size;
}

export interface ChoosePersona {
  personaId?: string;
  situation?: string;
}

/**
 * An explicit persona, else one of the right situation picked from the lead id so the same lead
 * always gets the same persona. A lead with unanswered calls gets a callback; English unless asked.
 */
export function choosePersona(scripts: LeadScripts, leadId: string, briefing: LeadBriefing, want: ChoosePersona = {}): ScriptPersona | undefined {
  if (want.personaId) {
    const found = scripts.personas.find((p) => p.id === want.personaId);
    if (!found) throw new Error(`unknown_persona:${want.personaId}`);
    return found;
  }
  const situation = want.situation ?? (briefing.missedOutboundCalls.length ? "callback_after_missed_calls" : "cold_inbound");
  const pool = scripts.personas.filter((p) => p.situation === situation && (p.persona.language ?? "en") === "en");
  const fallback = pool.length ? pool : scripts.personas.filter((p) => p.situation === situation);
  return fallback.length ? fallback[stableIndex(leadId, fallback.length)] : undefined;
}

const TRUTH_LABELS: Record<string, string> = {
  x_date: "Renewal date (X-date)",
  carrier: "Workers' compensation carrier",
  employees_full_time: "Full-time employees",
  employees_part_time: "Part-time employees",
  annual_payroll: "Annual payroll",
  has_general_liability: "Has general liability",
  owner_covered: "Owner covered by the policy",
  subcontractors: "Subcontractor spend per year",
  out_of_state_work: "Works out of state",
  years_in_business: "Years in business",
  email: "Email",
};

function show(v: unknown): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return String(v);
}

const HOW_TO_PLAY = [
  "Stay in character and speak in short turns. Start with the opening line.",
  "Give a fact only the way its reveal tag says: volunteers (offer it), if_asked (when asked), after_trust (only after the agent says it is an artificial intelligence, that the call is recorded, and what the call is for), never (deflect), does_not_know.",
  "Raise the objections in order, one at a time, when the agent moves to a new step. React to what the agent does using the reactions list.",
  "End the call when the person would: booked, refused twice, a stop request, or a hang up. Twenty-five turns at most.",
];

const NUMERIC_OVERRIDES = new Set(["x_date", "employees_full_time", "annual_payroll"]);

export interface BuildCardOptions {
  /** Whether the agent's prompt carries the lead's record. False marks every record fact as not in the packet. */
  briefingInAgentPacket: boolean;
}

/** The real record wins over the script wherever CRM holds the fact; the script fills the rest. */
export function buildPersonaCard(briefing: LeadBriefing, script: ScriptPersona | undefined, opts: BuildCardOptions): PersonaCard {
  const inPacket = opts.briefingInAgentPacket;
  const facts: PersonaFact[] = [];
  const overridden = new Set<string>();
  const policy = (key: string): RevealPolicy | "unscripted" => script?.reveal?.[key] ?? "unscripted";

  const record = (key: string, value: string | undefined): boolean => {
    if (value === undefined) return false;
    facts.push({ label: TRUTH_LABELS[key] ?? key, value, reveal: policy(key), source: "lead_record", inAgentPacket: inPacket });
    overridden.add(key);
    return true;
  };

  record("x_date", briefing.xDate?.date);
  record("carrier", briefing.xDate?.carrier ?? briefing.carriersCurrent[0]);
  record("employees_full_time", briefing.employees ? String(briefing.employees.count) : undefined);
  record("annual_payroll", briefing.payroll ? `${briefing.payroll.annualEstimate} dollars` : undefined);
  // The record's headcount and payroll are estimates from public data: Pat may know better, and the agent should confirm.

  for (const [key, value] of Object.entries(script?.truth ?? {})) {
    if (overridden.has(key) || value === null || value === undefined || key === "other") continue;
    facts.push({ label: TRUTH_LABELS[key] ?? key.replace(/_/g, " "), value: show(value), reveal: policy(key), source: "script", inAgentPacket: false });
  }

  const numericOverride = [...overridden].some((k) => NUMERIC_OVERRIDES.has(k));
  const scriptTraits = script?.hidden_facts ?? [];
  const traits = numericOverride ? scriptTraits.filter((t) => !/\d/.test(t)) : scriptTraits;
  const language = script?.persona.language ?? "en";

  return {
    personaId: script?.id,
    title: script?.title,
    situation: script?.situation,
    language,
    adversarial: script?.adversarial ?? undefined,
    // The real lead's identity replaces the script character's, so what Pat says matches what the agent holds.
    you: {
      name: briefing.ownerName ?? script?.persona.name ?? "the owner",
      role: script?.persona.role,
      business: briefing.business,
      trade: briefing.trade ?? script?.persona.trade,
      temperament: script?.persona.temperament,
      speech: script?.persona.speech,
    },
    whyYouAreCalling: script?.setup?.why_calling,
    callOrigin: script?.setup?.call_origin_note,
    openingLine: script?.opening_line,
    missedCalls: briefing.missedOutboundCalls.map((c) => ({ at: c.at, simulated: c.simulated })),
    facts,
    objections: [...(script?.objections ?? [])].sort((a, b) => a.order - b.order),
    reactions: script?.branch_behaviour ?? [],
    traits,
    droppedScriptTraits: scriptTraits.length - traits.length,
    howToPlay: HOW_TO_PLAY,
  };
}
