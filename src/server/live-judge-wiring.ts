/**
 * Installs the live judge and the live decision module. Azure is the default for
 * both; no mock is part of the live path.
 *
 * Which model answers the judge: the catalog's "azure-decision" model (the same
 * deployment the decision module uses), found each time the judge asks. If Azure
 * is not configured the model source returns null and the judge lets actions
 * proceed after the code rules; the dev server never gets that far, because it
 * refuses to start without working Azure settings (azure-startup-check.ts).
 *
 * Which module answers the tree's questions on a call: "azure-decision", selected
 * at install time. There is no keyword fallback on the live path: `installLiveJudge`
 * throws `azure_decision_model_unavailable` when Azure is not configured.
 * `VOICE_HARNESS_DECISION_MODULE=<id>` can still pick another one.
 * The mock modules (`jev-mock`, `openai-mock`) stay registered for tests only; they
 * are not listed or selectable by the Call tab.
 *
 * Credentials are never read into this module: the catalog holds them, and an
 * unreadable credential file counts as "no real model configured".
 */

import { getDecisionRegistry, type DecisionModuleRegistry } from "../decision/registry.js";
import { TEST_ONLY_DECISION_MODULE_IDS } from "../decision/modules.js";
import { asDecisionModule } from "../decision-models/bridge.js";
import { createDecisionModelCatalog, type DecisionModelCatalog } from "../decision-models/catalog.js";
import type { DecisionModel } from "../decision-models/types.js";
import { setActionJudge } from "../judge/index.js";
import { LiveJudge } from "../judging/live-judge.js";
import { azureStatus } from "./azure-startup-check.js";

/** The live decision model's catalog id. */
export const LIVE_DECISION_MODEL_ID = "azure-decision";

/**
 * Milliseconds one live decision may take. A real Azure chat model measured 1.5 to
 * 1.8 seconds per call, so the module default of 3000 could time out under load.
 * On a timeout the engine routes to the clarifying line, as for any failure.
 */
export const LIVE_DECISION_TIMEOUT_MS = 6000;

/**
 * The Azure chat deployment the decision model uses when the dotenv names none.
 * Chosen from the deployments listed on the resource; the dotenv's own
 * AZURE_DECISION_DEPLOYMENT or AZURE_FAST_DEPLOYMENT wins, and so does this variable.
 */
export const DEFAULT_DECISION_CHAT_DEPLOYMENT = "gpt-5.6-luna";
export const DECISION_CHAT_DEPLOYMENT_ENV = "VOICE_HARNESS_DECISION_CHAT_DEPLOYMENT";

let catalog: DecisionModelCatalog | null | undefined;

/** The catalog, or null when its credential file cannot be read. Read once. */
function catalogOrNull(): DecisionModelCatalog | null {
  if (catalog === undefined) {
    try {
      catalog = createDecisionModelCatalog({
        defaultChatDeployment: process.env[DECISION_CHAT_DEPLOYMENT_ENV]?.trim() || DEFAULT_DECISION_CHAT_DEPLOYMENT,
      });
    } catch {
      catalog = null;
    }
  }
  return catalog;
}

/** For tests: replaces the lazily built catalog (undefined forgets it, so the next use builds it again). */
export function useDecisionModelCatalog(replacement: DecisionModelCatalog | null | undefined): void {
  catalog = replacement;
}

/** The catalog's Azure model when Azure is configured, otherwise null (never a mock). */
function azureModelOrNull(): DecisionModel | null {
  const found = catalogOrNull()?.get(LIVE_DECISION_MODEL_ID);
  return found && !found.fellBackToMock && found.model.kind === "real" ? found.model : null;
}

/** The judge's model source: the Azure decision model, or null when Azure is not configured. */
export function liveJudgeModel(): DecisionModel | null {
  return azureModelOrNull();
}

/** The environment variable that opts in to a different decision module for the tree's questions. */
export const DECISION_MODULE_ENV = "VOICE_HARNESS_DECISION_MODULE";

export interface DecisionModuleChoice {
  /** What was asked for, or null when the variable is unset or empty. */
  requested: string | null;
  /** The module selected afterwards. */
  selected: string;
  outcome: "default" | "selected_registered" | "registered_from_catalog" | "refused";
  /** Why a request was refused, as a short code. */
  reason?: "unknown_decision_module" | "no_credential";
}

export interface DecisionModuleChoiceOptions {
  env?: Record<string, string | undefined>;
  /** The catalog to look the id up in. Default: the decision-model catalog, built only when an id is asked for. */
  catalog?: Pick<DecisionModelCatalog, "get"> | null;
  registry?: DecisionModuleRegistry;
}

/**
 * Selects the decision module the tree engine asks, only when
 * `VOICE_HARNESS_DECISION_MODULE` names one. Unset or empty: nothing happens, the
 * catalog is not built, and the keyword module stays selected.
 *
 * - An id already in the decision registry (for example a module a test registered) is selected.
 * - Otherwise the id is looked up in the decision-model catalog and the model is
 *   registered as a module (`asDecisionModule`) and selected. Registering is the
 *   only way a real model reaches a call; a real model costs money per decision.
 * - An unknown id, or a real model whose credential is missing (the catalog hands
 *   out its mock then), is refused and the keyword module stays: a mock is never
 *   run under a real model's name. Asking for a mock by its own id (`<id>-mock`) is fine.
 *
 * Never reads or returns a credential.
 */
export function applyDecisionModuleChoice(options: DecisionModuleChoiceOptions = {}): DecisionModuleChoice {
  const registry = options.registry ?? getDecisionRegistry();
  const requested = (options.env ?? process.env)[DECISION_MODULE_ENV]?.trim() || null;
  if (!requested) return { requested: null, selected: registry.selectedModuleId(), outcome: "default" };

  if (registry.list().some((m) => m.id === requested)) {
    registry.select(requested);
    return { requested, selected: requested, outcome: "selected_registered" };
  }
  const catalog = options.catalog === undefined ? catalogOrNull() : options.catalog;
  const found = catalog?.get(requested);
  const refuse = (reason: NonNullable<DecisionModuleChoice["reason"]>): DecisionModuleChoice => ({ requested, selected: registry.selectedModuleId(), outcome: "refused", reason });
  if (!found) return refuse("unknown_decision_module");
  if (found.fellBackToMock) return refuse("no_credential");
  if (!registry.list().some((m) => m.id === found.model.id)) registry.register(asDecisionModule(found.model, { timeoutMs: LIVE_DECISION_TIMEOUT_MS }));
  registry.select(found.model.id);
  return { requested, selected: found.model.id, outcome: "registered_from_catalog" };
}

export interface DecisionModuleOption {
  id: string;
  label: string;
  selected: boolean;
  /** "keyword" modules never call a model; "model" ones cost money per decision. */
  kind: "keyword" | "model";
  /** False when Azure is marked as not working. */
  available: boolean;
}

/**
 * What the Call tab may pick: every registered module except the test-only mocks,
 * plus azure-decision when it is configured and not yet registered. Builds the
 * catalog on first use, never at import.
 */
export function listDecisionModuleOptions(registry: DecisionModuleRegistry = getDecisionRegistry()): DecisionModuleOption[] {
  const options: DecisionModuleOption[] = registry
    .list()
    .filter((m) => !TEST_ONLY_DECISION_MODULE_IDS.includes(m.id))
    .map((m) => ({
      id: m.id,
      label: m.label,
      selected: m.selected,
      kind: "model" in registry.get(m.id) ? ("model" as const) : ("keyword" as const),
      available: azureStatus().ok,
    }));
  const entry = catalogOrNull()?.list().find((e) => e.id === LIVE_DECISION_MODEL_ID);
  if (entry?.configured && !options.some((o) => o.id === entry.id)) {
    options.push({ id: entry.id, label: entry.label, selected: false, kind: "model", available: azureStatus().ok });
  }
  return options;
}

export interface DecisionModuleStatus {
  selected: string;
  /** True when the selected module is a real model that can answer and Azure is working. */
  available: boolean;
  /** Why not, as a short code: Azure is not working, a test-only module is selected, or the module is not a real model. */
  reason?: "azure_unavailable" | "test_only_module" | "no_model";
  /** The fixed code of the Azure failure when reason is azure_unavailable. */
  azureCode?: string;
  /** Words for the page and the console. */
  message?: string;
}

/** What is answering the tree's questions right now, and whether that is the real model working. */
export function decisionModuleStatus(registry: DecisionModuleRegistry = getDecisionRegistry()): DecisionModuleStatus {
  const selected = registry.selectedModuleId();
  const module = registry.get(selected);
  const azure = azureStatus();
  if (!azure.ok) return { selected, available: false, reason: "azure_unavailable", azureCode: azure.code, message: `${azure.message} New calls are refused until it works again.` };
  if ("model" in module && (module as { model: DecisionModel }).model.kind === "real") return { selected, available: true };
  if (TEST_ONLY_DECISION_MODULE_IDS.includes(selected)) {
    return { selected, available: false, reason: "test_only_module", message: `Decision module ${selected} is a test-only stand-in, not a real model.` };
  }
  return { selected, available: false, reason: "no_model", message: `Decision module ${selected} is not a real model.` };
}

/**
 * Makes the live judge the judge every destructive action goes through, selects
 * the Azure decision module, and applies the decision module opt-in on top.
 * Throws `azure_decision_model_unavailable` when Azure is not configured: there
 * is no fallback, and the server's startup check has already refused to start.
 */
export function installLiveJudge(): void {
  const azure = azureModelOrNull();
  if (!azure) throw new Error("azure_decision_model_unavailable");
  setActionJudge(new LiveJudge({ model: liveJudgeModel }));
  const registry = getDecisionRegistry();
  if (!registry.list().some((m) => m.id === azure.id)) registry.register(asDecisionModule(azure, { timeoutMs: LIVE_DECISION_TIMEOUT_MS }));
  registry.select(azure.id);
  const choice = applyDecisionModuleChoice();
  if (choice.requested) {
    // Ids and codes only: nothing from a credential or a conversation.
    console.log(
      choice.outcome === "refused"
        ? `Decision module ${choice.requested} refused (${choice.reason}); ${choice.selected} stays selected`
        : `Decision module ${choice.selected} selected by ${DECISION_MODULE_ENV}`,
    );
  }
  const status = decisionModuleStatus(registry);
  console.log(
    status.available
      ? `Decision module: ${status.selected} (live Azure model, ${LIVE_DECISION_TIMEOUT_MS} millisecond limit per decision)`
      : `WARNING ${status.message}`,
  );
}
