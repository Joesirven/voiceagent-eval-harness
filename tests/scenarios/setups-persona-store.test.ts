import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLeadProfile } from "../../src/setups/lead-profile.js";
import { buildPersonaCard, choosePersona, listPersonas, loadLeadScripts } from "../../src/setups/persona-card.js";
import { SetupStore } from "../../src/setups/setup-store.js";
import { ELECTRICIAN, PLUMBER, ROOFER, RangeFakeDb, seedSetupWorld, syntheticScripts } from "../helpers/setups-fixtures.js";

const world = () => seedSetupWorld(new RangeFakeDb());

describe("persona card", () => {
  it("takes the facts from the real lead and fills the rest from the script", async () => {
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const script = choosePersona(syntheticScripts(), ROOFER, briefing, { personaId: "callback-a" })!;
    const card = buildPersonaCard(briefing, script, { briefingInAgentPacket: true });

    const fact = (label: string) => card.facts.find((f) => f.label === label)!;
    expect(fact("Renewal date (X-date)")).toMatchObject({ value: "2026-12-14", source: "lead_record", reveal: "if_asked", inAgentPacket: true });
    expect(fact("Workers' compensation carrier")).toMatchObject({ value: "Sample Mutual", source: "lead_record" });
    expect(fact("Full-time employees")).toMatchObject({ value: "6", source: "lead_record" });
    expect(fact("Annual payroll")).toMatchObject({ value: "280000 dollars", source: "lead_record" });
    // CRM does not hold these, so the script supplies them and the agent has to collect them.
    expect(fact("Has general liability")).toMatchObject({ value: "yes", source: "script", inAgentPacket: false });
    expect(fact("Subcontractor spend per year")).toMatchObject({ value: "40000", reveal: "after_trust" });
    // The script's own numbers lose to the record.
    expect(card.facts.map((f) => f.value)).not.toContain("99");
    expect(card.facts.map((f) => f.value)).not.toContain("2030-01-01");
  });

  it("plays the real lead, not the script's character", async () => {
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const card = buildPersonaCard(briefing, syntheticScripts().personas[0], { briefingInAgentPacket: true });
    expect(card.you).toMatchObject({ name: "Dana Roofer", business: "Example Ridge Roofing", trade: "residential roofing" });
    expect(JSON.stringify(card)).not.toContain("Script Business");
  });

  it("marks every record fact as collected, not confirmed, when the prompt carries no lead record", async () => {
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const card = buildPersonaCard(briefing, syntheticScripts().personas[0], { briefingInAgentPacket: false });
    expect(card.facts.every((f) => !f.inAgentPacket)).toBe(true);
  });

  it("orders objections and drops script lines that quote numbers the real record contradicts", async () => {
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const card = buildPersonaCard(briefing, syntheticScripts().personas[0], { briefingInAgentPacket: true });
    expect(card.objections.map((o) => o.order)).toEqual([1, 2]);
    expect(card.traits).toEqual(["He is not covered himself."]);
    expect(card.droppedScriptTraits).toBe(1);
    expect(card.reactions).toHaveLength(1);
  });

  it("keeps the script's numeric trait when the record has no numbers of its own", async () => {
    const { briefing } = (await readLeadProfile(world(), PLUMBER))!;
    const bare = { ...briefing, xDate: undefined, employees: undefined, payroll: undefined };
    const card = buildPersonaCard(bare, syntheticScripts().personas[0], { briefingInAgentPacket: true });
    expect(card.droppedScriptTraits).toBe(0);
    expect(card.facts.find((f) => f.label === "Annual payroll")).toMatchObject({ value: "1", source: "script" });
  });

  it("lists missed calls and flags the simulated ones", async () => {
    const { briefing } = (await readLeadProfile(world(), ELECTRICIAN, () => new Date("2026-10-19T12:00:00Z")))!;
    const card = buildPersonaCard(briefing, undefined, { briefingInAgentPacket: true });
    expect(card.missedCalls.map((c) => c.simulated).sort()).toEqual([false, true]);
  });

  it("still lists the facts when no script file is there", async () => {
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const card = buildPersonaCard(briefing, undefined, { briefingInAgentPacket: true });
    expect(card.personaId).toBeUndefined();
    expect(card.facts.length).toBeGreaterThanOrEqual(4);
    expect(card.objections).toEqual([]);
  });

  it("chooses a persona that fits the situation, English by default, the same one every time", async () => {
    const scripts = syntheticScripts();
    const { briefing } = (await readLeadProfile(world(), ROOFER))!;
    const a = choosePersona(scripts, ROOFER, briefing)!;
    expect(a.situation).toBe("callback_after_missed_calls");
    expect(a.persona.language).toBe("en");
    expect(choosePersona(scripts, ROOFER, briefing)!.id).toBe(a.id);
    expect(() => choosePersona(scripts, ROOFER, briefing, { personaId: "nope" })).toThrow("unknown_persona:nope");
    expect(listPersonas(scripts)).toHaveLength(4);
  });

  it("reads the scripts file at run time and says so when it is missing or unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "scripts-"));
    try {
      expect(() => loadLeadScripts(join(dir, "none.json"))).toThrow("lead_scripts_unavailable");
      writeFileSync(join(dir, "bad.json"), "{ not json");
      expect(() => loadLeadScripts(join(dir, "bad.json"))).toThrow("lead_scripts_unreadable");
      writeFileSync(join(dir, "ok.json"), JSON.stringify({ personas: syntheticScripts().personas }));
      expect(loadLeadScripts(join(dir, "ok.json")).personas).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("named setups", () => {
  const input = {
    name: "Roofer baseline",
    voiceModuleId: "vapi",
    decisionModuleId: "jev-mock",
    promptSetupId: "baseline-with-lead-record",
    leadId: ROOFER,
    direction: "inbound" as const,
  };

  it("saves, reads back and lists a setup, files private to the owner", () => {
    const store = new SetupStore(() => new Date("2026-10-19T12:00:00Z"));
    const saved = store.save({ ...input, notes: "first pass" });
    expect(saved.savedAt).toBe("2026-10-19T12:00:00.000Z");
    expect(store.get("roofer baseline")).toEqual(saved);
    expect(store.list().map((s) => s.name)).toEqual(["Roofer baseline"]);
    const dir = join(process.env.VOICE_HARNESS_DATA_DIR!, "setups");
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "roofer-baseline.json")).mode & 0o077).toBe(0);
  });

  it("refuses bad names, lead ids, directions and over-long notes", () => {
    const store = new SetupStore();
    expect(() => store.save({ ...input, name: "../escape" })).toThrow("bad_setup_name");
    expect(() => store.save({ ...input, name: "" })).toThrow("bad_setup_name");
    expect(() => store.save({ ...input, leadId: "lead-1" })).toThrow("bad_lead_id");
    expect(() => store.save({ ...input, direction: "sideways" as never })).toThrow("bad_direction");
    expect(() => store.save({ ...input, notes: "x".repeat(501) })).toThrow("bad_notes");
    expect(store.list()).toEqual([]);
  });

  it("answers undefined for a name that was never saved", () => {
    expect(new SetupStore().get("missing")).toBeUndefined();
    expect(new SetupStore().get("../../etc/passwd")).toBeUndefined();
  });
});
