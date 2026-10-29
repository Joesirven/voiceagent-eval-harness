/**
 * The decision modules a setup can choose between. The decision engine owns
 * the real registry (Jev by default, OpenAI's decision model, Kev and others
 * as they arrive); a setup only needs to name one and remember which it
 * named. Until that registry is on this branch the catalog below stands in
 * with the same identifiers, and `setDecisionCatalog` swaps in the real one
 * in a single line.
 */

export interface DecisionCatalogEntry {
  id: string;
  label: string;
}

export interface DecisionCatalog {
  list(): DecisionCatalogEntry[];
  /** Makes the engine use this module, when the engine can be switched. Throws on an unknown id. */
  select(id: string): void;
  selectedId(): string;
}

export const DEFAULT_DECISION_MODULE_ID = "jev-mock";

export function createStaticDecisionCatalog(): DecisionCatalog {
  const entries: DecisionCatalogEntry[] = [
    { id: "jev-mock", label: "Jev (TypeSafe AI), mock" },
    { id: "openai-mock", label: "OpenAI decision model, mock" },
  ];
  let selected = DEFAULT_DECISION_MODULE_ID;
  return {
    list: () => entries.map((e) => ({ ...e })),
    select(id) {
      if (!entries.some((e) => e.id === id)) throw new Error(`unknown_decision_module:${id}`);
      selected = id;
    },
    selectedId: () => selected,
  };
}

let catalog: DecisionCatalog = createStaticDecisionCatalog();

export function getDecisionCatalog(): DecisionCatalog {
  return catalog;
}

/** Install the engine's own registry (or a test double). Passing null restores the stand-in. */
export function setDecisionCatalog(next: DecisionCatalog | null): void {
  catalog = next ?? createStaticDecisionCatalog();
}
