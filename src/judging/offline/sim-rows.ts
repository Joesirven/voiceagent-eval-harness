/**
 * Row types, column lists, the content rule and the row builders for the
 * simulation tables in the harness database (supabase/harness/004, schema
 * voice_harness: sim_lead_facts, sim_batch, sim_run, sim_turn, sim_turn_eval).
 * Property names are column names. Nothing here touches a database; the writer
 * in sim-writer.ts sends these rows.
 *
 * THE CONTENT RULE. Every row states its content origin ("synthetic_fixture" or
 * "real_call"); the operator states it and nothing in this file guesses it. A
 * made-up row must have a made-up source (table "fixture"); a real-call row must
 * have a real source (dialer or Quo). Text (every column ending in _redacted) is
 * stored with the redaction_method that says what was done to it: on a real-call
 * row, text with a missing or unknown method is refused before any SQL is sent,
 * with sim_redaction_method_unknown. A real-call row without text needs no
 * method. The database enforces the same rule in its own constraints.
 *
 * PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
 * Nothing here refuses a real-call row because the text is not name-masked:
 * "not_redacted" is a known method, and the pattern redaction (redactText) does
 * not mask personal names. A row is never blocked on redaction, only labelled.
 */

import { createHash } from "node:crypto";
import type { JudgeVerdict } from "../../judge/types.js";
import type { JudgeScore } from "../../trace/extensions.js";
import type { TraceEvent, TranscriptLine } from "../../trace/index.js";
import { DECISION_ROUTER_IDS } from "../../server/voice/decision-router.js";
import { MAX_TURN_CAP } from "./types.js";
import type { EnforcementResult, LeadFacts, PairwisePick, PastCall, TurnJudgement } from "./types.js";
import type { TurnJudgingResult } from "./turn-judge.js";
import type { WholeCallEnd, WholeCallGrade, WholeCallRun } from "./whole-call.js";

/* ------------------------------------------------------------------ types */

export type SourceProjectRef = "source_primary" | "source_secondary";
export type HarnessProjectRef = "harness_store";
export type IdOrigin = SourceProjectRef | HarnessProjectRef | "harness_process" | "synthetic_fixture";
export type ContentOrigin = "synthetic_fixture" | "real_call";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const REDACTION_METHODS = ["transcript_turn_redacted", "harness_redact_text_v1", "not_redacted"] as const;
export type RedactionMethod = (typeof REDACTION_METHODS)[number];
export type PersonaOrigin = "synthetic_persona" | "real_call" | "fixture";
export type OrchestratorId = "direct" | "pipecat";
export type DecisionRouterChoice = "decision_model" | "pipecat_flows" | "pipecat_classifier";
export type SimulatorKind = "model" | "scripted";
/** Text as stored; the row's redaction_method says what was done to it. */
export type GatedText = string | null;

/** The origin of a source call is stated by the operator, never guessed from the key. */
export type SourceCallRef =
  | { source_call_origin: SourceProjectRef; source_call_table: "dialer" | "quo"; source_call_key: string; source_call_row_id: string | null }
  | { source_call_origin: "synthetic_fixture"; source_call_table: "fixture"; source_call_key: string; source_call_row_id: null };

export interface TranscriptReference {
  call_transcript_id: string | null;
  call_transcript_origin: SourceProjectRef | HarnessProjectRef | null;
  transcript_pipeline_version: string | null;
}

export type SimLeadFactsRow = SourceCallRef &
  TranscriptReference & {
    past_call_source: PastCall["source"] | null;
    attribution: PastCall["attribution"] | null;
    extractor_id: string;
    extractor_version: string;
    extractor_model: string | null;
    extractor_effort: Effort | null;
    /** Set exactly when extractor_id is "lead-record": "<source>:<call project reference>:<call id>". */
    source_lead_facts_key: string | null;
    persona_origin: PersonaOrigin;
    /** Set exactly when persona_origin is "synthetic_persona". */
    persona_id: string | null;
    trade_redacted: GatedText;
    business_type_redacted: GatedText;
    renewal_date_redacted: GatedText;
    annual_payroll_redacted: GatedText;
    employee_count: number | null;
    current_carrier_redacted: GatedText;
    language: string | null;
    objections_redacted: string[];
    temperament_redacted: GatedText;
    facts_sha256: string;
    content_origin: ContentOrigin;
    redaction_method: RedactionMethod | null;
    extracted_at: string;
  };

export interface WholeCallBatchConfig {
  limit: number;
  lead: SimulatorKind;
  direction: "inbound" | "outbound";
  maxTurns: number;
  pastCallsFileSha256?: string;
  factsFileSha256?: string;
  treeFileSha256?: string;
  diarizedConfigSha256?: string;
}

export interface TurnEvalBatchConfig {
  limit: number;
  callKeysSha256?: string;
  callCount: number;
  turnsPerCall: number;
  minPriorTurns: number;
  minWords: number;
  systemPromptFileSha256?: string;
  systemPromptIsPlaceholder: boolean;
  diarizedConfigSha256?: string;
  pastCallSourceId: string;
}

export interface SimBatchFailure {
  source_call_origin?: SourceProjectRef | "synthetic_fixture";
  source_call_table?: "dialer" | "quo" | "fixture";
  source_call_key?: string;
  turn_index: number | null;
  code: string;
}

interface SimBatchCommon {
  batch_key: string;
  status: "running" | "completed" | "failed" | "cancelled";
  cancel_requested: boolean;
  items_requested: number | null;
  items_found: number | null;
  items_done: number;
  items_blocked: number;
  items_failed: number;
  failures: SimBatchFailure[];
  harness_commit: string;
  harness_dirty: boolean;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}
export type SimBatchRow =
  | (SimBatchCommon & { kind: "whole_call"; config: WholeCallBatchConfig; items_judged: null })
  | (SimBatchCommon & { kind: "turn_eval"; config: TurnEvalBatchConfig; items_judged: number | null });

export interface SimRunRow {
  batch_id: string;
  item_index: number;
  attempt: number;
  /** 0 for the first run of the same lead facts in a batch, 1 for the next repeat, and so on. */
  repeat_index: number;
  record_id: string;
  record_id_origin: "harness_process";
  trace_ref: string;
  first_record_seq: number | null;
  last_record_seq: number | null;
  lead_id: string;
  lead_id_origin: IdOrigin;
  lead_facts_id: string;
  content_origin: ContentOrigin;
  direction: "inbound" | "outbound";
  clock_now: string;
  simulator: SimulatorKind;
  simulator_model: string | null;
  simulator_effort: Effort | null;
  simulator_max_tokens: number | null;
  scripted_preferred_time: string | null;
  scripted_objection_after_turns: number | null;
  scripted_objection_spacing: number | null;
  turn_cap: number;
  tree_source: "tree_file" | "active";
  tree_choice_id: string | null;
  tree_id: string;
  tree_version: string;
  tree_file_sha256: string | null;
  decision_module_id: string | null;
  decision_model_kind: "real" | "mock" | null;
  orchestrator_id: OrchestratorId | null;
  voice_path_id: string | null;
  voice_module_id: string | null;
  /** The Azure deployment that spoke as the agent. */
  dialogue_model: string | null;
  prompt_setup_id: string | null;
  decision_router_id: DecisionRouterChoice | null;
  /** The Azure deployment or module id that chose tree moves. */
  decision_model: string | null;
  judge_enabled: boolean | null;
  judge_model: string | null;
  persona_file_sha256: string | null;
  seed: string | null;
  model_settings: ModelSettings;
  status: "completed" | "blocked" | "failed";
  blocked_reason: string | null;
  failure_code: string | null;
  ended_by: WholeCallEnd | null;
  lead_turns: number;
  caller_lines: number | null;
  renewal_date_confirmed: boolean | null;
  payroll_captured: boolean | null;
  employee_count_captured: boolean | null;
  booked: boolean | null;
  enforcement: EnforcementResult[];
  enforcement_passed: boolean | null;
  judge_verdicts: Array<Partial<JudgeVerdict> & { action: string; recordSeq: number }>;
  judge_score: JudgeScore | null;
  started_at: string | null;
  ended_at: string | null;
  agent_reply_latency_ms_median: number | null;
  agent_reply_latency_ms_max: number | null;
  /** No producer today; always null. */
  input_tokens: null;
  output_tokens: null;
  cost_in_dollars: null;
  updated_at: string;
}

export const MODEL_SETTINGS_ROLES = ["agent", "lead", "decision", "judge", "extractor"] as const;
export type ModelSettingsRole = (typeof MODEL_SETTINGS_ROLES)[number];
export interface ModelSetting {
  deployment?: string;
  temperature?: number | null;
  max_output_tokens?: number | null;
  seed?: number | null;
}
export type ModelSettings = Partial<Record<ModelSettingsRole, ModelSetting>>;

export interface SimTurnRow {
  run_id: string;
  content_origin: ContentOrigin;
  line_index: number;
  turn_index: number;
  role: TranscriptLine["role"];
  spoken: boolean;
  said_at: string;
  record_seq: number | null;
  agent_reply_latency_ms: number | null;
  text_redacted: GatedText;
  redaction_method: RedactionMethod | null;
}

/** verdict and consistent are generated by the database and never sent. */
export type SimTurnEvalRow = SourceCallRef &
  TranscriptReference & {
    batch_id: string;
    past_call_source: PastCall["source"];
    attribution: PastCall["attribution"];
    turn_index: number;
    call_had_clean_turns: boolean;
    agent_id: string;
    agent_model: string | null;
    agent_effort: Effort | null;
    agent_system_prompt_sha256: string;
    agent_system_prompt_is_placeholder: boolean;
    judge_id: string;
    judge_model: string | null;
    judge_effort: Effort | null;
    judge_rubric_sha256: string;
    pick_agent_first: PairwisePick;
    pick_producer_first: PairwisePick;
    content_origin: ContentOrigin;
    agent_reply_redacted: GatedText;
    producer_reply_redacted: GatedText;
    redaction_method: RedactionMethod | null;
    judged_at: string;
  };

/* ------------------------------------------------------------ column lists */

export const LEAD_FACTS_COLUMNS = [
  "source_call_origin", "source_call_table", "source_call_key", "source_call_row_id", "persona_origin", "persona_id",
  "past_call_source", "attribution", "call_transcript_id", "call_transcript_origin", "transcript_pipeline_version",
  "extractor_id", "extractor_version", "extractor_model", "extractor_effort", "source_lead_facts_key", "trade_redacted",
  "business_type_redacted", "renewal_date_redacted", "annual_payroll_redacted", "employee_count",
  "current_carrier_redacted", "language", "objections_redacted", "temperament_redacted", "facts_sha256",
  "content_origin", "redaction_method", "extracted_at",
] as const;

export const BATCH_COLUMNS = [
  "batch_key", "kind", "status", "cancel_requested", "items_requested", "items_found", "items_judged", "items_done",
  "items_blocked", "items_failed", "failures", "config", "harness_commit", "harness_dirty", "started_at", "finished_at",
  "updated_at",
] as const;

export const RUN_COLUMNS = [
  "batch_id", "item_index", "attempt", "repeat_index", "record_id", "record_id_origin", "trace_ref", "first_record_seq",
  "last_record_seq", "lead_id", "lead_id_origin", "lead_facts_id", "content_origin", "direction", "clock_now", "simulator",
  "simulator_model", "simulator_effort", "simulator_max_tokens", "scripted_preferred_time", "scripted_objection_after_turns",
  "scripted_objection_spacing", "turn_cap", "tree_source", "tree_choice_id", "tree_id", "tree_version", "tree_file_sha256",
  "decision_module_id", "decision_model_kind", "orchestrator_id", "voice_path_id", "voice_module_id", "dialogue_model",
  "prompt_setup_id", "decision_router_id", "decision_model", "judge_enabled", "judge_model", "persona_file_sha256", "seed",
  "model_settings", "status", "blocked_reason", "failure_code", "ended_by", "lead_turns", "caller_lines",
  "renewal_date_confirmed", "payroll_captured", "employee_count_captured", "booked", "enforcement", "enforcement_passed",
  "judge_verdicts", "judge_score", "started_at", "ended_at", "agent_reply_latency_ms_median", "agent_reply_latency_ms_max",
  "input_tokens", "output_tokens", "cost_in_dollars", "updated_at",
] as const;

export const TURN_COLUMNS = [
  "run_id", "content_origin", "line_index", "turn_index", "role", "spoken", "said_at", "record_seq",
  "agent_reply_latency_ms", "text_redacted", "redaction_method",
] as const;

export const TURN_EVAL_COLUMNS = [
  "batch_id", "source_call_origin", "source_call_table", "source_call_key", "source_call_row_id", "past_call_source",
  "attribution", "call_transcript_id", "call_transcript_origin", "transcript_pipeline_version", "turn_index",
  "call_had_clean_turns", "agent_id", "agent_model", "agent_effort", "agent_system_prompt_sha256",
  "agent_system_prompt_is_placeholder", "judge_id", "judge_model", "judge_effort", "judge_rubric_sha256",
  "pick_agent_first", "pick_producer_first", "content_origin", "agent_reply_redacted", "producer_reply_redacted",
  "redaction_method", "judged_at",
] as const;

/* ------------------------------------------------------- errors and checks */

/** A refusal or failure of the writer. The message is a fixed code and never carries row data. */
export class SimWriteError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SimWriteError";
  }
}

const FIXTURE_KEY = /^fixture:[a-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIALER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUO_KEY = /^[A-Za-z0-9_-]{1,128}$/;
/** The same pattern as the batch_key check in 004_simulation.sql; also checked before any batch-key SQL. */
export const BATCH_KEY = /^(whole-call|turns)-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;
/** The fixed-code pattern of the identifier columns in 004_simulation.sql. */
export const FIXED_CODE = /^[A-Za-z0-9:._/-]{1,120}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PERSONA_ID = /^[a-z0-9-]{1,72}$/;
const PERSONA_KEY_PREFIX = "fixture:persona-";
const FACTS_FILE_VERSION = SHA256;
const LEAD_RECORD_VERSION = /^[0-9a-f]{40}(-dirty)?:[A-Za-z0-9._-]+$/;
const MODEL_EXTRACTOR_VERSION = /^[0-9a-f]{40}(-dirty)?:[A-Za-z0-9:._/-]+:(low|medium|high|xhigh|max)$/;
const SOURCE_LEAD_FACTS_KEY = /^[A-Za-z0-9_.-]{1,40}:(source_primary|source_secondary):[A-Za-z0-9_-]{1,128}$/;
const ORCHESTRATORS: readonly string[] = ["direct", "pipecat"];
const DECISION_ROUTERS: readonly string[] = DECISION_ROUTER_IDS;
const PERSONA_ORIGINS: readonly string[] = ["synthetic_persona", "real_call", "fixture"];
const VOICE_HARNESS_REFS: readonly string[] = ["source_primary", "source_secondary"];

function unknownKeys(row: object, allowed: readonly string[]): string | undefined {
  const set = new Set<string>(allowed);
  return Object.keys(row).find((k) => !set.has(k));
}

/** Throws when the row has a key that is not a column of its table. */
export function assertColumns(row: object, allowed: readonly string[]): void {
  if (unknownKeys(row, allowed) !== undefined) throw new SimWriteError("sim_row_has_unknown_column");
}

function hasText(values: ReadonlyArray<unknown>): boolean {
  return values.some((v) => (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0));
}

/**
 * The content rule. `textValues` are the row's text columns. The content origin
 * must be stated; a redaction method, when given, must be a known one; and text
 * on a real-call row needs a known method (a missing one is refused as unknown).
 *
 * PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
 * "not_redacted" is a known method, so nothing blocks a real-call row on redaction.
 */
export function assertContentRule(row: { content_origin?: unknown; redaction_method?: unknown }, textValues: ReadonlyArray<unknown>): void {
  if (row.content_origin !== "real_call" && row.content_origin !== "synthetic_fixture") throw new SimWriteError("sim_content_origin_unstated");
  const method = row.redaction_method;
  const given = method !== undefined && method !== null;
  if (given && !(REDACTION_METHODS as readonly unknown[]).includes(method)) throw new SimWriteError("sim_redaction_method_unknown");
  if (row.content_origin === "real_call" && hasText(textValues) && !given) throw new SimWriteError("sim_redaction_method_unknown");
}

export function assertSyntheticSource(row: { source_call_origin?: unknown; source_call_table?: unknown; source_call_key?: unknown }): void {
  if (
    row.source_call_origin !== "synthetic_fixture" ||
    row.source_call_table !== "fixture" ||
    typeof row.source_call_key !== "string" ||
    !FIXTURE_KEY.test(row.source_call_key)
  ) {
    throw new SimWriteError("sim_source_not_synthetic");
  }
}

/** A real call: a CRM project, table dialer or quo, and a key of that table's shape. */
export function assertRealSource(row: { source_call_origin?: unknown; source_call_table?: unknown; source_call_key?: unknown }): void {
  const key = row.source_call_key;
  const keyFits =
    typeof key === "string" && (row.source_call_table === "dialer" ? DIALER_KEY.test(key) : row.source_call_table === "quo" ? QUO_KEY.test(key) : false);
  if (!VOICE_HARNESS_REFS.includes(String(row.source_call_origin)) || !keyFits) throw new SimWriteError("sim_source_not_real_call");
}

/** The source must agree with the content origin: made-up content has a fixture source, real content a real one. */
function assertSourceMatchesContent(row: { content_origin?: unknown; source_call_origin?: unknown; source_call_table?: unknown; source_call_key?: unknown }): void {
  if (row.content_origin === "real_call") assertRealSource(row);
  else assertSyntheticSource(row);
}

export function assertTurnCap(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new SimWriteError("sim_bad_turn_cap");
  if (value > MAX_TURN_CAP) throw new SimWriteError("sim_turn_cap_above_25");
}

/** Persona origin ties to the content and source columns; see the PERSONAS section of 004_simulation.sql. */
export function assertPersonaTies(row: Pick<SimLeadFactsRow, "persona_origin" | "persona_id" | "content_origin" | "source_call_key" | "extractor_id">): void {
  const origin: unknown = row.persona_origin;
  if (typeof origin !== "string" || !PERSONA_ORIGINS.includes(origin)) throw new SimWriteError("sim_persona_origin_unstated");
  const id = row.persona_id;
  if ((origin === "real_call") !== (row.content_origin === "real_call")) throw new SimWriteError("sim_persona_ties");
  if ((origin === "synthetic_persona") !== (id !== null && id !== undefined)) throw new SimWriteError("sim_persona_ties");
  if (origin === "synthetic_persona" && (typeof id !== "string" || !PERSONA_ID.test(id) || row.source_call_key !== `${PERSONA_KEY_PREFIX}${id}`)) {
    throw new SimWriteError("sim_persona_ties");
  }
  if (origin === "fixture" && row.source_call_key.startsWith(PERSONA_KEY_PREFIX)) throw new SimWriteError("sim_persona_ties");
  // A persona lead is never built from a CRM lead record: that load is real-call content only.
  if (row.extractor_id === "lead-record" && origin !== "real_call") throw new SimWriteError("sim_persona_ties");
}

export function assertExtractorShape(row: Pick<SimLeadFactsRow, "extractor_id" | "extractor_version" | "extractor_model" | "extractor_effort" | "source_lead_facts_key">): void {
  if (typeof row.extractor_id !== "string" || !FIXED_CODE.test(row.extractor_id)) throw new SimWriteError("sim_bad_extractor");
  const modelFree = row.extractor_model === null && row.extractor_effort === null;
  const version = String(row.extractor_version);
  let fits: boolean;
  if (row.extractor_id === "facts-file") fits = modelFree && FACTS_FILE_VERSION.test(version);
  else if (row.extractor_id === "lead-record") fits = modelFree && LEAD_RECORD_VERSION.test(version);
  else fits = typeof row.extractor_model === "string" && row.extractor_effort !== null && MODEL_EXTRACTOR_VERSION.test(version);
  if (!fits) throw new SimWriteError("sim_bad_extractor");
  const keyGiven = row.source_lead_facts_key !== null && row.source_lead_facts_key !== undefined;
  if (keyGiven !== (row.extractor_id === "lead-record")) throw new SimWriteError("sim_bad_extractor");
  if (keyGiven && !SOURCE_LEAD_FACTS_KEY.test(String(row.source_lead_facts_key))) throw new SimWriteError("sim_bad_extractor");
}

export function validateLeadFactsRow(row: SimLeadFactsRow): void {
  assertColumns(row, LEAD_FACTS_COLUMNS);
  assertContentRule(row, [
    row.trade_redacted, row.business_type_redacted, row.renewal_date_redacted, row.annual_payroll_redacted,
    row.current_carrier_redacted, row.temperament_redacted, row.objections_redacted,
  ]);
  assertSourceMatchesContent(row);
  assertPastCallKnown(row);
  assertPersonaTies(row);
  assertExtractorShape(row);
}

/** Facts of a real call say which past call table and track labelling they came from (the database check sim_lead_facts_past_call_known). */
export function assertPastCallKnown(row: { source_call_table?: unknown; past_call_source?: unknown; attribution?: unknown }): void {
  if (row.source_call_table === "fixture") return;
  const unknown = (v: unknown) => v === null || v === undefined;
  if (unknown(row.past_call_source) || unknown(row.attribution)) throw new SimWriteError("sim_past_call_unknown");
}

/**
 * Whether a call id can become the source reference of a row of this content origin, checked without any database:
 * a real call needs a dialer identifier or a Quo key, a synthetic fixture must not look like a real call.
 * Throws sim_source_not_real_call or sim_source_not_synthetic.
 */
export function assertCallIdWritable(callId: string, contentOrigin: ContentOrigin): void {
  if (typeof callId !== "string") throw new SimWriteError(contentOrigin === "real_call" ? "sim_source_not_real_call" : "sim_source_not_synthetic");
  if (contentOrigin === "synthetic_fixture") {
    fixtureSourceRef(callId);
    return;
  }
  assertRealSource(realSourceRef(callId, "source_secondary", null));
}

export function validateBatchRow(row: SimBatchRow): void {
  assertColumns(row, BATCH_COLUMNS);
  if (!BATCH_KEY.test(row.batch_key) || (row.kind === "whole_call") !== row.batch_key.startsWith("whole-call-")) {
    throw new SimWriteError("sim_bad_batch_key");
  }
  if (row.kind === "whole_call") assertTurnCap(row.config.maxTurns);
  for (const count of [row.items_done, row.items_blocked, row.items_failed]) {
    if (!Number.isInteger(count) || count < 0) throw new SimWriteError("sim_bad_item_count");
  }
}

function assertOptional(code: string, value: unknown, fits: (v: unknown) => boolean): void {
  if (value !== null && value !== undefined && !fits(value)) throw new SimWriteError(code);
}
const isFixedCode = (v: unknown) => typeof v === "string" && FIXED_CODE.test(v);
const isIntegerOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v));
const isNumberOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

/** model_settings: keyed only by role, each value holding only deployment, temperature, max_output_tokens and seed, with their types. */
export function assertModelSettings(value: unknown): void {
  const bad = () => new SimWriteError("sim_bad_model_settings");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw bad();
  for (const [role, setting] of Object.entries(value)) {
    if (!(MODEL_SETTINGS_ROLES as readonly string[]).includes(role)) throw bad();
    if (setting === null || typeof setting !== "object" || Array.isArray(setting)) throw bad();
    for (const [key, v] of Object.entries(setting)) {
      if (v === undefined) continue;
      if (key === "deployment" ? !isFixedCode(v) : key === "temperature" ? !isNumberOrNull(v) : key === "max_output_tokens" || key === "seed" ? !isIntegerOrNull(v) : true) {
        throw bad();
      }
    }
  }
}

/** The setup columns of a run: shapes only, before any SQL. Absent values are null. */
export function assertRunSetup(row: Partial<SimRunRow>): void {
  const checks: Array<[string, unknown, (v: unknown) => boolean]> = [
    ["sim_bad_orchestrator_id", row.orchestrator_id, (v) => ORCHESTRATORS.includes(String(v))],
    ["sim_bad_voice_path_id", row.voice_path_id, isFixedCode],
    ["sim_bad_voice_module_id", row.voice_module_id, isFixedCode],
    ["sim_bad_dialogue_model", row.dialogue_model, isFixedCode],
    ["sim_bad_prompt_setup_id", row.prompt_setup_id, isFixedCode],
    ["sim_bad_decision_router_id", row.decision_router_id, (v) => DECISION_ROUTERS.includes(String(v))],
    ["sim_bad_decision_model", row.decision_model, isFixedCode],
    ["sim_bad_judge_enabled", row.judge_enabled, (v) => typeof v === "boolean"],
    ["sim_bad_judge_model", row.judge_model, isFixedCode],
    ["sim_bad_persona_file_sha256", row.persona_file_sha256, (v) => typeof v === "string" && SHA256.test(v)],
    ["sim_bad_tree_file_sha256", row.tree_file_sha256, (v) => typeof v === "string" && SHA256.test(v)],
    ["sim_bad_seed", row.seed, isFixedCode],
  ];
  for (const [code, value, fits] of checks) assertOptional(code, value, fits);
  if (row.model_settings !== undefined) assertModelSettings(row.model_settings);
  if (row.repeat_index !== undefined && (!Number.isInteger(row.repeat_index) || row.repeat_index < 0)) throw new SimWriteError("sim_bad_repeat_index");
  if (row.simulator !== undefined && row.simulator !== "model" && row.simulator !== "scripted") throw new SimWriteError("sim_bad_simulator");
  if (row.tree_source === "tree_file" && (row.tree_file_sha256 === null || row.tree_file_sha256 === undefined)) throw new SimWriteError("sim_bad_tree_file_sha256");
}

export function validateRunRow(row: Omit<SimRunRow, "batch_id" | "lead_facts_id"> & Partial<Pick<SimRunRow, "batch_id" | "lead_facts_id">>): void {
  assertColumns(row, RUN_COLUMNS);
  assertContentRule(row, []);
  // A made-up run plays a lead id minted by the harness or the fixture; a real-call run may name any origin.
  if (row.content_origin === "synthetic_fixture" && row.lead_id_origin !== "synthetic_fixture") throw new SimWriteError("sim_source_not_synthetic");
  assertTurnCap(row.turn_cap);
  if (row.lead_turns > row.turn_cap) throw new SimWriteError("sim_lead_turns_above_cap");
  assertRunSetup(row);
}

export function validateTurnRow(row: Omit<SimTurnRow, "run_id"> & Partial<Pick<SimTurnRow, "run_id">>): void {
  assertColumns(row, TURN_COLUMNS);
  assertContentRule(row, [row.text_redacted]);
}

export function validateTurnEvalRow(row: Omit<SimTurnEvalRow, "batch_id"> & Partial<Pick<SimTurnEvalRow, "batch_id">>): void {
  assertColumns(row, TURN_EVAL_COLUMNS);
  assertContentRule(row, [row.agent_reply_redacted, row.producer_reply_redacted]);
  assertSourceMatchesContent(row);
}

/* ---------------------------------------------------------------- hashing */

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with object keys sorted at every level, so equal facts always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/* ------------------------------------------------------------ git version */

export type GitRunner = (args: string[]) => string;

export interface HarnessVersion {
  harness_commit: string;
  harness_dirty: boolean;
}

/** The commit the harness runs from and whether the working tree differs from it. */
export function harnessVersion(git: GitRunner): HarnessVersion {
  let commit: string;
  let porcelain: string;
  try {
    commit = git(["rev-parse", "HEAD"]).trim();
    porcelain = git(["status", "--porcelain"]);
  } catch {
    throw new SimWriteError("sim_git_unavailable");
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new SimWriteError("sim_git_unavailable");
  return { harness_commit: commit, harness_dirty: porcelain.trim() !== "" };
}

/* ------------------------------------------------------------ lead facts */

const SLUG = /[^a-z0-9_-]+/g;

/**
 * The fixture reference for a synthetic fact. The operator has stated the
 * origin; a key that looks like a real call (a long hexadecimal identifier or a "quo:" id) is still
 * refused, so a real call can never be labelled synthetic by a flag alone.
 */
export function fixtureSourceRef(sourceCallId: string): Extract<SourceCallRef, { source_call_table: "fixture" }> {
  const raw = sourceCallId.trim();
  if (UUID.test(raw) || raw.toLowerCase().startsWith("quo:")) throw new SimWriteError("sim_source_not_synthetic");
  const bare = raw.startsWith("fixture:") ? raw.slice("fixture:".length) : raw;
  const slug = bare.toLowerCase().replace(SLUG, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!slug) throw new SimWriteError("sim_source_not_synthetic");
  // The persona-<id> form belongs to synthetic personas (personaSourceRef); a plain fixture never uses it.
  if (`fixture:${slug}`.startsWith(PERSONA_KEY_PREFIX)) throw new SimWriteError("sim_persona_ties");
  return { source_call_origin: "synthetic_fixture", source_call_table: "fixture", source_call_key: `fixture:${slug}`, source_call_row_id: null };
}

/** The fixture reference of a synthetic persona: "fixture:persona-<id>", id made of lowercase letters, digits and hyphens. */
export function personaSourceRef(personaId: string): Extract<SourceCallRef, { source_call_table: "fixture" }> {
  if (!PERSONA_ID.test(personaId)) throw new SimWriteError("sim_persona_ties");
  return { source_call_origin: "synthetic_fixture", source_call_table: "fixture", source_call_key: `${PERSONA_KEY_PREFIX}${personaId}`, source_call_row_id: null };
}

/** The reference of a real call, from the operator-stated CRM project. */
export function realSourceRef(callId: string, origin: SourceProjectRef, rowId: string | null): SourceCallRef {
  if (callId.startsWith("quo:")) {
    return { source_call_origin: origin, source_call_table: "quo", source_call_key: callId.slice("quo:".length), source_call_row_id: rowId };
  }
  return { source_call_origin: origin, source_call_table: "dialer", source_call_key: callId, source_call_row_id: rowId };
}

export interface ExtractorInfo {
  /** FactExtractor.id, "facts-file", or "lead-record". */
  id: string;
  /** "<commit>[-dirty]:<model>:<effort>", the sha256 of the facts file, or "<commit>[-dirty]:<loader name>" for lead-record. */
  version: string;
  model: string | null;
  effort: Effort | null;
  /** Required for "lead-record" and only then: "<source>:<call project reference>:<call id>". */
  sourceLeadFactsKey?: string;
}

/** A model-free load from a CRM structured lead record: no model, no effort. */
export function leadRecordExtractor(v: HarnessVersion, loaderName: string, sourceLeadFactsKey: string): ExtractorInfo {
  return { id: "lead-record", version: `${v.harness_commit}${v.harness_dirty ? "-dirty" : ""}:${loaderName}`, model: null, effort: null, sourceLeadFactsKey };
}

export function factsFileExtractor(fileSha256: string): ExtractorInfo {
  return { id: "facts-file", version: fileSha256, model: null, effort: null };
}

export function modelExtractorVersion(v: HarnessVersion, model: string, effort: Effort): string {
  return `${v.harness_commit}${v.harness_dirty ? "-dirty" : ""}:${model}:${effort}`;
}

/** The fact columns exactly as stored, in the form that is hashed. */
function storedFacts(facts: LeadFacts) {
  return {
    trade_redacted: facts.trade ?? null,
    business_type_redacted: facts.businessType ?? null,
    renewal_date_redacted: facts.renewalDate ?? null,
    annual_payroll_redacted: facts.annualPayroll ?? null,
    employee_count: facts.employeeCount ?? null,
    current_carrier_redacted: facts.currentCarrier ?? null,
    language: facts.language ?? null,
    objections_redacted: [...facts.objections],
    temperament_redacted: facts.temperament ?? null,
  };
}

export function factsSha256(facts: LeadFacts): string {
  return sha256Hex(canonicalJson(storedFacts(facts)));
}

export interface LeadFactsRowInput {
  facts: LeadFacts;
  /** What the operator stated about the facts. Never guessed. */
  contentOrigin: ContentOrigin;
  extractor: ExtractorInfo;
  extractedAt: Date;
  /** Required unless the content is a synthetic fixture. */
  realSource?: { origin: SourceProjectRef; rowId: string | null; pastCall?: Pick<PastCall, "source" | "attribution"> };
  /** Default: "real_call" for real-call content, "fixture" for a synthetic fixture. */
  personaOrigin?: PersonaOrigin;
  /** Required for "synthetic_persona" (the source call reference becomes fixture:persona-<id>), refused otherwise. */
  personaId?: string;
  /**
   * What was done to the text. Default: "not_redacted" for a real-call row that has text, null otherwise (a synthetic
   * row stores made-up text as said). Pass "harness_redact_text_v1" when the pattern redaction ran.
   */
  redactionMethod?: RedactionMethod | null;
}

function textOf(stored: ReturnType<typeof storedFacts>): boolean {
  return hasText([stored.trade_redacted, stored.business_type_redacted, stored.renewal_date_redacted, stored.annual_payroll_redacted,
    stored.current_carrier_redacted, stored.temperament_redacted, stored.objections_redacted]);
}

export function leadFactsRow(input: LeadFactsRowInput): SimLeadFactsRow {
  const { facts, extractor } = input;
  const stored = storedFacts(facts);
  let source: SourceCallRef;
  let pastCallSource: PastCall["source"] | null = null;
  let attribution: PastCall["attribution"] | null = null;
  const personaOrigin: PersonaOrigin = input.personaOrigin ?? (input.contentOrigin === "real_call" ? "real_call" : "fixture");
  if ((personaOrigin === "synthetic_persona") !== (input.personaId !== undefined)) throw new SimWriteError("sim_persona_ties");
  if (input.contentOrigin === "synthetic_fixture") {
    source = personaOrigin === "synthetic_persona" ? personaSourceRef(input.personaId!) : fixtureSourceRef(facts.sourceCallId);
  } else {
    if (!input.realSource) throw new SimWriteError("sim_source_not_synthetic");
    source = realSourceRef(facts.sourceCallId, input.realSource.origin, input.realSource.rowId);
    pastCallSource = input.realSource.pastCall?.source ?? null;
    attribution = input.realSource.pastCall?.attribution ?? null;
  }
  return {
    ...source,
    call_transcript_id: null,
    call_transcript_origin: null,
    transcript_pipeline_version: null,
    past_call_source: pastCallSource,
    attribution,
    extractor_id: extractor.id,
    extractor_version: extractor.version,
    extractor_model: extractor.model,
    extractor_effort: extractor.effort,
    source_lead_facts_key: extractor.sourceLeadFactsKey ?? null,
    persona_origin: personaOrigin,
    persona_id: input.personaId ?? null,
    ...stored,
    facts_sha256: factsSha256(facts),
    content_origin: input.contentOrigin,
    redaction_method: input.redactionMethod !== undefined ? input.redactionMethod : input.contentOrigin === "real_call" && textOf(stored) ? "not_redacted" : null,
    extracted_at: input.extractedAt.toISOString(),
  };
}

/* ---------------------------------------------------------------- batches */

export interface BatchFinish {
  batchKey: string;
  harness: HarnessVersion;
  startedAt: Date;
  finishedAt: Date | null;
  status: SimBatchRow["status"];
  itemsRequested: number | null;
  itemsFound: number | null;
  itemsBlocked: number;
  itemsFailed: number;
  failures?: SimBatchFailure[];
}

/** items_done counts every finished item: completed plus blocked plus failed. */
export function itemsDone(completed: number, blocked: number, failed: number): number {
  return completed + blocked + failed;
}

function batchCommon(i: BatchFinish, itemsCompleted: number): SimBatchCommon {
  return {
    batch_key: i.batchKey,
    status: i.status,
    // The database requires the flag for a cancelled batch (sim_batch_cancelled_was_requested).
    cancel_requested: i.status === "cancelled",
    items_requested: i.itemsRequested,
    items_found: i.itemsFound,
    items_done: itemsDone(itemsCompleted, i.itemsBlocked, i.itemsFailed),
    items_blocked: i.itemsBlocked,
    items_failed: i.itemsFailed,
    failures: i.failures ?? [],
    harness_commit: i.harness.harness_commit,
    harness_dirty: i.harness.harness_dirty,
    started_at: i.startedAt.toISOString(),
    finished_at: i.finishedAt ? i.finishedAt.toISOString() : null,
    updated_at: (i.finishedAt ?? i.startedAt).toISOString(),
  };
}

export function wholeCallBatchRow(i: BatchFinish & { config: WholeCallBatchConfig; itemsCompleted: number }): SimBatchRow {
  return { ...batchCommon(i, i.itemsCompleted), kind: "whole_call", config: i.config, items_judged: null };
}

export function turnEvalBatchRow(i: BatchFinish & { config: TurnEvalBatchConfig; itemsJudged: number | null }): SimBatchRow {
  // A turn-judging item is a call: judged calls are the completed ones (see turnEvalCallCounts).
  return { ...batchCommon(i, i.itemsJudged ?? 0), kind: "turn_eval", config: i.config, items_judged: i.itemsJudged };
}

/** A code made of lower-case letters, digits, underscores and colons; anything else becomes the fallback. */
export function fixedCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z][a-z0-9_:]{0,79}$/.test(value) ? value : fallback;
}

/* ------------------------------------------------------------------- runs */

export type SimulatorInfo =
  | { kind: "model"; model: string; effort?: Effort | null; maxTokens?: number | null }
  | { kind: "scripted"; preferredTime: string; objectionAfterTurns: number; objectionSpacing: number };

export type TreeInfo =
  | { source: "tree_file"; id: string; version: string; fileSha256: string }
  | { source: "active"; id: string; version: string; choiceId: string; fileSha256?: string };

/**
 * The agent setup that ran, passed in by the caller (the whole-call script builds no snapshot today).
 * Every field is optional; an absent one is stored as null (model_settings as {}).
 */
export interface RunSetup {
  orchestratorId?: OrchestratorId;
  /** For example azure_gpt_live, deepgram. */
  voicePathId?: string;
  /** For example azure-gpt-live. */
  voiceModuleId?: string;
  /** The Azure deployment that spoke as the agent. */
  dialogueModel?: string;
  promptSetupId?: string;
  decisionRouterId?: DecisionRouterChoice;
  /** The Azure deployment or module id that chose tree moves. */
  decisionModel?: string;
  judgeEnabled?: boolean;
  judgeModel?: string;
  personaFileSha256?: string;
  modelSettings?: ModelSettings;
  seed?: string;
}

export interface RunRowInput {
  itemIndex: number;
  attempt?: number;
  /** 0 for the first run of the same lead facts in a batch; a repeat has the next number. */
  repeatIndex?: number;
  setup?: RunSetup;
  leadId: string;
  /** Where the lead id was minted; "synthetic_fixture" for whole-call-lead-N. */
  leadIdOrigin: IdOrigin;
  contentOrigin: ContentOrigin;
  direction: "inbound" | "outbound";
  turnCap: number;
  clockNow: Date;
  simulator: SimulatorInfo;
  tree: TreeInfo;
  run: WholeCallRun;
  grade?: WholeCallGrade;
  /** A thrown error's code, when the call failed. */
  failureCode?: string;
  updatedAt: Date;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

interface FinalLine {
  role: string;
  turnIndex: number;
  atMs: number;
  recordSeq: number;
}

function finalLines(events: TraceEvent[]): FinalLine[] {
  return events
    .filter((e) => e.type === "transcript_final")
    .map((e) => ({ role: String(e.data.role), turnIndex: Number(e.data.turnIndex), atMs: e.atMs, recordSeq: e.recordSeq }));
}

/** Gaps from a caller line to the next agent line, in milliseconds, keyed by the agent line's turn index. */
function replyLatencies(events: TraceEvent[]): Map<number, number> {
  const out = new Map<number, number>();
  let callerAt: number | null = null;
  for (const line of finalLines(events)) {
    if (line.role === "caller") callerAt = line.atMs;
    else if (line.role === "agent" && callerAt !== null) {
      out.set(line.turnIndex, Math.max(0, Math.round(line.atMs - callerAt)));
      callerAt = null;
    }
  }
  return out;
}

export function simRunRow(input: RunRowInput): Omit<SimRunRow, "batch_id" | "lead_facts_id"> {
  const { run, grade, simulator, tree } = input;
  const setup = input.setup ?? {};
  const events = run.events;
  const latencies = [...replyLatencies(events).values()];
  const status: SimRunRow["status"] = input.failureCode !== undefined ? "failed" : run.status === "blocked" ? "blocked" : "completed";
  const outcome = status === "completed" ? grade?.outcome : undefined;
  const verdicts = events
    .filter((e) => e.type === "judge_verdict")
    .map((e) => ({
      action: String(e.data.action),
      allowed: e.data.allowed as boolean | undefined,
      reason: e.data.reason as string | undefined,
      scores: e.data.scores as JudgeVerdict["scores"] | undefined,
      recordSeq: e.recordSeq,
    }));
  const judge = run.record?.judge;
  return {
    item_index: input.itemIndex,
    attempt: input.attempt ?? 1,
    repeat_index: input.repeatIndex ?? 0,
    record_id: run.recordId,
    record_id_origin: "harness_process",
    trace_ref: `${run.recordId}.jsonl`,
    first_record_seq: events.length > 0 ? events[0]!.recordSeq : null,
    last_record_seq: events.length > 0 ? events[events.length - 1]!.recordSeq : null,
    lead_id: input.leadId,
    lead_id_origin: input.leadIdOrigin,
    content_origin: input.contentOrigin,
    direction: input.direction,
    clock_now: input.clockNow.toISOString(),
    simulator: simulator.kind,
    simulator_model: simulator.kind === "model" ? simulator.model : null,
    simulator_effort: simulator.kind === "model" ? simulator.effort ?? null : null,
    simulator_max_tokens: simulator.kind === "model" ? simulator.maxTokens ?? null : null,
    scripted_preferred_time: simulator.kind === "scripted" ? simulator.preferredTime : null,
    scripted_objection_after_turns: simulator.kind === "scripted" ? simulator.objectionAfterTurns : null,
    scripted_objection_spacing: simulator.kind === "scripted" ? simulator.objectionSpacing : null,
    turn_cap: input.turnCap,
    tree_source: tree.source,
    tree_choice_id: tree.source === "active" ? tree.choiceId : null,
    tree_id: tree.id,
    tree_version: tree.version,
    tree_file_sha256: tree.fileSha256 ?? null,
    decision_module_id: null,
    decision_model_kind: null,
    orchestrator_id: setup.orchestratorId ?? null,
    voice_path_id: setup.voicePathId ?? null,
    voice_module_id: setup.voiceModuleId ?? null,
    dialogue_model: setup.dialogueModel ?? null,
    prompt_setup_id: setup.promptSetupId ?? null,
    decision_router_id: setup.decisionRouterId ?? null,
    decision_model: setup.decisionModel ?? null,
    judge_enabled: setup.judgeEnabled ?? null,
    judge_model: setup.judgeModel ?? null,
    persona_file_sha256: setup.personaFileSha256 ?? null,
    seed: setup.seed ?? null,
    model_settings: setup.modelSettings ?? {},
    status,
    blocked_reason: status === "blocked" ? fixedCode(run.blockedReason, "blocked") : null,
    failure_code: status === "failed" ? fixedCode(input.failureCode, "run_failed") : null,
    ended_by: status === "completed" ? run.endedBy ?? null : null,
    lead_turns: run.leadTurns,
    caller_lines: status === "completed" && grade ? grade.turns : null,
    renewal_date_confirmed: outcome ? outcome.renewalDateConfirmed : null,
    payroll_captured: outcome ? outcome.payrollCaptured : null,
    employee_count_captured: outcome ? outcome.employeeCountCaptured : null,
    booked: outcome ? outcome.booked : null,
    enforcement: status === "completed" && grade ? grade.enforcement.map((r) => ({ rule: r.rule, passed: r.passed, note: r.note })) : [],
    enforcement_passed: status === "completed" && grade ? grade.enforcementPassed : null,
    judge_verdicts: verdicts,
    judge_score: judge ? { judgedAt: judge.judgedAt, score: judge.score, criteria: judge.criteria } : null,
    started_at: events.length > 0 ? events[0]!.at : null,
    ended_at: events.length > 0 ? events[events.length - 1]!.at : null,
    agent_reply_latency_ms_median: median(latencies),
    agent_reply_latency_ms_max: latencies.length > 0 ? Math.max(...latencies) : null,
    input_tokens: null,
    output_tokens: null,
    cost_in_dollars: null,
    updated_at: input.updatedAt.toISOString(),
  };
}

/**
 * The transcript lines of a run, by position. The lines are made up by the agent and the simulated lead and are stored
 * as said. Their redaction_method is null on a made-up run; on a real-call run it is "not_redacted" unless the caller
 * names another (no redaction ran on these lines).
 */
export function simTurnRows(run: WholeCallRun, contentOrigin: ContentOrigin, redactionMethod?: RedactionMethod | null): Array<Omit<SimTurnRow, "run_id">> {
  const method = redactionMethod !== undefined ? redactionMethod : contentOrigin === "real_call" ? "not_redacted" : null;
  const finals = finalLines(run.events);
  const latencies = replyLatencies(run.events);
  const used = new Set<string>();
  return run.transcript.map((line, index) => {
    const key = `${line.role}:${line.turnIndex}`;
    const match = used.has(key) ? undefined : finals.find((f) => f.role === line.role && f.turnIndex === line.turnIndex);
    if (match) used.add(key);
    return {
      content_origin: contentOrigin,
      line_index: index,
      turn_index: line.turnIndex,
      role: line.role,
      spoken: line.spoken,
      said_at: new Date(line.at).toISOString(),
      record_seq: match ? match.recordSeq : null,
      agent_reply_latency_ms: match && line.role === "agent" ? latencies.get(line.turnIndex) ?? null : null,
      text_redacted: line.text,
      redaction_method: line.text === "" ? null : method,
    };
  });
}

/* ------------------------------------------------------------ turn evals */

export interface TurnEvalAgentInfo {
  id: string;
  model: string | null;
  effort: Effort | null;
  systemPromptSha256: string;
  systemPromptIsPlaceholder: boolean;
}

export interface TurnEvalJudgeInfo {
  id: string;
  model: string | null;
  effort: Effort | null;
  rubricSha256: string;
}

export interface TurnEvalRowInput {
  judgement: TurnJudgement;
  pastCall: Pick<PastCall, "source" | "attribution" | "cleanTurns" | "sourceRowId"> | undefined;
  /** What the operator states about the source of the calls. Turn judging reads real calls only. */
  contentOrigin: ContentOrigin;
  sourceOrigin: SourceProjectRef | "synthetic_fixture";
  agent: TurnEvalAgentInfo;
  judge: TurnEvalJudgeInfo;
  judgedAt: Date;
  /**
   * The two replies as they are to be stored, with the method that produced them (the pattern redaction,
   * "harness_redact_text_v1", does not mask personal names). Omitted: no reply text is stored.
   * PROTOTYPE SAFETY SHORTCUT (Pat 2026-10-20): real call text allowed without name masking.
   */
  replyText?: { agentReply: string; producerReply: string; redactionMethod: RedactionMethod };
}

/** One judgement as a row. Reply text is stored only when the caller passes replyText. */
export function turnEvalRow(i: TurnEvalRowInput): Omit<SimTurnEvalRow, "batch_id"> {
  const j = i.judgement;
  const source: SourceCallRef =
    i.sourceOrigin === "synthetic_fixture" ? fixtureSourceRef(j.callId) : realSourceRef(j.callId, i.sourceOrigin, i.pastCall?.sourceRowId ?? null);
  return {
    ...source,
    call_transcript_id: null,
    call_transcript_origin: null,
    transcript_pipeline_version: null,
    past_call_source: i.pastCall?.source ?? (j.callId.startsWith("quo:") ? "quo" : "dialer"),
    attribution: i.pastCall?.attribution ?? "unverified",
    turn_index: j.turnIndex,
    call_had_clean_turns: i.pastCall?.cleanTurns !== undefined,
    agent_id: i.agent.id,
    agent_model: i.agent.model,
    agent_effort: i.agent.effort,
    agent_system_prompt_sha256: i.agent.systemPromptSha256,
    agent_system_prompt_is_placeholder: i.agent.systemPromptIsPlaceholder,
    judge_id: i.judge.id,
    judge_model: i.judge.model,
    judge_effort: i.judge.effort,
    judge_rubric_sha256: i.judge.rubricSha256,
    pick_agent_first: j.picks[0],
    pick_producer_first: j.picks[1],
    content_origin: i.contentOrigin,
    agent_reply_redacted: i.replyText?.agentReply ?? null,
    producer_reply_redacted: i.replyText?.producerReply ?? null,
    redaction_method: i.replyText?.redactionMethod ?? null,
    judged_at: i.judgedAt.toISOString(),
  };
}

/**
 * The call-level counts of a turn-judging batch. An item is a call, never a turn: a call is judged when at least one of
 * its turns has a judgement, and failed when it has failures and no judgement (a call whose turns all failed, or that
 * could not be read). A call with some judged and some failed turns counts once, as judged; its failed turns stay
 * listed in the failures column. So judged plus failed never exceeds the calls asked for.
 */
export function turnEvalCallCounts(result: Pick<TurnJudgingResult, "judgements" | "failures">): { judged: number; failed: number } {
  const judged = new Set(result.judgements.map((j) => j.callId));
  const failedOnly = new Set(result.failures.map((f) => f.callId).filter((id) => !judged.has(id)));
  return { judged: judged.size, failed: failedOnly.size };
}

/** The failures of a turn-judging run as batch failures: codes and call references only. */
export function turnEvalFailures(result: Pick<TurnJudgingResult, "failures">, sourceOrigin: SourceProjectRef | "synthetic_fixture"): SimBatchFailure[] {
  return result.failures.map((f) => {
    let ref: Partial<SimBatchFailure> = {};
    try {
      const s = sourceOrigin === "synthetic_fixture" ? fixtureSourceRef(f.callId) : realSourceRef(f.callId, sourceOrigin, null);
      ref = { source_call_origin: s.source_call_origin, source_call_table: s.source_call_table, source_call_key: s.source_call_key };
    } catch {
      ref = {};
    }
    return { ...ref, turn_index: f.turnIndex, code: fixedCode(f.code, "turn_judge_failed") };
  });
}

/* ------------------------------------------------------- whole batch rows */

export interface WholeCallItemInput {
  /** Already built with leadFactsRow, from what the operator stated about the origin. */
  leadFacts: SimLeadFactsRow;
  run: RunRowInput;
  /** See simTurnRows. */
  turnRedactionMethod?: RedactionMethod | null;
}

export interface WholeCallBatchInput {
  /** itemsBlocked and itemsFailed are ignored: the counts come from the runs themselves. */
  batch: Omit<BatchFinish, "itemsBlocked" | "itemsFailed"> & { config: WholeCallBatchConfig; itemsBlocked?: number; itemsFailed?: number };
  items: WholeCallItemInput[];
}

/** The rows of one whole-call batch, ready for SimWriter.writeWholeCallBatch. Pure: nothing is sent anywhere. */
export function buildWholeCallBatchWrite(input: WholeCallBatchInput): {
  batch: SimBatchRow;
  items: Array<{ leadFacts: SimLeadFactsRow; run: Omit<SimRunRow, "batch_id" | "lead_facts_id">; turns: Array<Omit<SimTurnRow, "run_id">> }>;
} {
  const items = input.items.map((item) => ({
    leadFacts: item.leadFacts,
    run: simRunRow(item.run),
    turns: simTurnRows(item.run.run, item.run.contentOrigin, item.turnRedactionMethod),
  }));
  const count = (status: SimRunRow["status"]) => items.filter((i) => i.run.status === status).length;
  return {
    batch: wholeCallBatchRow({ ...input.batch, itemsCompleted: count("completed"), itemsBlocked: count("blocked"), itemsFailed: count("failed") }),
    items,
  };
}
