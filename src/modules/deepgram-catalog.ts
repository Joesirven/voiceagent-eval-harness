/**
 * The Deepgram half of GET /api/voice/options: which speech to text and text
 * to speech models this account can actually use, asked of Deepgram itself
 * instead of a hardcoded list.
 *
 * Two calls with the configured key: the project list (a bad key is refused
 * here; the public models route answers any key) and that project's models.
 * The answer is kept in memory for a few minutes, so the endpoint stays cheap.
 * Failure never throws: the result is ok false with a plain reason and no
 * models, and failures are not cached.
 *
 * Shape decision: Deepgram speech to text models are ModelOption entries
 * (id is the exact `model` query value). For speech, the Deepgram "model" is
 * the voice itself (aura-2-thalia-en), so the voices are one ModelOption per
 * architecture (id "aura-2", role text_to_speech) whose `voices` lists the
 * exact ids sent to Deepgram, rather than a hundred near-identical entries.
 * Only English is offered: the pipeline transcribes with language "en".
 * Currently used defaults come first.
 */

import { loadDeepgramCredentials } from "../connectors/credentials.js";
import type { ModelOption, ProviderCatalog } from "../server/voice/voice-options.js";

export const DEFAULT_STT_MODEL = "nova-3-general";
export const DEFAULT_VOICE = "aura-2-thalia-en";
export const AURA_2_ID = "aura-2";

const BASE_URL = "https://api.deepgram.com/v1";
const TIMEOUT_MS = 5000;
const CACHE_MS = 5 * 60_000;

export interface DeepgramCatalogDeps {
  fetch?: typeof fetch;
  /** The Deepgram key; throws when none is configured. Default: the one credential loader. */
  apiKey?: () => string;
  timeoutMs?: number;
  now?: () => number;
  baseUrl?: string;
}

interface RawModel {
  canonical_name?: unknown;
  architecture?: unknown;
  languages?: unknown;
  streaming?: unknown;
  multilingual?: unknown;
}

class CatalogFailure extends Error {}

let cache: { at: number; catalog: ProviderCatalog } | undefined;

export function clearDeepgramCatalogCache(): void {
  cache = undefined;
}

export async function loadDeepgramCatalog(deps: DeepgramCatalogDeps = {}): Promise<ProviderCatalog> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < CACHE_MS) return cache.catalog;
  const checkedAt = new Date(now()).toISOString();
  try {
    const models = await fetchModels(deps);
    const catalog: ProviderCatalog = { status: { provider: "deepgram", ok: true, checkedAt }, models };
    cache = { at: now(), catalog };
    return catalog;
  } catch (err) {
    const detail = err instanceof CatalogFailure ? err.message : "Deepgram could not be reached";
    return { status: { provider: "deepgram", ok: false, detail, checkedAt }, models: [] };
  }
}

async function getJson(url: string, key: string, deps: DeepgramCatalogDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new CatalogFailure(timedOut ? "Deepgram did not answer in time" : "Deepgram could not be reached");
  }
  if (res.status === 401 || res.status === 403) throw new CatalogFailure("Deepgram refused the configured key");
  if (!res.ok) throw new CatalogFailure(`Deepgram answered with status ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new CatalogFailure("Deepgram sent an unreadable answer");
  }
}

async function fetchModels(deps: DeepgramCatalogDeps): Promise<ModelOption[]> {
  let key: string;
  try {
    key = (deps.apiKey ?? (() => loadDeepgramCredentials().apiKey))();
  } catch {
    throw new CatalogFailure("No Deepgram key is configured");
  }
  const base = deps.baseUrl ?? BASE_URL;
  const projects = (await getJson(`${base}/projects`, key, deps)) as { projects?: { project_id?: unknown }[] };
  const projectId = projects?.projects?.find((p) => typeof p?.project_id === "string")?.project_id;
  if (typeof projectId !== "string" || !/^[A-Za-z0-9-]+$/.test(projectId)) throw new CatalogFailure("The Deepgram key has no project");
  const raw = (await getJson(`${base}/projects/${projectId}/models`, key, deps)) as { stt?: RawModel[]; tts?: RawModel[] };
  if (!raw || !Array.isArray(raw.stt) || !Array.isArray(raw.tts)) throw new CatalogFailure("Deepgram sent an unexpected answer");
  const stt = speechToText(raw.stt);
  const voices = textToSpeech(raw.tts);
  if (!stt.length && !voices.length) throw new CatalogFailure("Deepgram lists no usable models for this account");
  return [...stt, ...(voices.length ? [{ id: AURA_2_ID, label: "Aura-2", role: "text_to_speech" as const, provider: "deepgram" as const, voices }] : [])];
}

const SAFE_NAME = /^[a-z0-9][a-z0-9.-]*$/;
const NOT_TRANSCRIPTION = new Set(["phoneme"]);

function speechToText(raw: RawModel[]): ModelOption[] {
  const names = new Set<string>();
  for (const m of raw) {
    const name = m?.canonical_name;
    if (typeof name !== "string" || !SAFE_NAME.test(name) || NOT_TRANSCRIPTION.has(name) || m.streaming !== true) continue;
    const langs = Array.isArray(m.languages) ? m.languages.filter((l): l is string => typeof l === "string") : [];
    if (m.multilingual === true || langs.some((l) => l === "en" || l.startsWith("en-"))) names.add(name);
  }
  const sorted = [...names].sort((a, b) => Number(b === DEFAULT_STT_MODEL) - Number(a === DEFAULT_STT_MODEL) || a.localeCompare(b));
  return sorted.map((id) => ({ id, label: id, role: "speech_to_text" as const, provider: "deepgram" as const }));
}

function textToSpeech(raw: RawModel[]): string[] {
  const names = new Set<string>();
  for (const m of raw) {
    const name = m?.canonical_name;
    if (typeof name === "string" && m.architecture === "aura-2" && /^aura-2-[a-z]+-en$/.test(name)) names.add(name);
  }
  return [...names].sort((a, b) => Number(b === DEFAULT_VOICE) - Number(a === DEFAULT_VOICE) || a.localeCompare(b));
}
