/**
 * Durable records as JSON lines on disk: one file per call and one per text
 * thread (all texts to one lead). The first line describes the record; every
 * later line is one trace event. Transcript, outcome, handoff note and the
 * full trace are all read back from those event lines.
 *
 * Personal data: the default directory is gitignored, and nothing here is
 * ever sent to another service. `pnpm records:purge` removes every record.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeScore } from "./extensions.js";
import { narrate } from "./narrate.js";
import { traceBus, type TraceEvent } from "./events.js";

export const RECORDS_DIR_ENV = "VOICE_HARNESS_RECORDS_DIR";
/** The default lives under the repository root, so it does not depend on where the process was started. */
export const DEFAULT_RECORDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/records");

/** Only the owner can read or enter these: records hold personal data. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A record file this store wrote: its name pattern. The first line must also be a meta line. */
const RECORD_FILE = /^(call|text)_[\w-]+\.jsonl$/;

function isRecordFile(path: string, name: string): boolean {
  if (!RECORD_FILE.test(name)) return false;
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    return JSON.parse(first).line === "meta";
  } catch {
    return false;
  }
}

export interface TranscriptLine {
  role: "caller" | "agent" | "system";
  text: string;
  turnIndex: number;
  spoken: boolean;
  at: string;
}

export interface HarnessRecord {
  recordId: string;
  kind: "call" | "text";
  leadId: string;
  direction?: "inbound" | "outbound";
  openedAt: string;
  /** The full trace, in order. */
  events: TraceEvent[];
  /** Spoken words only, with the time each turn was recorded. Empty for a text thread. */
  transcript: TranscriptLine[];
  /** The last call outcome event's data (calls only). */
  outcome?: Record<string, unknown>;
  /** The handoff note filed during the call, if any. */
  handoffNote?: Record<string, unknown>;
  /** Every text sent, skipped or blocked (text threads only). */
  texts: Array<{ at: string; messageId?: string; status: string; reason?: string; body?: string }>;
  /** The post-call score, from the call's `judge_score` event. */
  judge?: JudgeScore;
}

interface MetaLine {
  line: "meta";
  recordId: string;
  kind: "call" | "text";
  leadId: string;
  direction?: "inbound" | "outbound";
  openedAt: string;
}

export interface TimelineItem {
  at: string;
  seq: number;
  recordId: string;
  channel: "call" | "sms";
  direction?: "inbound" | "outbound";
  type: TraceEvent["type"];
  /** One plain-language sentence, or null for steps that only matter in the developer trace. */
  plain: string | null;
  /** Transcript words, for turn items only. */
  turn?: { role: string; text: string };
}

export interface LeadTimeline {
  leadId: string;
  records: Array<{ recordId: string; kind: "call" | "text"; direction?: string; openedAt: string; outcome?: string }>;
  items: TimelineItem[];
}

export class RecordStore {
  private explicitDir: string | undefined;

  /** The directory records live in: set explicitly, else the environment variable, else the default. */
  get dir(): string {
    return resolve(this.explicitDir ?? process.env[RECORDS_DIR_ENV] ?? DEFAULT_RECORDS_DIR);
  }

  setDir(dir: string | undefined): void {
    this.explicitDir = dir;
  }

  private fileFor(recordId: string): string {
    return join(this.dir, `${recordId}.jsonl`);
  }

  append(event: TraceEvent): void {
    const file = this.fileFor(event.recordId);
    if (!existsSync(file)) {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
        chmodSync(this.dir, DIR_MODE);
      }
      const meta: MetaLine = {
        line: "meta",
        recordId: event.recordId,
        kind: event.channel === "call" ? "call" : "text",
        leadId: event.leadId,
        direction: event.direction,
        openedAt: event.at,
      };
      appendFileSync(file, JSON.stringify(meta) + "\n", { mode: FILE_MODE });
    }
    appendFileSync(file, JSON.stringify({ line: "event", ...event }) + "\n");
  }

  /** How many events a record already holds, so numbering continues after a restart. */
  countEvents(recordId: string): number {
    const file = this.fileFor(recordId);
    if (!existsSync(file)) return 0;
    try {
      return parseLines(readFileSync(file, "utf8")).events.length;
    } catch {
      return 0; // an unreadable file must not stop a call
    }
  }

  /** Time of the first stored event, in epoch milliseconds, so a record spanning a restart keeps one clock. */
  firstEventMs(recordId: string): number | undefined {
    const file = this.fileFor(recordId);
    if (!existsSync(file)) return undefined;
    try {
      const at = Date.parse(parseLines(readFileSync(file, "utf8")).events[0]?.at ?? "");
      return Number.isFinite(at) ? at : undefined;
    } catch {
      return undefined;
    }
  }

  read(recordId: string): HarnessRecord | undefined {
    if (!/^[\w-]+$/.test(recordId)) return undefined;
    const file = this.fileFor(recordId);
    if (!existsSync(file)) return undefined;
    return fold(parseLines(readFileSync(file, "utf8")));
  }

  list(): HarnessRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => this.read(f.slice(0, -".jsonl".length)))
      .filter((r): r is HarnessRecord => r !== undefined)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  /** Every record of one lead, calls and texts together, merged in time order. */
  timeline(leadId: string): LeadTimeline {
    const records = this.list().filter((r) => r.leadId === leadId);
    const items: TimelineItem[] = [];
    for (const r of records) {
      for (const e of r.events) {
        items.push({
          at: e.at,
          seq: e.seq,
          recordId: r.recordId,
          channel: e.channel,
          direction: e.direction,
          type: e.type,
          plain: narrate(e),
          ...(e.type === "turn" || e.type === "transcript_final" ? { turn: { role: String(e.data.role), text: String(e.data.text) } } : {}),
        });
      }
    }
    items.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    return {
      leadId,
      records: records.map((r) => ({
        recordId: r.recordId,
        kind: r.kind,
        direction: r.direction,
        openedAt: r.openedAt,
        outcome: typeof r.outcome?.status === "string" ? r.outcome.status : undefined,
      })),
      items,
    };
  }

  /** Deletes every record file this store wrote (call_ or text_ name and a meta first line). Foreign files stay. */
  purge(): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const f of readdirSync(this.dir)) {
      if (!isRecordFile(join(this.dir, f), f)) continue;
      rmSync(join(this.dir, f));
      removed += 1;
    }
    try {
      rmdirSync(this.dir); // only succeeds when empty
    } catch {
      /* other files live here; leave the directory */
    }
    traceBus.reset();
    return removed;
  }
}

function parseLines(text: string): { meta?: MetaLine; events: TraceEvent[] } {
  let meta: MetaLine | undefined;
  const events: TraceEvent[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a half-written last line after a crash
    }
    if (parsed.line === "meta") meta = parsed;
    else if (parsed.line === "event") {
      const { line: _line, ...event } = parsed;
      events.push(event as TraceEvent);
    }
  }
  return { meta, events };
}

function fold({ meta, events }: { meta?: MetaLine; events: TraceEvent[] }): HarnessRecord | undefined {
  if (!meta) return undefined;
  const record: HarnessRecord = {
    recordId: meta.recordId,
    kind: meta.kind,
    leadId: meta.leadId,
    direction: meta.direction,
    openedAt: meta.openedAt,
    events,
    transcript: [],
    texts: [],
  };
  for (const e of events) {
    if (e.type === "turn" || e.type === "transcript_final") {
      record.transcript.push({
        role: e.data.role as TranscriptLine["role"],
        text: String(e.data.text),
        turnIndex: Number(e.data.turnIndex),
        spoken: e.data.spoken !== false,
        at: e.at,
      });
    } else if (e.type === "judge_score") {
      record.judge = e.data as unknown as JudgeScore;
    } else if (e.type === "call_outcome") {
      record.outcome = e.data;
    } else if (e.type === "handoff" && e.data.filed === true) {
      record.handoffNote = e.data.note as Record<string, unknown>;
    } else if (e.type === "text") {
      record.texts.push({
        at: e.at,
        messageId: e.messageId,
        status: String(e.data.status),
        reason: typeof e.data.reason === "string" ? e.data.reason : undefined,
        body: typeof e.data.body === "string" ? e.data.body : undefined,
      });
    }
  }
  return record;
}

export const recordStore = new RecordStore();

traceBus.seedRecordSeq = (recordId) => recordStore.countEvents(recordId);
traceBus.seedRecordStart = (recordId) => recordStore.firstEventMs(recordId);
traceBus.subscribe((event) => {
  try {
    recordStore.append(event);
  } catch (err) {
    // A full disk must never stop a call or a text.
    console.error("could not write record:", err instanceof Error ? err.message : err);
  }
});
