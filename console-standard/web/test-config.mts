// Plain test script: run from the repository root with node_modules/.bin/tsx console-standard/web/test-config.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOptions, fetchPromptSetups, validateConfig } from "./configs-plugin.ts";

const schema = JSON.parse(readFileSync(new URL("../configs-schema.json", import.meta.url), "utf8"));
const d = schema.defaults;
const base = { name: "Test", sttModel: d.sttModel, replyDeployment: d.replyDeployment, voice: d.voice, endpointingMs: d.endpointingMs, vadStopSecs: d.vadStopSecs };
const refuses = (raw: unknown, field?: string) => assert.throws(() => validateConfig(raw), field ? new RegExp(field) : undefined);
let count = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { count++; console.log(`ok  ${name}`); });

await ok("missing new fields take the defaults", () => {
  const c = validateConfig(base);
  for (const k of ["voicePath", "orchestration", "promptSetup", "lead", "direction"]) assert.equal((c as any)[k], d[k]);
});
await ok("every allowed value is accepted", () => {
  for (const voicePath of schema.voicePaths) for (const orchestration of schema.orchestrations) for (const lead of schema.leads) for (const direction of schema.directions) {
    validateConfig({ ...base, voicePath, orchestration, lead, direction, promptSetup: "a-b-1" });
  }
  for (const sttModel of schema.sttModels) validateConfig({ ...base, sttModel });
  for (const replyDeployment of schema.replyDeployments) validateConfig({ ...base, replyDeployment });
  validateConfig({ ...base, voice: "aura-2-zeus-en", endpointingMs: 100, vadStopSecs: 1.0 });
});
await ok("unknown keys and bad values are refused", () => {
  refuses({ ...base, extra: 1 }, "field extra");
  refuses({ ...base, id: "x" }, "field id");
  refuses({ ...base, voicePath: "azure_speech_to_speech" }, "voicePath");
  refuses({ ...base, orchestration: "other" }, "orchestration");
  refuses({ ...base, promptSetup: "Bad Id" }, "promptSetup");
  refuses({ ...base, promptSetup: 5 }, "promptSetup");
  refuses({ ...base, lead: "lead-9" }, "lead");
  refuses({ ...base, direction: "sideways" }, "direction");
  refuses({ ...base, voice: "aura-2-THALIA-en" }, "voice");
  refuses({ ...base, endpointingMs: 50 }, "endpointingMs");
  refuses({ ...base, vadStopSecs: 2 }, "vadStopSecs");
  refuses([], "config");
  refuses(null, "config");
});
await ok("options shape", async () => {
  const o = await buildOptions(async () => [{ id: "default", label: "Default", description: "" }]);
  assert.equal(o.voices.length, 10);
  for (const v of o.voices) assert.match(v.id, new RegExp(schema.voicePattern));
  assert.deepEqual(o.sttModels.map((c) => c.id), schema.sttModels);
  assert.deepEqual(o.replyDeployments.map((c) => c.id), schema.replyDeployments);
  assert.deepEqual(o.leads.map((c) => c.id), schema.leads);
  assert.deepEqual(o.directions.map((c) => c.id), schema.directions);
  assert.deepEqual(o.orchestrations.map((c) => c.id), schema.orchestrations);
  const azure = o.voicePaths.find((c) => c.id === "azure_speech_to_speech");
  assert.equal(azure?.available, false);
  assert.equal(azure?.reason, "not built yet");
  assert.equal(o.voicePaths.find((c) => c.id === "cascaded_deepgram")?.available, true);
  for (const c of [...o.sttModels, ...o.replyDeployments, ...o.voices, ...o.orchestrations, ...o.leads, ...o.directions]) assert.ok(c.label && c.description);
  for (const c of o.endpointingMs) assert.ok(c.id >= schema.endpointingMs.min && c.id <= schema.endpointingMs.max);
  for (const c of o.vadStopSecs) assert.ok(c.id >= schema.vadStopSecs.min && c.id <= schema.vadStopSecs.max);
});
await ok("options hold no credentials", async () => {
  const text = JSON.stringify(await buildOptions(async () => []));
  assert.doesNotMatch(text, /api[_-]?key|secret|token|password|bearer|authorization|sk-[a-z0-9]/i);
});
await ok("prompt setups: fetched, filtered, or just default", async () => {
  const resp = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const list = await fetchPromptSetups(resp([{ id: "warm-1", name: "Warm" }, "Bad Id", { id: "warm-1" }, "default"]));
  assert.deepEqual(list.map((c) => c.id), ["warm-1", "default"]);
  assert.deepEqual((await fetchPromptSetups(resp({ promptSetups: ["x1"] }))).map((c) => c.id), ["default", "x1"]);
  assert.deepEqual((await fetchPromptSetups(resp({}, 500))).map((c) => c.id), ["default"]);
  assert.deepEqual((await fetchPromptSetups((async () => { throw new Error("down"); }) as unknown as typeof fetch)).map((c) => c.id), ["default"]);
  assert.deepEqual((await fetchPromptSetups(resp("nonsense"))).map((c) => c.id), ["default"]);
});
console.log(`${count} groups passed`);
