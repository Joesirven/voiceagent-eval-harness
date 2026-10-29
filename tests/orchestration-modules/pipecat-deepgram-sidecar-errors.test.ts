import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fakeDeepgram } from "../helpers/fake-deepgram.js";
import { deepgramSidecarPath, defaultStart, pythonPath, sleep, startSidecar, withReadyWait, READY_WAIT_MS } from "../helpers/deepgram-sidecar.js";

const FALLBACK_LINE = "Sorry, could you say that again?";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** An Azure chat route that answers every request with one HTTP status and a body that must never surface. */
async function azureAnswering(status: number): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "provider text that must not surface", code: "x" } })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
}

/** An Azure chat route that streams the first sentence of a reply, then drops the connection mid-stream. */
async function azureFailingMidStream(): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const chunk = (content: string) => `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk(""));
      for (const word of "Sure, I can help with that. Could ".split(/(?<= )/)) res.write(chunk(word));
      setTimeout(() => res.destroy(), 100);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
}

describe.skipIf(!pythonPath)("pipecat deepgram sidecar error codes", () => {
  // Pipecat counts these as permanent: the reply model can no longer be used, so the call ends.
  it.each([
    [401, "azure_auth_failed"],
    [404, "azure_deployment_not_found"],
  ])("an Azure reply that answers %i is reported as %s, with no provider text", async (status, code) => {
    const dg = await fakeDeepgram({ apiKey: "dg-key-not-real" });
    const url = await azureAnswering(status);
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: "dg-key-not-real", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: url, AZURE_FOUNDRY_KEY: "az-key-not-real" });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    const [error] = await sidecar.waitForType("error", 1, 40_000);
    expect(error).toEqual({ type: "error", code });
    await sidecar.waitForType("ended");
    expect(sidecar.ofType("warning")).toHaveLength(0);
    expect(JSON.stringify(sidecar.lines) + sidecar.stderr).not.toContain("provider text");
  }, withReadyWait(70_000));

  it("keeps the call going on a non-fatal error (429), speaks a fallback line and reports a warning", async () => {
    const dg = await fakeDeepgram({ apiKey: "dg-key-not-real" });
    const url = await azureAnswering(429);
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: "dg-key-not-real", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: url, AZURE_FOUNDRY_KEY: "az-key-not-real" });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    const [warning] = await sidecar.waitForType("warning", 1, 40_000);
    expect(warning).toEqual({ type: "warning", code: "azure_rate_limited" });
    // The failed reply is settled and a fallback line takes its place, spoken by text to speech.
    const fallback = (await sidecar.waitForType("agent_line", 2, 15_000))[1];
    expect(fallback).toEqual({ type: "agent_line", line_id: 2, text: "Sorry, could you say that again?", interrupted: false });
    expect(dg.seen.spoken.join("")).toContain("Sorry, could you say that again?");
    // Not busy for good: the next caller line is taken as a new turn, and gets its own fallback.
    await sleep(300);
    sidecar.send({ type: "caller_text", text: "are you there" });
    expect((await sidecar.waitForType("caller_final", 2))[1]).toMatchObject({ turn: 2, text: "are you there" });
    sidecar.send({ type: "guidance", turn: 2, text: null });
    await sidecar.waitFor(() => sidecar.ofType("agent_line").filter((l) => l.text === "Sorry, could you say that again?").length === 2, 40_000);
    expect(sidecar.ofType("cleared")).toHaveLength(0);
    expect(sidecar.ofType("error")).toHaveLength(0);
    expect(sidecar.ofType("ended")).toHaveLength(0);
    sidecar.send({ type: "end" });
    await sidecar.waitForType("ended");
    expect(await sidecar.exited).toBe(0);
    expect(JSON.stringify(sidecar.lines) + sidecar.stderr).not.toContain("provider text");
  }, withReadyWait(120_000));
  it("with the line check on, a non-fatal reply failure still speaks the fallback line", async () => {
    const dg = await fakeDeepgram({ apiKey: "dg-key-not-real" });
    const url = await azureAnswering(429);
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: "dg-key-not-real", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: url, AZURE_FOUNDRY_KEY: "az-key-not-real" });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart({ guard: true }));
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    const [warning] = await sidecar.waitForType("warning", 1, 40_000);
    expect(warning).toEqual({ type: "warning", code: "azure_rate_limited" });
    // The line check settles the empty reply before the error reaches the worker; the fallback is still spoken.
    const fallback = (await sidecar.waitForType("agent_line", 2, 15_000))[1];
    expect(fallback).toEqual({ type: "agent_line", line_id: 2, text: FALLBACK_LINE, interrupted: false });
    expect(dg.seen.spoken.join("")).toContain(FALLBACK_LINE);
    expect(sidecar.ofType("error")).toHaveLength(0);
  }, withReadyWait(80_000));

  it("speaks the fallback before a caller line held behind the failed reply is answered", async () => {
    // A long disclosure (15 seconds of audio sent in about 1.5), so the reply to the held line begins while it is still audible.
    const dg = await fakeDeepgram({ apiKey: "dg-key-not-real", chunksFor: (t) => (t.startsWith("Hi ") ? 150 : 3), speechChunkMs: 10 });
    const url = await azureAnswering(429);
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: "dg-key-not-real", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: url, AZURE_FOUNDRY_KEY: "az-key-not-real" });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart({ turn_gap_ms: 300 }));
    await sidecar.waitForType("ready");
    await sidecar.waitForType("audio_out");
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final", 1, 20_000);
    sidecar.send({ type: "guidance", turn: 1, text: null });
    await sleep(100);
    // The reply has begun inside the disclosure's audible window: this line cannot interrupt it, so it is held.
    sidecar.send({ type: "caller_text", text: "are you there" });
    await sidecar.waitForType("warning", 1, 40_000);
    // The precondition: the held line did not interrupt anything (otherwise this run says nothing about the hold).
    expect(sidecar.ofType("cleared")).toHaveLength(0);
    const second = (await sidecar.waitForType("caller_final", 2, 20_000))[1];
    expect(second).toMatchObject({ turn: 2, text: "are you there" });
    const order = sidecar.lines.map((l) => (l.type === "agent_line" ? `line:${l.line_id}:${l.text}` : l.type === "caller_final" ? `caller:${l.turn}` : ""));
    expect(order.indexOf(`line:2:${FALLBACK_LINE}`)).toBeGreaterThan(-1);
    expect(order.indexOf("caller:2")).toBeGreaterThan(order.indexOf(`line:2:${FALLBACK_LINE}`));
    expect(sidecar.ofType("agent_line").filter((l) => l.line_id === 2)).toHaveLength(1);
    expect(sidecar.ofType("error")).toHaveLength(0);
  }, withReadyWait(90_000));

  it("cuts the partial speech of a reply that fails mid-stream before speaking the fallback", async () => {
    // Long reply speech, so the partial reply is still speaking when the error lands.
    const dg = await fakeDeepgram({ apiKey: "dg-key-not-real", chunksFor: (t) => (t.startsWith("Hi ") ? 3 : 40), speechChunkMs: 20 });
    const url = await azureFailingMidStream();
    const sidecar = startSidecar({ DEEPGRAM_API_KEY: "dg-key-not-real", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: url, AZURE_FOUNDRY_KEY: "az-key-not-real" });
    cleanup.push(() => sidecar.kill(), () => dg.close());
    sidecar.send(defaultStart());
    await sidecar.waitForType("ready");
    await sidecar.waitForType("agent_line");
    await sleep(500);
    sidecar.send({ type: "caller_text", text: "hello" });
    await sidecar.waitForType("caller_final");
    sidecar.send({ type: "guidance", turn: 1, text: null });
    const [warning] = await sidecar.waitForType("warning", 1, 40_000);
    expect(warning).toEqual({ type: "warning", code: "azure_failed" });
    await sidecar.waitFor(() => sidecar.ofType("agent_line").some((l) => l.line_id === 2), 15_000);
    await sleep(1500);
    // The partial reply is cut (its speech is not credited to the fallback), and the fallback is reported as itself.
    expect(sidecar.ofType("agent_line").filter((l) => l.line_id === 2)).toEqual([{ type: "agent_line", line_id: 2, text: FALLBACK_LINE, interrupted: false }]);
    expect(sidecar.ofType("cleared")).toEqual([{ type: "cleared", reason: "reply_failed" }]);
    for (const line of sidecar.ofType("agent_line").filter((l) => l.line_id === 1)) expect(line.interrupted).toBe(true);
    expect(sidecar.ofType("agent_line")).toHaveLength(sidecar.ofType("agent_line").some((l) => l.line_id === 1) ? 3 : 2);
    expect(sidecar.ofType("error")).toHaveLength(0);
  }, withReadyWait(80_000));

  it("writes no message text, exception text or local values to standard error", async () => {
    // Loads the sidecar's module (its logging setup) without running the call, then logs the ways a library might.
    const probe = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("sidecar_probe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
import asyncio, logging, warnings
from loguru import logger
secret = "provider text that must not surface"
try:
    raise RuntimeError(secret)
except RuntimeError:
    logger.exception(secret)
    logging.getLogger("probe").exception(secret)
logger.warning(secret)
logging.getLogger("probe").warning(secret)
warnings.warn(secret)
async def fails():
    raise RuntimeError(secret)
async def main():
    asyncio.get_running_loop().create_task(fails())
    await asyncio.sleep(0.05)
asyncio.run(main())
import gc
gc.collect()
print("done", flush=True)
`;
    const child = spawn(pythonPath!, ["-I", "-u", "-c", probe, deepgramSidecarPath], { env: { PATH: "/usr/bin:/bin", PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.once("close", r));
    expect(code).toBe(0);
    expect(stdout).toContain("done");
    expect(stderr).not.toContain("provider text");
    expect(stderr).not.toContain("secret");
    expect(stderr).not.toContain("Traceback");
    // Still something to go on: a level and where it came from, one record per line.
    const lines = stderr.split("\n").filter(Boolean);
    expect(lines.filter((l) => l.startsWith("ERROR")).length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l.startsWith("WARNING")).length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.length).toBeLessThan(200);
  }, READY_WAIT_MS + 20_000);
});
