import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const voiceSidecarPath = fileURLToPath(new URL("./pipecat/sidecar_voice.py", import.meta.url));

/** Debugging switches the sidecar's devtools.py reads; only set values pass, never anything else. */
export function pipecatDevtoolsEnv(env: NodeJS.ProcessEnv = process.env, callId?: string): Record<string, string> {
  const mode = env.CRM_WHISKER?.trim().toLowerCase();
  if (mode !== "file" && mode !== "live") return {};
  const out: Record<string, string> = { CRM_WHISKER: mode };
  for (const key of ["CRM_WHISKER_PORT", "CRM_WHISKER_DIR"]) if (env[key]) out[key] = env[key]!;
  if (callId) out.CRM_CALL_ID = callId;
  return out;
}

/** Pinned interpreter for Pipecat sidecars. Never read from browser input. */
export function resolvePipecatPython(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pythonPath = env.VOICE_HARNESS_PIPECAT_PYTHON?.trim();
  if (!pythonPath || !isAbsolute(pythonPath) || !existsSync(pythonPath)) return undefined;
  if (!existsSync(voiceSidecarPath)) return undefined;
  return pythonPath;
}

export function pipecatVoiceSidecarPath(): string {
  return voiceSidecarPath;
}
