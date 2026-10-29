/**
 * Decision module registry, shaped like the voice module registry: one place
 * that knows every option, typed config, on or off, and exactly one selected.
 */

import { JevMockModule, OpenAiMockModule, type DecisionConfigPatch } from "./modules.js";
import type { DecisionModule, DecisionModuleConfig, DecisionRequest, DecisionResult } from "./types.js";

export interface DecisionModuleInfo {
  id: string;
  label: string;
  config: DecisionModuleConfig;
  selected: boolean;
}

const DEFAULT_DECISION_MODULE_ID = "jev-mock";

export class DecisionModuleRegistry {
  private modules = new Map<string, DecisionModule>();
  private selectedId = DEFAULT_DECISION_MODULE_ID;

  constructor() {
    for (const m of [new JevMockModule(), new OpenAiMockModule()]) this.modules.set(m.id, m);
  }

  list(): DecisionModuleInfo[] {
    return [...this.modules.values()].map((m) => ({ id: m.id, label: m.label, config: m.getConfig(), selected: m.id === this.selectedId }));
  }

  /** Adds any decision module. Its `id` is its name; a name already in use is refused. */
  register(module: DecisionModule): void {
    if (!module.id.trim()) throw new Error("decision_module_id_required");
    if (this.modules.has(module.id)) throw new Error(`duplicate_decision_module:${module.id}`);
    this.modules.set(module.id, module);
  }

  get(id: string): DecisionModule {
    const m = this.modules.get(id);
    if (!m) throw new Error(`unknown_decision_module:${id}`);
    return m;
  }

  update(id: string, patch: DecisionConfigPatch): DecisionModuleInfo {
    this.get(id).updateConfig?.(patch); // a module with no settings of its own is left as it is
    return this.list().find((m) => m.id === id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.get(id).setEnabled?.(enabled);
  }

  select(id: string): void {
    this.get(id);
    this.selectedId = id;
  }

  selectedModuleId(): string {
    return this.selectedId;
  }

  /** Asks the selected module and returns output the engine can trust. A module that throws is an "unclear". */
  async ask(request: DecisionRequest): Promise<{ module: DecisionModule | null; result: DecisionResult }> {
    const module = this.activeModule();
    if (!module) return { module: null, result: { answer: "unclear", confidence: 0, reason: "no decision module is switched on" } };
    try {
      return { module, result: sanitizeDecision(await module.decide(request), request.answers) };
    } catch {
      return { module, result: { answer: "unclear", confidence: 0, reason: "the module did not answer" } };
    }
  }

  /** The selected module when it is switched on, otherwise none. */
  activeModule(): DecisionModule | null {
    const m = this.get(this.selectedId);
    return m.getConfig().enabled ? m : null;
  }
}

/**
 * Makes a module's output safe to act on: an answer outside the closed list, or
 * a confidence that is not a finite number from 0 to 1, becomes "unclear" with
 * confidence 0, so the tree routes it to the clarifying line.
 */
export function sanitizeDecision(raw: unknown, answers: string[]): DecisionResult {
  const r = (raw ?? {}) as Partial<DecisionResult>;
  if (typeof r.answer !== "string" || !answers.includes(r.answer)) {
    return { answer: "unclear", confidence: 0, reason: "the module gave an answer outside the allowed list" };
  }
  const c = r.confidence;
  const valid = typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1;
  // An invalid confidence is no answer at all: a confidence of 0 alone would still pass a threshold of 0.
  return {
    answer: valid ? r.answer : "unclear",
    confidence: valid ? c : 0,
    reason: (typeof r.reason === "string" ? r.reason : "") + (valid ? "" : " (the module's confidence was not a number from 0 to 1)"),
  };
}

let registry = new DecisionModuleRegistry();

export function getDecisionRegistry(): DecisionModuleRegistry {
  return registry;
}

export function resetDecisionRegistry(): void {
  registry = new DecisionModuleRegistry();
}
