-- harness_run: one row per voice-harness test call.
--
-- NOT APPLIED. Review and apply this file with the target database's migration
-- tool. Use a database dedicated to harness data.
--
-- What a row holds: the full snapshot of the setup the run used (voice module,
-- decision module, prompt text, lead record given to the agent), the
-- transcript, the whole trace, the judge verdicts and score, the disposition
-- and the call outcome. The harness writes the row when the call ends and
-- updates it when a later judge result lands. The key is record_id (the
-- harness's own record name), so a retry never doubles a run.
--
-- The table is standalone. It has no foreign key to an external lead table.

create table if not exists public.harness_run (
  id                  uuid primary key default gen_random_uuid(),
  record_id           text not null unique,
  call_id             text,
  -- No foreign key to an external lead table.
  lead_id             uuid not null,
  agency_id           uuid,
  direction           text check (direction in ('inbound', 'outbound')),
  is_test_run         boolean not null default true,
  setup_name          text not null,
  voice_module_id     text not null,
  decision_module_id  text not null,
  prompt_setup_id     text not null,
  persona_id          text,
  -- The resolved setup as it was when the call started, so later edits never change what this run says it used.
  setup_snapshot      jsonb not null,
  started_at          timestamptz not null,
  ended_at            timestamptz,
  outcome_status      text,
  disposition         text,
  outcome             jsonb,
  transcript          jsonb not null default '[]'::jsonb,
  trace               jsonb not null default '[]'::jsonb,
  judge_verdicts      jsonb not null default '[]'::jsonb,
  judge_score         jsonb,
  handoff_note        jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists harness_run_lead_started_idx on public.harness_run (lead_id, started_at desc);
create index if not exists harness_run_setup_started_idx on public.harness_run (setup_name, started_at desc);

comment on table public.harness_run is
  'Test calls from the local voice harness: setup snapshot, transcript, trace, judge verdicts, outcome. Transcripts are call content: treat as sensitive. Written only by the harness, through the service role.';

-- Only the service role reaches this table: row level security on, and no policy for anyone else.
alter table public.harness_run enable row level security;
revoke all on public.harness_run from anon, authenticated;

-- Make the table visible to the REST interface without waiting for a schema cache refresh.
notify pgrst, 'reload schema';
