-- PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20: "this is a prototype; name
-- masking is not a priority; get the simulator working end to end first").
-- Search for "PROTOTYPE SAFETY SHORTCUT" to find every such place.
--
-- The cleaned-transcript design (003, which includes the agency app's migration
-- unchanged) lets a turn be eval_ready only when its text is redacted. Here,
-- in the harness project only, eval_ready needs just a producer or lead role,
-- so turns stored with redaction_status 'not_redacted' (recorded honestly)
-- can be used for evaluation. the agency app's migration file is not edited; this
-- constraint swap lives in the harness project alone.
--
-- To undo in the safety pass: put back
--   check (not eval_ready or (redaction_status = 'redacted' and speaker_role in ('producer', 'lead')))
-- under the name transcript_turn_eval_needs_redaction_and_role.
--
-- Idempotent. Apply after 003 with `tsx scripts/harness-db.ts up supabase/harness/006_prototype_eval_without_redaction.sql`.

set lock_timeout = '10s';

begin;

alter table voice_harness.transcript_turn drop constraint if exists transcript_turn_eval_needs_redaction_and_role;
alter table voice_harness.transcript_turn drop constraint if exists transcript_turn_eval_needs_role_prototype;
alter table voice_harness.transcript_turn add constraint transcript_turn_eval_needs_role_prototype
  check (not eval_ready or speaker_role in ('producer', 'lead'));

comment on constraint transcript_turn_eval_needs_role_prototype on voice_harness.transcript_turn is
  'PROTOTYPE SAFETY SHORTCUT (Pat, 2026-10-20): eval_ready no longer requires redacted text. Restore transcript_turn_eval_needs_redaction_and_role in the safety pass (see supabase/harness/006).';

commit;
