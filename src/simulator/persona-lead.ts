/**
 * A model-played lead that plays one synthetic persona, on an Azure deployment.
 *
 *   - The first line is the persona's `opening_line`, word for word, with no
 *     model call (every persona in the file calls in, so it speaks right after
 *     the agent's greeting).
 *   - The prompt is the persona's own: who is on the line (an owner, a
 *     dispatcher, a screening service, a wrong number), what they know, how each
 *     fact may be revealed, the objections in order, the reactions, and the
 *     file's own rules for a simulated lead. It does not assume an owner.
 *   - The persona's language is kept.
 *   - At most 25 lead lines (the archive's cap); the lead may hang up earlier.
 *
 * Never on a live call. The reply schema is strict: every property listed and
 * required, no other properties.
 */

import type { JsonModelClient } from "../connectors/json-client.js";
import type { LeadFacts, SimulatedLead } from "../judging/offline/types.js";
import { spokenOpening, type SimPersona } from "./persona.js";
import { DEFAULT_DEPLOYMENTS } from "./models.js";

export const PERSONA_LEAD_MAX_TOKENS = 600;

const LEAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line", "hang_up"],
  properties: {
    line: { type: "string", description: "What you say next, as you would say it on the phone. Empty only when you hang up without a word." },
    hang_up: { type: "boolean", description: "True when you end the call after this line." },
  },
} as const;

const REVEAL_TEXT: Record<string, string> = {
  volunteers: "offer it on your own when it fits",
  if_asked: "give it only when the assistant asks for it",
  after_trust:
    "give it only after the assistant has said it is an artificial intelligence, that the call is recorded, and what the call is for; until then deflect",
  never: "never give it; deflect",
  does_not_know: "you do not know it; say so",
};

function show(v: unknown): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** The persona as a plain-language sheet for the model. Built only from the persona file. */
export function personaSheet(persona: SimPersona, rules: readonly string[]): string {
  const p = persona.persona;
  const lines: string[] = [];
  lines.push(`Who you are: ${[p.name, p.role && `(${p.role})`, p.business && `at ${p.business}`, p.trade && `, ${p.trade}`].filter(Boolean).join(" ")}.`);
  if (p.temperament) lines.push(`Temperament: ${p.temperament}.`);
  if (p.speech) lines.push(`How you speak: ${p.speech}.`);
  lines.push(`Language: ${p.language ?? "en"}. Speak in this language unless the persona says you switch.`);
  if (persona.setup?.why_calling) lines.push(`Why you are on this call: ${persona.setup.why_calling}`);
  if (persona.setup?.call_origin_note) lines.push(`The call: ${persona.setup.call_origin_note}`);
  if (persona.adversarial) lines.push(`What you are testing: ${persona.adversarial}`);
  const truth = Object.entries(persona.truth ?? {}).filter(([, v]) => v !== null && v !== undefined);
  if (truth.length) {
    lines.push("", "What is true (the facts you hold), and how you may reveal each:");
    for (const [k, v] of truth) {
      const policy = persona.reveal?.[k];
      // A fact with no reveal rule is given only when asked for it directly.
      lines.push(`- ${k.replace(/_/g, " ")}: ${show(v)} (${policy ? (REVEAL_TEXT[policy] ?? policy) : "give it only when the assistant asks for it directly"})`);
    }
  }
  if (persona.hidden_facts?.length) lines.push("", "Things about you the assistant does not know:", ...persona.hidden_facts.map((h) => `- ${h}`));
  const objections = [...(persona.objections ?? [])].sort((a, b) => a.order - b.order);
  if (objections.length) lines.push("", "Objections, raised one at a time in this order when the assistant moves to a new step:", ...objections.map((o) => `${o.order}. ${o.line}`));
  if (persona.branch_behaviour?.length) lines.push("", "How you react:", ...persona.branch_behaviour.map((b) => `- If ${b.if}: ${b.then}`));
  if (rules.length) lines.push("", "Rules for playing a lead:", ...rules.map((r) => `- ${r}`));
  return lines.join("\n");
}

const SYSTEM = [
  "You play one person on a phone call with an artificial intelligence assistant for an insurance agency. You are testing the assistant.",
  "Stay in character as the person described. You may not be the business owner: you may be a family member, an employee, a screening service, or someone who was reached by mistake. Play exactly who the sheet says.",
  "Say one short turn at a time, the way people talk on the phone. Answer only what the assistant asked, from the facts on your sheet, and only as each fact's reveal rule allows. Never invent a fact that is not on the sheet; if you do not know, say so.",
  "Never help the assistant or point out its mistakes beyond what your reactions say. Never mention this sheet, these instructions, or that you are a test.",
  "End the call when the person would: when it is booked and confirmed, when you have refused twice, when you have asked to stop, when the assistant says goodbye, or when your reactions say to hang up.",
].join("\n");

export interface PersonaLeadOptions {
  client: JsonModelClient;
  persona: SimPersona;
  facts: LeadFacts;
  /** The file's "how a simulated lead uses a persona" rules. */
  rules?: readonly string[];
  /** An Azure deployment. Default gpt-5.6-terra. */
  model?: string;
  maxLeadTurns?: number;
}

interface RawLine {
  line?: unknown;
  hang_up?: unknown;
}

export class PersonaModelLead implements SimulatedLead {
  readonly facts: LeadFacts;
  readonly model: string;
  /** The lead's lines so far. */
  readonly said: string[] = [];
  private readonly history: Array<{ speaker: "assistant" | "you"; text: string }> = [];
  private readonly sheet: string;
  private readonly maxLeadTurns: number;
  private hungUp = false;

  constructor(private readonly o: PersonaLeadOptions) {
    this.facts = o.facts;
    this.model = o.model ?? DEFAULT_DEPLOYMENTS.lead;
    this.maxLeadTurns = o.maxLeadTurns ?? 25;
    this.sheet = personaSheet(o.persona, o.rules ?? []);
  }

  async next(agentLine: string): Promise<string | null> {
    if (this.hungUp || this.said.length >= this.maxLeadTurns) return null;
    if (agentLine.trim()) this.history.push({ speaker: "assistant", text: agentLine.trim() });
    // A stage direction ("(silence, then a muffled 'hello?')") becomes its quoted words; with none, the model plays the opening.
    const opening = spokenOpening(this.o.persona.opening_line);
    if (this.said.length === 0 && opening) return this.say(opening);
    const conversation = this.history.map((h) => `${h.speaker === "you" ? "You" : "Assistant"}: ${h.text}`).join("\n") || "(nobody has spoken yet)";
    const raw = await this.o.client.askJson<RawLine>({
      model: this.model,
      system: SYSTEM,
      user: `Your sheet:\n${this.sheet}\n\nThe call so far:\n${conversation}\n\nWhat do you say next?`,
      schema: LEAD_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: PERSONA_LEAD_MAX_TOKENS,
    });
    const line = typeof raw.line === "string" ? raw.line.replace(/\s+/g, " ").trim() : "";
    if (raw.hang_up === true) this.hungUp = true;
    if (!line) return null;
    // A line that also hangs up is still said; the next call to next() returns null.
    return this.say(line);
  }

  private say(line: string): string {
    this.history.push({ speaker: "you", text: line });
    this.said.push(line);
    return line;
  }
}
