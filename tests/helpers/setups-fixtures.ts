import type { Row, SelectQuery } from "../../src/store/database-client.js";
import type { LeadScripts, ScriptPersona } from "../../src/setups/persona-card.js";
import { FakeDb } from "./fake-db.js";

/** The fake database plus the range and text filters the picker uses. */
export class RangeFakeDb extends FakeDb {
  async select(table: string, q: SelectQuery): Promise<Row[]> {
    const rows = await super.select(table, { ...q, limit: undefined });
    const out = rows.filter(
      (r) =>
        Object.entries(q.gte ?? {}).every(([c, v]) => r[c] != null && String(r[c]) >= String(v)) &&
        Object.entries(q.lte ?? {}).every(([c, v]) => r[c] != null && String(r[c]) <= String(v)) &&
        Object.entries(q.ilike ?? {}).every(([c, v]) => String(r[c] ?? "").toLowerCase().includes(v.toLowerCase())),
    );
    return q.limit === undefined ? out : out.slice(0, q.limit);
  }
}

export const LIVE_AGENCY = "00000000-0000-4000-8000-000000000001";
export const OTHER_AGENCY = "a0000000-0000-0000-0000-000000000100";
export const ROOFER = "00000000-0000-4000-8000-000000000001";
export const PLUMBER = "00000000-0000-4000-8000-000000000002";
export const ELECTRICIAN = "00000000-0000-4000-8000-000000000003";
export const WAREHOUSED = "00000000-0000-4000-8000-000000000004";
const entity = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;

/** Four synthetic leads, all invented, phones in the 555 exchange. */
export function seedSetupWorld(db: FakeDb): FakeDb {
  const lead = (id: string, n: number, agency: string, owner: string, created: string) => ({
    id, agency_id: agency, entity_id: entity(n), owner_name: owner, phone: `+1650555010${n}`, email: `owner${n}@example.com`,
    stage: "new", note: null, created_at: created, attributes: {}, updated_at: "2026-10-01T00:00:00.000Z",
  });
  db.seed("crm_lead",
    lead(ROOFER, 1, LIVE_AGENCY, "Dana Roofer", "2026-10-04"),
    lead(PLUMBER, 2, LIVE_AGENCY, "Sam Plumber", "2026-10-03"),
    lead(ELECTRICIAN, 3, LIVE_AGENCY, "Lee Sparks", "2026-10-02"),
    lead(WAREHOUSED, 4, OTHER_AGENCY, "Ghost Lead", "2026-10-01"),
  );
  db.seed("crm_lead_index",
    { entity_id: entity(1), business_name: "Example Ridge Roofing", owner_name: null, trade: "residential roofing", city: "Fresno", state: "CA", employees: 6, employees_basis: "per-firm", employees_is_modeled: false, next_renewal_on: "2026-12-14", next_renewal_line: "workers_comp", next_renewal_carrier: "Sample Mutual", carriers_current: ["Sample Mutual"], phone: "+15550101", email: "owner1@example.com", dnc_status: "clear" },
    { entity_id: entity(2), business_name: "Example Pipe Works", owner_name: null, trade: "plumbing", city: "Reno", state: "NV", employees: 3, employees_basis: "benchmark", employees_is_modeled: true, next_renewal_on: "2027-02-10", next_renewal_line: "workers_comp", next_renewal_carrier: null, carriers_current: [], phone: "+15550102" },
    { entity_id: entity(3), business_name: "Example Volt Electric", owner_name: null, trade: "electrical contractor", city: "Tulsa", state: "OK", employees: null, next_renewal_on: "2026-11-30", next_renewal_line: "workers_comp", next_renewal_carrier: "Other Sample Co", carriers_current: ["Other Sample Co"] },
    { entity_id: entity(4), business_name: "Ghost Roofing", owner_name: null, trade: "roofing", next_renewal_on: "2026-12-01" },
  );
  db.seed("crm_entity_fact",
    { entity_id: entity(1), key: "payroll.annual_est", value_num: 310000, observed_at: "2026-09-01T00:00:00Z" },
    { entity_id: entity(1), key: "payroll.annual_est", value_num: 280000, observed_at: "2026-10-01T00:00:00Z" },
    { entity_id: entity(1), key: "payroll.basis", value_text: "employees times county trade wage", observed_at: "2026-10-01T00:00:00Z" },
    { entity_id: entity(1), key: "payroll.trade_wage", value_num: 46000, observed_at: "2026-10-01T00:00:00Z" },
  );
  db.seed("crm_interaction_event",
    { contact_id: ROOFER, channel: "call", direction: "outbound", occurred_at: "2026-10-10T16:00:00Z", title: "Call", snippet: "Asked to call back after the holiday" },
    { contact_id: ROOFER, channel: "sms", direction: "outbound", occurred_at: "2026-10-11T16:00:00Z", title: "Text", snippet: "Hi Dana, this is the agency" },
    { contact_id: ROOFER, channel: "voicemail", direction: "inbound", occurred_at: "2026-10-12T16:00:00Z", title: "Voicemail", snippet: null },
    { contact_id: ELECTRICIAN, channel: "call", direction: "inbound", occurred_at: "2026-10-09T16:00:00Z", title: "Inbound call", snippet: "Wrong time, call later" },
    { contact_id: PLUMBER, channel: "sms", direction: "outbound", occurred_at: "2026-10-09T16:00:00Z", title: "Text", snippet: "Intro text" },
  );
  db.seed("crm_dialer_call",
    { contact_id: ROOFER, outcome: "no_answer", started_at: "2026-10-16T17:00:00Z" },
    { contact_id: ROOFER, outcome: "no_answer", started_at: "2026-10-17T18:30:00Z" },
    { contact_id: ROOFER, outcome: "human", started_at: "2026-10-12T18:30:00Z" },
    { contact_id: ELECTRICIAN, outcome: "no_answer", started_at: "2026-10-15T17:00:00Z" },
  );
  db.seed("crm_agency", { id: LIVE_AGENCY, outbound_config: {} });
  db.seed("crm_consent_event",
    { agency_id: LIVE_AGENCY, contact_id: ROOFER, channel: "call", action: "granted", scope: "ai_voice", occurred_at: "2026-10-01T12:00:00.000Z" },
    { agency_id: LIVE_AGENCY, contact_id: ROOFER, channel: "sms", action: "granted", occurred_at: "2026-10-01T12:05:00.000Z" },
  );
  return db;
}

const persona = (over: Partial<ScriptPersona> & { id: string; situation: string }): ScriptPersona => ({
  title: `Synthetic ${over.id}`,
  persona: { name: "Script Person", role: "owner", business: "Script Business", trade: "script trade", temperament: "friendly, hurried", language: "en", speech: "quick" },
  setup: { why_calling: "Saw two missed calls and no message.", call_origin_note: "Inbound." },
  opening_line: "Hi, who is this?",
  truth: { x_date: "2030-01-01", carrier: "Script Carrier", employees_full_time: 99, annual_payroll: 1, has_general_liability: true, owner_covered: false, subcontractors: 40000, email: "script@example.com" },
  reveal: { x_date: "if_asked", carrier: "if_asked", employees_full_time: "if_asked", annual_payroll: "if_asked", has_general_liability: "if_asked", subcontractors: "after_trust" },
  objections: [{ order: 2, class: "email_me", line: "Just email me." }, { order: 1, class: "busy", line: "I only have a minute." }],
  branch_behaviour: [{ if: "the agent says a price", then: "ask what the number is" }],
  hidden_facts: ["Says five employees and 250,000 dollars first.", "He is not covered himself."],
  ...over,
});

export function syntheticScripts(): LeadScripts {
  return {
    personas: [
      persona({ id: "callback-a", situation: "callback_after_missed_calls" }),
      persona({ id: "callback-b", situation: "callback_after_missed_calls" }),
      persona({ id: "callback-es", situation: "callback_after_missed_calls", persona: { language: "es", name: "Persona" } }),
      persona({ id: "cold-a", situation: "cold_inbound" }),
    ],
    rules: [],
  };
}
