/**
 * Runnable trial scenarios for the control page. Each one resets the mock
 * stores, seeds a synthetic lead, drives the harness against the currently
 * selected voice module, and returns the call log it produced.
 */

import { isAiCallingEnabled, setAiCallingEnabled } from "../config.js";
import { CallHarness } from "../harness/call-harness.js";
import { mockLeadStore } from "../store/lead-store-seam.js";
import { clearCallLogs, getCallLogs, type CallLogEntry } from "../store/call-log.js";
import { getLead, resetLeadStore, seedLead, type LeadRecord } from "../store/lead-store.js";
import { traceBus } from "../trace/index.js";
import type { Clock } from "../types/clock.js";

const AGENCY = "agency-demo";
const IN_WINDOW = "2026-10-15T14:00:00.000Z"; // 10:00 Eastern
const OUTSIDE_WINDOW = "2026-10-15T02:00:00.000Z"; // 22:00 Eastern

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function syntheticLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: "lead-1",
    agencyId: AGENCY,
    name: "Jane Doe",
    phone: "+15550101",
    timezone: "America/New_York",
    smsConsentAt: "2026-10-01T12:00:00.000Z",
    voiceConsentAt: "2026-10-01T12:00:00.000Z",
    artificialVoiceConsent: { at: "2026-10-01T12:00:00.000Z", basis: "lead_written" },
    textAgreementAt: "2026-10-01T12:00:00.000Z",
    scheduledOutboundAt: "2026-10-15T14:00:00.000Z",
    dncStatus: "clear",
    priorCallSummaries: ["Prior: asked about auto quote."],
    quoteFields: {},
    handoffNotes: [],
    messages: [],
    bookings: [],
    ...overrides,
  };
}

export interface ScenarioOutcome {
  id: string;
  title: string;
  summary: string;
  detail: unknown;
  logs: CallLogEntry[];
  /** The durable records this run wrote, oldest first. */
  recordIds: string[];
}

interface Scenario {
  id: string;
  title: string;
  run(): Promise<{ summary: string; detail: unknown }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "recognized-inbound",
    title: "Recognized-lead inbound",
    async run() {
      seedLead(syntheticLead());
      const r = await new CallHarness(clockAt(IN_WINDOW), mockLeadStore).runInbound("lead-1", "+15550102", {
        idempotencyKey: "scn-inbound",
        callerUtterances: ["Hi, I am Jane Doe, I need an auto quote.", "I drive a 2019 Honda Civic."],
      });
      return {
        summary: `${r.status} via ${r.moduleId}; handoff notes filed: ${getLead("lead-1")?.handoffNotes.length}`,
        detail: { transcript: r.transcript, quoteFields: getLead("lead-1")?.quoteFields, handoff: getLead("lead-1")?.handoffNotes },
      };
    },
  },
  {
    id: "outbound-agreed-time",
    title: "Outbound at the agreed time",
    async run() {
      seedLead(syntheticLead());
      const r = await new CallHarness(clockAt(IN_WINDOW), mockLeadStore).runOutbound("lead-1", "+15550101", {
        idempotencyKey: "scn-outbound",
        scheduledReason: "text_agreed_callback",
        callerUtterances: ["Are you an AI?"],
      });
      return { summary: `${r.status} via ${r.moduleId ?? "none"}`, detail: { transcript: r.transcript } };
    },
  },
  {
    id: "quiet-hours",
    title: "Quiet-hours refusal",
    async run() {
      seedLead(syntheticLead());
      const h = new CallHarness(clockAt(OUTSIDE_WINDOW), mockLeadStore);
      const call = await h.runOutbound("lead-1", "+15550101", {
        idempotencyKey: "scn-quiet",
        scheduledReason: "text_agreed_callback",
      });
      const text = await h.sendText("lead-1", "Hello", "scn-quiet-sms");
      return { summary: `call ${call.status} (${call.reason}); text ${text.status} (${text.reason})`, detail: { call, text } };
    },
  },
  {
    id: "stop-suppression",
    title: "STOP or do-not-call suppression",
    async run() {
      seedLead(syntheticLead({ onStopList: true }));
      const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
      const call = await h.runOutbound("lead-1", "+15550101", {
        idempotencyKey: "scn-stop",
        scheduledReason: "text_agreed_callback",
      });
      const text = await h.sendText("lead-1", "Hello", "scn-stop-sms");
      const inbound = await h.runInbound("lead-1", "+15550102", { idempotencyKey: "scn-stop-in" });
      return {
        summary: `call ${call.reason}; text ${text.reason}; inbound ${inbound.status}`,
        detail: { call, text, inbound },
      };
    },
  },
  {
    id: "duplicate-webhook",
    title: "Duplicate webhook",
    async run() {
      seedLead(syntheticLead());
      const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
      const opts = {
        idempotencyKey: "scn-dup",
        scheduledReason: "text_agreed_callback",
        callerUtterances: ["Hello"],
      };
      const first = await h.runOutbound("lead-1", "+15550101", opts);
      const second = await h.runOutbound("lead-1", "+15550101", opts);
      return { summary: `first ${first.status}; second ${second.status}`, detail: { first, second } };
    },
  },
  {
    id: "flag-off",
    title: "Agency flag off",
    async run() {
      seedLead(syntheticLead());
      const previous = isAiCallingEnabled(AGENCY);
      setAiCallingEnabled(AGENCY, false);
      const h = new CallHarness(clockAt(IN_WINDOW), mockLeadStore);
      let inbound, outbound;
      try {
        inbound = await h.runInbound("lead-1", "+15550102", { idempotencyKey: "scn-off-in" });
        outbound = await h.runOutbound("lead-1", "+15550101", {
          idempotencyKey: "scn-off-out",
          scheduledReason: "text_agreed_callback",
        });
      } finally {
        setAiCallingEnabled(AGENCY, previous);
      }
      return {
        summary: `inbound ${inbound.status}; outbound ${outbound.status} (${outbound.reason})`,
        detail: { inbound, outbound },
      };
    },
  },
  {
    id: "no-invented-facts",
    title: "No invented facts",
    async run() {
      seedLead(syntheticLead());
      const r = await new CallHarness(clockAt(IN_WINDOW), mockLeadStore).runInbound("lead-1", "+15550102", {
        idempotencyKey: "scn-facts",
        callerUtterances: ["Hello", "I want a 500 dollar deductible"],
      });
      return {
        summary: `fields stored: ${Object.keys(getLead("lead-1")?.quoteFields ?? {}).join(", ") || "none"}`,
        detail: { transcript: r.transcript, quoteFields: getLead("lead-1")?.quoteFields },
      };
    },
  },
];

export function listScenarios(): Array<{ id: string; title: string }> {
  return SCENARIOS.map(({ id, title }) => ({ id, title }));
}

/**
 * Runs one scenario against the selected module. Resets the lead store and
 * call log first, so it is a clean demonstration each time. The demo agency
 * flag is turned on for the run and put back afterwards; module settings are
 * left as the page set them.
 */
export async function runScenario(id: string): Promise<ScenarioOutcome> {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`unknown_scenario:${id}`);
  resetLeadStore();
  clearCallLogs();
  // Scenarios run with the demo agency on; the flag-off scenario turns it off itself.
  const previousFlag = isAiCallingEnabled(AGENCY);
  setAiCallingEnabled(AGENCY, true);
  const firstSeq = traceBus.history().at(-1)?.seq ?? 0;
  let outcome;
  try {
    outcome = await scenario.run();
  } finally {
    setAiCallingEnabled(AGENCY, previousFlag);
  }
  const { summary, detail } = outcome;
  const logs = getCallLogs();
  const recordIds = [...new Set(traceBus.history().filter((e) => e.seq > firstSeq).map((e) => e.recordId))];
  return { id, title: scenario.title, summary, detail, logs, recordIds };
}
