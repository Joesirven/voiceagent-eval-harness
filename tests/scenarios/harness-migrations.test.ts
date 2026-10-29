import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../../supabase/harness/${name}`, import.meta.url), "utf8");

describe("migration 005, voice_harness.call_lead_facts", () => {
  const sql = read("005_call_lead_facts.sql");

  it("is service role only: row level security enabled and forced, no policy, every other role revoked", () => {
    expect(sql).toMatch(/alter table voice_harness\.call_lead_facts enable row level security;/);
    expect(sql).toMatch(/alter table voice_harness\.call_lead_facts force row level security;/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on table voice_harness\.call_lead_facts from public, anon, authenticated, service_role;/);
    expect(sql).toMatch(/grant select, insert, update, delete on table voice_harness\.call_lead_facts to service_role;/);
    expect(sql).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/i);
    expect(sql).toMatch(/revoke all on schema voice_harness from public, anon, authenticated;/);
  });

  it("keeps the constraints that make one honest row per call", () => {
    for (const name of [
      "call_lead_facts_status_matches_ids",
      "call_lead_facts_values_need_lead",
      "call_lead_facts_index_values_need_row",
      "call_lead_facts_one_row_per_call",
    ]) expect(sql, name).toMatch(new RegExp(`constraint ${name} (check|unique) \\(`));
    expect(sql).toContain("unique (source, call_id, call_project_ref)");
    expect(sql).toContain("check (facts_status in ('read', 'no_lead', 'no_entity', 'no_index_row'))");
    expect(sql).toContain("check (call_project_ref in ('source_secondary', 'source_primary'))");
  });
});

describe("migration 006, the prototype evaluation shortcut", () => {
  const sql = read("006_prototype_eval_without_redaction.sql");

  it("is marked for the safety pass and swaps the redaction requirement for a role requirement", () => {
    expect(sql).toMatch(/^-- PROTOTYPE SAFETY SHORTCUT/);
    expect(sql).toMatch(/drop constraint if exists transcript_turn_eval_needs_redaction_and_role;/);
    expect(sql).toMatch(
      /add constraint transcript_turn_eval_needs_role_prototype\s+check \(not eval_ready or speaker_role in \('producer', 'lead'\)\);/,
    );
    // Its statements (comments aside, which quote the constraint to restore) loosen nothing else.
    const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/redaction_status/);
    expect(statements).not.toMatch(/disable row level security|grant |revoke /i);
  });
});

describe("migration 007, follow-ups to 005 and 006", () => {
  const sql = read("007_cleared_calls_followups.sql");
  const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("adds the marked prototype view with raw text, for service_role only", () => {
    expect(sql).toContain("PROTOTYPE SAFETY SHORTCUT");
    expect(statements).toMatch(/create view voice_harness\.transcript_turn_prototype\s+with \(security_invoker = true\)/);
    expect(statements).toMatch(/t\.text_raw,/);
    expect(statements).toMatch(/t\.redaction_status,/);
    expect(statements).toMatch(/revoke all on voice_harness\.transcript_turn_prototype from public, anon, authenticated, service_role;/);
    expect(statements).toMatch(/grant select on voice_harness\.transcript_turn_prototype to service_role;/);
    expect(statements).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/i);
  });

  it("ties the transcript link to the same call and to the current run, and requires a unique source key", () => {
    expect(statements).toMatch(/add constraint call_transcript_call_identity unique \(id, source, call_key, call_project_ref\)/);
    expect(statements).toMatch(
      /foreign key \(call_transcript_id, source, call_id, call_project_ref\)\s+references voice_harness\.call_transcript \(id, source, call_key, call_project_ref\)\s+on delete set null \(call_transcript_id\)/,
    );
    expect(statements).toMatch(/before insert or update of call_transcript_id on voice_harness\.call_lead_facts/);
    expect(statements).toMatch(/t\.is_current/);
    expect(statements).toMatch(/alter column source_call_key set not null/);
    expect(statements).toMatch(/add constraint call_lead_facts_one_row_per_source_key unique \(source, source_call_key, call_project_ref\)/);
  });

  it("gives call_lead_facts the same service_role policy as call_transcript and loosens nothing else", () => {
    expect(statements).toMatch(/create policy service_role_all on voice_harness\.call_lead_facts\s+to service_role using \(true\) with check \(true\);/);
    expect(statements.match(/create policy/g)).toHaveLength(1);
    expect(statements).not.toMatch(/disable row level security|no force row level security/i);
    expect(statements).not.toMatch(/to (public|anon|authenticated)\b/i);
  });

  it("marks every promise of 003 that the shortcut overrides", () => {
    for (const target of ["comment on table voice_harness.transcript_turn is", "comment on column voice_harness.transcript_turn.text_raw is", "comment on view voice_harness.transcript_turn_redacted is"]) {
      const at = statements.indexOf(target);
      expect(at, target).toBeGreaterThan(-1);
      expect(statements.slice(at, statements.indexOf(";", at)), target).toContain("PROTOTYPE SAFETY SHORTCUT");
    }
  });

  it("adds its constraints only when missing, so a re-apply does not re-add or revalidate them, and says a re-apply still locks briefly", () => {
    expect(sql).toContain("briefly takes an AccessExclusiveLock");
    expect(statements).not.toMatch(/drop constraint if exists call_transcript_call_identity|drop constraint if exists call_lead_facts_one_row_per_source_key/);
    expect(statements).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'call_lead_facts_transcript_same_call'/);
  });
});


describe("migration 008, call direction", () => {
  const sql = read("008_call_direction.sql");
  const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("adds direction and its source, both or neither, each part required explicitly because a check passes on null", () => {
    expect(statements).toMatch(/add column if not exists direction text;/);
    expect(statements).toMatch(/add column if not exists direction_source text;/);
    expect(statements).toContain("(direction is null and direction_source is null)");
    expect(statements).toContain("direction is not null and direction_source is not null");
    expect(statements).toContain("direction in ('inbound', 'outbound')");
    expect(statements).toContain("direction_source in ('crm_quo_call.direction', 'assumed_dialer_outbound')");
    // The dialer assumption only for dialer calls going out; Quo's own value only for Quo calls.
    expect(statements).toContain("(direction_source <> 'assumed_dialer_outbound' or (source = 'dialer' and direction = 'outbound'))");
    expect(statements).toContain("(direction_source <> 'crm_quo_call.direction' or source = 'quo')");
  });

  it("changes no access and adds its constraint only when missing", () => {
    expect(statements).not.toMatch(/grant |revoke |policy|row level security/i);
    expect(statements).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'call_transcript_direction_values'/);
  });
});
