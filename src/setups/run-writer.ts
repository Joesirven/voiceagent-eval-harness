/**
 * Writes every test call back to the harness database: transcript, trace,
 * judge verdicts, disposition and outcome, with the full snapshot of the setup
 * the call ran under. One row per call in the table `harness_run`
 * (supabase/harness/002_harness_run.sql), keyed by the harness's record name.
 *
 * Rules this file keeps:
 * - It writes only to `harness_run` through the local run sink.
 * - Only calls to the lead of the applied setup are written; scenario and
 *   mock runs are not. The opt-in Talk switch (VOICE_HARNESS_RUN_WRITEBACK_TALK)
 *   widens that to every call, setup or not, with a snapshot built from the
 *   call's own agent context event (setup name "talk").
 * - A failed write never touches the call. The local record on disk is the
 *   source, and `writeBack(recordId)` writes it again.
 * - Write-back is off by default. The environment or setups page can turn it on.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPromptSetupRegistry } from "../behaviour/prompt/setups.js";
import { getDecisionRegistry } from "../decision/registry.js";
import type { ModuleInfo } from "../modules/base-module.js";
import { getModuleRegistry } from "../modules/registry.js";
import { getActiveLeadStore } from "../store/active-store.js";
import { DATA_DIR_ENV, DEFAULT_DATA_DIR } from "../store/held-stops.js";
import type { DbClient, Row } from "../store/database-client.js";
import { recordStore, traceBus, type HarnessRecord, type TraceEvent } from "../trace/index.js";
import { getActiveSetup, type SetupSnapshot } from "./active-setup.js";
import { HARNESS_RUN_TABLE, RestRunSink, defaultRunSink, type RunSink } from "./run-sink.js";

export const RUN_TABLE = "harness_run";
export const RUN_WRITEBACK_ENV = "VOICE_HARNESS_RUN_WRITEBACK";
export const RUN_WRITEBACK_TALK_ENV = "VOICE_HARNESS_RUN_WRITEBACK_TALK";

const ON_WORDS = ["1", "true", "on", "yes"];

let override: boolean | undefined;
/** Turns write-back on or off for this process; undefined goes back to the environment. */
export function setRunWriteBack(enabled: boolean | undefined): void {
  override = enabled;
}

let talkOverride: boolean | undefined;
/** Turns the Talk switch on or off for this process; undefined goes back to the environment. */
export function setTalkWriteBack(enabled: boolean | undefined): void {
  talkOverride = enabled;
}

/**
 * Off unless asked for. VOICE_HARNESS_RUN_WRITEBACK_TALK=1 (or true, on, yes, any
 * case) writes every Talk call made from the control page, setup or not. It
 * needs write-back itself to be on; it never turns it on.
 */
export function isTalkWriteBackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (talkOverride !== undefined) return talkOverride;
  const value = env[RUN_WRITEBACK_TALK_ENV];
  return value !== undefined && ON_WORDS.includes(value.trim().toLowerCase());
}

/**
 * Off by default. VOICE_HARNESS_RUN_WRITEBACK enables it with an on word.
 */
export function isRunWriteBackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (override !== undefined) return override;
  const value = env[RUN_WRITEBACK_ENV];
  // Set to anything but an on word (as on master, where only 1 meant on), it is off.
  if (value !== undefined) return ON_WORDS.includes(value.trim().toLowerCase());
  return false;
}

/** Where run records go, by name only: no host, user or password, and no file is read. */
export interface RunStoreInfo {
  kind: "local";
  table: string | null;
  writeBack: boolean;
  /** Every Talk call is written, not only calls to the applied setup's lead. */
  talkWriteBack: boolean;
  /** Our own error code when the configuration cannot be used. */
  error?: string;
}

export function describeRunStore(env: Record<string, string | undefined> = process.env): RunStoreInfo {
  const writeBack = isRunWriteBackEnabled(env);
  const talkWriteBack = isTalkWriteBackEnabled(env);
  return { kind: "local", table: HARNESS_RUN_TABLE, writeBack, talkWriteBack };
}

/** One line for the server log. */
export function runStoreLogLine(info: RunStoreInfo = describeRunStore()): string {
  const parts = ["database on this machine", info.table ?? info.error ?? null, `write-back ${info.writeBack ? "on" : "off"}`, `Talk calls ${info.talkWriteBack ? "on" : "off"}`].filter(Boolean);
  return `Run records: ${parts.join(", ")}`;
}

/** refused: nothing was attempted (write-back is off), which is neither a write nor a failure. */
export type RunWriteStatus = "pending" | "written" | "failed" | "refused";
export interface RunStatus {
  recordId: string;
  status: RunWriteStatus;
  /** Our own error code, never a secret. */
  error?: string;
  at: string;
}

/** The row for one call. Pure, so tests can check it without a database. */
export function buildRunRow(record: HarnessRecord, snapshot: SetupSnapshot): Row {
  const events = record.events;
  const last = <T extends TraceEvent["type"]>(type: T) => [...events].reverse().find((e) => e.type === type);
  const disposition = last("disposition")?.data.value;
  const score = last("judge_score")?.data ?? record.judge ?? null;
  const outcomeStatus = typeof record.outcome?.status === "string" ? record.outcome.status : null;
  return {
    record_id: record.recordId,
    call_id: events.find((e) => e.callId)?.callId ?? null,
    lead_id: record.leadId,
    agency_id: snapshot.lead.agencyId,
    direction: record.direction ?? snapshot.direction,
    is_test_run: true,
    setup_name: snapshot.name,
    voice_module_id: snapshot.voiceModule.id,
    decision_module_id: snapshot.decisionModule.id,
    prompt_setup_id: snapshot.promptSetup.id,
    persona_id: snapshot.persona?.personaId ?? null,
    setup_snapshot: snapshot,
    started_at: record.openedAt,
    ended_at: record.outcome ? (last("call_outcome")?.at ?? null) : null,
    outcome_status: outcomeStatus,
    disposition: typeof disposition === "string" ? disposition : null,
    outcome: record.outcome ?? null,
    transcript: record.transcript,
    trace: events,
    judge_verdicts: events.filter((e) => e.type === "judge_verdict").map((e) => e.data),
    judge_score: score,
    handoff_note: record.handoffNote ?? null,
  };
}

/** What a Talk call's snapshot needs from the live process, gathered when the call is first written. */
export interface TalkSnapshotParts {
  voiceModule: ModuleInfo;
  decisionModuleId: string;
  decisionModuleLabel: string;
  lead: { agencyId: string; name: string } | undefined;
}

/** The record's agent context event: the instructions the agent started with and the prompt setup they came from. */
function agentContextOf(record: HarnessRecord): { setupId: string | undefined; text: string } {
  const event = [...record.events].reverse().find((e) => e.type === "tool_call" && e.data.tool === "agent_context");
  const inputs = event?.data.inputs as Record<string, unknown> | undefined;
  const result = event?.data.result as Record<string, unknown> | undefined;
  const setupId = typeof inputs?.setupId === "string" ? inputs.setupId : undefined;
  const text = typeof result?.text === "string" ? result.text : "";
  return { setupId, text };
}

/**
 * The snapshot of a Talk call made without an applied setup, built from the
 * call itself. Pure: the live parts are passed in. "default" as the prompt
 * setup id is what the voice manager records when the control page named
 * none; the caller resolves it to the selected prompt setup.
 */
export function talkSnapshotFor(record: HarnessRecord, parts: TalkSnapshotParts): SetupSnapshot {
  const context = agentContextOf(record);
  const promptSetupId = context.setupId ?? "default";
  return {
    name: "talk",
    appliedAt: record.openedAt,
    direction: record.direction ?? "inbound",
    voiceModule: parts.voiceModule,
    decisionModule: { id: parts.decisionModuleId, label: parts.decisionModuleLabel },
    promptSetup: { id: promptSetupId, label: promptSetupId, includesBriefing: false, instructions: context.text },
    renderedPrompt: context.text,
    renderedPromptSha256: createHash("sha256").update(context.text).digest("hex"),
    lead: { leadId: record.leadId, agencyId: parts.lead?.agencyId ?? "unknown", businessName: parts.lead?.name ?? record.leadId, callCount: 0 },
    briefingGiven: null,
  };
}

/** The live parts for a Talk call: the selected voice and decision modules and the lead as the active store knows it. */
async function liveTalkParts(record: HarnessRecord): Promise<TalkSnapshotParts> {
  const modules = getModuleRegistry();
  const decisions = getDecisionRegistry();
  const decisionModuleId = decisions.selectedModuleId();
  let lead: TalkSnapshotParts["lead"];
  try {
    const found = await getActiveLeadStore().getLead(record.leadId);
    if (found) lead = { agencyId: found.agencyId, name: found.name };
  } catch {
    /* an unreachable lead store leaves the lead as unknown; the call is still written */
  }
  return {
    voiceModule: modules.get(modules.selectedModuleId()).info(),
    decisionModuleId,
    decisionModuleLabel: decisions.list().find((m) => m.id === decisionModuleId)?.label ?? decisionModuleId,
    lead,
  };
}

/** Resolves the voice manager's "default" prompt setup id to the one selected in the prompt setup registry. */
function resolveTalkPromptSetup(snapshot: SetupSnapshot): SetupSnapshot {
  if (snapshot.promptSetup.id !== "default") return snapshot;
  const id = getPromptSetupRegistry().selectedId();
  return { ...snapshot, promptSetup: { ...snapshot.promptSetup, id, label: id } };
}

export interface RunWriterDeps {
  sink: () => RunSink;
  now: () => Date;
  read: (recordId: string) => HarnessRecord | undefined;
  snapshotFor: (recordId: string) => SetupSnapshot | undefined;
  /** The live parts of a Talk call's snapshot; tests pass fixed ones. */
  talkParts: (record: HarnessRecord) => Promise<TalkSnapshotParts>;
}

function snapshotDir(): string {
  return join(resolve(process.env[DATA_DIR_ENV] ?? DEFAULT_DATA_DIR), "run-snapshots");
}

/** The snapshot is also kept on disk, so a call can be written back after the server restarted. */
function saveSnapshot(recordId: string, snapshot: SetupSnapshot): void {
  try {
    const dir = snapshotDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    writeFileSync(join(dir, `${recordId}.json`), JSON.stringify(snapshot), { mode: 0o600 });
  } catch {
    /* the in-memory copy still serves this process */
  }
}

function loadSnapshot(recordId: string): SetupSnapshot | undefined {
  if (!/^[\w-]+$/.test(recordId)) return undefined;
  try {
    return JSON.parse(readFileSync(join(snapshotDir(), `${recordId}.json`), "utf8")) as SetupSnapshot;
  } catch {
    return undefined;
  }
}

export class RunWriter {
  private readonly snapshots = new Map<string, SetupSnapshot>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly status = new Map<string, RunStatus>();
  private readonly deps: RunWriterDeps;

  /** `db` writes through that client instead of the default sink (tests use it). */
  constructor(deps: Partial<RunWriterDeps> & { db?: () => DbClient } = {}) {
    const { db } = deps;
    this.deps = {
      sink: deps.sink ?? (db ? () => new RestRunSink(db()) : () => defaultRunSink()),
      now: deps.now ?? (() => new Date()),
      read: deps.read ?? ((id) => recordStore.read(id)),
      snapshotFor: deps.snapshotFor ?? ((id) => this.snapshots.get(id) ?? loadSnapshot(id)),
      talkParts: deps.talkParts ?? liveTalkParts,
    };
  }

  /** Listens on a trace bus. Returns the unsubscribe function. */
  attach(bus: { subscribe(listener: (e: TraceEvent) => void): () => void } = traceBus): () => void {
    return bus.subscribe((event) => this.onEvent(event));
  }

  statuses(): RunStatus[] {
    return [...this.status.values()].sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Waits for every queued write; tests and shutdown use it. */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private onEvent(event: TraceEvent): void {
    if (event.channel !== "call") return;
    const active = getActiveSetup();
    if (active && active.profile.leadId === event.leadId) {
      // The first event of a call fixes the setup it ran under, even if the setup changes mid-call.
      if (!this.snapshots.has(event.recordId)) {
        this.snapshots.set(event.recordId, active.snapshot);
        saveSnapshot(event.recordId, active.snapshot);
      }
    } else if (!isTalkWriteBackEnabled()) {
      return;
    }
    // A Talk call without a setup gets its snapshot when it is first written, from the record itself.
    if (!isRunWriteBackEnabled()) return;
    const known = this.status.has(event.recordId);
    const settles = event.type === "call_outcome";
    const refines = known && (event.type === "judge_verdict" || event.type === "judge_score" || event.type === "disposition");
    if (settles || refines) this.queue(event.recordId);
  }

  /** Writes (or rewrites) one call from its local record. Used for a retry. Refused while write-back is off. */
  async writeBack(recordId: string): Promise<RunStatus> {
    if (!isRunWriteBackEnabled()) {
      return { recordId, status: "refused", error: "run_writeback_off", at: this.deps.now().toISOString() };
    }
    this.queue(recordId);
    await this.chains.get(recordId);
    return this.status.get(recordId)!;
  }

  private queue(recordId: string): void {
    this.mark(recordId, "pending");
    const previous = this.chains.get(recordId) ?? Promise.resolve();
    const next = previous.then(() => this.write(recordId));
    this.chains.set(recordId, next);
  }

  private mark(recordId: string, status: RunWriteStatus, error?: string): void {
    this.status.set(recordId, { recordId, status, ...(error ? { error } : {}), at: this.deps.now().toISOString() });
  }

  /** Builds, keeps and saves the snapshot of a Talk call without a setup; nothing while the Talk switch is off. */
  private async talkSnapshot(record: HarnessRecord): Promise<SetupSnapshot | undefined> {
    if (!isTalkWriteBackEnabled()) return undefined;
    const snapshot = resolveTalkPromptSetup(talkSnapshotFor(record, await this.deps.talkParts(record)));
    this.snapshots.set(record.recordId, snapshot);
    saveSnapshot(record.recordId, snapshot);
    return snapshot;
  }

  private async write(recordId: string): Promise<void> {
    // A write queued before the switch was turned off does not run.
    if (!isRunWriteBackEnabled()) return this.mark(recordId, "refused", "run_writeback_off");
    try {
      const record = this.deps.read(recordId);
      if (!record || record.kind !== "call") throw new Error("run_record_not_found");
      const snapshot = this.deps.snapshotFor(recordId) ?? (await this.talkSnapshot(record));
      if (!snapshot) throw new Error("run_setup_snapshot_missing");
      const row = buildRunRow(record, snapshot);
      const sink = this.deps.sink();
      if (!(await sink.insertIgnore(row))) {
        // Already there: bring it up to date (a judge result may have landed since).
        const { record_id: _key, ...patch } = row;
        await sink.update(recordId, { ...patch, updated_at: this.deps.now().toISOString() });
      }
      this.mark(recordId, "written");
    } catch (err) {
      const code = err instanceof Error ? err.message.slice(0, 120) : "run_write_failed";
      this.mark(recordId, "failed", code);
      console.error(`could not write run ${recordId} to the harness database: ${code}`);
    }
  }
}

let writer: RunWriter | null = null;
let detach: (() => void) | null = null;

export function getRunWriter(): RunWriter {
  writer ??= new RunWriter();
  return writer;
}

/** Starts listening to the trace bus once. Safe to call again. */
export function attachRunWriter(): void {
  if (detach) return;
  detach = getRunWriter().attach();
}

/** Tests: drop the writer and its listener. */
export function resetRunWriter(): void {
  detach?.();
  detach = null;
  writer = null;
  override = undefined;
  talkOverride = undefined;
}
