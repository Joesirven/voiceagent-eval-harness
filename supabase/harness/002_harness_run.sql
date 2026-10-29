-- voice_harness.harness_run: one row per call and text attempt of the voice
-- harness. It holds the call's content in full: transcript, trace, setup
-- snapshot, rendered prompt, and briefing.
--
-- In schema voice_harness, which the Supabase API does not expose, rather than
-- public, which it does. The columns are the ones src/setups/run-sink.ts may
-- write (RUN_COLUMNS), plus the test-run columns of the local Docker table the
-- integrator built. A column the run writer does not set has a default. The
-- key is record_id (the harness's own record name), so a retry never doubles a
-- run. Text identifiers, and no foreign key into an external system: a row may describe
-- a synthetic lead.
--
-- Access: row level security on and forced, with no policy, so no role
-- without the bypass right reaches a row; anon and authenticated also lose
-- schema usage and every table privilege, and service_role keeps only select,
-- insert, update and delete. The harness writes as postgres, which bypasses
-- row level security.
--
-- Plain Postgres (the loopback database): anon, authenticated, service_role
-- and postgres (003 grants to it) are created as login-less roles when
-- missing, so this file and 003 apply the same way there.
--
-- Idempotent: safe to run twice. `create table if not exists` keeps an older
-- table as it is, so check the shape with `scripts/harness-db.ts verify`.
-- Apply with `tsx scripts/harness-db.ts up supabase/harness/002_harness_run.sql`.

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

create table if not exists voice_harness.harness_run (
  id                 uuid primary key default gen_random_uuid(),
  record_id          text not null unique,
  call_id            text,
  kind               text not null default 'call' check (kind in ('call', 'text')),
  lead_id            text not null,
  agency_id          text,
  direction          text check (direction in ('inbound', 'outbound')),
  attempt_number     integer check (attempt_number is null or attempt_number >= 1),
  attempt_status     text,
  block_reason       text,
  is_test_run        boolean not null default true,
  -- voice-harness-test is a run made with the legal blocks suspended.
  test_run_tag       text not null default 'voice-harness-test' check (test_run_tag in ('voice-harness-test', 'voice-harness')),
  test_session_id    text,
  setup_name         text not null default 'default',
  voice_module_id    text,
  decision_module_id text,
  prompt_setup_id    text,
  persona_id         text,
  -- The resolved setup as it was when the call started, so later edits never change what this run says it used.
  setup_snapshot     jsonb not null default '{}'::jsonb,
  started_at         timestamptz not null,
  ended_at           timestamptz,
  outcome_status     text,
  disposition        text,
  outcome            jsonb,
  transcript         jsonb not null default '[]'::jsonb,
  trace              jsonb not null default '[]'::jsonb,
  trace_ref          text,
  judge_verdicts     jsonb not null default '[]'::jsonb,
  judge_score        jsonb,
  handoff_note       jsonb,
  stop_requested     boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists harness_run_lead_started_idx on voice_harness.harness_run (lead_id, started_at desc);
create index if not exists harness_run_setup_started_idx on voice_harness.harness_run (setup_name, started_at desc);

comment on table voice_harness.harness_run is
  'Call and text attempts of the local voice harness: setup snapshot, transcript, trace, judge verdicts, outcome. Transcripts are call content: treat as sensitive. Harness project only; no anon or authenticated access.';

alter table voice_harness.harness_run enable row level security;
alter table voice_harness.harness_run force row level security;
revoke all on table voice_harness.harness_run from public, anon, authenticated, service_role;
grant select, insert, update, delete on table voice_harness.harness_run to service_role;

commit;
