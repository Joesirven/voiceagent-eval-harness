import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePipecatPython } from "../../src/orchestration-modules/pipecat-config.js";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const pipecatDir = here("../../src/orchestration-modules/pipecat/");
const devtools = join(pipecatDir, "devtools.py");
const fixture = here("./pipecat-devtools-fixture.py");
const python = resolvePipecatPython();
const whiskerInstalled =
  python !== undefined &&
  (() => {
    try {
      execFileSync(python, ["-I", "-c", "import pipecat_whisker"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devtools-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The host's spawn shape: isolated interpreter, nothing but PATH and the encoding. */
const env = (extra: Record<string, string>) => ({ PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8", ...extra });
const whiskFiles = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".whisk")) : []);

function lines(text: string) {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function runFixture(extra: Record<string, string>, hold = false) {
  const child = spawn(python!, ["-I", "-u", fixture, devtools], {
    env: env({ CRM_WHISKER_DIR: dir, ...(hold ? { FIXTURE_HOLD: "1" } : {}), ...extra }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
  const waitFor = async (pred: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, exited, output: () => out, waitFor, finish: () => child.stdin.write("\n") };
}

describe.skipIf(!python)("pipecat devtools helper", () => {
  it("does nothing when unset or off: no files, no whisker import, pipeline ends", async () => {
    for (const extra of [{}, { CRM_WHISKER: "off" }, { CRM_WHISKER: "" }] as Array<Record<string, string>>) {
      const run = runFixture(extra);
      expect(await run.exited).toBe(0);
      const [first] = lines(run.output());
      expect(first).toEqual({ sink: null, whisker_imported: false });
      expect(whiskFiles()).toEqual([]);
    }
  }, 60_000);

  it("is a no-op, not a failure, when the whisker package cannot be imported", async () => {
    const run = runFixture({ CRM_WHISKER: "live", FIXTURE_BLOCK_WHISKER: "1", FIXTURE_CALL_ID: "nowhisker" });
    expect(await run.exited).toBe(0);
    expect(lines(run.output())[0]).toMatchObject({ sink: null });
    expect(whiskFiles()).toEqual([]);
  }, 30_000);

  it.skipIf(!whiskerInstalled)("file mode records a short fake pipeline to <call id>.whisk and the pipeline still ends", async () => {
    const run = runFixture({ CRM_WHISKER: "file", FIXTURE_CALL_ID: "call-42" });
    expect(await run.exited).toBe(0);
    expect(lines(run.output())[0]).toMatchObject({ sink: "WhiskerFile" });
    expect(whiskFiles()).toEqual(["call-42.whisk"]);
    expect(statSync(join(dir, "call-42.whisk")).size).toBeGreaterThan(100);
  }, 30_000);

  it.skipIf(!whiskerInstalled)("a cancel before the pipeline has started still ends the runner (the recorder is released)", async () => {
    const run = runFixture({ CRM_WHISKER: "file", FIXTURE_SLOW_START: "1", FIXTURE_CANCEL: "1", FIXTURE_CALL_ID: "early-cancel" });
    expect(await run.exited).toBe(0);
    expect(lines(run.output()).some((l) => l.done === true)).toBe(true);
  }, 30_000);

  it.skipIf(!whiskerInstalled)("keeps a hostile call id inside the recording directory", async () => {
    const run = runFixture({ CRM_WHISKER: "file", FIXTURE_CALL_ID: "../../escape/x" });
    expect(await run.exited).toBe(0);
    const files = whiskFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[A-Za-z0-9_-]+\.whisk$/);
    expect(existsSync(join(dir, "..", "escape"))).toBe(false);
  }, 30_000);

  it.skipIf(!whiskerInstalled)("live mode listens on 127.0.0.1 only", async () => {
    const port = await freePort();
    const run = runFixture({ CRM_WHISKER: "live", CRM_WHISKER_PORT: String(port), FIXTURE_CALL_ID: "live-1" }, true);
    try {
      await run.waitFor(() => run.output().includes("sink"));
      expect(lines(run.output())[0]).toMatchObject({ sink: "WhiskerServer" });
      const listeners = execFileSync("lsof", ["-nP", "-a", "-p", String(run.child.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
      const names = listeners.split("\n").slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/).slice(8).join(" "));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} `));
    } finally {
      run.finish();
      await run.exited;
    }
    expect(whiskFiles()).toEqual(["live-1.whisk"]);
  }, 40_000);

  it.skipIf(!whiskerInstalled)("live mode falls back to file only when the port is taken, and the call continues", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const run = runFixture({ CRM_WHISKER: "live", CRM_WHISKER_PORT: String(port), FIXTURE_CALL_ID: "busy" });
      expect(await run.exited).toBe(0);
      expect(lines(run.output())[0]).toMatchObject({ sink: "WhiskerFile" });
      expect(whiskFiles()).toEqual(["busy.whisk"]);
    } finally {
      blocker.close();
    }
  }, 30_000);
});

/** Drives a real sidecar over its standard-input protocol with the hook present. */
function runSidecar(file: string, extra: Record<string, string>, script: (api: { send: (m: object) => void; wait: (type: string) => Promise<Record<string, unknown>> }) => Promise<void>) {
  const child = spawn(python!, ["-I", "-u", join(pipecatDir, file)], {
    env: env({ CRM_WHISKER_DIR: dir, ...extra }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const seen: Array<Record<string, unknown>> = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) if (p) seen.push(JSON.parse(p));
  });
  const exited = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
  const wait = async (type: string) => {
    const end = Date.now() + 20_000;
    for (;;) {
      const hit = seen.find((m) => m.type === type);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no ${type}; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return script({ send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`), wait }).then(async () => ({ code: await exited, seen }));
}

describe.skipIf(!python)("sidecars start and close with the devtools hook present", () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["sidecar.py", {}, false],
    ["sidecar.py", { CRM_WHISKER: "file", CRM_CALL_ID: "text-1" }, true],
    ["sidecar_voice.py", {}, false],
    ["sidecar_voice.py", { CRM_WHISKER: "file", CRM_CALL_ID: "voice-1" }, true],
  ];
  for (const [file, extra, records] of cases) {
    it.skipIf(records && !whiskerInstalled)(`${file} ${records ? "records with file mode" : "runs with the switch unset"}: ready, end, closed, exit 0`, async () => {
      const { code, seen } = await runSidecar(file, extra, async ({ send, wait }) => {
        await wait("ready");
        send({ id: 5, type: "end" });
        await wait("closed");
      });
      expect(code).toBe(0);
      expect(seen.some((m) => m.error)).toBe(false);
      expect(whiskFiles().length).toBe(records ? 1 : 0);
      if (records) expect(statSync(join(dir, whiskFiles()[0]!)).size).toBeGreaterThan(100);
    }, 40_000);
  }
});
