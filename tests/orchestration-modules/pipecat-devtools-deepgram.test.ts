import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAzureChat } from "../helpers/fake-azure-chat.js";
import { fakeDeepgram } from "../helpers/fake-deepgram.js";
import { deepgramSidecarPath, defaultStart, pythonPath, startSidecar } from "../helpers/deepgram-sidecar.js";

// Runs once sidecar_deepgram.py carries the devtools hook and pipecat_whisker is installed.
const hookPresent = existsSync(deepgramSidecarPath) && readFileSync(deepgramSidecarPath, "utf8").includes("devtools.py");
const whiskerInstalled =
  pythonPath !== undefined &&
  (() => {
    try {
      execFileSync(pythonPath, ["-I", "-c", "import pipecat_whisker"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe.skipIf(!pythonPath || !hookPresent || !whiskerInstalled)("deepgram sidecar with the devtools hook", () => {
  it("starts and speaks the disclosure as before, and records the call in file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devtools-dg-"));
    const dg = await fakeDeepgram({ apiKey: "k" });
    const az = await fakeAzureChat({ apiKey: "a", reply: () => "ok" });
    const sidecar = startSidecar({
      DEEPGRAM_API_KEY: "k",
      DEEPGRAM_BASE_URL: dg.baseUrl,
      AZURE_FOUNDRY_URL: az.url,
      AZURE_FOUNDRY_KEY: "a",
      CRM_WHISKER: "file",
      CRM_WHISKER_DIR: dir,
      CRM_CALL_ID: "dg-1",
    } as never);
    cleanup.push(() => sidecar.kill(), () => az.close(), () => dg.close(), () => rmSync(dir, { recursive: true, force: true }));
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out", 3);
    expect(readdirSync(dir)).toEqual(["dg-1.whisk"]);
    expect(statSync(join(dir, "dg-1.whisk")).size).toBeGreaterThan(100);
  }, 30_000);
});
