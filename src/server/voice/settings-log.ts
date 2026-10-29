/**
 * One server log line per module setting that changed, with the old value, the
 * new value and who asked (the `source` field of the POST body, for example
 * "settings-sheet"). This is how the next "who switched the model" question is
 * answered from the log. Values are setting names and numbers only.
 */

import type { ModuleConfig } from "../../modules/base-module.js";

const SOURCE = /^[a-z][a-z0-9_-]{0,40}$/;
const VALUE = /^[A-Za-z0-9_.:-]{0,64}$/;

/** A source token safe for the log; anything else is "unknown". */
export function settingSource(raw: unknown): string {
  return typeof raw === "string" && SOURCE.test(raw) ? raw : "unknown";
}

const shown = (v: unknown): string => {
  const s = String(v);
  return VALUE.test(s) ? s : "(unprintable)";
};

export function logModuleChanges(
  moduleId: string,
  before: ModuleConfig,
  after: ModuleConfig,
  source: string,
  log: (line: string) => void = (line) => console.log(line),
): void {
  const flat = (c: ModuleConfig): Record<string, unknown> => ({
    enabled: c.enabled,
    voice: c.voice,
    model: c.model,
    ...Object.fromEntries(Object.entries(c.latency).map(([k, v]) => [`latency.${k}`, v])),
  });
  const a = flat(before);
  const b = flat(after);
  for (const field of Object.keys(b)) {
    if (a[field] !== b[field]) log(`module setting changed module=${moduleId} field=${field} old=${shown(a[field])} new=${shown(b[field])} source=${settingSource(source)}`);
  }
}
