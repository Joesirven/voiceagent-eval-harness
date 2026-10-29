import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test worker writes records to its own temporary directory, never to ./data.
process.env.VOICE_HARNESS_RECORDS_DIR = mkdtempSync(join(tmpdir(), "voice-harness-records-"));
