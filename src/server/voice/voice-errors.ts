/**
 * The one catalog of voice errors and the one way to report them.
 *
 * Every failure on the voice paths (direct Azure, Pipecat, Deepgram, and the
 * Python sidecars) ends up here with a fixed code. The catalog gives each code a
 * plain title, what happened and a concrete fix. `reportVoiceError` turns a code
 * into a record, keeps it in a short recent list (served in /api/state, also for
 * errors outside any call), emits a `voice_error` trace event when a call is
 * traced, and marks Azure as not working when the code means exactly that.
 *
 * Nothing here ever carries a key, a hostname or provider text: records are
 * built only from the fixed catalog text and the code.
 */

import { traceBus, type TraceContext } from "../../trace/index.js";
import { markAzureFailed } from "../azure-startup-check.js";

export type VoiceErrorSeverity = "error" | "warning";
/** Which voice path the error belongs to; "server" is anything outside a path. */
export type VoiceErrorPath = "azure_gpt_live" | "azure_voice_live" | "pipecat" | "deepgram" | "server";

export interface VoiceErrorEntry {
  title: string;
  /** What happened, one plain sentence. Becomes the record's detail. */
  what: string;
  /** A concrete step the person can take. */
  fix: string;
  severity: VoiceErrorSeverity;
  /** True when the call keeps going after this error. */
  canContinue: boolean;
  /** Set when the error means Azure does not work: the code the Azure block records. */
  azureBlock?: "foundry_auth" | "foundry_deployment_not_found" | `foundry_${string}`;
  path: VoiceErrorPath;
}

const SETTINGS = "the settings file named by VOICE_HARNESS_DEV_ENV_FILE";
const RESTART = "Restart the call.";

const azureSettings = (title: string, what: string, fix: string, azureBlock: VoiceErrorEntry["azureBlock"]): VoiceErrorEntry => ({
  title, what, fix, severity: "error", canContinue: false, azureBlock, path: "azure_gpt_live",
});

/** Azure Voice Live has its own resource, settings and codes: none of them sets the Azure block, which belongs to the gpt-live resource. */
const voiceLive = (title: string, what: string, fix: string): VoiceErrorEntry => ({
  title, what, fix, severity: "error", canContinue: false, path: "azure_voice_live",
});
const OR_GPT_LIVE = " Or set Voice path to Azure gpt-live.";

export const VOICE_ERROR_CATALOG = {
  azure_auth_failed: {
    title: "Azure refused the key",
    what: "Azure answered the voice connection with an authentication failure, so the key was not accepted.",
    fix: `Check AZURE_FOUNDRY_KEY in ${SETTINGS}: it must be the current key for the same Azure resource as AZURE_FOUNDRY_URL. Then start the call again. New calls stay blocked until Azure accepts the key.`,
    severity: "error", canContinue: false, azureBlock: "foundry_auth", path: "azure_gpt_live",
  },
  azure_deployment_not_found: {
    title: "Azure deployment not found",
    what: "Azure could not find the voice deployment, so it refused the connection.",
    fix: `Check that AZURE_FOUNDRY_URL in ${SETTINGS} points at the right resource and that the live deployment exists there (see AZURE_REALTIME_DEPLOYMENT). New calls stay blocked until the deployment is found.`,
    severity: "error", canContinue: false, azureBlock: "foundry_deployment_not_found", path: "azure_gpt_live",
  },
  azure_model_not_deployed: {
    title: "This model is not an allowed live deployment",
    what: "The model chosen for the voice session is not one of the live deployments this server allows, or Azure does not have it deployed.",
    fix: `Choose a model from the Model menu in Settings; it lists only the live deployments Azure reports for this resource (or, when Azure cannot be listed, those named by AZURE_REALTIME_DEPLOYMENT in ${SETTINGS}). Then start the call again.`,
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_rate_limited: {
    title: "Azure is rate limiting voice calls",
    what: "Azure answered that this key has sent too many requests for now.",
    fix: "Wait a minute and start the call again. If it keeps happening, ask for a higher limit on the Azure deployment.",
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_connect_failed: {
    title: "Could not connect to Azure",
    what: "The voice connection to Azure could not be opened.",
    fix: "Check the network connection of the machine running the harness, then start the call again. If the network is fine, check AZURE_FOUNDRY_URL in the settings file. New calls stay blocked until Azure can be reached.",
    severity: "error", canContinue: false, azureBlock: "foundry_unreachable", path: "azure_gpt_live",
  },
  azure_start_timeout: {
    title: "Azure took too long to start the call",
    what: "Azure did not answer the voice session start in time.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_session_rejected: {
    title: "Azure rejected the voice session",
    what: "Azure opened the connection but refused to start the voice session.",
    fix: "Check that the Model chosen in Settings is a live deployment the Azure resource has (Azure's own reply is in the detail), and that the resource allows live voice, then start the call again.",
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_closed_before_start: {
    title: "Azure closed the connection while starting",
    what: "Azure closed the voice connection before the session began.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_closed: {
    title: "Azure closed the call connection",
    what: "Azure closed the voice connection in the middle of the call.",
    fix: "Start the call again. If it repeats within a few minutes, check the Azure resource status and the network.",
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_error: {
    title: "Azure reported an error during the call",
    what: "Azure sent an error message during the call without a more specific reason.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "azure_gpt_live",
  },
  azure_failed: {
    title: "The Azure reply failed",
    what: "Azure could not produce the agent's reply during the call.",
    fix: "Start the call again. If it repeats, check the Azure deployment named by AZURE_REPLY_DEPLOYMENT in the settings file.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  azure_env_file_not_configured: azureSettings(
    "Settings file is not configured",
    "VOICE_HARNESS_DEV_ENV_FILE is not set, so the Azure settings cannot be read.",
    "Start the server with VOICE_HARNESS_DEV_ENV_FILE pointing at the settings file that holds AZURE_FOUNDRY_URL and AZURE_FOUNDRY_KEY.",
    "foundry_env_file_not_configured",
  ),
  azure_env_file_permissions_too_open: azureSettings(
    "Settings file is readable by others",
    "The settings file is readable by other users, so the harness refuses to read the Azure key from it.",
    `Run chmod 600 on ${SETTINGS}, then start the call again.`,
    "foundry_env_file_permissions_too_open",
  ),
  azure_env_file_unreadable: azureSettings(
    "Settings file cannot be read",
    "The settings file could not be read, so the Azure settings are unavailable.",
    `Check that ${SETTINGS} exists and that this user can read it.`,
    "foundry_env_file_unreadable",
  ),
  azure_settings_missing_url: azureSettings(
    "Azure address is missing",
    "AZURE_FOUNDRY_URL is missing from the settings file.",
    `Add AZURE_FOUNDRY_URL to ${SETTINGS}.`,
    "foundry_missing_AZURE_FOUNDRY_URL",
  ),
  azure_settings_missing_key: azureSettings(
    "Azure key is missing",
    "AZURE_FOUNDRY_KEY is missing from the settings file.",
    `Add AZURE_FOUNDRY_KEY to ${SETTINGS}.`,
    "foundry_missing_AZURE_FOUNDRY_KEY",
  ),
  azure_live_url_invalid: azureSettings(
    "Azure address is not valid",
    "AZURE_FOUNDRY_URL is not a valid URL.",
    `Correct AZURE_FOUNDRY_URL in ${SETTINGS}: it is the https address of the Azure resource.`,
    "foundry_url_invalid",
  ),
  azure_live_url_not_secure: azureSettings(
    "Azure address is not secure",
    "AZURE_FOUNDRY_URL does not use https, so the harness will not send the key to it.",
    `Change AZURE_FOUNDRY_URL in ${SETTINGS} to an https address.`,
    "foundry_url_invalid",
  ),
  azure_live_url_not_azure: azureSettings(
    "Azure address is not an Azure address",
    "AZURE_FOUNDRY_URL does not point at an Azure host, so the harness will not send the key to it.",
    `Correct AZURE_FOUNDRY_URL in ${SETTINGS} to the Azure resource address.`,
    "foundry_url_not_azure",
  ),
  azure_voice_live_env_file_not_configured: voiceLive(
    "Settings file is not configured",
    "VOICE_HARNESS_DEV_ENV_FILE is not set, so the Azure Voice Live settings cannot be read.",
    `Start the server with VOICE_HARNESS_DEV_ENV_FILE pointing at the settings file that holds AZURE_VOICE_LIVE_URL and AZURE_VOICE_LIVE_KEY.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_env_file_permissions_too_open: voiceLive(
    "Settings file is readable by others",
    "The settings file is readable by other users, so the harness refuses to read the Azure Voice Live key from it.",
    `Run chmod 600 on ${SETTINGS}, then choose Azure Voice Live again.`,
  ),
  azure_voice_live_env_file_unreadable: voiceLive(
    "Settings file cannot be read",
    "The settings file could not be read, so the Azure Voice Live settings are unavailable.",
    `Check that ${SETTINGS} exists and that this user can read it.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_missing_url: voiceLive(
    "Azure Voice Live address is missing",
    "AZURE_VOICE_LIVE_URL is missing from the settings file.",
    `Add AZURE_VOICE_LIVE_URL (the https Foundry address of the Azure resource that runs Voice Live) to ${SETTINGS}.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_missing_key: voiceLive(
    "Azure Voice Live key is missing",
    "AZURE_VOICE_LIVE_KEY is missing from the settings file.",
    `Add AZURE_VOICE_LIVE_KEY (a key of the same Azure resource as AZURE_VOICE_LIVE_URL) to ${SETTINGS}.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_url_invalid: voiceLive(
    "Azure Voice Live address is not usable",
    "AZURE_VOICE_LIVE_URL is not the https address of an Azure resource that can run Voice Live, so the harness will not send the key to it.",
    `Correct AZURE_VOICE_LIVE_URL in ${SETTINGS} to the Foundry address of the Azure resource that runs Voice Live, with no path. The resource's OpenAI address cannot run Voice Live.`,
  ),
  azure_voice_live_auth_failed: voiceLive(
    "Azure Voice Live refused the key",
    "Azure answered the Voice Live connection with an authentication failure, so the key was not accepted.",
    `Check AZURE_VOICE_LIVE_KEY in ${SETTINGS}: it must be a current key of the same Azure resource as AZURE_VOICE_LIVE_URL. Then start the call again.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_rate_limited: voiceLive(
    "Azure Voice Live is rate limiting calls",
    "Azure answered that the Voice Live resource has had too many requests for now.",
    "Wait a minute and start the call again. If it keeps happening, ask for a higher limit on the Azure Voice Live resource.",
  ),
  azure_voice_live_connect_failed: voiceLive(
    "Could not connect to Azure Voice Live",
    "The Voice Live connection to Azure could not be opened.",
    `Check the network connection of the machine running the harness, then start the call again. If the network is fine, check AZURE_VOICE_LIVE_URL in the settings file.${OR_GPT_LIVE}`,
  ),
  azure_voice_live_start_timeout: voiceLive(
    "Azure Voice Live took too long to start the call",
    "Azure Voice Live did not accept the session settings in time.",
    RESTART,
  ),
  azure_voice_live_session_rejected: voiceLive(
    "Azure Voice Live rejected the session",
    "Azure Voice Live opened the connection but refused the session or its settings (for example a model this region does not offer).",
    "Start the call again; Azure's own reply is in the detail. If it repeats, set Voice path to Azure gpt-live.",
  ),
  azure_voice_live_model_not_offered: voiceLive(
    "This model is not offered on Azure Voice Live",
    "The model or transcription chosen for Azure Voice Live is not one the harness verified on the Voice Live resource.",
    "Choose from the Model menu in Settings; it lists only the Voice Live models that passed the whole flow on this resource. Then start the call again.",
  ),
  azure_voice_live_closed_before_start: voiceLive(
    "Azure Voice Live closed the connection while starting",
    "Azure Voice Live closed the connection before the session began.",
    RESTART,
  ),
  azure_voice_live_closed: voiceLive(
    "Azure Voice Live closed the call connection",
    "Azure Voice Live closed the connection in the middle of the call.",
    "Start the call again. If it repeats within a few minutes, check the Azure Voice Live resource and the network, or set Voice path to Azure gpt-live.",
  ),
  azure_voice_live_error: voiceLive(
    "Azure Voice Live reported an error during the call",
    "Azure Voice Live sent an error that stops the call (not a refused request, which the call survives).",
    RESTART,
  ),
  azure_voice_live_needs_direct: {
    title: "Azure Voice Live needs the Direct orchestrator",
    what: "Azure Voice Live is its own hosted speech agent, and the harness reaches it directly; the orchestrator is set to Pipecat.",
    fix: "Set Orchestrator to Direct Azure, or set Voice path to Azure gpt-live or Deepgram, then start the call again.",
    severity: "error", canContinue: false, path: "azure_voice_live",
  },
  pipecat_interpreter_not_configured: {
    title: "Pipecat is not set up",
    what: "The Python interpreter for Pipecat is not configured on this machine.",
    fix: "Set VOICE_HARNESS_PIPECAT_PYTHON to the Python of the Pipecat environment and restart the server, or set Orchestrator to Direct Azure.",
    severity: "error", canContinue: false, path: "pipecat",
  },
  pipecat_not_configured: {
    title: "Pipecat is not set up",
    what: "The Python interpreter for Pipecat is not configured on this machine.",
    fix: "Set VOICE_HARNESS_PIPECAT_PYTHON to the Python of the Pipecat environment and restart the server, or set Orchestrator to Direct Azure.",
    severity: "error", canContinue: false, path: "pipecat",
  },
  pipecat_unavailable: {
    title: "The Pipecat helper could not start",
    what: "The Pipecat helper process is missing, or the Pipecat package in that Python environment is not the pinned version.",
    fix: "Check that VOICE_HARNESS_PIPECAT_PYTHON points at the environment built from src/orchestration-modules/pipecat/requirements.txt. Or set Orchestrator to Direct Azure.",
    severity: "error", canContinue: false, path: "pipecat",
  },
  pipecat_failed: {
    title: "The Pipecat helper failed",
    what: "The Pipecat helper reported a failure, so caller audio no longer reaches the model.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "pipecat",
  },
  pipecat_closed: {
    title: "The Pipecat helper stopped",
    what: "The Pipecat helper process exited while the call was open.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "pipecat",
  },
  pipecat_stopped: {
    title: "The Pipecat helper had already stopped",
    what: "Caller audio arrived after the Pipecat helper had stopped.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "pipecat",
  },
  protocol_error: {
    title: "The voice helper sent something unexpected",
    what: "A voice helper process sent a message the server could not understand.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "server",
  },
  deepgram_key_missing: {
    title: "Deepgram key is missing",
    what: "No Deepgram key was found in the settings files.",
    fix: `Add DEEPGRAM_API_KEY to ${SETTINGS}, then start the call again. Or set Voice path to Azure gpt-live.`,
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_credentials_unreadable: {
    title: "Deepgram or Azure settings could not be read",
    what: "The settings needed by the Deepgram helper could not be read from the settings files.",
    fix: `Check that ${SETTINGS} exists, is mode 600 and holds DEEPGRAM_API_KEY, AZURE_FOUNDRY_URL and AZURE_FOUNDRY_KEY.`,
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_key_rejected: {
    title: "Deepgram refused the key",
    what: "Deepgram answered with an authentication failure, so the key was not accepted.",
    fix: `Replace DEEPGRAM_API_KEY in ${SETTINGS} with a current key from the Deepgram console, then start the call again. Or set Voice path to Azure gpt-live.`,
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_sidecar_missing: {
    title: "The Deepgram helper is missing",
    what: "The Deepgram helper script was not found in the harness files.",
    fix: "Check that src/orchestration-modules/pipecat/sidecar_deepgram.py exists in this checkout. Or set Voice path to Azure gpt-live.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_unavailable: {
    title: "The Deepgram helper could not start",
    what: "The Deepgram helper process could not start, or the Pipecat package it needs is not the pinned version.",
    fix: "Check that VOICE_HARNESS_PIPECAT_PYTHON points at the environment built from src/orchestration-modules/pipecat/requirements.txt. Or set Voice path to Azure gpt-live.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_start_timeout: {
    title: "The Deepgram helper took too long to start",
    what: "The Deepgram helper did not become ready in time.",
    fix: "Start the call again. If it repeats, set Voice path to Azure gpt-live.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_failed: {
    title: "The Deepgram path failed",
    what: "The Deepgram helper reported a failure.",
    fix: "Start the call again. If it repeats, set Voice path to Azure gpt-live.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  deepgram_closed: {
    title: "The Deepgram helper stopped",
    what: "The Deepgram helper process exited while the call was open.",
    fix: "Start the call again. If it repeats, set Voice path to Azure gpt-live.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  microphone_audio_missing: {
    title: "No microphone audio is arriving",
    what: "The call is open but no caller audio has reached the server.",
    fix: "Open the harness at http://127.0.0.1:4311/ on the machine running it, allow microphone access for the tab, and check the input device. You can type a line instead.",
    severity: "warning", canContinue: true, path: "server",
  },
  text_not_sent: {
    title: "The typed line was not sent",
    what: "A typed caller line could not be delivered to the voice session.",
    fix: "Send the line again. If the call has ended, start a new call.",
    severity: "warning", canContinue: true, path: "server",
  },
  call_not_cleared: {
    title: "The call was not cleared",
    what: "The harness did not clear this call, so no voice session was opened.",
    fix: "Start the call again from the Call tab so the harness checks it first.",
    severity: "error", canContinue: false, path: "server",
  },
  voice_session_already_open: {
    title: "A voice call is already open",
    what: "Only one live voice call can run at a time, and one is still open.",
    fix: "Hang up the open call, then start the new one.",
    severity: "error", canContinue: false, path: "server",
  },
  voice_module_unavailable: {
    title: "The voice module is unavailable",
    what: "The Azure live voice module is not registered in this server.",
    fix: "Restart the server. If it repeats, check the server start log for module errors.",
    severity: "error", canContinue: false, path: "server",
  },
  disclosure_unavailable: {
    title: "The opening line is missing",
    what: "The call has no opening disclosure line yet, so the agent cannot speak first.",
    fix: "Start the call again from the Call tab.",
    severity: "error", canContinue: false, path: "server",
  },
  lead_not_found: {
    title: "The lead was not found",
    what: "The lead for this call could not be loaded from the lead store.",
    fix: "Pick the lead again and start the call. If it repeats, check the lead store connection.",
    severity: "error", canContinue: false, path: "server",
  },
  unknown_orchestrator: {
    title: "Unknown orchestrator",
    what: "The page asked for an orchestrator the server does not know.",
    fix: "Set Orchestrator to Direct Azure or Pipecat.",
    severity: "warning", canContinue: true, path: "server",
  },
  deepgram_model_not_offered: {
    title: "This Deepgram model is not offered",
    what: "The page asked for a Deepgram speech to text model or speech voice that the Deepgram model listing does not offer.",
    fix: "Choose the model again from the Settings menu; it lists only the models Deepgram offers this account.",
    severity: "warning", canContinue: true, path: "deepgram",
  },
  deepgram_needs_pipecat: {
    title: "Deepgram needs the Pipecat orchestrator",
    what: "The Deepgram speech path runs through the Pipecat helper, and the orchestrator is set to Direct Azure.",
    fix: "Set Orchestrator to Pipecat, or set Voice path to Azure gpt-live, then start the call again.",
    severity: "error", canContinue: false, path: "deepgram",
  },
  unknown_voice_path: {
    title: "Unknown speech path",
    what: "The page asked for a speech path the server does not know.",
    fix: "Set Voice path to Azure gpt-live, Azure Voice Live or Deepgram.",
    severity: "warning", canContinue: true, path: "server",
  },
  unknown_model_role: {
    title: "Unknown model slot",
    what: "The page asked to set a model for a slot the speech path does not have.",
    fix: "Choose the model again from the Settings menu; it only offers the slots each speech path has.",
    severity: "warning", canContinue: true, path: "server",
  },
  voice_not_offered: {
    title: "This voice is not offered for the model",
    what: "The page asked for a voice the chosen model cannot speak with.",
    fix: "Choose a voice from the Voice menu in Settings; it lists only the voices the chosen model offers.",
    severity: "warning", canContinue: true, path: "server",
  },
  bad_path_model_choice: {
    title: "Model choice not understood",
    what: "The page sent a model choice without a speech path, slot or model name.",
    fix: "Choose the model again from the Settings menu.",
    severity: "warning", canContinue: true, path: "server",
  },
  decision_router_unknown: {
    title: "Unknown decision router",
    what: "The page asked for a decision router, or a speech path, that the server does not know.",
    fix: "Choose the decision router again from the Settings menu; it lists only the routers each speech path offers.",
    severity: "warning", canContinue: true, path: "server",
  },
  decision_router_not_supported: {
    title: "This speech path cannot use that decision router",
    what: "Pipecat Flows and the Pipecat classifier need a cascaded pipeline (speech to text, reply, speech), and Azure gpt-live and Azure Voice Live are speech to speech, so they only run the decision model.",
    fix: "Keep Decision model on Azure gpt-live or Azure Voice Live, or set Voice path to Deepgram and choose the router there.",
    severity: "warning", canContinue: true, path: "azure_gpt_live",
  },
  decision_router_unavailable: {
    title: "This decision router cannot run yet",
    what: "The decision router is listed for this speech path but its runtime is not wired in, so the call would have nothing to run it.",
    fix: "Keep Decision model for now; the Settings menu shows why each router is unavailable and offers it once it can run.",
    severity: "warning", canContinue: true, path: "server",
  },
  unknown_stale_output_drop: {
    title: "Unknown barge-in setting",
    what: "The page asked for a barge-in output setting the server does not know.",
    fix: "Set the drop-after-barge-in setting to Off, One gap or Two gaps.",
    severity: "warning", canContinue: true, path: "server",
  },
  voice_start_failed: {
    title: "The voice call could not start",
    what: "The voice session failed to start for a reason the server could not name.",
    fix: RESTART,
    severity: "error", canContinue: false, path: "server",
  },
  voice_unknown_error: {
    title: "A voice error with no known cause",
    what: "A voice path reported an error code that is not in the catalog.",
    fix: "Start the call again. If it repeats, send the call id to the harness maintainers so the code can be added.",
    severity: "error", canContinue: false, path: "server",
  },
} as const satisfies Record<string, VoiceErrorEntry>;

export type VoiceErrorCode = keyof typeof VOICE_ERROR_CATALOG;

/** Older or provider-side codes that map onto a catalog code. */
const ALIASES: Record<string, VoiceErrorCode> = {
  deepgram_error: "deepgram_failed",
};

export function isVoiceErrorCode(code: string): code is VoiceErrorCode {
  return Object.prototype.hasOwnProperty.call(VOICE_ERROR_CATALOG, code);
}

/** A catalog code for any raw code; unknown ones become voice_unknown_error, never passed through. */
export function normalizeVoiceErrorCode(raw: string): VoiceErrorCode {
  if (isVoiceErrorCode(raw)) return raw;
  return ALIASES[raw] ?? "voice_unknown_error";
}

export interface VoiceErrorRecord {
  /** Counts up from 1 in this process; the page uses it to show each error once. */
  id: number;
  code: VoiceErrorCode;
  title: string;
  detail: string;
  fix: string;
  severity: VoiceErrorSeverity;
  canContinue: boolean;
  /** True when Azure is not working and new calls are refused until it works again. */
  blocksNewCalls: boolean;
  path: VoiceErrorPath;
  callId?: string;
  at: string;
}

export const RECENT_VOICE_ERRORS_LIMIT = 20;

/** What to try when a plain restart does not help, by the path the call is on. */
const IF_IT_REPEATS: Record<VoiceErrorPath, string> = {
  azure_gpt_live: " If it repeats, check the Azure resource status and the network.",
  azure_voice_live: " If it repeats, check the Azure Voice Live resource and the network, or set Voice path to Azure gpt-live.",
  pipecat: " If it repeats, set Orchestrator to Direct Azure.",
  deepgram: " If it repeats, set Voice path to Azure gpt-live.",
  server: "",
};

let nextId = 1;
const recent: VoiceErrorRecord[] = [];

/** Newest last. A copy, safe to serve. */
export function recentVoiceErrors(): VoiceErrorRecord[] {
  return recent.map((r) => ({ ...r }));
}

export function resetVoiceErrors(): void {
  recent.length = 0;
  nextId = 1;
}

export interface ReportOptions {
  /** Present for an error inside a traced call: the event goes on that call's trace. */
  trace?: TraceContext;
  /** For a call without a trace context (for example the lead was not found). */
  callId?: string;
  path?: VoiceErrorPath;
  /** True when the harness is trying once more: the record is a warning and the call can still continue. */
  retrying?: boolean;
  /** Azure's own error type and code (identifier tokens only), appended to the detail. */
  providerDetail?: string;
  /** For azure_model_not_deployed: the model that was refused and the live deployments allowed (names only). */
  refusedModel?: { model: string; allowed: string[] };
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function refusedModelSentence(r: ReportOptions["refusedModel"]): string {
  if (!r) return "";
  const model = MODEL_NAME.test(r.model) ? r.model : "(unreadable name)";
  const allowed = r.allowed.filter((n) => MODEL_NAME.test(n));
  return ` Model: ${model}; live deployments allowed: ${allowed.length ? allowed.join(", ") : "none"}.`;
}

/**
 * The one way a voice error is emitted: recent list, trace event (when the call
 * is traced) and, for Azure-not-working codes, the Azure block that refuses new
 * calls. Never throws.
 */
export function reportVoiceError(rawCode: string, options: ReportOptions = {}): VoiceErrorRecord {
  const code = normalizeVoiceErrorCode(rawCode);
  const entry: VoiceErrorEntry = VOICE_ERROR_CATALOG[code];
  const callId = options.trace?.callId ?? options.callId;
  const path = options.path ?? entry.path;
  const record: VoiceErrorRecord = {
    id: nextId++,
    code,
    title: entry.title,
    detail:
      (options.retrying ? `${entry.what} The harness is trying once more.` : entry.what) +
      (options.providerDetail && /^[A-Za-z0-9_.\/ -]{1,130}$/.test(options.providerDetail) ? ` Azure said: ${options.providerDetail}.` : "") +
      refusedModelSentence(options.refusedModel),
    fix: entry.fix === RESTART ? entry.fix + IF_IT_REPEATS[path] : entry.fix,
    severity: options.retrying ? "warning" : entry.severity,
    canContinue: options.retrying ? true : entry.canContinue,
    blocksNewCalls: entry.azureBlock !== undefined && !options.retrying,
    path,
    ...(callId ? { callId } : {}),
    at: new Date().toISOString(),
  };
  recent.push(record);
  if (recent.length > RECENT_VOICE_ERRORS_LIMIT) recent.shift();
  const c = options.trace;
  if (c) {
    try {
      const { callId: _callId, ...data } = record;
      traceBus.emit({
        type: "voice_error", leadId: c.leadId, leadLabel: c.leadLabel, recordId: c.recordId, channel: c.channel,
        direction: c.direction, callId: c.callId, data,
      });
    } catch {
      /* a trace failure never hides the error from the list */
    }
  }
  // After the caller of this function has told the page: the block ends calls in progress, which closes the socket.
  if (entry.azureBlock && !options.retrying) {
    const code = entry.azureBlock;
    queueMicrotask(() => markAzureFailed(code));
  }
  return record;
}

/** The browser socket frame for a record: the record's fields under type "error" (code stays first-class). */
export function voiceErrorFrame(record: VoiceErrorRecord): Record<string, unknown> {
  return { type: "error", ...record };
}
