/**
 * The models actually deployed on the Azure resource, for GET /api/voice/options
 * and the model checks before a call starts.
 *
 * The listing is the resource's own deployment list (data plane,
 * GET {resource origin}/openai/deployments, with the API key). GET /models on
 * the v1 route is not used: it is Azure's whole model catalog and includes
 * models this resource has not deployed (gpt-realtime among them), which is the
 * mistake behind azure_session_rejected on test calls (2026-10-19).
 *
 * Each deployment gets a role from its base model:
 *   - speech_to_speech: the gpt-live family only (gpt-live-1). A real probe on
 *     2026-10-20 (one session.start per model on /live/sessions) started
 *     gpt-live-1 with all five voices; gpt-realtime-2.1 answered
 *     server_error / output_creation_failed and gpt-realtime-2.1-mini did not
 *     answer. The gpt-realtime family needs the realtime protocol, a separate
 *     voice path, so it is in no call slot; nor are translation, gpt-audio and
 *     *-realtime-preview models.
 *   - speech_to_text: transcribe and whisper models.
 *   - text_to_speech: tts models.
 *   - reply: text chat models.
 *
 * A failed listing never throws and never stops calls: the result is ok false
 * with a plain reason, and the speech_to_speech list falls back to the live
 * deployments named in the settings (AZURE_REALTIME_DEPLOYMENT, else gpt-live-1).
 * Nothing here ever carries the key, the host or provider text.
 */

import { loadFoundryConfig, type FoundryConfigFileSystem } from "../models/foundry.js";
import { liveDeployments } from "../server/voice/azure-credentials.js";
import type { ModelOption, ModelRole, ProviderCatalog } from "../server/voice/voice-options.js";

/** The voices the live protocol speaks with: all five started a gpt-live-1 session (probe, 2026-10-20). */
export const LIVE_VOICES: readonly string[] = ["verse", "alloy", "marin", "coral", "shimmer"];
/** A custom voice id, sent to Azure as { id } (see FRAME_VOICE_PREFIX in azure-live-session.ts). */
const CUSTOM_VOICE = /^voice_[A-Za-z0-9_-]{1,64}$/;

/** The one voice rule for a live session: a listed voice or a custom voice id. */
export function isAllowedLiveVoice(voice: string): boolean {
  return LIVE_VOICES.includes(voice) || CUSTOM_VOICE.test(voice);
}

const LIST_API_VERSION = "2022-12-01";
const DEFAULT_TIMEOUT_MS = 4_000;
/** A good listing is kept this long; a failed one only briefly, so Azure coming back shows soon. */
const OK_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 30_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AzureCatalogDeps {
  env?: Record<string, string | undefined>;
  fs?: FoundryConfigFileSystem;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** What a reset returns to; the test setup sets a fetch that never reaches Azure. */
let defaultDeps: AzureCatalogDeps = {};
let deps: AzureCatalogDeps = {};
let cached: { catalog: ProviderCatalog; until: number } | undefined;
let inFlight: Promise<ProviderCatalog> | undefined;
/** The models of the last listing that worked, kept through any number of failed refreshes. */
let lastGoodModels: ModelOption[] | undefined;

/** Tests give the catalog a fake fetch and settings. Clears the cache. */
export function setAzureCatalogDeps(patch: AzureCatalogDeps): void {
  deps = { ...deps, ...patch };
  cached = undefined;
  inFlight = undefined;
  lastGoodModels = undefined;
}

/** The test setup uses this so no test reaches the real listing, even with VOICE_HARNESS_DEV_ENV_FILE exported. */
export function setDefaultAzureCatalogDeps(patch: AzureCatalogDeps): void {
  defaultDeps = { ...patch };
  deps = { ...defaultDeps };
}

export function resetAzureCatalog(): void {
  deps = { ...defaultDeps };
  cached = undefined;
  inFlight = undefined;
  lastGoodModels = undefined;
}

/** The role a base model plays, or undefined when it is none the harness uses (images, embeddings, other protocols). */
export function roleOfModel(model: string): ModelRole | undefined {
  const m = model.toLowerCase();
  if (/(dall-e|image|sora|embedding|whisper-tts)/.test(m)) return undefined;
  if (/transcribe|whisper/.test(m)) return "speech_to_text";
  if (/tts/.test(m)) return "text_to_speech";
  if (/translate/.test(m)) return undefined;
  if (/^gpt-live-\d/.test(m)) return "speech_to_speech";
  if (/realtime|audio/.test(m)) return undefined;
  if (/^(gpt-|o\d|mistral|llama|phi-|deepseek|grok|ministral|codestral|cohere|jais|microsoft-)/.test(m)) return "reply";
  return undefined;
}

const label = (deployment: string, model: string): string => (deployment === model ? deployment : `${deployment} (${model})`);

function option(deployment: string, model: string, role: ModelRole): ModelOption {
  return { id: deployment, label: label(deployment, model), role, provider: "azure", ...(role === "speech_to_speech" ? { voices: [...LIVE_VOICES] } : {}) };
}

/** Plain words for a failed listing. Never a key, a host or provider text. */
const REASONS: Record<string, string> = {
  settings: "Azure settings are missing or unreadable (AZURE_FOUNDRY_URL and AZURE_FOUNDRY_KEY in the file named by VOICE_HARNESS_DEV_ENV_FILE)",
  auth: "Azure refused the key when listing deployments",
  not_found: "Azure has no deployment listing at AZURE_FOUNDRY_URL",
  rate_limited: "Azure is rate limiting this key",
  unavailable: "Azure answered the deployment listing with a server error",
  timeout: "the Azure deployment listing timed out",
  unreachable: "Azure could not be reached",
  bad_response: "Azure answered with something that is not a deployment listing",
  no_live: "the Azure deployment listing has no live deployment this harness recognises",
};

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "bad_response";
}

function fallback(now: number, reason: string, env: Record<string, string | undefined>, fs?: FoundryConfigFileSystem): ProviderCatalog {
  return {
    status: { provider: "azure", ok: false, detail: `${REASONS[reason] ?? REASONS.bad_response}; offering only the live deployments named in the settings.`, checkedAt: new Date(now).toISOString() },
    models: liveDeployments(env, fs).map((name) => option(name, name, "speech_to_speech")),
  };
}

async function listOnce(): Promise<ProviderCatalog> {
  const now = (deps.now ?? Date.now)();
  const env = deps.env ?? process.env;
  let origin: string;
  let apiKey: string;
  try {
    const config = loadFoundryConfig(env, deps.fs);
    origin = new URL(config.baseUrl).origin;
    apiKey = config.apiKey;
  } catch {
    return fallback(now, "settings", env, deps.fs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  let body: unknown;
  try {
    // A redirect could carry the key to another host, so none is followed.
    const res = await (deps.fetch ?? fetch)(`${origin}/openai/deployments?api-version=${LIST_API_VERSION}`, {
      method: "GET",
      headers: { "api-key": apiKey },
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return fallback(now, reasonForStatus(res.status), env, deps.fs);
    try {
      body = await res.json();
    } catch {
      // Azure answered, but not with JSON.
      return fallback(now, controller.signal.aborted ? "timeout" : "bad_response", env, deps.fs);
    }
  } catch {
    return fallback(now, controller.signal.aborted ? "timeout" : "unreachable", env, deps.fs);
  } finally {
    clearTimeout(timer);
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return fallback(now, "bad_response", env, deps.fs);
  const models: ModelOption[] = [];
  for (const d of data as Array<Record<string, unknown>>) {
    const deployment = d?.id;
    const model = typeof d?.model === "string" ? d.model : deployment;
    if (typeof deployment !== "string" || typeof model !== "string" || !NAME.test(deployment) || !NAME.test(model)) continue;
    // A deployment still being created, or one that failed, cannot take a call.
    if (typeof d.status === "string" && d.status !== "succeeded") continue;
    const role = roleOfModel(model);
    if (role) models.push(option(deployment, model, role));
  }
  models.sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id));
  // A listing with no live deployment recognised must not refuse every call: say so and keep the settings names.
  if (!models.some((m) => m.role === "speech_to_speech")) {
    const settings = fallback(now, "no_live", env, deps.fs);
    return { status: settings.status, models: [...settings.models, ...models] };
  }
  return { status: { provider: "azure", ok: true, checkedAt: new Date(now).toISOString() }, models };
}

/** The deployments on the resource, cached. Never throws. */
export function loadAzureCatalog(): Promise<ProviderCatalog> {
  const now = (deps.now ?? Date.now)();
  if (cached && cached.until > now) return Promise.resolve(cached.catalog);
  if (inFlight) return inFlight;
  const started = listOnce()
    .catch(() => fallback(now, "unreachable", deps.env ?? process.env, deps.fs))
    .then((listed) => {
      // A failed refresh keeps the last good models (reported as not ok), so a short Azure outage refuses nothing new.
      if (listed.status.ok) lastGoodModels = listed.models;
      const catalog = !listed.status.ok && lastGoodModels ? { status: listed.status, models: lastGoodModels } : listed;
      if (inFlight === started) {
        cached = { catalog, until: (deps.now ?? Date.now)() + (catalog.status.ok ? OK_TTL_MS : FAILED_TTL_MS) };
        inFlight = undefined;
      }
      return catalog;
    });
  inFlight = started;
  return started;
}

/** The last listing, for synchronous readers (the model menu, saving a model). Undefined before the first listing ends. */
export function azureCatalogSnapshot(): ProviderCatalog | undefined {
  return cached?.catalog;
}

/**
 * The speech_to_speech deployment names a live session may use: the last
 * listing when there is one, else the names in the settings. Synchronous.
 */
export function liveModelIds(): string[] {
  const snap = cached?.catalog;
  // A failed listing already carries the settings names; before any listing, read them directly.
  if (snap) return snap.models.filter((m) => m.role === "speech_to_speech").map((m) => m.id);
  return liveDeployments(deps.env ?? process.env, deps.fs);
}
