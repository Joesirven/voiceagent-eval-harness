/** Drives the real sidecar_deepgram.py subprocess over its stdio protocol. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePipecatPython } from "../../src/orchestration-modules/pipecat-config.js";

export const deepgramSidecarPath = fileURLToPath(new URL("../../src/orchestration-modules/pipecat/sidecar_deepgram.py", import.meta.url));
export const pythonPath = resolvePipecatPython();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Line = Record<string, unknown> & { type?: string };

/**
 * How long a sidecar may take to print its first line (ready, or a refusal).
 * Loading Pipecat takes seconds on a loaded host, so this wait has its own
 * deadline; each test's own waits start only after it, and keep their meaning.
 */
export const READY_WAIT_MS = readyWaitMs(process.env.VOICE_HARNESS_SIDECAR_TEST_START_MS);

/** VOICE_HARNESS_SIDECAR_TEST_START_MS overrides the wait (tests only; the runtime's own start deadline is separate). */
export function readyWaitMs(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1000 && n <= 600_000 ? n : 45_000;
}

/** A test's vitest timeout: its own steps plus the ready wait of each sidecar it starts. */
export function withReadyWait(ownMs: number, sidecars = 1): number {
  return ownMs + sidecars * READY_WAIT_MS;
}

export interface SidecarEnv {
  DEEPGRAM_API_KEY: string;
  DEEPGRAM_BASE_URL: string;
  AZURE_FOUNDRY_URL: string;
  AZURE_FOUNDRY_KEY: string;
  AZURE_REPLY_DEPLOYMENT?: string;
}

export function startSidecar(env: SidecarEnv) {
  const spawnedAt = Date.now();
  const child: ChildProcessWithoutNullStreams = spawn(pythonPath!, ["-I", "-u", deepgramSidecarPath], {
    env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Line[] = [];
  let buffer = "";
  let stderr = "";
  let exitCode: number | null | undefined;
  let exitSignal: string | null = null;
  let firstLineMs: number | undefined;
  const exited = new Promise<number | null>((r) =>
    child.once("close", (code, signal) => {
      exitSignal = signal;
      exitCode = code;
      r(code);
    }),
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lines.push(JSON.parse(raw) as Line);
      firstLineMs ??= Date.now() - spawnedAt;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => void (stderr += c));
  child.stdin.on("error", () => undefined);

  /** The last lines of standard error, with every value of the spawn environment taken out. */
  const stderrTail = () => {
    let text = stderr.split("\n").filter(Boolean).slice(-8).join("\n");
    for (const value of Object.values(env)) if (typeof value === "string" && value.length >= 4) text = text.split(value).join("[scrubbed]");
    return text || "(empty)";
  };
  const seen = () => JSON.stringify(lines.map((l) => l.type ?? l.error ?? l.id)).slice(0, 600);

  // The first line (ready, or a refusal) gets the load-tolerant deadline. A
  // sidecar that exits first fails at once, with its exit code.
  let started: Promise<void> | undefined;
  const waitForFirstLine = () =>
    (started ??= (async () => {
      const deadline = spawnedAt + READY_WAIT_MS;
      while (lines.length === 0 && exitCode === undefined && Date.now() < deadline) await sleep(25);
      if (lines.length > 0) return;
      if (exitCode !== undefined) throw new Error(`sidecar exited with code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ""} before reporting ready; standard error ends:\n${stderrTail()}`);
      throw new Error(`sidecar did not report ready within ${READY_WAIT_MS / 1000} seconds; saw ${seen()}; standard error ends:\n${stderrTail()}`);
    })());

  const api = {
    lines,
    exited,
    get stderr() {
      return stderr;
    },
    /** Milliseconds from spawn to the first line, once there is one. */
    get firstLineMs() {
      return firstLineMs;
    },
    send(message: object) {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    ofType(type: string): Line[] {
      return lines.filter((l) => l.type === type);
    },
    async waitFor(check: () => boolean, ms = 8000): Promise<void> {
      await waitForFirstLine();
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) await sleep(15);
      if (!check()) throw new Error(`timed out; saw ${seen()}`);
    },
    async waitForType(type: string, count = 1, ms = 8000): Promise<Line[]> {
      await api.waitFor(() => api.ofType(type).length >= count, ms);
      return api.ofType(type);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
  return api;
}

export function defaultStart(overrides: Record<string, unknown> = {}) {
  return {
    type: "start",
    instructions: "STANDING RULES. Lead packet: Jane, auto quote.",
    disclosure: "Hi Jane, this is an automated assistant calling for the agency.",
    turn_gap_ms: 900,
    stale_output_cap_gaps: 1,
    guard: false,
    ...overrides,
  };
}

/** One mu-law frame as the page sends: 21 bytes of silence. */
export const callerFrame = Buffer.alloc(21, 0xff).toString("base64");
