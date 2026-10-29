/**
 * One read-only listing of the deployments on the configured Azure endpoint. No
 * model is invoked. Prints deployment name, model, version and a rough kind;
 * never prints the endpoint host or the key. Needs VOICE_HARNESS_DEV_ENV_FILE.
 *
 * The settings come through loadFoundryConfig, the same checked path every
 * other Azure call uses: the dotenv must be mode 600 or tighter, and the URL
 * must be HTTPS on an Azure host, so the key is never sent anywhere else.
 */
import { fileURLToPath } from "node:url";
import { loadFoundryConfig, type FoundryConfigFileSystem } from "../src/models/foundry.js";

const kindOf = (id: string, caps: Record<string, unknown> = {}): string => {
  const s = id.toLowerCase();
  // Transcription and translation first: gpt-live-transcribe and gpt-realtime-translate are not voice session models.
  if (/transcribe|whisper|stt/.test(s)) return "transcription";
  if (/translate/.test(s)) return "translation";
  // Only the gpt-live family starts a session on the live protocol (/live/sessions) the harness speaks.
  if (/^gpt-live-\d/.test(s)) return "live";
  if (/realtime/.test(s)) return "realtime (not the live protocol)";
  if (/embed/.test(s)) return "embedding";
  if (/claude/.test(s)) return "claude";
  if (/tts|speech/.test(s)) return "speech";
  if (caps.chat_completion || /gpt|o\d|chat/.test(s)) return "chat";
  return "other";
};

export interface ListDeps {
  env?: Record<string, string | undefined>;
  fs?: FoundryConfigFileSystem;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Exit code 0 when the listing was printed, 1 otherwise. Errors are fixed codes only. */
export async function listAzureDeployments(deps: ListDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    const config = loadFoundryConfig(deps.env ?? process.env, deps.fs);
    // The data-plane deployment listing: GET /models would be Azure's whole model catalog, not this resource's deployments.
    // A redirect could carry the api-key header to another host, so none is followed.
    const res = await (deps.fetch ?? fetch)(`${new URL(config.baseUrl).origin}/openai/deployments?api-version=2022-12-01`, {
      headers: { "api-key": config.apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    log(`listing status=${res.status}`);
    if (!res.ok) throw new Error("azure_listing_failed");
    const body = (await res.json()) as { data?: Array<Record<string, any>> };
    for (const d of body.data ?? []) {
      log(JSON.stringify({ deployment: d.id, model: d.model ?? d.base_model ?? null, version: d.version ?? d.model_version ?? null, kind: kindOf(String(d.model ?? d.id), d.capabilities) }));
    }
    const named = { AZURE_FAST_DEPLOYMENT: config.deployments.fast, AZURE_LONG_DEPLOYMENT: config.deployments.long, AZURE_REPLY_DEPLOYMENT: config.deployments.reply };
    for (const [name, value] of Object.entries(named)) log(value ? `${name} = ${value}` : `${name} not set in the dotenv`);
    return 0;
  } catch (err) {
    const code = err instanceof Error && /^[a-z][a-zA-Z0-9_]{0,60}$/.test(err.message) ? err.message : "azure_listing_failed";
    log(`listing failed: ${code}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await listAzureDeployments();
}
