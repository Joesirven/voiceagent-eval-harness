// Contract test between the page and the bot. Run from the repository root: node_modules/.bin/tsx console-standard/test-contract.mts
// Every choice the page offers is turned into a start body setting and checked by the page server validator and by the bot validator (python); both must agree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildOptions, validateConfig } from "./web/configs-plugin.ts";
import { SETTING_KEYS } from "./web/src/config/options.ts";

const here = new URL(".", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(`${here}configs-schema.json`, "utf8"));
const seed = JSON.parse(readFileSync(`${here}configs.seed.json`, "utf8"));
const python = "/tmp/crm-console-standard-venv/bin/python";

// The fields the page sends are exactly the schema's settings fields.
assert.deepEqual([...SETTING_KEYS].sort(), Object.keys(schema.defaults).sort(), "start body fields differ from schema defaults");

const options = await buildOptions(async () => [{ id: "default", label: "Default", description: "" }, { id: "warm-1", label: "Warm", description: "" }]);
const groups: [string, { id: string | number; available?: boolean }[]][] = [
  ["voicePath", options.voicePaths], ["sttModel", options.sttModels], ["replyDeployment", options.replyDeployments], ["voice", options.voices],
  ["endpointingMs", options.endpointingMs], ["vadStopSecs", options.vadStopSecs], ["orchestration", options.orchestrations],
  ["promptSetup", options.promptSetups], ["lead", options.leads], ["direction", options.directions],
];
assert.deepEqual(groups.map(([k]) => k).sort(), [...SETTING_KEYS].sort(), "options do not cover every setting");

type Case = { label: string; settings: Record<string, unknown>; expectAccepted: boolean };
const cases: Case[] = [{ label: "defaults", settings: { ...schema.defaults }, expectAccepted: true }];
for (const [key, list] of groups) for (const choice of list) {
  cases.push({ label: `${key}=${choice.id}`, settings: { ...schema.defaults, [key]: choice.id }, expectAccepted: choice.available !== false });
}
for (const entry of seed) {
  const { id, name, note, ...rest } = entry;
  cases.push({ label: `seed ${id}`, settings: { ...schema.defaults, ...rest }, expectAccepted: true });
}

const pageVerdict = (settings: Record<string, unknown>) => {
  try { validateConfig({ name: "Contract", ...settings }); return true; } catch { return false; }
};
const botScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(`${here}bot`)})
from settings import SettingsError, from_body
out = []
for body in json.load(sys.stdin):
    try:
        from_body(body)
        out.append(True)
    except SettingsError:
        out.append(False)
print(json.dumps(out))
`;
const botVerdicts: boolean[] = JSON.parse(execFileSync(python, ["-I", "-c", botScript], {
  input: JSON.stringify(cases.map((c) => ({ config: c.settings }))), encoding: "utf8",
}));
assert.equal(botVerdicts.length, cases.length);

cases.forEach((c, i) => {
  const page = pageVerdict(c.settings);
  assert.equal(page, botVerdicts[i], `page validator (${page}) and bot validator (${botVerdicts[i]}) disagree on ${c.label}`);
  assert.equal(page, c.expectAccepted, `${c.label}: expected ${c.expectAccepted ? "accepted" : "refused"}`);
});

// Values outside the schema are refused by both.
const bad: Record<string, unknown>[] = [
  { voicePath: "azure_speech_to_speech" }, { orchestration: "x" }, { promptSetup: "Bad Id" }, { lead: "lead-9" }, { direction: "x" },
  { endpointingMs: 99 }, { endpointingMs: 1501 }, { endpointingMs: 300.5 }, { vadStopSecs: 0.05 }, { vadStopSecs: 1.01 },
  { sttModel: "x" }, { replyDeployment: "x" }, { voice: "aura-2-X-en" }, { extra: 1 },
];
const badCases = bad.map((b) => ({ ...schema.defaults, ...b }));
const badBot: boolean[] = JSON.parse(execFileSync(python, ["-I", "-c", botScript], { input: JSON.stringify(badCases.map((c) => ({ config: c }))), encoding: "utf8" }));
badCases.forEach((c, i) => {
  assert.equal(pageVerdict(c), false, `page accepted ${JSON.stringify(bad[i])}`);
  assert.equal(badBot[i], false, `bot accepted ${JSON.stringify(bad[i])}`);
});
// A start body with only some fields: both fill the rest from the defaults.
assert.equal(pageVerdict({ sttModel: schema.defaults.sttModel, replyDeployment: "default", voice: schema.defaults.voice, endpointingMs: 300, vadStopSecs: 0.2 }), true);
console.log(`contract test passed: ${cases.length} offered choices and ${bad.length} refused values agree`);
