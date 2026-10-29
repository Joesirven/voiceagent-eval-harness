import { afterEach, describe, expect, it } from "vitest";
import { fakeAzureChat } from "../helpers/fake-azure-chat.js";
import { fakeDeepgram } from "../helpers/fake-deepgram.js";
import { defaultStart, pythonPath, startSidecar, withReadyWait } from "../helpers/deepgram-sidecar.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function rig() {
  const dg = await fakeDeepgram({ apiKey: "k" });
  const az = await fakeAzureChat({ apiKey: "a", reply: () => "ok" });
  const sidecar = startSidecar({ DEEPGRAM_API_KEY: "k", DEEPGRAM_BASE_URL: dg.baseUrl, AZURE_FOUNDRY_URL: az.url, AZURE_FOUNDRY_KEY: "a" });
  cleanup.push(() => sidecar.kill(), () => az.close(), () => dg.close());
  return { dg, sidecar };
}

describe.skipIf(!pythonPath)("pipecat deepgram sidecar speech to text model", () => {
  it("uses the speech to text model Node chose", async () => {
    const { dg, sidecar } = await rig();
    sidecar.send(defaultStart({ stt_model: "nova-2-phonecall" }));
    await sidecar.waitForType("ready");
    await sidecar.waitFor(() => dg.seen.listenUrls.length > 0);
    expect(dg.seen.listenUrls[0]).toMatch(/model=nova-2-phonecall/);
  }, withReadyWait(30_000));

  it("refuses a speech to text model that could change the query string", async () => {
    const { sidecar } = await rig();
    sidecar.send(defaultStart({ stt_model: "nova-3&encoding=x" }));
    await sidecar.waitFor(() => sidecar.lines.length > 0);
    expect(sidecar.lines[0]).toEqual({ id: 0, error: "failed" });
  }, withReadyWait(30_000));
});
