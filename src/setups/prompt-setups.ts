/**
 * Prompt setups: named variants of the instructions the voice agent starts a
 * call with, so two runs can differ in the prompt and nothing else. A setup
 * says whether the lead's real record is written into the prompt; the
 * "no lead record" variant is the control that shows what the record adds.
 *
 * `renderAgentPrompt` is the one place that turns a setup plus a context
 * packet into the text a voice module sends as its instructions.
 */

import type { LeadBriefing } from "../memory/briefing.js";
import type { LeadContextPacket } from "../memory/context.js";

export interface PromptSetup {
  id: string;
  label: string;
  /** Written into the prompt: the lead's record section. False is the control. */
  includesBriefing: boolean;
  instructions: string;
}

/** The fixed rules the agent is tested against, in plain words. */
const CORE_RULES = [
  "You are an artificial intelligence assistant answering for an insurance agency. Say so in your first turn, and say the call is recorded.",
  "Never state, estimate or hint at a price. Never give coverage advice, compare coverage or carriers, bind coverage, take payment, or change or cancel a policy. Those go to a licensed producer.",
  "Never claim a quote exists. Never use false urgency. Never promise something you cannot deliver. Never let the caller believe a licensed person is on the line.",
  "Before you have confirmed you are speaking with the right person, do not discuss the renewal, the carrier or any account detail.",
  "Your job, in this order: confirm the renewal date (the X-date); collect payroll and employee count; learn current coverage, especially general liability; book an appointment with a licensed producer; otherwise take a message and write a handoff note.",
  "If the caller raises the same objection a second time, treat it as a real decision and end politely. A request to stop contact, in any words, ends the call at once.",
];

const BASELINE = `${CORE_RULES.map((r) => `- ${r}`).join("\n")}\n- Speak in short spoken turns. Ask one question at a time.`;

export const PROMPT_SETUPS: readonly PromptSetup[] = [
  {
    id: "baseline-with-lead-record",
    label: "Baseline rules, lead record included",
    includesBriefing: true,
    instructions: BASELINE,
  },
  {
    id: "baseline-no-lead-record",
    label: "Baseline rules, no lead record (control)",
    includesBriefing: false,
    instructions: BASELINE,
  },
  {
    id: "brief-with-lead-record",
    label: "Short rules, lead record included",
    includesBriefing: true,
    instructions: [
      "You are an artificial intelligence assistant for an insurance agency; say so and say the call is recorded, in your first turn.",
      "Never give a price, advice, a quote, or bind anything. Confirm who you are speaking with before any account detail. Goals: confirm the X-date, get payroll and employee count, ask about general liability, book a licensed producer, else take a message. Stop at once if asked.",
    ]
      .map((r) => `- ${r}`)
      .join("\n"),
  },
];

export function getPromptSetup(id: string): PromptSetup {
  const found = PROMPT_SETUPS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown_prompt_setup:${id}`);
  return found;
}

export const DEFAULT_PROMPT_SETUP_ID = "baseline-with-lead-record";

function when(iso: string): string {
  return iso.slice(0, 10);
}

/** The lead's record as text. Unknown fields say so, so the agent collects them instead of guessing. */
export function renderBriefing(b: LeadBriefing): string {
  const lines: string[] = [];
  lines.push(`Business: ${b.business}${b.ownerName ? ` (owner on file: ${b.ownerName})` : ""}`);
  lines.push(`Trade: ${b.trade ?? "unknown"}${b.city || b.state ? `; location: ${[b.city, b.state].filter(Boolean).join(", ")}` : ""}`);
  lines.push(
    b.xDate
      ? `X-date on file: ${b.xDate.date}${b.xDate.line ? ` for ${b.xDate.line}` : ""}${b.xDate.carrier ? `, carrier ${b.xDate.carrier}` : ""}. Public-record data: confirm it, do not assume it.`
      : "X-date: unknown. Ask for it.",
  );
  lines.push(`Carriers believed current: ${b.carriersCurrent.length ? b.carriersCurrent.join(", ") : "unknown"}`);
  lines.push(
    b.employees
      ? `Employees on file: ${b.employees.count}${b.employees.modeled ? " (a modelled estimate, not the firm's own number)" : ""}. Confirm.`
      : "Employees: unknown. Ask.",
  );
  lines.push(
    b.payroll
      ? `Annual payroll estimate: ${b.payroll.annualEstimate} dollars${b.payroll.basis ? ` (basis: ${b.payroll.basis})` : ""}. An estimate, not the firm's figure: confirm.`
      : "Annual payroll: unknown. Ask.",
  );
  if (b.missedOutboundCalls.length) {
    lines.push(
      `Our system rang this number ${b.missedOutboundCalls.length} times without an answer and left no message (${b.missedOutboundCalls
        .map((c) => when(c.at))
        .join(", ")}). If the caller is calling back, they may not know who rang.`,
    );
  }
  if (b.priorCalls.length) {
    lines.push("Earlier calls:");
    for (const c of b.priorCalls.slice(0, 5)) lines.push(`  - ${when(c.at)} ${c.direction} ${c.channel}: ${c.summary}`);
  }
  if (b.priorTexts.length) {
    lines.push("Earlier texts:");
    for (const t of b.priorTexts.slice(0, 5)) lines.push(`  - ${when(t.at)} ${t.direction}: ${t.summary}`);
  }
  if (b.producerNote) lines.push(`Producer's note on the lead: ${b.producerNote}`);
  return lines.join("\n");
}

/** The full instructions for one call: the setup's rules, then the lead's record when the setup includes it. */
export function renderAgentPrompt(setup: PromptSetup, packet: Pick<LeadContextPacket, "name" | "briefing">): string {
  const parts = [setup.instructions];
  if (setup.includesBriefing && packet.briefing) {
    parts.push(
      `What the lead record says (the person may not be who the record names; confirm before using any of it):\n${renderBriefing(packet.briefing)}`,
    );
  }
  return parts.join("\n\n");
}
