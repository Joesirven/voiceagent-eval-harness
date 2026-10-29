/**
 * Durable record of STOP requests that an external adapter could only hold in
 * memory. JSON Lines in the gitignored
 * data directory, so a restart does not lose a request and a person can find it.
 *
 * The file never holds the caller's words. Two kinds of line:
 * - "held": one STOP (lead, call or message id, source, matched phrase, times, note).
 * - "replayed": the id of a held STOP that an external store has recorded.
 *
 * The directory is data/ under the repository root, the same place the live
 * trace records go. VOICE_HARNESS_DATA_DIR overrides it; tests use a
 * temporary one.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR_ENV = "VOICE_HARNESS_DATA_DIR";
export const HELD_STOPS_FILE = "held-stops.jsonl";
/** The default lives under the repository root, so it does not depend on where the process was started. */
export const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");

/** Only the owner can read or enter the directory: it holds personal data. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface HeldStopEntry {
  /** Stable key: lead, source, call or message id, and the time the STOP was heard. */
  id: string;
  leadId: string;
  callId: string | null;
  source: "voice_call" | "text";
  matched: string;
  occurredAt: string;
  recordedAt: string;
  note: string;
}

export interface HeldStopLog {
  entries: HeldStopEntry[];
  replayedIds: Set<string>;
  /** Lines that could not be read; each one may hide a held STOP, so the caller reports them. */
  unreadableLines: number;
}

export interface HeldStopFile {
  readonly path: string;
  read(): HeldStopLog;
  /** Appends one line. Throws if the file cannot be written; the caller decides what to do. */
  append(line: Record<string, unknown>): void;
}

export function heldStopsPath(): string {
  return join(process.env[DATA_DIR_ENV] || DEFAULT_DATA_DIR, HELD_STOPS_FILE);
}

/** The file at `path`. A missing file reads as empty. */
export function heldStopFileAt(path: string): HeldStopFile {
  return {
    path,
    read() {
      const log: HeldStopLog = { entries: [], replayedIds: new Set(), unreadableLines: 0 };
      if (!existsSync(path)) return log;
      for (const raw of readFileSync(path, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          log.unreadableLines += 1;
          continue;
        }
        if (line.kind === "held" && typeof line.id === "string" && typeof line.leadId === "string") {
          log.entries.push(line as unknown as HeldStopEntry);
        } else if (line.kind === "replayed" && typeof line.id === "string") {
          log.replayedIds.add(line.id);
        } else {
          log.unreadableLines += 1;
        }
      }
      return log;
    },
    append(line) {
      appendHeldStop(path, line);
    },
  };
}

/** Appends one line, creating the directory (mode 0o700) and the file (mode 0o600) if needed. */
export function appendHeldStop(path: string, line: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: FILE_MODE });
}
