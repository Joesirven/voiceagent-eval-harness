/**
 * supabase/harness/004_simulation.sql read as text, no database: row level
 * security is forced on all five tables, and no foreign key leaves them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = new URL("../../supabase/harness/004_simulation.sql", import.meta.url);
const TABLES = ["sim_lead_facts", "sim_batch", "sim_run", "sim_turn", "sim_turn_eval"];

/** The file without its line comments, so prose cannot satisfy or break a check. */
const sql = readFileSync(MIGRATION, "utf8")
  .split("\n")
  .map((line) => line.replace(/^\s*--.*$/, ""))
  .join("\n");

describe("004_simulation.sql, read as text", () => {
  it("enables and forces row level security on all five tables", () => {
    for (const table of TABLES) {
      expect(sql, table).toContain(`alter table voice_harness.${table} enable row level security;`);
      expect(sql, table).toContain(`alter table voice_harness.${table} force row level security;`);
    }
  });

  it("creates exactly the five tables, all in the voice_harness schema", () => {
    const created = [...sql.matchAll(/create table if not exists (\S+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(TABLES.map((t) => `voice_harness.${t}`).sort());
  });

  it("has no policy and revokes everything from public, anon, authenticated and service_role", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on table[\s\S]*from public, anon, authenticated, service_role;/);
  });

  it("has no foreign key that leaves the five tables (none into CRM, none into call_transcript)", () => {
    const targets = [...sql.matchAll(/\breferences\s+([A-Za-z0-9_."]+)/gi)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets) {
      expect(TABLES.map((t) => `voice_harness.${t}`), target).toContain(target);
    }
    expect(sql).not.toMatch(/references\s+(public\.|voice_harness\.call_transcript)/i);
  });

  it("has no approval gate, no raw text column, and the repeat-aware run key", () => {
    expect(sql).not.toMatch(/wait_for_approval/);
    // Every text column that can carry call content ends in _redacted; none is named like raw text.
    expect(sql).not.toMatch(/^\s*(raw\w*|text|content|body|reply\w*|transcript\w*text)\s+text\b/m);
    expect(sql).toContain("unique (batch_id, lead_facts_id, repeat_index, attempt)");
    expect(sql).toMatch(/simulator in \('model', 'scripted'\)/);
    expect(sql).not.toMatch(/'claude'/);
  });

  it("marks each real-call text check with the prototype shortcut comment, and none is a name-masking gate", () => {
    const raw = readFileSync(MIGRATION, "utf8");
    const marker = "PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.";
    // The file header once, and one for each of the four tables' redaction checks.
    expect(raw.split(marker).length - 1).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("'not_redacted'");
    expect(sql).not.toMatch(/NAME_MASKING/);
  });
});
