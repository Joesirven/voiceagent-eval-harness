/**
 * The warm-up before a Talk call: POST /api/call/warmup, run when the person
 * presses Go in the call setup dialog, before the call starts.
 *
 * Four steps run in parallel, each with its own time limit:
 *   - voice_path: the selected orchestrator and voice path resolve to a session mode (no network).
 *   - azure: Azure is not marked as not working (azureReadyForNewCall).
 *   - lead: the lead loads from the active lead store, which also opens that store's connection.
 *   - decision_model: when the selected decision module is a real model, one tiny fixed question,
 *     so the connection and the model are warm for the first real decision. This is a small
 *     billed model call: it runs only when this endpoint is called, never at startup or on a timer.
 *
 * The call may start when voice_path and azure are ok and lead is ok or skipped. A decision_model
 * failure is a warning only. Steps carry fixed codes and fixed text: never a key, a host, error
 * text, lead details, or the model's question or answer. The warm-up question runs outside any
 * traced run, so it puts no event on a call record.
 */

import { azureReadyForNewCall, type AzureStatus } from "./azure-startup-check.js";
import { decisionStepUsed, resolveVoiceSessionMode, selectedVoicePath } from "./voice/manager.js";
import { isVoiceErrorCode, VOICE_ERROR_CATALOG } from "./voice/voice-errors.js";
import { getDecisionRegistry, type DecisionModuleRegistry } from "../decision/registry.js";
import type { DecisionModule } from "../decision/types.js";
import type { DecisionModel, DecisionModelRequest } from "../decision-models/types.js";
import { getActiveLeadStore } from "../store/active-store.js";

export type CallWarmupStepId = "voice_path" | "azure" | "lead" | "decision_model";

export interface CallWarmupStep {
  id: CallWarmupStepId;
  label: string;
  ok: boolean;
  /** A step with nothing to check (no lead given, or no real decision model). Skipped steps are ok with 0 milliseconds. */
  skipped?: boolean;
  ms: number;
  /** A fixed code when the step failed, for example timeout or lead_not_found. */
  code?: string;
  /** Plain words for the dialog: fixed text, the session mode or the model id. */
  detail?: string;
}

export interface CallWarmupResult {
  /** True when voice_path and azure are ok and lead is ok or skipped. decision_model never makes it false. */
  ok: boolean;
  totalMs: number;
  /** Always in this order: voice_path, azure, lead, decision_model. */
  steps: CallWarmupStep[];
}

/** Milliseconds each step may take before it counts as failed with code "timeout". */
export const CALL_WARMUP_STEP_TIMEOUT_MS = 8000;

const LABELS: Record<CallWarmupStepId, string> = {
  voice_path: "Voice path",
  azure: "Azure",
  lead: "Lead",
  decision_model: "Decision model",
};

/** The same lead id shape POST /api/play/start accepts. */
const LEAD_ID_SHAPE = /^[\w-]{1,60}$/;
/** Azure's codes name the setting (foundry_missing_AZURE_FOUNDRY_KEY), voice codes may carry a colon; no dot or space, so never a host or a sentence. */
const CODE_SHAPE = /^[a-z][a-zA-Z0-9_:]{0,60}$/;

/** A code is kept only when it already looks like one; anything else (error text, a host) becomes the fallback. */
function safeCode(code: unknown, fallback: string): string {
  return typeof code === "string" && CODE_SHAPE.test(code) ? code : fallback;
}

const errorCodeOf = (err: unknown, fallback: string): string => safeCode(err instanceof Error ? err.message : undefined, fallback);

/**
 * The one question the warm-up asks: fixed, tiny, and about no real lead.
 * A fresh object each time, so a model can never change the next warm-up's request.
 */
export function warmupDecisionRequest(): DecisionModelRequest {
  return {
    nodeId: "warmup",
    question: "Is the caller greeting the agent?",
    answers: ["yes", "unclear"],
    transcript: [{ role: "caller", text: "Hello.", turnIndex: 0 }],
  };
}

export interface CallWarmupInput {
  /** The lead the call is for. Absent, null or empty: the lead step is skipped. */
  leadId?: unknown;
}

/** Everything the warm-up reaches; tests pass fakes so nothing touches the network. */
export interface CallWarmupDeps {
  /** Default: resolveVoiceSessionMode("audio"). Throws a fixed code when the path cannot run. */
  resolveVoiceMode?: () => string | Promise<string>;
  /** Default: azureReadyForNewCall(). */
  azureReady?: () => Promise<AzureStatus>;
  /** Default: the active lead store's getLead. */
  getLead?: (leadId: string) => Promise<unknown>;
  /** Default: the decision registry, read when the warm-up runs. */
  decisionRegistry?: Pick<DecisionModuleRegistry, "get" | "selectedModuleId">;
  /**
   * Whether the call will ask the decision model. Default: false on the Azure paths without the decision tree,
   * which answer each turn themselves, so warming the model would be a billed request for nothing.
   */
  decisionModelUsed?: () => boolean;
  /** Default: CALL_WARMUP_STEP_TIMEOUT_MS. */
  stepTimeoutMs?: number;
  /** Default: performance.now. */
  now?: () => number;
}

type StepOutcome = Pick<CallWarmupStep, "ok" | "skipped" | "code" | "detail">;

const skippedStep = (detail: string): StepOutcome => ({ ok: true, skipped: true, detail });

/** Runs one step under its own time limit. Never rejects: a throw or a timeout is a failed step. */
async function runStep(id: CallWarmupStepId, run: () => StepOutcome | Promise<StepOutcome>, limitMs: number, now: () => number): Promise<CallWarmupStep> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  // Started on a microtask, so a step that throws before its first await is a failed step too.
  const work = Promise.resolve()
    .then(run)
    .catch((): StepOutcome => ({ ok: false, code: "warmup_step_failed", detail: "The check failed for a reason the server could not name." }));
  const timedOut = new Promise<StepOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: "timeout", detail: `No answer within ${limitMs / 1000} seconds.` }), limitMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([work, timedOut]);
    const ms = outcome.skipped ? 0 : Math.max(0, Math.round(now() - started));
    return {
      id,
      label: LABELS[id],
      ok: outcome.ok,
      ...(outcome.skipped ? { skipped: true } : {}),
      ms,
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function voicePathStep(resolveMode: () => string | Promise<string>): Promise<StepOutcome> {
  try {
    return { ok: true, detail: await resolveMode() };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const code = isVoiceErrorCode(message) ? message : "voice_start_failed";
    return { ok: false, code, detail: VOICE_ERROR_CATALOG[code].title };
  }
}

async function azureStep(azureReady: () => Promise<AzureStatus>): Promise<StepOutcome> {
  const status = await azureReady();
  if (status.ok) return { ok: true };
  return { ok: false, code: safeCode(status.code, "azure_unavailable"), detail: status.message ?? "Azure is not working." };
}

async function leadStep(leadId: unknown, getLead: (leadId: string) => Promise<unknown>): Promise<StepOutcome> {
  if (leadId === undefined || leadId === null || leadId === "") return skippedStep("No lead was picked.");
  if (typeof leadId !== "string" || !LEAD_ID_SHAPE.test(leadId)) return { ok: false, code: "bad_lead_id", detail: "The lead id is not valid." };
  let lead: unknown;
  try {
    lead = await getLead(leadId);
  } catch (err) {
    return { ok: false, code: errorCodeOf(err, "lead_store_failed"), detail: "The lead store could not be read." };
  }
  if (lead === undefined || lead === null) return { ok: false, code: "lead_not_found", detail: VOICE_ERROR_CATALOG.lead_not_found.title };
  return { ok: true };
}

function realModelOf(module: DecisionModule): DecisionModel | undefined {
  const model = "model" in module ? (module as { model?: DecisionModel }).model : undefined;
  return model?.kind === "real" ? model : undefined;
}

async function decisionModelStep(registry: Pick<DecisionModuleRegistry, "get" | "selectedModuleId">, limitMs: number): Promise<StepOutcome> {
  const selected = registry.selectedModuleId();
  const model = realModelOf(registry.get(selected));
  if (!model) return skippedStep(`Decision module ${selected} is not a real model.`);
  // The model's own limit as well as the step's, so its request stops instead of running on.
  // The answer and its reason are never kept: only whether the model answered.
  let outcome;
  try {
    outcome = await model.decide(warmupDecisionRequest(), { timeoutMs: limitMs });
  } catch {
    return { ok: false, code: "error", detail: "The decision model did not answer; the first decision may be slow." };
  }
  if (outcome.ok) return { ok: true, detail: model.id };
  return { ok: false, code: safeCode(outcome.code, safeCode(outcome.reason, "error")), detail: "The decision model did not answer; the first decision may be slow." };
}

/** Warms up and checks everything a Talk call needs. Never throws; every failure is a step with a code. */
export async function warmUpCall(input: CallWarmupInput = {}, deps: CallWarmupDeps = {}): Promise<CallWarmupResult> {
  const now = deps.now ?? (() => performance.now());
  const limitMs = deps.stepTimeoutMs ?? CALL_WARMUP_STEP_TIMEOUT_MS;
  const resolveMode = deps.resolveVoiceMode ?? (() => resolveVoiceSessionMode("audio"));
  const azureReady = deps.azureReady ?? (() => azureReadyForNewCall());
  const getLead = deps.getLead ?? ((leadId: string) => getActiveLeadStore().getLead(leadId));
  const started = now();
  const [voicePath, azure, lead, decisionModel] = await Promise.all([
    runStep("voice_path", () => voicePathStep(resolveMode), limitMs, now),
    runStep("azure", () => azureStep(azureReady), limitMs, now),
    runStep("lead", () => leadStep(input.leadId, getLead), limitMs, now),
    runStep(
      "decision_model",
      async () =>
        (deps.decisionModelUsed ?? decisionStepUsed)()
          ? decisionModelStep(deps.decisionRegistry ?? getDecisionRegistry(), limitMs)
          : skippedStep("The decision tree is off, so the call does not ask the decision model before each reply."),
      limitMs,
      now,
    ),
  ]);
  return {
    ok: voicePath.ok && azure.ok && (lead.ok || lead.skipped === true),
    totalMs: Math.max(0, Math.round(now() - started)),
    steps: [voicePath, azure, lead, decisionModel],
  };
}

/** The one server log line for a warm-up: milliseconds, "skipped", or code/milliseconds per step. Never a detail. */
export function warmupLogLine(result: CallWarmupResult): string {
  const parts = result.steps.map((s) => `${s.id}=${s.skipped ? "skipped" : s.ok ? `${s.ms}ms` : `${safeCode(s.code, "failed")}/${s.ms}ms`}`);
  return `call warmup ok=${result.ok ? "yes" : "no"} ${parts.join(" ")} total=${result.totalMs}ms`;
}
