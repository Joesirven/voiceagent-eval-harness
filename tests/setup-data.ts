import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

// Every test starts with an empty held-STOP directory, so one test's STOPs never reach another test.
let dir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-harness-held-stops-"));
  process.env.VOICE_HARNESS_DATA_DIR = dir;
  // No test may reach a database because its environment file is not present.
  process.env.VOICE_HARNESS_DATABASE_ENV_FILE = join(dir, "no-database.env");
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
