-- voice_harness.call_lead_facts: the agency app's own structured lead facts for the
-- calls cleared for simulations, one row per source call, in the harness
-- Supabase project (harness_store). Pat approved reading these values
-- for the 219 cleared calls on 2026-10-20 (renewal date, carrier, headcount,
-- payroll, trade, business type), from the agency app production or development.
--
-- These are the agency app's values as stored, not facts extracted from call text.
-- voice_harness.sim_lead_facts (migration 004) keeps that second meaning; the
-- simulator builds its rows from this table, and can grade a fact extractor
-- against it.
--
-- The values are the lead record AS READ (read_at), the lead's current state,
-- not as of the call: reflects_current_state says so on every row.
--
-- One row per source call, also when nothing could be read, so a count of rows
-- always equals the number of calls looked at: facts_status says why a row has
-- no values (no lead on the call, no business entity on the lead, no lead
-- index row).
--
-- Column names follow LeadFacts in src/judging/offline/types.ts, in snake case
-- (renewal_date, current_carriers, employee_count, annual_payroll,
-- business_type); trade has no LeadFacts field and keeps the agency app's name. The
-- the agency app source of each column is in its comment.
--
-- No foreign keys into the agency app: call_project_ref says which database the
-- identifiers belong to. Access as for call_transcript: row level security on
-- (and forced), no policy; anon and authenticated lose schema usage and every
-- table privilege; service_role keeps select, insert, update and delete. The
-- loader writes as postgres, which bypasses row level security.
--
-- Idempotent. Apply with `tsx scripts/harness-db.ts up supabase/harness/005_call_lead_facts.sql`,
-- after 002 and 003 (call_transcript_id references call_transcript).

set lock_timeout = '10s';

begin;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'postgres'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema if not exists voice_harness;
revoke all on schema voice_harness from public, anon, authenticated;
grant usage on schema voice_harness to service_role;

create table if not exists voice_harness.call_lead_facts (
  id                      uuid primary key default gen_random_uuid(),

  -- Which call.
  source                  text not null check (source in ('dialer', 'quo')),
  source_table            text generated always as (case source when 'dialer' then 'cr_dialer_call' else 'cr_quo_call' end) stored,
  call_id                 uuid not null,
  call_project_ref        text not null check (call_project_ref in ('source_secondary', 'source_primary')),
  -- The source's own key: cr_quo_call.quo_call_id for Quo, the row id as text for the dialer.
  source_call_key         text check (source_call_key is null or length(btrim(source_call_key)) > 0),
  -- The transcript loaded from the same call, when there is one.
  call_transcript_id      uuid references voice_harness.call_transcript (id) on delete set null,

  -- Which lead.
  lead_id                 uuid,
  entity_id               uuid,
  facts_status            text not null check (facts_status in ('read', 'no_lead', 'no_entity', 'no_index_row')),
  constraint call_lead_facts_status_matches_ids check (
    (facts_status = 'no_lead' and lead_id is null and entity_id is null)
    or (facts_status = 'no_entity' and lead_id is not null and entity_id is null)
    or (facts_status in ('read', 'no_index_row') and lead_id is not null and entity_id is not null)
  ),

  -- The six approved facts, as the agency app stores them.
  renewal_date            date,
  current_carriers        text[],
  renewal_carrier         text,
  employee_count          numeric check (employee_count is null or employee_count >= 0),
  employee_count_basis    text,
  annual_payroll          numeric check (annual_payroll is null or annual_payroll >= 0),
  annual_payroll_observed_at timestamptz,
  trade                   text,
  business_type           text,
  -- No lead or no entity: no values. No lead index row: only the payroll observation can exist.
  constraint call_lead_facts_values_need_lead check (
    facts_status not in ('no_lead', 'no_entity')
    or (annual_payroll is null and annual_payroll_observed_at is null)
  ),
  constraint call_lead_facts_index_values_need_row check (
    facts_status = 'read'
    or (renewal_date is null and current_carriers is null and renewal_carrier is null and employee_count is null
        and employee_count_basis is null and trade is null and business_type is null)
  ),

  -- Provenance.
  reflects_current_state  boolean not null default true check (reflects_current_state),
  read_at                 timestamptz not null,
  loader_version          text not null check (length(btrim(loader_version)) > 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint call_lead_facts_one_row_per_call unique (source, call_id, call_project_ref)
);

create index if not exists call_lead_facts_entity_idx on voice_harness.call_lead_facts (entity_id) where entity_id is not null;

comment on table voice_harness.call_lead_facts is
  'the agency app''s structured lead facts for the calls cleared for simulations (Pat, 2026-10-20), one row per source call, as read (the lead''s current state, not as of the call). Not facts extracted from text: see sim_lead_facts. Service role only.';
comment on column voice_harness.call_lead_facts.call_id is 'cr_dialer_call.id or cr_quo_call.id, in the database named by call_project_ref.';
comment on column voice_harness.call_lead_facts.source_call_key is 'cr_quo_call.quo_call_id (Quo''s own call id) for Quo; cr_dialer_call.id as text for the dialer.';
comment on column voice_harness.call_lead_facts.call_transcript_id is 'voice_harness.call_transcript.id of the same call (whose call_key equals call_id), when its text was loaded.';
comment on column voice_harness.call_lead_facts.lead_id is 'cr_lead.id: the call''s contact_id. Null when the call has no lead (facts_status no_lead).';
comment on column voice_harness.call_lead_facts.entity_id is 'cr_lead.entity_id, the business the lead belongs to.';
comment on column voice_harness.call_lead_facts.facts_status is 'read: the lead index row was read (any value may still be null). no_lead and no_entity: no values. no_index_row: no lead index row, so only the payroll observation can be present.';
comment on column voice_harness.call_lead_facts.renewal_date is 'cr_lead_index.next_renewal_on.';
comment on column voice_harness.call_lead_facts.current_carriers is 'cr_lead_index.carriers_current.';
comment on column voice_harness.call_lead_facts.renewal_carrier is 'cr_lead_index.next_renewal_carrier.';
comment on column voice_harness.call_lead_facts.employee_count is 'cr_lead_index.employees.';
comment on column voice_harness.call_lead_facts.employee_count_basis is 'cr_lead_index.employees_basis.';
comment on column voice_harness.call_lead_facts.annual_payroll is 'cr_entity_fact value_num for key payroll.annual_est, the newest observation.';
comment on column voice_harness.call_lead_facts.annual_payroll_observed_at is 'cr_entity_fact observed_at of that observation.';
comment on column voice_harness.call_lead_facts.trade is 'cr_lead_index.trade.';
comment on column voice_harness.call_lead_facts.business_type is 'cr_lead_index.business_type.';
comment on column voice_harness.call_lead_facts.reflects_current_state is 'Always true: the values are the lead record when read (read_at), not as of the call.';

alter table voice_harness.call_lead_facts enable row level security;
alter table voice_harness.call_lead_facts force row level security;
revoke all on table voice_harness.call_lead_facts from public, anon, authenticated, service_role;
grant select, insert, update, delete on table voice_harness.call_lead_facts to service_role;

commit;
