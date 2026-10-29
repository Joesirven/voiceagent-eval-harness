import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { pipecatVoiceSidecarPath, resolvePipecatPython } from "../../src/orchestration-modules/pipecat-config.js";

const pythonPath = resolvePipecatPython();
/** Each test starts a real Python sidecar; alone they take 3 to 8 seconds, so 5 seconds fails under machine load (test note). */
const SIDECAR_TEST_TIMEOUT_MS = 30_000;

describe("pipecat voice sidecar", () => {
  it.skipIf(!pythonPath)("starts and relays one audio frame", async () => {
    const child = spawn(pythonPath!, ["-I", "-u", pipecatVoiceSidecarPath()], {
      env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const lines: string[] = [];
    const nextLine = () =>
      new Promise<string>((resolve, reject) => {
        const tick = () => {
          const idx = buffer.indexOf("\n");
          if (idx >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            resolve(line);
            return;
          }
          child.stdout.once("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            tick();
          });
          child.once("close", () => reject(new Error("closed")));
        };
        tick();
      });
    child.stderr.resume();
    const ready = JSON.parse(await nextLine());
    expect(ready).toMatchObject({ id: 0, type: "ready", version: "1.13.0" });
    child.stdin.write(JSON.stringify({ type: "audio_in", data: Buffer.from([0xff, 0x7f]).toString("base64") }) + "\n");
    let relay: { type: string };
    for (;;) {
      relay = JSON.parse(await nextLine());
      if (relay.type === "to_model") break;
      expect(relay.type).toBe("stats");
    }
    child.stdin.write(JSON.stringify({ id: 1, type: "end" }) + "\n");
    const closed = JSON.parse(await nextLine());
    expect(closed.type).toBe("closed");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }, SIDECAR_TEST_TIMEOUT_MS);

  it.skipIf(!pythonPath)("survives large Azure model audio chunks", async () => {
    const { PipecatVoiceRuntime } = await import("../../src/server/voice/pipecat-voice-runtime.js");
    const rt = new PipecatVoiceRuntime();
    let failed = "";
    await rt.start({
      onToModel: () => undefined,
      onFromModel: () => undefined,
      onCleared: () => undefined,
      onFailure: (code) => {
        failed = code;
      },
    });
    const huge = Buffer.alloc(120_000, 0xaa).toString("base64");
    rt.sendCallerAudio(Buffer.alloc(320, 0xff).toString("base64"));
    rt.relayModelAudio(huge);
    await new Promise((r) => setTimeout(r, 1500));
    expect(failed).toBe("");
    expect(rt.isStopped).toBe(false);
    expect(rt.toModelFrames).toBeGreaterThanOrEqual(1);
    await rt.stop();
  }, SIDECAR_TEST_TIMEOUT_MS);
});
