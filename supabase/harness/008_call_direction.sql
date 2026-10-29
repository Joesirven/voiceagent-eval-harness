-- voice_harness.call_transcript.direction: which way the call went, for the
-- simulator's real-call batch (asked for by the simulator parent the simulator task,
-- 2026-10-20). The cleaned-transcript design (003) has no direction.
--
-- direction_source says where it came from: Quo calls carry their own
-- direction (cr_quo_call.direction); dialer calls have no direction column and
-- are outbound by how the dialer works, which is recorded as an assumption.
-- Null direction means not known yet, with direction_source null too.
--
-- No new access rules: the columns sit on a table that already has them.
-- Idempotent. Apply after 003 with `tsx scripts/harness-db.ts up supabase/harness/008_call_direction.sql`.

set lock_timeout = '10s';

begin;

alter table voice_harness.call_transcript add column if not exists direction text;
alter table voice_harness.call_transcript add column if not exists direction_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'call_transcript_direction_values' and conrelid = 'voice_harness.call_transcript'::regclass) then
    alter table voice_harness.call_transcript
      add constraint call_transcript_direction_values check (
        (direction is null and direction_source is null)
        -- Both present: a check passes on null, so each part is required explicitly.
        or (direction is not null and direction_source is not null
            and direction in ('inbound', 'outbound')
            and direction_source in ('crm_quo_call.direction', 'assumed_dialer_outbound')
            and (direction_source <> 'assumed_dialer_outbound' or (source = 'dialer' and direction = 'outbound'))
            and (direction_source <> 'crm_quo_call.direction' or source = 'quo'))
      );
  end if;
end $$;

comment on column voice_harness.call_transcript.direction is
  'inbound or outbound, from the producer''s side; null when not known. See direction_source.';
comment on column voice_harness.call_transcript.direction_source is
  'crm_quo_call.direction (the source system value, mapped), or assumed_dialer_outbound (dialer calls have no direction column; the dialer only places calls).';

commit;
