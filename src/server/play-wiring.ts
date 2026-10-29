/**
 * The one place the play mode gets its call implementation: the decision
 * module's start, which goes through the harness (every compliance check, a
 * single-use clearance, the disclosure as the agent's first turn). Tests that
 * exercise only the page's own logic may install the local fake with
 * setStartInteractiveCall; the dev server never does.
 */
import { CallHarness } from "../harness/call-harness.js";
import { startInteractiveCall } from "../decision/interactive.js";
import { toTreeView } from "../decision/tree.js";
import { loadActiveTree } from "../decision/tree-source.js";
import { getHarnessConfig, setAiCallingEnabled } from "../config.js";
import { getLead, seedLead, type LeadRecord } from "../store/lead-store.js";
import type { Clock } from "../types/clock.js";
import { systemClock } from "../types/clock.js";
import type { StartInteractiveCall } from "./fake-interactive.js";
export type { InteractiveCall, StartInteractiveCall } from "./fake-interactive.js";

/** Served by `GET /api/tree`: the tree the next call will run (a switch applies to the next call). */
export const currentDecisionTree = () => toTreeView(loadActiveTree());

export interface PlayLeadOption {
  id: string;
  label: string;
  /** True when the lead is on the do-not-call list (Talk may still start them in dev). */
  onDncList?: boolean;
  /** Prefer this lead when the Talk picker loads. */
  talkDefault?: boolean;
}

export const playLeads: PlayLeadOption[] = [
  { id: "lead-1", label: "Jane (all consents)" },
  { id: "lead-2", label: "Marcus (asked about a renewal)" },
  { id: "lead-3", label: "Priya (no text consent)" },
  { id: "lead-4", label: "Maria (Ortega Landscaping, renewal in 45 days)" },
];

/** A calendar date (YYYY-MM-DD) and ISO instant some days from now; the demo lead's dates are computed when seeded. */
function daysFromNow(days: number): { date: string; iso: string } {
  const d = new Date(Date.now() + days * 86_400_000);
  return { date: d.toISOString().slice(0, 10), iso: d.toISOString() };
}

/** Maria's record for the demo: a renewal 45 days out and one earlier call 21 days ago. */
function mariaDemoLead(): Pick<LeadRecord, "timezone" | "priorCallSummaries" | "briefing"> {
  const renewal = daysFromNow(45);
  const earlier = daysFromNow(-21);
  const summary = "Spoke with Maria; she was on a job site and asked us to call back closer to the renewal.";
  return {
    timezone: "America/Los_Angeles",
    priorCallSummaries: [`${earlier.date}: ${summary}`],
    briefing: {
      agencyName: "Example Mutual",
      producerName: "Pat",
      business: "Ortega Landscaping",
      ownerName: "Maria Ortega",
      trade: "Landscaping (C-27)",
      city: "Fresno",
      state: "CA",
      xDate: { date: renewal.date, line: "workers' compensation", carrier: "State Compensation Insurance Fund" },
      carriersCurrent: ["State Compensation Insurance Fund"],
      employees: { count: 9, basis: "vendor estimate", modeled: true },
      priorCalls: [{ at: earlier.iso, direction: "outbound", channel: "call", summary }],
      priorTexts: [],
      missedOutboundCalls: [],
    },
  };
}

/** Leads the Call/Talk picker may start. */
export async function listPlayLeads(): Promise<PlayLeadOption[]> {
  return playLeads.map((lead) => ({ ...lead, talkDefault: lead.id === "lead-4" }));
}

let playClock: Clock = systemClock;
/** The clock the play harness uses for calling hours and the agreed time (tests fix it). */
export function setPlayClock(clock: Clock): void {
  playClock = clock;
}

/** Adds the play leads to the mock store when they are not there yet. Never overwrites a lead. */
export function ensurePlayLeads(): void {
  if (getHarnessConfig().leadStoreKind !== "mock") return;
  const consent = "2026-10-01T12:00:00.000Z";
  playLeads.forEach((l, i) => {
    if (getLead(l.id)) return;
    const textConsent = l.id !== "lead-3";
    seedLead({
      id: l.id,
      agencyId: getHarnessConfig().agencyId,
      name: l.label.split(" ")[0]!,
      phone: `+155501000${10 + i}`,
      timezone: "America/New_York",
      smsConsentAt: textConsent ? consent : undefined,
      voiceConsentAt: consent,
      artificialVoiceConsent: { at: consent, basis: "lead_written" },
      textAgreementAt: textConsent ? consent : undefined,
      scheduledOutboundAt: consent,
      dncStatus: "clear",
      priorCallSummaries: [],
      quoteFields: {},
      handoffNotes: [],
      messages: [],
      bookings: [],
      ...(l.id === "lead-4" ? mariaDemoLead() : {}),
    });
  });
}

const gatedStart: StartInteractiveCall = ({ leadId, direction }) =>
  startInteractiveCall({ leadId, direction, harness: new CallHarness(playClock), playTalk: true });

let starter: StartInteractiveCall | null = gatedStart;

export function setStartInteractiveCall(fn: StartInteractiveCall | null): void {
  starter = fn;
}

export function resetStartInteractiveCall(): void {
  starter = gatedStart;
}

export function getStartInteractiveCall(): StartInteractiveCall | null {
  return starter;
}
