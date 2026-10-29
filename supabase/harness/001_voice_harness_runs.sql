-- Voice harness runs: one row for every call and text attempt the local testing
-- harness makes (placed, answered, skipped, blocked or failed, with the reason),
-- with the transcript, outcome, disposition, handoff note, a reference to the full
-- trace, the test-run tag, and which voice, decision and prompt setups were used.
--
-- NOT APPLIED, and never to the harness Supabase project (scripts/harness-db.ts
-- refuses it; the harness table is voice_harness.harness_run in 002).
-- Written for the development database only, to be handed to Pat or
-- Dana. Never apply it to production. The harness probes for this table and falls
-- back to its local records when the table is missing, so applying it is optional.
--
-- Access: row-level security is on and there are no policies, so no signed-in user
-- or anonymous visitor can read or write a row. Only the service role (which skips
-- row-level security) can, and it is the key the harness uses.

create table if not exists public.voice_harness_runs (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- The call id, or the message id for a text. One row per attempt; a repeat write is ignored.
  attempt_id        text not null unique,
  record_id         text not null,
  kind              text not null check (kind in ('call', 'text')),
  direction         text check (direction in ('inbound', 'outbound')),
  -- Text, not a foreign key: the harness also runs on synthetic leads that are not in cr_lead.
  lead_id           text not null,

  status            text not null check (status in ('placed', 'answered', 'skipped', 'blocked', 'failed')),
  -- The harness's own status word, for example ai_handled, not_answered or skipped_duplicate.
  detail_status     text not null,
  -- Why it was skipped, blocked or failed, as a short reason code. Null when nothing stopped it.
  reason            text,

  transcript        jsonb not null default '[]'::jsonb,
  outcome           jsonb,
  disposition       text,
  handoff_note      jsonb,
  -- The file name of the full trace in the harness's local records.
  trace_ref         text not null,

  -- Every row is tagged. voice-harness-test is a run made with the legal blocks suspended.
  test_run_tag      text not null check (test_run_tag in ('voice-harness-test', 'voice-harness')),
  test_session_id   text,

  voice_setup_id    text,
  decision_setup_id text,
  prompt_setup_id   text,

  -- A request to stop was heard. In test mode it is recorded here and locally only,
  -- never through the agency app's STOP function.
  stop_requested    boolean not null default false,
  recorded_at       timestamptz not null default now()
);

create index if not exists voice_harness_runs_lead_idx on public.voice_harness_runs (lead_id, created_at desc);
create index if not exists voice_harness_runs_session_idx on public.voice_harness_runs (test_session_id);

alter table public.voice_harness_runs enable row level security;
alter table public.voice_harness_runs force row level security;

revoke all on table public.voice_harness_runs from public;
revoke all on table public.voice_harness_runs from anon;
revoke all on table public.voice_harness_runs from authenticated;
grant select, insert on table public.voice_harness_runs to service_role;

comment on table public.voice_harness_runs is
  'Call and text attempts from the local voice testing harness (development database only). Service role only.';
