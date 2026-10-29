-- THE VOICE HARNESS KEEPS CLEANED CALL TRANSCRIPTS.
--
-- Version 20261123150800, PROVISIONAL: one 10000 step above 20261123140800,
-- the highest version in the read-only clone of develop on 2026-10-19. Re-mint
-- with `pnpm migration:new` in the voice-harness working copy before it lands,
-- and rename the rollback file in supabase/rollbacks/ to match.
--
-- Written for the agency app's `voice-harness` branch. Its revert is
-- supabase/rollbacks/<same name>.sql, kept OUT of supabase/migrations/ because
-- every .sql file there is replayed.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
-- One schema, two tables and one view, all in `voice_harness`, so nobody
-- mistakes them for the product's own `public.cr_*` tables:
--
--   voice_harness.call_transcript   one row per call per pipeline run: which
--                                   call, from which source and which the agency app
--                                   database, call-level language, labels,
--                                   quality, redaction and provenance.
--   voice_harness.transcript_turn   one row per speaker turn of that run:
--                                   timings relative to the recording, the
--                                   diarizer's label, the source's own speaker
--                                   label, the assigned role with method and
--                                   confidence, raw and redacted text kept
--                                   apart, and the turn-level evaluation flag.
--   voice_harness.transcript_turn_redacted
--                                   the only shape any copy leaving the
--                                   database is read from: redacted text only,
--                                   and only for redacted turns.
--
-- Used for turn-level evaluation (the agent's reply against the producer's real
-- reply), simulated leads built from real calls, and decision tree work.
--
-- ── WHY A SCHEMA, LIKE gads ────────────────────────────────────────────────
-- Raw call text is the most sensitive data in the product (the comment on
-- cr_call_utterance says so). `voice_harness` is not in the API's exposed
-- schemas, so neither the anonymous key nor a signed-in user can reach it over
-- HTTP, the same fence `gads` keeps around refresh tokens. Server code reaches
-- it the way it reaches gads: through the service role, from a Postgres
-- connection or a definer procedure added with the writer, not in this file.
-- db-audit's rls_and_grants_cover_every_schema check covers it: row level
-- security on every table, no USAGE for anon or authenticated.
--
-- ── NO FOREIGN KEYS INTO public ────────────────────────────────────────────
-- dialer_call_id and quo_call_id are cr_dialer_call.id and cr_quo_call.id,
-- stored WITHOUT a foreign key on purpose: on 2026-10-19 the real calls
-- existed only in production, and a transcript built from a production call
-- may be kept in another database. call_project_ref says which database the
-- identifier belongs to.
--
-- ── DECISION TREE NODES ────────────────────────────────────────────────────
-- Node identifiers are the voice harness tree's (GET /api/tree in the harness).
-- That tree changes, so a call row naming nodes must carry
-- decision_tree_version, and node identifiers are text with no foreign key.
--
-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────
-- Every statement can run twice, so applying this by hand to the develop
-- database ahead of the branch merging, and the ordinary push afterwards, give
-- the same result.
--
-- ROLLBACK: supabase/rollbacks/20261123150800_the_voice_harness_keeps_cleaned_call_transcripts.sql
-- (by hand, or copied into a new migration). It drops every transcript row.

set lock_timeout = '10s';

begin;

create schema if not exists voice_harness;

comment on schema voice_harness is
  'Owned by the voice harness: cleaned, diarized call transcripts for turn-level evaluation and simulated leads. Not exposed to the API; service role only. 20261123150800.';

-- ── voice_harness.call_transcript ──────────────────────────────────────────
create table if not exists voice_harness.call_transcript (
  id uuid primary key default gen_random_uuid(),

  -- Which call.
  source text not null check (source in ('dialer', 'quo')),
  dialer_call_id uuid,
  quo_call_id uuid,
  call_key uuid generated always as (coalesce(dialer_call_id, quo_call_id)) stored,
  call_project_ref text not null
    check (call_project_ref in ('source_secondary', 'source_primary')),
  agency_id uuid,
  constraint call_transcript_one_call_reference check (
    (source = 'dialer' and dialer_call_id is not null and quo_call_id is null)
    or (source = 'quo' and quo_call_id is not null and dialer_call_id is null)
  ),

  -- Which audio.
  audio_object_refs text[] not null default '{}',
  audio_duration_ms integer check (audio_duration_ms is null or audio_duration_ms >= 0),
  audio_channels smallint check (audio_channels is null or audio_channels between 1 and 8),

  -- Language of the call as a whole.
  language text not null default 'unknown'
    check (language in ('english', 'spanish', 'mixed', 'unknown')),
  language_method text,
  language_confidence real check (language_confidence is null or language_confidence between 0 and 1),

  -- Labels.
  outcome_label text,
  outcome_label_method text,
  objection_codes text[] not null default '{}',
  decision_tree_version text,
  decision_tree_node_ids text[] not null default '{}',
  constraint call_transcript_nodes_need_tree_version check (
    cardinality(decision_tree_node_ids) = 0 or decision_tree_version is not null
  ),

  -- Quality and redaction.
  quality_flags text[] not null default '{}',
  redaction_status text not null default 'not_redacted'
    check (redaction_status in ('not_redacted', 'redacted', 'needs_review', 'failed')),
  redaction_method text,
  redacted_at timestamptz,
  constraint call_transcript_redacted_has_time check (
    redaction_status <> 'redacted' or redacted_at is not null
  ),
  eval_ready boolean not null default false,
  eval_ready_reason text not null check (length(btrim(eval_ready_reason)) > 0),

  -- Provenance, so a row can be regenerated.
  pipeline_version text not null,
  diarization_method text not null,
  transcription_method text,
  speaker_reference text not null default 'none'
    check (speaker_reference in ('dialer_tracks', 'quo_turns', 'manual', 'none')),
  is_current boolean not null default true,
  processing_started_at timestamptz not null,
  processing_completed_at timestamptz,
  constraint call_transcript_processing_order check (
    processing_completed_at is null or processing_completed_at >= processing_started_at
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint call_transcript_one_run_per_version unique (source, call_key, call_project_ref, pipeline_version)
);

-- At most one current run per call.
create unique index if not exists call_transcript_one_current_idx
  on voice_harness.call_transcript (source, call_key, call_project_ref)
  where is_current;

-- Reads are scoped by tenant.
create index if not exists call_transcript_agency_current_idx
  on voice_harness.call_transcript (agency_id)
  where is_current;

comment on table voice_harness.call_transcript is
  'One row per call per pipeline run of the voice harness transcript cleaner. Service role only. Column meanings: docs/cleaned-transcripts.md (voice harness). 20261123150800.';
comment on column voice_harness.call_transcript.call_project_ref is
  'The the agency app database the call identifier belongs to: source_secondary (develop) or source_primary (production). No foreign key, because the row may live in the other database.';
comment on column voice_harness.call_transcript.audio_object_refs is
  'Private storage references (storage:<bucket>/<path>) of the audio this run used, in order. Never copied out.';
comment on column voice_harness.call_transcript.decision_tree_node_ids is
  'Node identifiers of the voice harness tree at decision_tree_version that this call covered.';
comment on column voice_harness.call_transcript.diarization_method is
  'What separated the speakers, with its version or settings. Model services run only through the agency app''s Azure AI Foundry: write azure-foundry:<deployment name>; a method with no model is named plainly (for example dialer-tracks-only).';
comment on column voice_harness.call_transcript.transcription_method is
  'What produced the text, in the same form as diarization_method (azure-foundry:<deployment name> plus settings such as the recognizer language).';
comment on column voice_harness.call_transcript.speaker_reference is
  'Where an independent speaker reference came from, for scoring diarization: dialer_tracks (cr_call_utterance agent and prospect), quo_turns (Quo identifier and userId), manual, or none.';
comment on column voice_harness.call_transcript.is_current is
  'The run consumers read. A regeneration, in one transaction, first clears this on the old run and then inserts the new one (the partial unique index is not deferrable). Any change of method or deployment gets a new pipeline_version; re-running the same version deletes that run first.';

-- ── voice_harness.transcript_turn ──────────────────────────────────────────
create table if not exists voice_harness.transcript_turn (
  id uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references voice_harness.call_transcript (id) on delete cascade,
  turn_index integer not null check (turn_index >= 0),

  -- Timing, in milliseconds from the start of the recording.
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  constraint transcript_turn_time_order check (end_ms >= start_ms),

  -- Who spoke.
  diarization_label text not null,
  source_speaker_label text,
  source_turn_ref text,
  speaker_role text not null default 'unknown'
    check (speaker_role in ('producer', 'lead', 'other', 'unknown')),
  role_method text not null default 'none'
    check (role_method in ('dialer_track', 'quo_identifier', 'quo_user_id', 'diarization_heuristic', 'model', 'manual', 'none')),
  role_confidence real check (role_confidence is null or role_confidence between 0 and 1),
  constraint transcript_turn_role_has_method check (
    speaker_role = 'unknown' or role_method <> 'none'
  ),

  -- Language and overlap.
  language text not null default 'unknown'
    check (language in ('english', 'spanish', 'mixed', 'unknown')),
  overlap_ms integer not null default 0 check (overlap_ms >= 0),
  constraint transcript_turn_overlap_within_turn check (overlap_ms <= end_ms - start_ms),
  has_overlap boolean generated always as (overlap_ms > 0) stored,

  -- Text: raw and redacted are separate columns, never one.
  text_raw text not null,
  text_redacted text,
  redaction_status text not null default 'not_redacted'
    check (redaction_status in ('not_redacted', 'redacted', 'needs_review', 'failed')),
  constraint transcript_turn_redacted_has_text check (
    redaction_status <> 'redacted' or (text_redacted is not null and text_redacted <> '')
  ),
  transcription_confidence real
    check (transcription_confidence is null or transcription_confidence between 0 and 1),
  quality_flags text[] not null default '{}',

  -- Turn-level evaluation.
  eval_ready boolean not null default false,
  eval_ready_reason text not null check (length(btrim(eval_ready_reason)) > 0),
  constraint transcript_turn_eval_needs_redaction_and_role check (
    not eval_ready or (redaction_status = 'redacted' and speaker_role in ('producer', 'lead'))
  ),

  -- Labels.
  decision_tree_node_id text,
  objection_codes text[] not null default '{}',

  created_at timestamptz not null default now(),

  constraint transcript_turn_order_unique unique (transcript_id, turn_index)
);

create index if not exists transcript_turn_eval_ready_idx
  on voice_harness.transcript_turn (transcript_id)
  where eval_ready;

comment on table voice_harness.transcript_turn is
  'One row per speaker turn of a call_transcript run. Service role only. text_raw never leaves the database; read transcript_turn_redacted for any copy. 20261123150800.';
comment on column voice_harness.transcript_turn.diarization_label is
  'The diarizer''s own label for the speaker (for example SPEAKER_00), before any role is assigned.';
comment on column voice_harness.transcript_turn.source_speaker_label is
  'The source''s independent label when one exists: agent or prospect from the dialer transcription track, or the Quo turn identifier class. The reference diarization is scored against.';
comment on column voice_harness.transcript_turn.source_turn_ref is
  'The source turn this aligns to: a cr_call_utterance id, or the index into cr_quo_call.transcript.';
comment on column voice_harness.transcript_turn.eval_ready is
  'Clean enough for turn-level evaluation (agent reply against the producer''s real reply). Requires redacted text and a producer or lead role; eval_ready_reason says why or why not.';
comment on column voice_harness.transcript_turn.decision_tree_node_id is
  'Node identifier of the voice harness tree at the call''s decision_tree_version.';

-- ── voice_harness.transcript_turn_redacted ─────────────────────────────────
-- Dropped and created, not replaced, so a later change to the column list
-- still runs twice. It holds no data; the grant below restores access.
drop view if exists voice_harness.transcript_turn_redacted;
create view voice_harness.transcript_turn_redacted
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
         t.text_redacted,
         t.transcription_confidence,
         t.quality_flags,
         t.eval_ready,
         t.eval_ready_reason,
         t.decision_tree_node_id,
         t.objection_codes
    from voice_harness.transcript_turn t
   where t.redaction_status = 'redacted';

comment on view voice_harness.transcript_turn_redacted is
  'Redacted turns only, without text_raw or source_turn_ref. Every copy that leaves the database is read from here. Includes turns of runs that are no longer current: join call_transcript on is_current. 20261123150800.';

-- ── Access: service role only ──────────────────────────────────────────────
alter table voice_harness.call_transcript enable row level security;
alter table voice_harness.transcript_turn enable row level security;

drop policy if exists service_role_all on voice_harness.call_transcript;
create policy service_role_all on voice_harness.call_transcript
  to service_role using (true) with check (true);
drop policy if exists service_role_all on voice_harness.transcript_turn;
create policy service_role_all on voice_harness.transcript_turn
  to service_role using (true) with check (true);

-- Explicit, so nothing depends on the default access list of the database it
-- lands on (the 2026-08 audit found anon holding arwdDxtm by default).
revoke all on schema voice_harness from public, anon, authenticated;
revoke all on all tables in schema voice_harness from public, anon, authenticated;
grant usage on schema voice_harness to postgres, service_role;
grant select, insert, update, delete on voice_harness.call_transcript to service_role;
grant select, insert, update, delete on voice_harness.transcript_turn to service_role;
grant select on voice_harness.transcript_turn_redacted to service_role;

commit;
