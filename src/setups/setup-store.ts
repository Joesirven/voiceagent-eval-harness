/**
 * Named setups, saved as small JSON files in the gitignored data directory
 * (directory mode 0o700, files 0o600). A setup is only a set of choices:
 * the voice module, the decision module, the prompt setup, the lead and the
 * call direction. A run stores a full snapshot of what these resolved to, so
 * editing a setup later never changes what an earlier run says it used.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR_ENV, DEFAULT_DATA_DIR } from "../store/held-stops.js";
import { UUID } from "./util.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;

export interface NamedSetup {
  name: string;
  voiceModuleId: string;
  decisionModuleId: string;
  promptSetupId: string;
  leadId: string;
  direction: "inbound" | "outbound";
  /** A fixed persona from the lead scripts; absent means one is chosen from the lead. */
  personaId?: string;
  notes?: string;
  savedAt: string;
}

export type SetupInput = Omit<NamedSetup, "savedAt">;

function setupsDir(): string {
  return join(resolve(process.env[DATA_DIR_ENV] ?? DEFAULT_DATA_DIR), "setups");
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function validateSetupInput(input: SetupInput): void {
  if (!NAME.test(input.name)) throw new Error("bad_setup_name");
  if (!slug(input.name)) throw new Error("bad_setup_name");
  if (!UUID.test(input.leadId)) throw new Error("bad_lead_id");
  if (input.direction !== "inbound" && input.direction !== "outbound") throw new Error("bad_direction");
  for (const key of ["voiceModuleId", "decisionModuleId", "promptSetupId"] as const) {
    if (typeof input[key] !== "string" || !/^[\w.-]{1,80}$/.test(input[key])) throw new Error(`bad_${key}`);
  }
  if (input.personaId !== undefined && !/^[\w-]{1,100}$/.test(input.personaId)) throw new Error("bad_persona_id");
  if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 500)) throw new Error("bad_notes");
}

export class SetupStore {
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Saves under the name, replacing a setup with the same name (the file is the only copy, so the page asks first). */
  save(input: SetupInput): NamedSetup {
    validateSetupInput(input);
    const dir = setupsDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      chmodSync(dir, DIR_MODE);
    }
    const setup: NamedSetup = {
      name: input.name,
      voiceModuleId: input.voiceModuleId,
      decisionModuleId: input.decisionModuleId,
      promptSetupId: input.promptSetupId,
      leadId: input.leadId,
      direction: input.direction,
      ...(input.personaId ? { personaId: input.personaId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      savedAt: this.now().toISOString(),
    };
    writeFileSync(join(dir, `${slug(input.name)}.json`), JSON.stringify(setup, null, 2) + "\n", { mode: FILE_MODE });
    return setup;
  }

  exists(name: string): boolean {
    return existsSync(join(setupsDir(), `${slug(name)}.json`));
  }

  get(name: string): NamedSetup | undefined {
    const s = slug(name);
    if (!s) return undefined;
    const file = join(setupsDir(), `${s}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as NamedSetup;
    } catch {
      return undefined;
    }
  }

  list(): NamedSetup[] {
    const dir = setupsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf8")) as NamedSetup;
        } catch {
          return undefined;
        }
      })
      .filter((s): s is NamedSetup => s !== undefined && typeof s.name === "string")
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
}

export const setupStore = new SetupStore();
