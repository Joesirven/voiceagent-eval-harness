/**
 * Swappable prompt setups. Shipped setups come from data/prompt-setups.json and can
 * not be overwritten or removed; custom ones can be registered, pasted in as JSON,
 * and removed again. One setup is selected at a time for the testing harness.
 */

import { readDataFile } from "../data-files.js";
import { isOverridesFileName, readOverridesFile } from "./overrides-file.js";
import { findPersonality } from "./personality.js";
import { PROMPT_LAYERS, type PromptLayerId, type PromptSetup } from "./types.js";

export const DEFAULT_SETUP_ID = "playbook-full";

/** The longest text one layer override may have. */
export const MAX_OVERRIDE_CHARS = 20000;

const SETUP_ID_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The reasons a setup is invalid, as short codes. An empty list means valid. */
export function validateSetup(candidate: unknown): string[] {
  const errors: string[] = [];
  if (typeof candidate !== "object" || candidate === null) return ["setup_not_an_object"];
  const s = candidate as Record<string, unknown>;
  if (typeof s.id !== "string" || !SETUP_ID_FORMAT.test(s.id)) errors.push("setup_id_invalid");
  if (typeof s.label !== "string" || !s.label.trim()) errors.push("setup_label_missing");
  if (typeof s.description !== "string") errors.push("setup_description_missing");
  if (!Array.isArray(s.layers)) {
    errors.push("setup_layers_missing");
  } else {
    const seen = new Set<string>();
    for (const layer of s.layers) {
      if (typeof layer !== "string" || !(PROMPT_LAYERS as readonly string[]).includes(layer)) errors.push(`setup_layer_unknown:${String(layer)}`);
      else if (seen.has(layer)) errors.push(`setup_layer_duplicate:${layer}`);
      else seen.add(layer);
    }
  }
  if (typeof s.personalityId !== "string") errors.push("setup_personality_missing");
  else if (s.personalityId !== "none" && !findPersonality(s.personalityId)) errors.push(`setup_personality_unknown:${s.personalityId}`);
  if (s.notes !== undefined && typeof s.notes !== "string") errors.push("setup_notes_invalid");
  if (s.overrides !== undefined) {
    if (typeof s.overrides !== "object" || s.overrides === null || Array.isArray(s.overrides)) {
      errors.push("setup_overrides_invalid");
    } else {
      for (const [key, value] of Object.entries(s.overrides)) {
        if (key === "disclosure") errors.push("disclosure_locked");
        else if (!(PROMPT_LAYERS as readonly string[]).includes(key)) errors.push(`setup_override_layer_unknown:${key}`);
        else if (typeof value !== "string") errors.push(`setup_override_not_text:${key}`);
        else if (value.length > MAX_OVERRIDE_CHARS) errors.push(`setup_override_too_long:${key}`);
      }
    }
  }
  if (s.overridesFile !== undefined && !isOverridesFileName(s.overridesFile)) errors.push("setup_overrides_file_invalid");
  return errors;
}

function normalise(raw: Record<string, unknown>): PromptSetup {
  const setup: PromptSetup = {
    id: raw.id as string,
    label: (raw.label as string).trim(),
    description: raw.description as string,
    layers: [...(raw.layers as PromptLayerId[])],
    personalityId: raw.personalityId as string,
  };
  if (typeof raw.notes === "string") setup.notes = raw.notes;
  if (typeof raw.overrides === "object" && raw.overrides !== null) {
    setup.overrides = { ...(raw.overrides as Partial<Record<PromptLayerId, string>>) };
  }
  return setup;
}

/** A shipped setup whose overrides live in a markdown file: the file is read once, when the registry loads. */
function withOverridesFile(setup: PromptSetup, raw: Record<string, unknown>): PromptSetup {
  if (typeof raw.overridesFile !== "string") return setup;
  const fromFile = readOverridesFile(raw.overridesFile);
  return { ...setup, overridesFile: raw.overridesFile, overrides: { ...fromFile, ...(setup.overrides ?? {}) } };
}

export type PromptSetupEntry = PromptSetup & { shipped: boolean };

export class PromptSetupRegistry {
  private readonly shipped = new Map<string, PromptSetup>();
  private readonly custom = new Map<string, PromptSetup>();
  private selected = DEFAULT_SETUP_ID;

  constructor() {
    const file = readDataFile<{ setups: unknown[] }>("prompt-setups.json");
    for (const raw of file.setups) {
      const errors = validateSetup(raw);
      if (errors.length) throw new Error(`shipped_setup_invalid:${(raw as { id?: string }).id ?? "?"}:${errors.join(",")}`);
      const setup = withOverridesFile(normalise(raw as Record<string, unknown>), raw as Record<string, unknown>);
      this.shipped.set(setup.id, setup);
    }
    if (!this.shipped.has(DEFAULT_SETUP_ID)) throw new Error("shipped_setup_default_missing");
  }

  /** Shipped setups first, then custom ones, each in the order they were added. */
  list(): PromptSetupEntry[] {
    return [
      ...[...this.shipped.values()].map((s) => ({ ...s, shipped: true })),
      ...[...this.custom.values()].map((s) => ({ ...s, shipped: false })),
    ];
  }

  get(id: string): PromptSetup | undefined {
    return this.shipped.get(id) ?? this.custom.get(id);
  }

  isShipped(id: string): boolean {
    return this.shipped.has(id);
  }

  selectedId(): string {
    return this.selected;
  }

  selectedSetup(): PromptSetup {
    return this.get(this.selected) as PromptSetup;
  }

  select(id: string): PromptSetup {
    const setup = this.get(id);
    if (!setup) throw new Error(`setup_unknown:${id}`);
    this.selected = id;
    return setup;
  }

  /** Adds or replaces a custom setup. A shipped setup is never overwritten. */
  register(setup: PromptSetup): PromptSetup {
    const errors = validateSetup(setup);
    if (errors.length) throw new Error(errors.join(","));
    if (this.shipped.has(setup.id)) throw new Error(`setup_is_shipped:${setup.id}`);
    if (setup.overridesFile !== undefined) throw new Error("setup_overrides_file_is_shipped_only");
    const stored = normalise(setup as unknown as Record<string, unknown>);
    this.custom.set(stored.id, stored);
    return stored;
  }

  /** Removes a custom setup. If it was selected, the default is selected again. */
  remove(id: string): void {
    if (this.shipped.has(id)) throw new Error(`setup_is_shipped:${id}`);
    if (!this.custom.delete(id)) throw new Error(`setup_unknown:${id}`);
    if (this.selected === id) this.selected = DEFAULT_SETUP_ID;
  }

  /**
   * Reads pasted JSON: one setup object, an array of them, or { "setups": [...] }.
   * Nothing is registered; valid setups and per-setup errors come back for the caller.
   */
  parseSetups(json: string): { setups: PromptSetup[]; errors: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { setups: [], errors: ["json_invalid"] };
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { setups?: unknown }).setups)
        ? (parsed as { setups: unknown[] }).setups
        : [parsed];
    const setups: PromptSetup[] = [];
    const errors: string[] = [];
    candidates.forEach((candidate, index) => {
      const problems = validateSetup(candidate);
      const id = (candidate as { id?: unknown } | null)?.id;
      if (problems.length === 0 && typeof id === "string" && this.shipped.has(id)) problems.push(`setup_is_shipped:${id}`);
      if (problems.length) errors.push(`setup[${index}]: ${problems.join(", ")}`);
      else setups.push(normalise(candidate as Record<string, unknown>));
    });
    return { setups, errors };
  }

  /** parseSetups, then register every valid setup. */
  importSetups(json: string): { registered: PromptSetup[]; errors: string[] } {
    const { setups, errors } = this.parseSetups(json);
    return { registered: setups.map((s) => this.register(s)), errors };
  }
}

let registry: PromptSetupRegistry | undefined;

export function getPromptSetupRegistry(): PromptSetupRegistry {
  registry ??= new PromptSetupRegistry();
  return registry;
}

export function resetPromptSetupRegistry(): void {
  registry = undefined;
}
