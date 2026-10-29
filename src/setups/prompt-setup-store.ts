/**
 * Custom prompt setups on disk. One JSON file holds every setup that is not shipped.
 * The file is written whole to a temporary file next to it and then renamed over it,
 * so a reader never sees a half-written file. Shipped setups are never read from or
 * written to this file, and a shipped id in the file is skipped on load.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getPromptSetupRegistry, type PromptSetupRegistry } from "../behaviour/prompt/setups.js";
import { PROMPT_LAYERS, type PromptSetup } from "../behaviour/prompt/types.js";

export const DEFAULT_PROMPT_SETUPS_FILE = "data/prompt-setups.local.json";

export function promptSetupsFilePath(): string {
  return resolve(process.env.VOICE_HARNESS_PROMPT_SETUPS_FILE?.trim() || DEFAULT_PROMPT_SETUPS_FILE);
}

/** Writes the custom setups of the registry to the file, atomically. */
export function saveCustomSetups(registry: PromptSetupRegistry = getPromptSetupRegistry(), file = promptSetupsFilePath()): void {
  const setups: PromptSetup[] = registry
    .list()
    .filter((s) => !s.shipped)
    .map(({ shipped: _shipped, ...setup }) => setup);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ setups }, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch (err) {
    if (existsSync(temp)) unlinkSync(temp);
    throw err;
  }
}

/** Registers the saved setups. A missing or unreadable file registers nothing. Returns the ids registered and the problems found. */
export function loadCustomSetups(registry: PromptSetupRegistry = getPromptSetupRegistry(), file = promptSetupsFilePath()): { loaded: string[]; errors: string[] } {
  if (!existsSync(file)) return { loaded: [], errors: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { loaded: [], errors: ["file_unreadable"] };
  }
  const { setups, errors } = registry.parseSetups(text);
  const loaded: string[] = [];
  for (const setup of setups) {
    // The disclosure layer is always part of a saved setup, even if the file was edited by hand to leave it out.
    const layers = PROMPT_LAYERS.filter((l) => l === "disclosure" || setup.layers.includes(l));
    registry.register({ ...setup, layers });
    loaded.push(setup.id);
  }
  return { loaded, errors };
}

const loadedRegistries = new WeakSet<PromptSetupRegistry>();

/** Loads the file into the current registry once per registry (first use, and at server start). */
export function ensureCustomSetupsLoaded(): void {
  const registry = getPromptSetupRegistry();
  if (loadedRegistries.has(registry)) return;
  loadedRegistries.add(registry);
  loadCustomSetups(registry);
}
