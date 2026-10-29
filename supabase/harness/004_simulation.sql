-- voice_harness simulation tables: lead facts, batches, simulated whole calls,
-- their transcript lines, and turn judgements, in the harness Supabase project
-- (harness_store, Postgres 17). Never the agency app's production or
-- development project.
--
-- Apply: tsx scripts/harness-db.ts up supabase/harness/004_simulation.sql
-- (scripts/harness-db.ts:129-135 accepts only NNN_name.sql in supabase/harness).
-- Revert (supabase/harness has no rollback folder):
--   drop table if exists voice_harness.sim_turn_eval, voice_harness.sim_turn,
--     voice_harness.sim_run, voice_harness.sim_batch, voice_harness.sim_lead_facts;
-- The schema stays: harness_run and the cleaned-transcript tables live in it.
--
-- ORIGINS. Every identifier from outside a table says which database minted it:
--   'source_primary'  the agency app production
--   'source_secondary'  the agency app development
--   'harness_store'  this project (a cleaned transcript loaded here)
--   'harness_process'       minted by the local harness process before any database
--                           sees it (record ids call_<base36><hex>, src/trace/events.ts:127-139)
--   'synthetic_fixture'     made up for a test, a fixture file or a synthetic lead
-- A source call is (origin, table, key):
--   'dialer'  key = cr_call_utterance.call_id, a uuid (past-calls.ts:196-202)
--   'quo'     key = Quo's own identifier cr_quo_call.quo_call_id with "quo:" removed
--             (past-calls.ts:70, 206-216, 233-236); NOT cr_quo_call.id, which goes in
--             source_call_row_id once resolved (docs/cleaned-transcripts.md:82)
--   'fixture' key = 'fixture:<name>'
-- Synthetic origin, table 'fixture' and the 'fixture:' prefix imply each other, so a
-- real call key can never be labelled synthetic.
--
-- PERSONAS. A simulated lead is played from a synthetic persona (one of the 41 in
-- lead-scripts.json), from a facts file, or from the facts of a real past call.
-- sim_lead_facts.persona_origin says which, and the checks tie it to the source call
-- columns above:
--   'synthetic_persona'  made-up content: content_origin 'synthetic_fixture', source
--                        origin 'synthetic_fixture', source table 'fixture', source key
--                        'fixture:persona-<id>', and persona_id = <id>, a slug of
--                        lowercase letters, digits and hyphens (at most 72 characters,
--                        so the key fits the 80-character fixture key shape).
--   'fixture'            made-up content from a facts file: content_origin
--                        'synthetic_fixture', source table 'fixture', a key that does
--                        not start 'fixture:persona-' (so the two never overlap),
--                        persona_id null.
--   'real_call'          if and only if content_origin is 'real_call'; persona_id null.
-- persona_id is non-null exactly when persona_origin is 'synthetic_persona'. The
-- unique key (below) contains the extractor, so one persona can have separate facts per
-- extractor. A persona lead must never be built from a the agency app lead record: the
-- extractor 'lead-record' (a model-free load from the agency app structured lead records)
-- requires persona_origin 'real_call', and sim_run_synthetic_needs_synthetic_lead keeps
-- a made-up run on a lead id minted by the harness or the fixture.
-- Extractors: 'facts-file' (version = sha256 of the file), 'lead-record' (version =
-- <commit>[-dirty]:<loader name>, no model, no effort, and source_lead_facts_key
-- "<source>:<call project reference>:<call id>" naming the lead record; no foreign key,
-- migration 005 lands after this one), and any model extractor.
--
-- STORAGE RULE. Pat approved reading the 219 cleared calls, so the five old
-- "<table>_real_calls_wait_for_approval" constraints are gone. There is no raw text
-- column anywhere: every text column that can carry call content ends in _redacted
-- (trade, business type, renewal date, payroll, carrier, temperament, objections,
-- text_redacted, agent_reply_redacted, producer_reply_redacted). redaction_method says
-- what was done to the text: 'transcript_turn_redacted', 'harness_redact_text_v1' (the
-- pattern redaction, which does not mask personal names) or 'not_redacted'. One value
-- list serves every row. A real_call row that holds text must name one of them, so an
-- unknown or missing method is rejected. A row without text needs none.
-- PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
-- Nothing here gates a row on name masking; see the same comment on each check below.
-- employee_count and language are a number and a letters-only value, not text for this
-- rule. content_origin is carried down by composite foreign keys whose columns are all
-- not null (sim_lead_facts -> sim_run -> sim_turn), so the default "match simple" never
-- skips the check.
--
-- No foreign key leaves these five tables: none into the agency app, none into
-- voice_harness.call_transcript (a cleaned transcript may live in the agency app
-- development or here).
--
-- ACCESS follows 002_harness_run.sql:33-45, 91-94: row level security enabled and
-- forced, no policy, everything revoked from public, anon, authenticated and
-- service_role, then select, insert, update and delete granted to service_role.
-- The harness writes as postgres. The block before commit raises if anon or
-- authenticated can reach anything. Keeping voice_harness out of the API's exposed
-- schemas is a project setting this file cannot assert: confirm it in the
-- voiceagent-eval-harness API settings after applying.
--
-- Idempotent. No "unique nulls not distinct" (the loopback database's Postgres
-- version is not pinned): every unique key column is not null. updated_at is set
-- by the writer.

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

-- ---------------------------------------------------------------- sim_lead_facts
create table if not exists voice_harness.sim_lead_facts (
  id uuid primary key default gen_random_uuid(),

  source_call_origin text not null
    check (source_call_origin in ('source_primary', 'source_secondary', 'synthetic_fixture')),
  source_call_table text not null check (source_call_table in ('dialer', 'quo', 'fixture')),
  source_call_key text not null,
  constraint sim_lead_facts_source_call_shape check (
    (source_call_origin = 'synthetic_fixture') = (source_call_table = 'fixture')
    and case source_call_table
      when 'fixture' then source_call_key ~ '^fixture:[a-z0-9_-]{1,80}$'
      when 'dialer' then source_call_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      else source_call_key ~ '^[A-Za-z0-9_-]{1,128}$'
    end
  ),
  source_call_row_id uuid,
  constraint sim_lead_facts_source_call_row_id_fits check (
    source_call_row_id is null
    or source_call_table = 'quo'
    or (source_call_table = 'dialer' and source_call_row_id::text = source_call_key)
  ),
  persona_origin text not null check (persona_origin in ('synthetic_persona', 'real_call', 'fixture')),
  persona_id text check (persona_id is null or persona_id ~ '^[a-z0-9-]{1,72}$'),
  past_call_source text check (past_call_source in ('diarized', 'dialer', 'quo')),
  attribution text check (attribution in ('track', 'diarized', 'unverified')),
  constraint sim_lead_facts_past_call_known check (
    source_call_table = 'fixture' or (past_call_source is not null and attribution is not null)
  ),
  call_transcript_id uuid,
  call_transcript_origin text
    check (call_transcript_origin in ('source_primary', 'source_secondary', 'harness_store')),
  transcript_pipeline_version text,
  constraint sim_lead_facts_transcript_reference_complete check (
    (call_transcript_id is null) = (call_transcript_origin is null)
    and (call_transcript_id is null or transcript_pipeline_version is not null)
  ),

  extractor_id text not null check (extractor_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  extractor_version text not null,
  extractor_model text,
  extractor_effort text check (extractor_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  constraint sim_lead_facts_extractor_shape check (
    (extractor_id = 'facts-file'
       and extractor_model is null and extractor_effort is null
       and extractor_version ~ '^[0-9a-f]{64}$')
    or (extractor_id = 'lead-record'
       and extractor_model is null and extractor_effort is null
       and extractor_version ~ '^[0-9a-f]{40}(-dirty)?:[A-Za-z0-9._-]+$')
    or (extractor_id not in ('facts-file', 'lead-record')
       and extractor_model is not null and extractor_effort is not null
       and extractor_version ~ '^[0-9a-f]{40}(-dirty)?:[A-Za-z0-9:._/-]+:(low|medium|high|xhigh|max)$')
  ),
  -- The lead record a 'lead-record' load read: "<source>:<call project reference>:<call id>". No foreign key.
  source_lead_facts_key text
    check (source_lead_facts_key is null
           or source_lead_facts_key ~ '^[A-Za-z0-9_.-]{1,40}:(source_primary|source_secondary):[A-Za-z0-9_-]{1,128}$'),
  constraint sim_lead_facts_lead_record_key check (
    (extractor_id = 'lead-record') = (source_lead_facts_key is not null)
  ),

  trade_redacted text,
  business_type_redacted text,
  renewal_date_redacted text,
  annual_payroll_redacted text,
  employee_count integer check (employee_count is null or employee_count >= 0),
  current_carrier_redacted text,
  language text check (language is null or language ~ '^[A-Za-z -]{1,40}$'),
  objections_redacted text[] not null default '{}',
  temperament_redacted text,
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),

  content_origin text not null check (content_origin in ('synthetic_fixture', 'real_call')),
  constraint sim_lead_facts_content_matches_source check (
    (content_origin = 'synthetic_fixture') = (source_call_origin = 'synthetic_fixture')
  ),
  constraint sim_lead_facts_persona_ties check (
    (persona_origin = 'real_call') = (content_origin = 'real_call')
    and (persona_origin = 'synthetic_persona') = (persona_id is not null)
    and (persona_origin <> 'synthetic_persona' or source_call_key = 'fixture:persona-' || persona_id)
    and (persona_origin <> 'fixture' or source_call_key not like 'fixture:persona-%')
    -- A persona lead is never built from a the agency app lead record: that load is real-call content only.
    and (extractor_id <> 'lead-record' or persona_origin = 'real_call')
  ),
  redaction_method text check (redaction_method in ('transcript_turn_redacted', 'harness_redact_text_v1', 'not_redacted')),
  -- PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  -- Any text on a real-call row needs a known redaction_method (not_redacted is one); no method is rejected.
  constraint sim_lead_facts_real_call_text_is_redacted check (
    content_origin = 'synthetic_fixture'
    or redaction_method is not null
    or (coalesce(trade_redacted, '') = '' and coalesce(business_type_redacted, '') = ''
        and coalesce(renewal_date_redacted, '') = '' and coalesce(annual_payroll_redacted, '') = ''
        and coalesce(current_carrier_redacted, '') = '' and coalesce(temperament_redacted, '') = ''
        and objections_redacted = '{}')
  ),

  extracted_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint sim_lead_facts_one_per_extraction unique
    (source_call_origin, source_call_table, source_call_key, extractor_id, extractor_version, facts_sha256),
  constraint sim_lead_facts_id_content_origin unique (id, content_origin)
);

comment on table voice_harness.sim_lead_facts is
  'What a simulated lead knows (LeadFacts, src/judging/offline/types.ts:77-90). Insert only: on conflict do nothing and reuse the id; fact columns are never updated, so a run always points at the facts it played. A real-call row with text names its redaction_method (see the file header). 004_simulation.';
comment on column voice_harness.sim_lead_facts.extractor_version is
  'Model extractor: <harness commit>[-dirty]:<model>:<effort>. The prompt constants are not exported (claude-lead.ts:25, 61), so the commit is the version. Facts file: sha256 of the file.';
comment on column voice_harness.sim_lead_facts.facts_sha256 is
  'sha256 of the canonical JSON of the fact columns as stored (trade, business type and the other text columns as stored, with the redaction named in redaction_method).';
comment on column voice_harness.sim_lead_facts.source_lead_facts_key is
  'Set exactly when extractor_id is lead-record: <source>:<call project reference>:<call id> of the the agency app lead record that was loaded. Free-standing: the key is not required to repeat the source_call columns, and no foreign key points at it (migration 005 lands after 004).';
comment on column voice_harness.sim_lead_facts.source_call_row_id is
  'cr_dialer_call.id or cr_quo_call.id, the key of voice_harness.call_transcript.call_key. For Quo, filled only after a read-only lookup by quo_call_id.';

-- ---------------------------------------------------------------- sim_batch
create table if not exists voice_harness.sim_batch (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null,
  kind text not null check (kind in ('whole_call', 'turn_eval')),
  constraint sim_batch_key_shape check (
    batch_key ~ '^(whole-call|turns)-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$'
    and (kind = 'whole_call') = (batch_key like 'whole-call-%')
  ),

  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  cancel_requested boolean not null default false,
  constraint sim_batch_cancelled_was_requested check (status <> 'cancelled' or cancel_requested),

  items_requested integer check (items_requested is null or items_requested >= 0),
  items_found integer check (items_found is null or items_found >= 0),
  items_judged integer check (items_judged is null or items_judged >= 0),
  constraint sim_batch_judged_is_turn_eval check (items_judged is null or kind = 'turn_eval'),
  items_done integer not null default 0 check (items_done >= 0),
  items_blocked integer not null default 0 check (items_blocked >= 0),
  items_failed integer not null default 0 check (items_failed >= 0),
  failures jsonb not null default '[]'::jsonb,
  constraint sim_batch_failures_shape check (
    jsonb_typeof(failures) = 'array'
    and not jsonb_path_exists(failures, '$[*] ? (@.type() != "object")')
    and not jsonb_path_exists(failures,
      '$[*].keyvalue() ? (!(@.key like_regex "^(source_call_origin|source_call_table|source_call_key|turn_index|code)$"))')
    and not jsonb_path_exists(failures, '$[*] ? (!(@.code like_regex "^[a-z0-9_:]{1,80}$"))')
    -- Value types and shapes, not only key names: a failure holds identifiers and a code, never free text.
    and not jsonb_path_exists(failures, '$[*].source_call_origin ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_-]{1,40}$"))')
    and not jsonb_path_exists(failures, '$[*].source_call_table ? (@.type() != "string" || !(@ like_regex "^[a-z_]{1,40}$"))')
    and not jsonb_path_exists(failures,
      '$[*].source_call_key ? (@.type() != "string" || !(@ like_regex "^(fixture:[a-z0-9_-]{1,80}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{1,128})$"))')
    and not jsonb_path_exists(failures, '$[*].turn_index ? (@.type() != "number" && @.type() != "null")')
  ),

  config jsonb not null default '{}'::jsonb,
  constraint sim_batch_config_shape check (
    jsonb_typeof(config) = 'object'
    and (config - case kind
          when 'whole_call' then array['limit', 'lead', 'direction', 'maxTurns', 'pastCallsFileSha256',
                                       'factsFileSha256', 'treeFileSha256', 'diarizedConfigSha256']
          else array['limit', 'callKeysSha256', 'callCount', 'turnsPerCall', 'minPriorTurns', 'minWords',
                     'systemPromptFileSha256', 'systemPromptIsPlaceholder', 'diarizedConfigSha256', 'pastCallSourceId']
        end) = '{}'::jsonb
    and not jsonb_path_exists(config, '$.* ? (@.type() == "object" || @.type() == "array")')
    and not jsonb_path_exists(config, '$.* ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9:._-]{1,120}$"))')
  ),
  harness_commit text not null check (harness_commit ~ '^[0-9a-f]{40}$'),
  harness_dirty boolean not null,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint sim_batch_finish_order check (finished_at is null or finished_at >= started_at),
  constraint sim_batch_terminal_has_finish check ((status = 'running') = (finished_at is null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sim_batch_key_unique unique (batch_key),
  constraint sim_batch_id_kind unique (id, kind)
);

comment on table voice_harness.sim_batch is
  'One invocation of scripts/judges-whole-call.ts (whole_call) or scripts/judges-turns.ts (turn_eval). batch_key is the output folder name under data/judges/ (judges-whole-call.ts:185, judges-turns.ts:113), never a path. 004_simulation.';
comment on column voice_harness.sim_batch.cancel_requested is
  'Sticky: once true it is never cleared (the writer''s upsert keeps cancel_requested = sim_batch.cancel_requested or excluded.cancel_requested). SimWriter.requestCancel sets it while status is running; SimWriter.readBatchControl reads it. A runner that honours it stops between items and finishes the batch as cancelled.';
comment on column voice_harness.sim_batch.items_done is
  'Items finished one way or another: completed plus blocked plus failed runs (whole_call), or calls (never turns) for turn_eval: judged calls (at least one judgement) plus failed calls (failures and no judgement), so items_done never exceeds items_requested. Written by the writer from the same counts as items_blocked and items_failed.';
comment on column voice_harness.sim_batch.failures is
  'TurnJudgingResult.failures (turn-judge.ts:113-118, 169-172), written whole once per batch, never appended. Codes only.';

-- ---------------------------------------------------------------- sim_run
create table if not exists voice_harness.sim_run (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  batch_kind text not null default 'whole_call' check (batch_kind = 'whole_call'),
  constraint sim_run_batch_fk foreign key (batch_id, batch_kind)
    references voice_harness.sim_batch (id, kind) on delete cascade,
  item_index integer not null check (item_index >= 0),
  attempt integer not null default 1 check (attempt >= 1),
  -- A repeat of the same lead facts in the same batch (a second run of the same persona) has the next repeat_index.
  repeat_index integer not null default 0 check (repeat_index >= 0),

  record_id text not null check (record_id ~ '^call_[a-z0-9]{1,40}$'),
  record_id_origin text not null default 'harness_process' check (record_id_origin = 'harness_process'),
  trace_ref text not null,
  constraint sim_run_trace_ref_names_record check (trace_ref = record_id || '.jsonl'),
  first_record_seq integer check (first_record_seq is null or first_record_seq >= 0),
  last_record_seq integer check (last_record_seq is null or last_record_seq >= 0),

  lead_id text not null check (lead_id ~ '^[A-Za-z0-9_:-]{1,80}$'),
  lead_id_origin text not null check (lead_id_origin in
    ('source_primary', 'source_secondary', 'harness_store', 'harness_process', 'synthetic_fixture')),
  lead_facts_id uuid not null,
  content_origin text not null check (content_origin in ('synthetic_fixture', 'real_call')),
  constraint sim_run_lead_facts_fk foreign key (lead_facts_id, content_origin)
    references voice_harness.sim_lead_facts (id, content_origin) on delete restrict,
  constraint sim_run_synthetic_needs_synthetic_lead check (
    content_origin = 'real_call' or lead_id_origin = 'synthetic_fixture'
  ),

  -- Setup snapshot as typed columns: identifiers and hashes only.
  direction text not null check (direction in ('inbound', 'outbound')),
  clock_now timestamptz not null,
  simulator text not null check (simulator in ('model', 'scripted')),
  simulator_model text,  -- the model that played the lead: an Azure deployment such as gpt-5.6-terra
  simulator_effort text check (simulator_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  simulator_max_tokens integer check (simulator_max_tokens is null or simulator_max_tokens > 0),
  scripted_preferred_time text check (scripted_preferred_time is null or length(scripted_preferred_time) <= 40),
  scripted_objection_after_turns integer check (scripted_objection_after_turns is null or scripted_objection_after_turns >= 0),
  scripted_objection_spacing integer check (scripted_objection_spacing is null or scripted_objection_spacing >= 0),
  constraint sim_run_simulator_shape check (
    (simulator = 'model'
       and simulator_model is not null and simulator_model ~ '^[A-Za-z0-9:._/-]{1,120}$'
       and num_nonnulls(scripted_preferred_time, scripted_objection_after_turns, scripted_objection_spacing) = 0)
    or (simulator = 'scripted'
       and num_nonnulls(simulator_model, simulator_effort, simulator_max_tokens) = 0
       and num_nulls(scripted_preferred_time, scripted_objection_after_turns, scripted_objection_spacing) = 0)
  ),
  turn_cap integer not null check (turn_cap between 1 and 25),
  tree_source text not null check (tree_source in ('tree_file', 'active')),
  tree_choice_id text check (tree_choice_id in ('full', 'stub', 'fixture', 'custom')),
  tree_id text not null,
  tree_version text not null,
  tree_file_sha256 text check (tree_file_sha256 is null or tree_file_sha256 ~ '^[0-9a-f]{64}$'),
  -- The hash is required for a --tree file; for the active tree it may be stored when the file is known.
  constraint sim_run_tree_shape check (
    (tree_source = 'tree_file' and tree_file_sha256 is not null and tree_choice_id is null)
    or (tree_source = 'active' and tree_choice_id is not null)
  ),
  decision_module_id text,
  decision_model_kind text check (decision_model_kind in ('real', 'mock')),

  -- The agent setup that ran. Identifiers only, all optional (the caller passes what it knows).
  orchestrator_id text check (orchestrator_id in ('direct', 'pipecat')),
  voice_path_id text check (voice_path_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),       -- for example azure_gpt_live, deepgram
  voice_module_id text check (voice_module_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),   -- for example azure-gpt-live
  dialogue_model text check (dialogue_model ~ '^[A-Za-z0-9:._/-]{1,120}$'),     -- the Azure deployment that spoke as the agent
  prompt_setup_id text check (prompt_setup_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  decision_router_id text check (decision_router_id in ('decision_model', 'pipecat_flows', 'pipecat_classifier')),
  decision_model text check (decision_model ~ '^[A-Za-z0-9:._/-]{1,120}$'),    -- Azure deployment or module id that chose tree moves
  judge_enabled boolean,
  judge_model text check (judge_model ~ '^[A-Za-z0-9:._/-]{1,120}$'),          -- Azure deployment

  -- Reproducibility.
  persona_file_sha256 text check (persona_file_sha256 ~ '^[0-9a-f]{64}$'),
  seed text check (seed ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  model_settings jsonb not null default '{}'::jsonb,
  -- Keyed only by role; each value holds only deployment, temperature, max_output_tokens, seed with their types.
  -- Strict mode so an array value is not unwrapped; every path is a filter guarded by exists(), so a missing key cannot raise.
  constraint sim_run_model_settings_shape check (
    jsonb_typeof(model_settings) = 'object'
    and (model_settings - array['agent', 'lead', 'decision', 'judge', 'extractor']) = '{}'::jsonb
    and not jsonb_path_exists(model_settings, 'strict $.* ? (@.type() != "object")')
    and not jsonb_path_exists(model_settings,
      'strict $.* ? (@.type() == "object").keyvalue() ? (!(@.key like_regex "^(deployment|temperature|max_output_tokens|seed)$"))')
    and not jsonb_path_exists(model_settings,
      'strict $.* ? (@.type() == "object" && exists(@.deployment) && (@.deployment.type() != "string" || !(@.deployment like_regex "^[A-Za-z0-9:._/-]{1,120}$")))')
    and not jsonb_path_exists(model_settings,
      'strict $.* ? (@.type() == "object" && exists(@.temperature) && @.temperature.type() != "number" && @.temperature.type() != "null")')
    and not jsonb_path_exists(model_settings,
      'strict $.* ? (@.type() == "object" && exists(@.max_output_tokens) && (@.max_output_tokens.type() != "number" && @.max_output_tokens.type() != "null" || @.max_output_tokens.type() == "number" && @.max_output_tokens % 1 != 0))')
    and not jsonb_path_exists(model_settings,
      'strict $.* ? (@.type() == "object" && exists(@.seed) && (@.seed.type() != "number" && @.seed.type() != "null" || @.seed.type() == "number" && @.seed % 1 != 0))')
  ),

  -- What happened.
  status text not null check (status in ('completed', 'blocked', 'failed')),
  blocked_reason text check (blocked_reason is null or blocked_reason ~ '^[a-z][a-z0-9_:]{0,79}$'),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_:]{0,79}$'),
  ended_by text check (ended_by in ('agent_ended', 'lead_hung_up', 'turn_limit')),
  lead_turns integer not null default 0 check (lead_turns >= 0),
  caller_lines integer check (caller_lines is null or caller_lines >= 0),
  constraint sim_run_lead_turns_within_cap check (lead_turns <= turn_cap),
  constraint sim_run_turn_limit_means_cap_reached check (ended_by is distinct from 'turn_limit' or lead_turns = turn_cap),
  constraint sim_run_status_shape check (
    (status = 'blocked' and blocked_reason is not null and failure_code is null and ended_by is null and lead_turns = 0)
    or (status = 'completed' and blocked_reason is null and failure_code is null and ended_by is not null)
    or (status = 'failed' and blocked_reason is null and failure_code is not null)
  ),

  -- Grade.
  renewal_date_confirmed boolean,
  payroll_captured boolean,
  employee_count_captured boolean,
  booked boolean,
  constraint sim_run_outcome_all_or_none check (
    num_nulls(renewal_date_confirmed, payroll_captured, employee_count_captured, booked) in (0, 4)
  ),
  constraint sim_run_outcome_only_when_completed check (status = 'completed' or booked is null),
  enforcement jsonb not null default '[]'::jsonb,
  constraint sim_run_enforcement_shape check (
    jsonb_typeof(enforcement) = 'array'
    and not jsonb_path_exists(enforcement, '$[*] ? (@.type() != "object")')
    and not jsonb_path_exists(enforcement, '$[*].keyvalue() ? (!(@.key like_regex "^(rule|passed|note)$"))')
    and not jsonb_path_exists(enforcement, '$[*].rule ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:. -]{1,80}$"))')
    and not jsonb_path_exists(enforcement, '$[*].passed ? (@.type() != "boolean")')
    and not jsonb_path_exists(enforcement, '$[*].note ? (@.type() != "string" || !(@ like_regex "^.{0,255}$" flag "s"))')
  ),
  enforcement_passed boolean,
  judge_verdicts jsonb not null default '[]'::jsonb,
  constraint sim_run_judge_verdicts_shape check (
    jsonb_typeof(judge_verdicts) = 'array'
    and not jsonb_path_exists(judge_verdicts, '$[*] ? (@.type() != "object")')
    and not jsonb_path_exists(judge_verdicts,
      '$[*].keyvalue() ? (!(@.key like_regex "^(action|allowed|reason|scores|recordSeq)$"))')
    and not jsonb_path_exists(judge_verdicts, '$[*].action ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:. -]{1,80}$"))')
    and not jsonb_path_exists(judge_verdicts, '$[*].allowed ? (@.type() != "boolean")')
    and not jsonb_path_exists(judge_verdicts, '$[*].recordSeq ? (@.type() != "number")')
    and not jsonb_path_exists(judge_verdicts, '$[*].reason ? (@.type() != "string" || !(@ like_regex "^.{0,255}$" flag "s"))')
    and not jsonb_path_exists(judge_verdicts, '$[*].scores[*] ? (@.type() != "object")')
    and not jsonb_path_exists(judge_verdicts, '$[*].scores[*].keyvalue() ? (!(@.key like_regex "^(criterion|score|note)$"))')
    and not jsonb_path_exists(judge_verdicts, '$[*].scores[*].criterion ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:. -]{1,80}$"))')
    and not jsonb_path_exists(judge_verdicts, '$[*].scores[*].score ? (@.type() != "number")')
    and not jsonb_path_exists(judge_verdicts, '$[*].scores[*].note ? (@.type() != "string" || !(@ like_regex "^.{0,255}$" flag "s"))')
  ),
  judge_score jsonb,
  constraint sim_run_judge_score_shape check (
    judge_score is null
    or (jsonb_typeof(judge_score) = 'object'
        and (judge_score - array['judgedAt', 'score', 'criteria']) = '{}'::jsonb
        and not jsonb_path_exists(judge_score, '$.judgedAt ? (@.type() != "string" || !(@ like_regex "^[0-9T:.+Z-]{1,40}$"))')
        and not jsonb_path_exists(judge_score, '$.score ? (@.type() != "number")')
        and not jsonb_path_exists(judge_score, '$.criteria[*] ? (@.type() != "object")')
        and not jsonb_path_exists(judge_score, '$.criteria[*].keyvalue() ? (!(@.key like_regex "^(criterion|score|note)$"))')
        and not jsonb_path_exists(judge_score, '$.criteria[*].criterion ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:. -]{1,80}$"))')
        and not jsonb_path_exists(judge_score, '$.criteria[*].score ? (@.type() != "number")')
        and not jsonb_path_exists(judge_score, '$.criteria[*].note ? (@.type() != "string" || !(@ like_regex "^.{0,255}$" flag "s"))'))
  ),

  -- Timing and cost.
  started_at timestamptz,
  ended_at timestamptz,
  constraint sim_run_time_order check (ended_at is null or started_at is null or ended_at >= started_at),
  agent_reply_latency_ms_median integer check (agent_reply_latency_ms_median is null or agent_reply_latency_ms_median >= 0),
  agent_reply_latency_ms_max integer check (agent_reply_latency_ms_max is null or agent_reply_latency_ms_max >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_in_dollars numeric(12, 6) check (cost_in_dollars is null or cost_in_dollars >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sim_run_record_unique unique (record_id),
  constraint sim_run_one_per_attempt unique (batch_id, lead_facts_id, repeat_index, attempt),
  constraint sim_run_id_content_origin unique (id, content_origin)
);

create index if not exists sim_run_lead_facts_idx on voice_harness.sim_run (lead_facts_id);

comment on table voice_harness.sim_run is
  'One attempt at one simulated whole call (runWholeCall, whole-call.ts:76-148) and its grade (whole-call.ts:354-368). Keyed by batch, lead facts, repeat_index and attempt, so a repeat of the same persona is idempotent; item_index is the loop position, an attribute only. The trace stays in data/judges/<batch_key>/records/<trace_ref> (judges-whole-call.ts:185, 188; call-harness.ts:918). 004_simulation.';
comment on column voice_harness.sim_run.clock_now is
  'The instant the harness clock returned: today at 14:00 (judges-whole-call.ts:110-113). Spoken times resolve against it (engine.ts:207-211).';
comment on column voice_harness.sim_run.tree_id is
  'The tree actually used: the --tree file, or loadActiveTree() (tree-source.ts:89). tree_file_sha256 is required for --tree and may also be stored for the active tree when the file is known (the active file path is not exported, tree-source.ts:75-77).';
comment on column voice_harness.sim_run.enforcement is
  'From a second rule-based post-call judge run inside gradeWholeCall (whole-call.ts:358-359), not the run that produced judge_score (call-harness.ts:1076-1082).';
comment on column voice_harness.sim_run.judge_verdicts is
  'judge_verdict event data plus recordSeq (gate.ts:62-67). Reasons are fixed strings today; the writer accepts verdicts only from the rule judge, and a newly injected judge must be reviewed first.';
comment on column voice_harness.sim_run.cost_in_dollars is
  'No writer yet: askJson returns only parsed JSON (json-client.ts:65-67). Same for input_tokens and output_tokens.';

-- ---------------------------------------------------------------- sim_turn
create table if not exists voice_harness.sim_turn (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  content_origin text not null check (content_origin in ('synthetic_fixture', 'real_call')),
  constraint sim_turn_run_fk foreign key (run_id, content_origin)
    references voice_harness.sim_run (id, content_origin) on delete cascade,

  line_index integer not null check (line_index >= 0),
  turn_index integer not null check (turn_index >= -1),
  role text not null check (role in ('caller', 'agent', 'system')),
  spoken boolean not null,
  said_at timestamptz not null,
  record_seq integer check (record_seq is null or record_seq >= 0),
  agent_reply_latency_ms integer check (agent_reply_latency_ms is null or agent_reply_latency_ms >= 0),
  constraint sim_turn_latency_on_agent_lines check (agent_reply_latency_ms is null or role = 'agent'),

  text_redacted text,
  redaction_method text check (redaction_method in ('transcript_turn_redacted', 'harness_redact_text_v1', 'not_redacted')),
  -- PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  -- Text on a real-call line needs a known redaction_method (not_redacted is one); no method is rejected.
  constraint sim_turn_real_call_text_is_redacted check (
    content_origin = 'synthetic_fixture' or coalesce(text_redacted, '') = '' or redaction_method is not null
  ),

  created_at timestamptz not null default now(),

  constraint sim_turn_order_unique unique (run_id, line_index)
);

comment on table voice_harness.sim_turn is
  'One TranscriptLine (records.ts:39-45), keyed by position: turn_index repeats and the disclosure is -1 (engine.ts:161-162). The writer replaces a run''s lines in one transaction (delete, then insert). For a synthetic run the text is made up and stored as said; text on a real-call run names its redaction_method. 004_simulation.';

-- ---------------------------------------------------------------- sim_turn_eval
create table if not exists voice_harness.sim_turn_eval (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  batch_kind text not null default 'turn_eval' check (batch_kind = 'turn_eval'),
  constraint sim_turn_eval_batch_fk foreign key (batch_id, batch_kind)
    references voice_harness.sim_batch (id, kind) on delete cascade,

  source_call_origin text not null
    check (source_call_origin in ('source_primary', 'source_secondary', 'synthetic_fixture')),
  source_call_table text not null check (source_call_table in ('dialer', 'quo', 'fixture')),
  source_call_key text not null,
  constraint sim_turn_eval_source_call_shape check (
    (source_call_origin = 'synthetic_fixture') = (source_call_table = 'fixture')
    and case source_call_table
      when 'fixture' then source_call_key ~ '^fixture:[a-z0-9_-]{1,80}$'
      when 'dialer' then source_call_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      else source_call_key ~ '^[A-Za-z0-9_-]{1,128}$'
    end
  ),
  source_call_row_id uuid,
  constraint sim_turn_eval_source_call_row_id_fits check (
    source_call_row_id is null
    or source_call_table = 'quo'
    or (source_call_table = 'dialer' and source_call_row_id::text = source_call_key)
  ),
  past_call_source text not null check (past_call_source in ('diarized', 'dialer', 'quo')),
  attribution text not null check (attribution in ('track', 'diarized', 'unverified')),
  call_transcript_id uuid,
  call_transcript_origin text
    check (call_transcript_origin in ('source_primary', 'source_secondary', 'harness_store')),
  transcript_pipeline_version text,
  constraint sim_turn_eval_transcript_reference_complete check (
    (call_transcript_id is null) = (call_transcript_origin is null)
    and (call_transcript_id is null or transcript_pipeline_version is not null)
  ),
  turn_index integer not null check (turn_index >= 1),
  call_had_clean_turns boolean not null,

  agent_id text not null check (agent_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  agent_model text,
  agent_effort text check (agent_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  agent_system_prompt_sha256 text not null check (agent_system_prompt_sha256 ~ '^[0-9a-f]{64}$'),
  agent_system_prompt_is_placeholder boolean not null,
  judge_id text not null check (judge_id ~ '^[A-Za-z0-9:._/-]{1,120}$'),
  judge_model text,
  judge_effort text check (judge_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  judge_rubric_sha256 text not null check (judge_rubric_sha256 ~ '^[0-9a-f]{64}$'),

  pick_agent_first text not null check (pick_agent_first in ('first', 'second', 'same')),
  pick_producer_first text not null check (pick_producer_first in ('first', 'second', 'same')),
  verdict text generated always as (
    case
      when pick_agent_first = 'first' and pick_producer_first = 'second' then 'better'
      when pick_agent_first = 'second' and pick_producer_first = 'first' then 'worse'
      when pick_agent_first = 'same' and pick_producer_first = 'same' then 'same'
      else 'inconsistent'
    end
  ) stored,
  consistent boolean generated always as (
    (pick_agent_first = 'first' and pick_producer_first = 'second')
    or (pick_agent_first = 'second' and pick_producer_first = 'first')
    or (pick_agent_first = 'same' and pick_producer_first = 'same')
  ) stored,

  content_origin text not null check (content_origin in ('synthetic_fixture', 'real_call')),
  constraint sim_turn_eval_content_matches_source check (
    (content_origin = 'synthetic_fixture') = (source_call_origin = 'synthetic_fixture')
  ),
  agent_reply_redacted text,
  producer_reply_redacted text,
  redaction_method text check (redaction_method in ('transcript_turn_redacted', 'harness_redact_text_v1', 'not_redacted')),
  -- PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
  -- Reply text on a real-call judgement needs a known redaction_method (not_redacted is one); no method is rejected.
  constraint sim_turn_eval_real_call_text_is_redacted check (
    content_origin = 'synthetic_fixture'
    or (coalesce(agent_reply_redacted, '') = '' and coalesce(producer_reply_redacted, '') = '')
    or redaction_method is not null
  ),

  judged_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint sim_turn_eval_one_per_turn unique
    (batch_id, source_call_origin, source_call_table, source_call_key, turn_index)
);

comment on table voice_harness.sim_turn_eval is
  'One TurnJudgement (types.ts:63-72). A real-call row may carry reply text when its redaction_method is named (see the file header). 004_simulation.';
comment on column voice_harness.sim_turn_eval.turn_index is
  'Index into the merged PastCall.turns (past-calls.ts:277), not transcript_turn.turn_index.';

-- ---------------------------------------------------------------- access
alter table voice_harness.sim_lead_facts enable row level security;
alter table voice_harness.sim_lead_facts force row level security;
alter table voice_harness.sim_batch enable row level security;
alter table voice_harness.sim_batch force row level security;
alter table voice_harness.sim_run enable row level security;
alter table voice_harness.sim_run force row level security;
alter table voice_harness.sim_turn enable row level security;
alter table voice_harness.sim_turn force row level security;
alter table voice_harness.sim_turn_eval enable row level security;
alter table voice_harness.sim_turn_eval force row level security;

revoke all on table voice_harness.sim_lead_facts, voice_harness.sim_batch, voice_harness.sim_run,
  voice_harness.sim_turn, voice_harness.sim_turn_eval
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table voice_harness.sim_lead_facts, voice_harness.sim_batch,
  voice_harness.sim_run, voice_harness.sim_turn, voice_harness.sim_turn_eval
  to service_role;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['voice_harness.sim_lead_facts', 'voice_harness.sim_batch', 'voice_harness.sim_run',
                           'voice_harness.sim_turn', 'voice_harness.sim_turn_eval'] loop
    if not exists (select 1 from pg_class where oid = t::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception 'access_check_failed: row level security not enabled and forced on %', t;
    end if;
    if exists (select 1 from pg_policy where polrelid = t::regclass) then
      raise exception 'access_check_failed: % has a policy', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'access_check_failed: % holds a privilege on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_schema_privilege(r, 'voice_harness', 'USAGE,CREATE') then
      raise exception 'access_check_failed: % holds usage or create on schema voice_harness', r;
    end if;
  end loop;
end $$;

commit;
