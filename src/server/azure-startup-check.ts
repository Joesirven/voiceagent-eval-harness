/**
 * Azure health for the dev server: a startup check that refuses to start, and a
 * runtime watch that blocks new calls.
 *
 * Startup: the settings are read through the one loader (loadFoundryConfig, which
 * wraps src/connectors/credentials.ts) and checked once with a free, read-only
 * listing of the deployments (no model is invoked, nothing is paid). Missing
 * settings or a failed listing give a warning that names the setting or the check
 * and the server exits before it listens. The key and the host are never printed.
 *
 * Runtime: the trace bus carries one `tool_call` event per Azure call. A failed
 * one with an authentication or not-found code marks Azure as not working: the
 * status shows in /api/state, new calls are refused, and calls in progress are
 * ended with the reason. Before refusing a new call the check is run again (at
 * most once per interval), so Azure working again lifts the block without a restart.
 */

import { createFoundryClient, loadFoundryConfig, type FoundryConfigFileSystem } from "../models/foundry.js";
import { traceBus, type TraceEvent } from "../trace/index.js";

export interface AzureStatus {
  ok: boolean;
  /** A fixed code such as foundry_missing_AZURE_FOUNDRY_KEY or foundry_auth. Never a value. */
  code?: string;
  /** Words for the console and the page. Never a key or a host. */
  message?: string;
  /** Where the failure was seen. */
  source?: "startup" | "runtime";
}

export interface AzureCheckDeps {
  env?: Record<string, string | undefined>;
  fs?: FoundryConfigFileSystem;
  fetch?: typeof fetch;
}

/** Codes that mean "Azure does not work for us", as opposed to a slow or busy moment. */
export const AZURE_BLOCKING_CODES: readonly string[] = ["foundry_auth", "foundry_deployment_not_found"];

const SETTING_HINTS: Record<string, string> = {
  foundry_env_file_not_configured: "VOICE_HARNESS_DEV_ENV_FILE is not set",
  foundry_env_file_permissions_too_open: "the dotenv named by VOICE_HARNESS_DEV_ENV_FILE is readable by others (it must be mode 600)",
  foundry_env_file_unreadable: "the dotenv named by VOICE_HARNESS_DEV_ENV_FILE cannot be read",
  foundry_missing_AZURE_FOUNDRY_URL: "AZURE_FOUNDRY_URL is missing from the dotenv",
  foundry_missing_AZURE_FOUNDRY_KEY: "AZURE_FOUNDRY_KEY is missing from the dotenv",
  foundry_url_invalid: "AZURE_FOUNDRY_URL is not a valid URL",
  foundry_url_not_azure: "AZURE_FOUNDRY_URL is not an HTTPS Azure address",
  foundry_auth: "the deployment listing was refused: the Azure key does not work (authentication failed)",
  foundry_deployment_not_found: "the deployment listing or a deployment was not found: check AZURE_FOUNDRY_URL and the deployment names",
  foundry_timeout: "the deployment listing timed out",
  foundry_unreachable: "the Azure endpoint could not be reached",
  foundry_unavailable: "the Azure service answered with a server error",
  foundry_rate_limited: "the Azure service is rate limiting this key",
  foundry_bad_response: "the Azure endpoint answered with something that is not a deployment listing",
};

/** Plain words for a code, safe to print: only the fixed text above or the code itself. */
export function describeAzureFailure(code: string): string {
  return SETTING_HINTS[code] ?? `check failed (${code})`;
}

function failure(code: string, source: "startup" | "runtime"): AzureStatus {
  return { ok: false, code, source, message: `Azure is not working: ${describeAzureFailure(code)}.` };
}

function codeOf(err: unknown): string {
  return err instanceof Error && /^[a-z][a-zA-Z0-9_]{0,60}$/.test(err.message) ? err.message : "foundry_unreachable";
}

/** One free verification: load the settings, list the deployments. Never throws, never leaks a value. */
export async function checkAzure(deps: AzureCheckDeps = {}, source: "startup" | "runtime" = "startup"): Promise<AzureStatus> {
  try {
    const config = loadFoundryConfig(deps.env ?? process.env, deps.fs);
    const doFetch = deps.fetch ?? fetch;
    // A redirect could carry the key to another host, so none is followed.
    const client = createFoundryClient(config, { fetch: ((url, init) => doFetch(url, { ...init, redirect: "error" })) as typeof fetch });
    await client.listDeployments();
    return { ok: true };
  } catch (err) {
    return failure(codeOf(err), source);
  }
}

/**
 * Startup gate: prints the warning and returns false when the server must not start.
 * The caller exits with a nonzero code before listening.
 */
export async function azureStartupGate(deps: AzureCheckDeps & { log?: (line: string) => void } = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = await checkAzure(deps, "startup");
  if (status.ok) return true;
  log(`WARNING ${status.message}`);
  log("Refusing to start: the decision model and the voice calls need Azure. Fix the setting named above and start again.");
  return false;
}

/* ------------------------------------------------------------------ runtime */

let runtime: AzureStatus = { ok: true };
let onBlocked: ((status: AzureStatus) => void) | undefined;
let lastRecheckAt = 0;
export const AZURE_RECHECK_INTERVAL_MS = 5000;

/** What /api/state and the Call tab show. */
export function azureStatus(): AzureStatus {
  return { ...runtime };
}

/** Marks Azure as not working. Ends calls in progress the first time. */
export function markAzureFailed(code: string): void {
  if (!runtime.ok) return; // keep the first failure's code until Azure works again
  runtime = failure(code, "runtime");
  console.error(`WARNING ${runtime.message} New calls are refused until it works again.`);
  onBlocked?.(azureStatus());
}

export function markAzureWorking(): void {
  runtime = { ok: true };
}

/** For tests. */
export function resetAzureHealth(): void {
  runtime = { ok: true };
  onBlocked = undefined;
  lastRecheckAt = 0;
}

/** Reacts to Azure failures seen on the trace bus. `end` is called once when Azure becomes not working. Returns the unsubscribe. */
export function watchAzureFailures(end: (status: AzureStatus) => void): () => void {
  onBlocked = end;
  const unsubscribe = traceBus.subscribe((event: TraceEvent) => {
    if (event.type !== "tool_call" || event.data.success !== false) return;
    const tool = event.data.tool;
    const reason = event.data.reason;
    if (typeof tool !== "string" || !tool.startsWith("foundry.") || typeof reason !== "string") return;
    if (AZURE_BLOCKING_CODES.includes(reason)) markAzureFailed(reason);
  });
  return () => {
    unsubscribe();
    if (onBlocked === end) onBlocked = undefined;
  };
}

/**
 * Call before starting a call. Returns ok when Azure works. When it has been
 * marked as not working, the check is run again (at most once per interval) and
 * a pass lifts the block.
 */
export async function azureReadyForNewCall(deps: AzureCheckDeps & { now?: () => number } = {}): Promise<AzureStatus> {
  if (runtime.ok) return { ok: true };
  const now = (deps.now ?? Date.now)();
  if (now - lastRecheckAt >= AZURE_RECHECK_INTERVAL_MS) {
    lastRecheckAt = now;
    const again = await checkAzure(deps, "runtime");
    if (again.ok) markAzureWorking();
  }
  return azureStatus();
}
