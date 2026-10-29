/**
 * The one Azure AI Foundry client. Every runtime model call in the harness goes
 * through it: decision models, judges, transcription and diarization, and the
 * realtime voice session. The rule (2026-10-19): everything runs on
 * the configured system's Azure AI Foundry, never on a direct vendor route.
 *
 * Foundry serves its models over an OpenAI-compatible route,
 *     AZURE_FOUNDRY_URL=https://<resource>.openai.azure.com/openai/v1
 * and a model is named by its DEPLOYMENT name, not its catalog id.
 *
 * Credentials come from the development dotenv named by VOICE_HARNESS_DEV_ENV_FILE,
 * read at run time only. The key is held as a non-enumerable property, so
 * printing, logging or serializing a config never shows it. Errors carry fixed
 * codes ("foundry_timeout"), never values, prompt text or response text.
 *
 * Every call emits one `tool_call` trace event (through `traceTool`) with the
 * operation, the deployment, success or failure and the duration. Nothing else:
 * no prompt, no reply, no audio, no key.
 *
 * Tests use `createMockFoundryClient`, which has the same interface and emits
 * the same events. `pnpm check` makes no network call.
 */

import { inspect } from "node:util";
import {
  ConnectorCredentialError,
  loadAzureCredentials,
  normalizeAzureUrl,
  type AzureCredentials,
  type ConnectorCredentialErrorCode,
  type ConnectorFs,
} from "../connectors/credentials.js";
import { traceTool } from "../trace/events.js";

/* ------------------------------------------------------------------ config */

/**
 * Deployment names, from configuration only; none is hard-coded. The first
 * three are the settings the configured system's code already reads; the rest are the
 * harness's own. Any may be missing, and a caller that needs one it lacks
 * fails with `foundry_deployment_not_configured`.
 */
export interface FoundryDeploymentNames {
  fast?: string;
  long?: string;
  reply?: string;
  /** The live judge's and the decision tree's fast typed questions. */
  decision?: string;
  /** The offline judges and the analysis that stands in for Fable. */
  judge?: string;
  transcribe?: string;
  realtime?: string;
}

export interface FoundryConfig {
  /** For example https://<resource>.openai.azure.com/openai/v1, with no trailing slash. */
  readonly baseUrl: string;
  readonly deployments: FoundryDeploymentNames;
  /**
   * Where typed decision questions go (Microsoft-Decision-1's System One route).
   * Default: the resource origin + /providers/microsoft/v1/systemone. Override
   * with AZURE_FOUNDRY_DECISION_URL when the decision model lives on another
   * Foundry resource (for example the *.services.ai.azure.com one).
   */
  readonly decisionUrl: string;
  /** Non-enumerable: never printed, logged or serialized. */
  readonly apiKey: string;
}

export type FoundryConfigFileSystem = ConnectorFs;

/** The foundry_-prefixed code each shared credential code maps to. */
const FOUNDRY_CODES: Record<ConnectorCredentialErrorCode, string> = {
  env_file_not_configured: "foundry_env_file_not_configured",
  env_file_permissions_too_open: "foundry_env_file_permissions_too_open",
  env_file_unreadable: "foundry_env_file_unreadable",
  missing_azure_url: "foundry_missing_AZURE_FOUNDRY_URL",
  missing_azure_key: "foundry_missing_AZURE_FOUNDRY_KEY",
  url_invalid: "foundry_url_invalid",
  url_not_azure: "foundry_url_not_azure",
  missing_gateway_key: "foundry_missing_gateway_key",
};

function asFoundryError(err: unknown): never {
  throw new Error(err instanceof ConnectorCredentialError ? FOUNDRY_CODES[err.code] : "foundry_env_file_unreadable");
}

/** Checks the URL and returns it without a trailing slash. Throws `foundry_url_invalid` or `foundry_url_not_azure`. */
export function normalizeFoundryUrl(raw: string): string {
  try {
    return normalizeAzureUrl(raw);
  } catch (err) {
    return asFoundryError(err);
  }
}

/** Builds a config with the key hidden from enumeration. */
export function makeFoundryConfig(
  baseUrl: string,
  apiKey: string,
  deployments: FoundryDeploymentNames = {},
  decisionUrl?: string,
): FoundryConfig {
  const base = normalizeFoundryUrl(baseUrl);
  const decision = decisionUrl ? normalizeFoundryUrl(decisionUrl) : `${new URL(base).origin}/providers/microsoft/v1/systemone`;
  const config = { baseUrl: base, decisionUrl: decision, deployments: { ...deployments } } as FoundryConfig;
  Object.defineProperty(config, "apiKey", { value: apiKey, enumerable: false, writable: false });
  return Object.freeze(config);
}

/** A Foundry config from loaded Azure credentials. */
export function foundryConfigFromCredentials(creds: AzureCredentials): FoundryConfig {
  return makeFoundryConfig(creds.foundryUrl, creds.apiKey, {
    fast: creds.fastDeployment,
    long: creds.longDeployment,
    reply: creds.replyDeployment,
    decision: creds.decisionDeployment,
    judge: creds.judgeDeployment,
    transcribe: creds.transcribeDeployment,
    realtime: creds.realtimeDeployment,
  }, creds.decisionUrl);
}

/**
 * Reads the Foundry settings from the dotenv named by VOICE_HARNESS_DEV_ENV_FILE,
 * through the one credential loader (src/connectors/credentials.ts).
 * Error codes: foundry_env_file_not_configured, foundry_env_file_permissions_too_open,
 * foundry_env_file_unreadable, foundry_missing_AZURE_FOUNDRY_URL,
 * foundry_missing_AZURE_FOUNDRY_KEY, foundry_url_invalid, foundry_url_not_azure.
 */
export function loadFoundryConfig(
  env: Record<string, string | undefined> = process.env,
  fs?: FoundryConfigFileSystem,
): FoundryConfig {
  let creds: AzureCredentials;
  try {
    creds = loadAzureCredentials(env, fs);
  } catch (err) {
    return asFoundryError(err);
  }
  return foundryConfigFromCredentials(creds);
}

/** The named deployment, or `foundry_deployment_not_configured`. */
export function requireDeployment(config: FoundryConfig, role: keyof FoundryDeploymentNames): string {
  const name = config.deployments[role];
  if (!name) throw new Error("foundry_deployment_not_configured");
  return name;
}

/* --------------------------------------------------------------- interface */

export interface FoundryMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

export type FoundryResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  /** Strict structured output: the reply is JSON matching `schema`. */
  | { type: "json_schema"; name: string; schema: Record<string, unknown> };

export interface FoundryCompleteRequest {
  /** The deployment name on the Foundry resource. */
  deployment: string;
  messages: FoundryMessage[];
  responseFormat?: FoundryResponseFormat;
  maxTokens?: number;
  /** Default 30,000 milliseconds. */
  timeoutMs?: number;
  /**
   * Optional: ask for this many alternatives per output token, for turning a
   * one-word choice into per-answer probabilities. Not every deployment
   * supports it; one that does not answers `foundry_bad_request`.
   */
  topLogprobs?: number;
}

export interface FoundryUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface FoundryTokenLogprob {
  token: string;
  logprob: number;
  top: Array<{ token: string; logprob: number }>;
}

export interface FoundryCompletion {
  text: string;
  /** Present when `responseFormat` asked for JSON. */
  json?: unknown;
  latencyMs: number;
  usage: FoundryUsage;
  /** Present only when `topLogprobs` was asked for and the deployment sent them. */
  logprobs?: FoundryTokenLogprob[];
}

export interface FoundryTranscribeRequest {
  deployment: string;
  audio: Uint8Array;
  /** Default "audio.wav". The extension tells the service the format. */
  fileName?: string;
  mimeType?: string;
  /** For example "en" or "es". Omit to let the service detect it. */
  language?: string;
  /** Speaker-separated segments. Needs a deployment that diarizes (for example gpt-4o-transcribe-diarize). */
  diarize?: boolean;
  timeoutMs?: number;
}

export interface FoundrySegment {
  /** The service's own label ("A", "speaker_0"). Null when the deployment does not diarize. */
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
}

export interface FoundryTranscript {
  text: string;
  segments: FoundrySegment[];
  latencyMs: number;
}

/**
 * One typed question in the System One format that Microsoft-Decision-1 (and
 * Jev and Kev, off Azure) speak: a closed choice, a yes-or-no ("noul"), or a
 * score over ordered levels.
 */
export type FoundryDecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export interface FoundryDecideRequest {
  deployment: string;
  /** The conversation or facts the questions are about, already redacted by the caller. */
  state: string | Record<string, unknown>;
  /** Keyed by question name. */
  questions: Record<string, FoundryDecisionQuestion>;
  /** Default 3,000 milliseconds: a typed answer slower than that has stopped being quick. */
  timeoutMs?: number;
}

export type FoundryDecisionAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "noul"; probability: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };

export interface FoundryDecision {
  answers: Record<string, FoundryDecisionAnswer>;
  latencyMs: number;
  usage: FoundryUsage;
}

/**
 * Where a server opens the realtime voice session. Server-side only: the URL
 * and headers carry the key, so this must never be sent to a browser. It
 * refuses to serialize (`toJSON` and `inspect` show no key).
 */
export interface FoundryRealtimeConnection {
  readonly deployment: string;
  readonly url: string;
  /** Call only on the server, when opening the WebSocket. */
  headers(): Record<string, string>;
}

export interface FoundryClient {
  /**
   * The deployment names on the resource: the data-plane listing
   * (GET {resource origin}/openai/deployments). Not GET /models, which is
   * Azure's whole model catalog and names models the resource does not have.
   */
  listDeployments(): Promise<string[]>;
  complete(request: FoundryCompleteRequest): Promise<FoundryCompletion>;
  /** Typed decision questions on a decision deployment (Microsoft-Decision-1). */
  decide(request: FoundryDecideRequest): Promise<FoundryDecision>;
  transcribe(request: FoundryTranscribeRequest): Promise<FoundryTranscript>;
  realtimeSession(request: { deployment: string }): FoundryRealtimeConnection;
}

/* ------------------------------------------------------------- real client */

export interface FoundryClientOptions {
  fetch?: typeof fetch;
  /** Milliseconds; injectable so tests measure latency without waiting. */
  clock?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The data-plane deployment listing answers on this version with the API key. */
const DEPLOYMENT_LIST_API_VERSION = "2022-12-01";
const DEPLOYMENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function checkDeployment(deployment: string): void {
  if (!DEPLOYMENT_NAME.test(deployment)) throw new Error("foundry_deployment_name_invalid");
}

function statusCode(status: number): string {
  if (status === 400) return "foundry_bad_request";
  if (status === 401 || status === 403) return "foundry_auth";
  if (status === 404) return "foundry_deployment_not_found";
  if (status === 408) return "foundry_timeout";
  if (status === 413) return "foundry_too_large";
  if (status === 429) return "foundry_rate_limited";
  if (status >= 500) return "foundry_unavailable";
  return `foundry_http_${status}`;
}

function redactedConnection(deployment: string, url: string, headers: () => Record<string, string>): FoundryRealtimeConnection {
  const shown = { deployment, url, headers: "[server only]" };
  return {
    deployment,
    url,
    headers,
    toJSON: () => shown,
    [inspect.custom]: () => shown,
  } as FoundryRealtimeConnection;
}

export function createFoundryClient(config: FoundryConfig, options: FoundryClientOptions = {}): FoundryClient {
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? (() => performance.now());
  const authHeaders = (): Record<string, string> => ({ "api-key": config.apiKey, authorization: `Bearer ${config.apiKey}` });

  /** One request. Throws only fixed codes. */
  async function request(path: string, init: { method: "GET" | "POST"; body?: BodyInit; json?: unknown; timeoutMs?: number; url?: string }): Promise<unknown> {
    const headers: Record<string, string> = { ...authHeaders(), accept: "application/json" };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const signal = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(init.url ?? `${config.baseUrl}${path}`, { method: init.method, headers, body, signal });
    } catch {
      // Never forward the underlying error: it can carry the URL or headers.
      throw new Error(signal.aborted ? "foundry_timeout" : "foundry_unreachable");
    }
    if (!res.ok) throw new Error(statusCode(res.status));
    try {
      return await res.json();
    } catch {
      throw new Error(signal.aborted ? "foundry_timeout" : "foundry_bad_response");
    }
  }

  return {
    listDeployments() {
      return traceTool("foundry.list_deployments", {}, async () => {
        // The api-key header only, as the data-plane listing was verified with (2026-10-20).
        const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
        let res: Response;
        try {
          res = await doFetch(`${new URL(config.baseUrl).origin}/openai/deployments?api-version=${DEPLOYMENT_LIST_API_VERSION}`, {
            method: "GET",
            headers: { "api-key": config.apiKey, accept: "application/json" },
            signal,
          });
        } catch {
          throw new Error(signal.aborted ? "foundry_timeout" : "foundry_unreachable");
        }
        if (!res.ok) throw new Error(statusCode(res.status));
        let body: { data?: Array<{ id?: unknown }> };
        try {
          body = (await res.json()) as typeof body;
        } catch {
          throw new Error("foundry_bad_response");
        }
        if (!Array.isArray(body?.data)) throw new Error("foundry_bad_response");
        return body.data.flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
      }, (names) => ({ count: names.length }));
    },

    complete(req) {
      return traceTool("foundry.complete", { deployment: req.deployment }, async () => {
        checkDeployment(req.deployment);
        const started = clock();
        const payload: Record<string, unknown> = { model: req.deployment, messages: req.messages };
        // The gpt-5 family takes max_completion_tokens, not max_tokens.
        if (req.maxTokens !== undefined) payload.max_completion_tokens = req.maxTokens;
        if (req.responseFormat?.type === "json_schema") {
          payload.response_format = { type: "json_schema", json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: true } };
        } else if (req.responseFormat) {
          payload.response_format = { type: req.responseFormat.type };
        }
        if (req.topLogprobs !== undefined) {
          payload.logprobs = true;
          payload.top_logprobs = req.topLogprobs;
        }
        const body = (await request("/chat/completions", { method: "POST", json: payload, timeoutMs: req.timeoutMs })) as ChatCompletionBody;
        const choice = body?.choices?.[0];
        if (!choice || typeof choice.message?.content !== "string") {
          if (choice?.finish_reason === "content_filter") throw new Error("foundry_content_filtered");
          throw new Error("foundry_bad_response");
        }
        if (choice.finish_reason === "content_filter") throw new Error("foundry_content_filtered");
        if (choice.finish_reason === "length") throw new Error("foundry_reply_truncated");
        const result: FoundryCompletion = {
          text: choice.message.content,
          latencyMs: Math.round(clock() - started),
          usage: { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null },
        };
        if (req.responseFormat && req.responseFormat.type !== "text") {
          try {
            result.json = JSON.parse(result.text);
          } catch {
            throw new Error("foundry_reply_not_json");
          }
        }
        const logprobs = choice.logprobs?.content;
        if (Array.isArray(logprobs)) {
          result.logprobs = logprobs.map((t) => ({
            token: t.token,
            logprob: t.logprob,
            top: (t.top_logprobs ?? []).map((a) => ({ token: a.token, logprob: a.logprob })),
          }));
        }
        return result;
      }, (r) => ({ latencyMs: r.latencyMs, usage: r.usage }));
    },

    decide(req) {
      return traceTool("foundry.decide", { deployment: req.deployment }, async () => {
        checkDeployment(req.deployment);
        const started = clock();
        const body = (await request("", {
          method: "POST",
          url: config.decisionUrl,
          json: { model: req.deployment, state: req.state, questions: req.questions },
          timeoutMs: req.timeoutMs ?? 3_000,
        })) as DecisionBody;
        if (!body || typeof body.answers !== "object" || body.answers === null) throw new Error("foundry_bad_response");
        const answers: Record<string, FoundryDecisionAnswer> = {};
        for (const [name, raw] of Object.entries(body.answers)) answers[name] = parseDecisionAnswer(raw);
        return {
          answers,
          latencyMs: Math.round(clock() - started),
          usage: { inputTokens: body.usage?.input_tokens ?? body.usage?.inputTokens ?? null, outputTokens: body.usage?.output_tokens ?? body.usage?.outputTokens ?? null },
        };
      }, (r) => ({ latencyMs: r.latencyMs, usage: r.usage }));
    },

    transcribe(req) {
      return traceTool("foundry.transcribe", { deployment: req.deployment, diarize: req.diarize ?? false }, async () => {
        checkDeployment(req.deployment);
        const started = clock();
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(req.audio)], { type: req.mimeType ?? "audio/wav" }), req.fileName ?? "audio.wav");
        form.append("model", req.deployment);
        if (req.language) form.append("language", req.language);
        if (req.diarize) {
          form.append("response_format", "diarized_json");
          form.append("chunking_strategy", "auto");
        } else {
          form.append("response_format", "json");
        }
        const body = (await request("/audio/transcriptions", { method: "POST", body: form, timeoutMs: req.timeoutMs ?? 120_000 })) as TranscriptionBody;
        if (typeof body?.text !== "string") throw new Error("foundry_bad_response");
        const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : null);
        const segments: FoundrySegment[] = (Array.isArray(body.segments) ? body.segments : []).map((s) => ({
          speaker: typeof s.speaker === "string" ? s.speaker : null,
          startMs: seconds(s.start),
          endMs: seconds(s.end),
          text: typeof s.text === "string" ? s.text : "",
        }));
        return { text: body.text, segments, latencyMs: Math.round(clock() - started) };
      }, (r) => ({ latencyMs: r.latencyMs, segments: r.segments.length }));
    },

    realtimeSession({ deployment }) {
      checkDeployment(deployment);
      const wsBase = config.baseUrl.replace(/^https:/, "wss:");
      return redactedConnection(deployment, `${wsBase}/realtime?model=${encodeURIComponent(deployment)}`, () => ({ "api-key": config.apiKey }));
    },
  };
}

interface ChatCompletionBody {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: unknown };
    logprobs?: { content?: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface DecisionBody {
  answers?: Record<string, unknown> | null;
  usage?: { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function numberMap(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const value = typeof n === "string" ? Number(n) : n;
    if (isNumber(value)) out[k] = value;
  }
  return out;
}

/** One answer, read strictly. A yes-or-no answer may name its probability "noul" (System One) or "probability". */
function parseDecisionAnswer(raw: unknown): FoundryDecisionAnswer {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (a.type === "choice" && typeof a.choice === "string") {
    return { type: "choice", choice: a.choice, probabilities: numberMap(a.probabilities), confidence: isNumber(a.confidence) ? a.confidence : undefined };
  }
  if (a.type === "noul" || a.type === "boolean") {
    const p = isNumber(a.noul) ? a.noul : isNumber(a.probability) ? a.probability : null;
    if (p === null) throw new Error("foundry_bad_response");
    return { type: "noul", probability: p };
  }
  if (a.type === "score" && isNumber(a.score)) {
    return { type: "score", score: a.score, probabilities: numberMap(a.probabilities), confidence: isNumber(a.confidence) ? a.confidence : undefined };
  }
  throw new Error("foundry_bad_response");
}

interface TranscriptionBody {
  text?: unknown;
  segments?: Array<{ speaker?: unknown; start?: unknown; end?: unknown; text?: unknown }>;
}

/* -------------------------------------------------------------- the mock */

export type MockCompletionReply = string | { text?: string; json?: unknown; usage?: Partial<FoundryUsage>; logprobs?: FoundryTokenLogprob[] };

export interface MockFoundryScript {
  deployments?: string[];
  /** Return the reply, or throw an Error with a fixed code to simulate a failure. Default: an empty JSON object. */
  complete?: (request: FoundryCompleteRequest) => MockCompletionReply | Promise<MockCompletionReply>;
  /** Return the answers, or throw an Error with a fixed code. Default: every choice question answers its first criterion with probability 1. */
  decide?: (request: FoundryDecideRequest) => Record<string, FoundryDecisionAnswer> | Promise<Record<string, FoundryDecisionAnswer>>;
  transcribe?: (request: FoundryTranscribeRequest) => Omit<FoundryTranscript, "latencyMs"> | Promise<Omit<FoundryTranscript, "latencyMs">>;
  /** Reported latency in milliseconds. Nothing waits. Default 120. */
  latencyMs?: number;
}

export interface MockFoundryClient extends FoundryClient {
  /** Every request received, in order, for assertions. */
  readonly calls: Array<{ op: "list_deployments" | "complete" | "decide" | "transcribe" | "realtime"; deployment?: string; request?: unknown }>;
}

/** Same interface and trace events as the real client; never touches the network. */
export function createMockFoundryClient(script: MockFoundryScript = {}): MockFoundryClient {
  const calls: MockFoundryClient["calls"] = [];
  const latencyMs = script.latencyMs ?? 120;
  return {
    calls,
    listDeployments() {
      calls.push({ op: "list_deployments" });
      return traceTool("foundry.list_deployments", {}, async () => [...(script.deployments ?? [])], (names) => ({ count: names.length }));
    },
    complete(req) {
      calls.push({ op: "complete", deployment: req.deployment, request: req });
      return traceTool("foundry.complete", { deployment: req.deployment }, async () => {
        checkDeployment(req.deployment);
        const reply = script.complete ? await script.complete(req) : { json: {} };
        const shaped = typeof reply === "string" ? { text: reply } : reply;
        const text = shaped.text ?? (shaped.json !== undefined ? JSON.stringify(shaped.json) : "");
        const result: FoundryCompletion = {
          text,
          latencyMs,
          usage: { inputTokens: shaped.usage?.inputTokens ?? null, outputTokens: shaped.usage?.outputTokens ?? null },
        };
        if (req.responseFormat && req.responseFormat.type !== "text") {
          try {
            result.json = shaped.json ?? JSON.parse(text);
          } catch {
            throw new Error("foundry_reply_not_json");
          }
        }
        if (shaped.logprobs) result.logprobs = shaped.logprobs;
        return result;
      }, (r) => ({ latencyMs: r.latencyMs, usage: r.usage }));
    },
    decide(req) {
      calls.push({ op: "decide", deployment: req.deployment, request: req });
      return traceTool("foundry.decide", { deployment: req.deployment }, async () => {
        checkDeployment(req.deployment);
        const answers = script.decide ? await script.decide(req) : defaultMockAnswers(req);
        return { answers, latencyMs, usage: { inputTokens: null, outputTokens: null } };
      }, (r) => ({ latencyMs: r.latencyMs, usage: r.usage }));
    },
    transcribe(req) {
      calls.push({ op: "transcribe", deployment: req.deployment });
      return traceTool("foundry.transcribe", { deployment: req.deployment, diarize: req.diarize ?? false }, async () => {
        checkDeployment(req.deployment);
        const out = script.transcribe ? await script.transcribe(req) : { text: "", segments: [] };
        return { ...out, latencyMs };
      }, (r) => ({ latencyMs: r.latencyMs, segments: r.segments.length }));
    },
    realtimeSession({ deployment }) {
      calls.push({ op: "realtime", deployment });
      checkDeployment(deployment);
      return redactedConnection(deployment, `mock://foundry/realtime?model=${encodeURIComponent(deployment)}`, () => ({ "api-key": "mock" }));
    },
  };
}

function defaultMockAnswers(req: FoundryDecideRequest): Record<string, FoundryDecisionAnswer> {
  const out: Record<string, FoundryDecisionAnswer> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    if (q.type === "choice") {
      const first = Object.keys(q.criteria)[0] ?? "";
      out[name] = { type: "choice", choice: first, probabilities: { [first]: 1 } };
    } else if (q.type === "noul") {
      out[name] = { type: "noul", probability: 0.5 };
    } else {
      out[name] = { type: "score", score: 0 };
    }
  }
  return out;
}
