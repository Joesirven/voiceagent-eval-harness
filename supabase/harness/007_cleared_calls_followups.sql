-- Follow-ups to 005 and 006 from their landing review (the migration review),
-- harness Supabase project (harness_store). 005 and 006 are applied
-- and frozen; everything here is a new statement on top of them.
--
-- 1. PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): evaluation readers and the
--    simulator need the 219 cleared calls, whose turns are eval_ready but not
--    redacted, so transcript_turn_redacted shows none of them. The view
--    transcript_turn_prototype shows every turn with its raw text and its
--    redaction_status. Drop it in the safety pass.
-- 2. Access on call_lead_facts: 005's header says "as for call_transcript",
--    which has a service_role_all policy, while 005 gave call_lead_facts none.
--    On Supabase both work because service_role and postgres hold the bypass
--    right (checked 2026-10-20: rolbypassrls true for both; service_role read
--    all 219 rows), but on plain Postgres a service_role without it would read
--    nothing. So call_lead_facts gets the same service_role_all policy, and
--    its row level security stays forced.
-- 3. call_transcript_id must name the transcript of the same call: a composite
--    foreign key on (id, source, call key, project), and a trigger that only
--    accepts a link to the current run (is_current) when it is written.
-- 4. source_call_key is required and unique per source and project.
--
-- On 2026-10-20 all 219 rows already met 3 and 4 (219 of 219 keys present
-- and distinct; 219 of 219 links on the same call and current).
--
-- 5. Every statement that promises raw text never leaves the database (the
--    transcript_turn table comment, the text_raw column comment, the redacted
--    view's comment) now says the prototype shortcut overrides it here.
--
-- Order: 003, 005, 006, then 007. Re-applying 003 (the agency app's migration)
-- rewrites its comments and recreates transcript_turn_redacted, so re-apply
-- 007 after it. Re-applying 007 does not re-add or revalidate the constraints,
-- but it briefly takes an AccessExclusiveLock on call_lead_facts (set not null,
-- the policy and the trigger are dropped and created again) and on the
-- transcript_turn_prototype view (dropped and created again), plus lighter
-- locks for the comments, all bounded by the 10 second lock timeout below.
--
-- Idempotent. Apply after 006 with `tsx scripts/harness-db.ts up supabase/harness/007_cleared_calls_followups.sql`.

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

-- ── 1. The prototype view ──────────────────────────────────────────────────
drop view if exists voice_harness.transcript_turn_prototype;
create view voice_harness.transcript_turn_prototype
  with (security_invoker = true) as
  select t.id,
         t.transcript_id,
         t.turn_index,
         t.start_ms,
         t.end_ms,
         t.diarization_label,
         t.source_speaker_label,
         t.speaker_role,
         t.role_method,
         t.role_confidence,
         t.language,
         t.overlap_ms,
         t.has_overlap,
         t.text_raw,
         t.text_redacted,
         t.redaction_status,
         t.transcription_confidence,
         t.quality_flags,
         t.eval_ready,
         t.eval_ready_reason,
         t.decision_tree_node_id,
         t.objection_codes
    from voice_harness.transcript_turn t;

comment on view voice_harness.transcript_turn_prototype is
  'PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): every turn with its raw text, redacted or not, for evaluation readers and the simulator while name masking waits. Drop in the safety pass and read transcript_turn_redacted again. Join call_transcript on is_current.';

revoke all on voice_harness.transcript_turn_prototype from public, anon, authenticated, service_role;
grant select on voice_harness.transcript_turn_prototype to service_role;

comment on column voice_harness.transcript_turn.eval_ready is
  'Clean enough for turn-level evaluation; eval_ready_reason says why or why not. Designed to require redacted text and a producer or lead role. PROTOTYPE SAFETY SHORTCUT (006): in the harness project only the role is required, so not_redacted turns can be ready; read them through transcript_turn_prototype.';

-- ── 5. Promises the shortcut overrides ─────────────────────────────────────
comment on table voice_harness.transcript_turn is
  'One row per speaker turn of a call_transcript run. Service role only. Designed so text_raw never leaves the database and copies are read from transcript_turn_redacted. PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): in the harness project, evaluation readers and the simulator read text_raw through transcript_turn_prototype, and it may go to the simulator''s Azure models without name masking.';
comment on column voice_harness.transcript_turn.text_raw is
  'The recognizer''s text. PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): in the harness project it is read through transcript_turn_prototype and may go to the simulator''s Azure models; restore "never leaves the database" in the safety pass.';
comment on view voice_harness.transcript_turn_redacted is
  'Redacted turns only, without text_raw or source_turn_ref. Designed as the only shape a copy leaving the database may take. PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): in the harness project the 219 cleared calls are not redacted, so they are not here; transcript_turn_prototype is used instead until the safety pass. Join call_transcript on is_current.';

-- ── 2. The access policy and comment ───────────────────────────────────────
drop policy if exists service_role_all on voice_harness.call_lead_facts;
create policy service_role_all on voice_harness.call_lead_facts
  to service_role using (true) with check (true);

comment on table voice_harness.call_lead_facts is
  'the agency app''s structured lead facts for the calls cleared for simulations (Pat, 2026-10-20), one row per source call, as read (the lead''s current state, not as of the call). Not facts extracted from text: see sim_lead_facts. Access: row level security forced, one service_role_all policy (as call_transcript), only service_role granted; postgres writes as owner with the bypass right.';

-- ── 3. The transcript link names the same call ─────────────────────────────
-- Added only when missing, so a re-apply does not re-add or revalidate them (other statements still lock briefly; see the header).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'call_transcript_call_identity' and conrelid = 'voice_harness.call_transcript'::regclass) then
    alter table voice_harness.call_transcript
      add constraint call_transcript_call_identity unique (id, source, call_key, call_project_ref);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_lead_facts_transcript_same_call' and conrelid = 'voice_harness.call_lead_facts'::regclass) then
    alter table voice_harness.call_lead_facts drop constraint if exists call_lead_facts_call_transcript_id_fkey;
    alter table voice_harness.call_lead_facts
      add constraint call_lead_facts_transcript_same_call
      foreign key (call_transcript_id, source, call_id, call_project_ref)
      references voice_harness.call_transcript (id, source, call_key, call_project_ref)
      on delete set null (call_transcript_id);
  end if;
end $$;

create or replace function voice_harness.call_lead_facts_link_is_current()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.call_transcript_id is not null and not exists (
    select 1 from voice_harness.call_transcript t where t.id = new.call_transcript_id and t.is_current
  ) then
    raise exception 'call_lead_facts.call_transcript_id must name the current transcript run of the call'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

revoke all on function voice_harness.call_lead_facts_link_is_current() from public, anon, authenticated;

drop trigger if exists call_lead_facts_link_is_current on voice_harness.call_lead_facts;
create trigger call_lead_facts_link_is_current
  before insert or update of call_transcript_id on voice_harness.call_lead_facts
  for each row execute function voice_harness.call_lead_facts_link_is_current();

comment on column voice_harness.call_lead_facts.call_transcript_id is
  'voice_harness.call_transcript.id of the same call (same source, call key and project), current when written. A regeneration of the transcript does not move this link: the loader must re-link after every regeneration, and scripts/harness-db.ts verify counts stale links.';

-- ── 4. The source key is required and unique ───────────────────────────────
alter table voice_harness.call_lead_facts alter column source_call_key set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'call_lead_facts_one_row_per_source_key' and conrelid = 'voice_harness.call_lead_facts'::regclass) then
    alter table voice_harness.call_lead_facts
      add constraint call_lead_facts_one_row_per_source_key unique (source, source_call_key, call_project_ref);
  end if;
end $$;

commit;
