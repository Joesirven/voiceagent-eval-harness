// Plain names and one-line descriptions for every dropdown option. The server's own label is the fallback,
// so a new option still shows up (with its server label) before anyone adds a description here.
export interface Described { name: string; description: string }

const orchestrators: Record<string, Described> = {
  direct: { name: "Direct to Azure", description: "The harness talks to Azure itself. Fewest moving parts." },
  pipecat: { name: "Pipecat", description: "A Pipecat relay sits between the call and Azure; the default when available." },
};
const voicePaths: Record<string, Described> = {
  azure_gpt_live: { name: "Azure live voice", description: "One Azure model listens and speaks. The default." },
  azure_voice_live: {
    name: "Azure Voice Live",
    description: "Azure's hosted speech agent hears the caller, detects turns and speaks with an Azure voice; its model calls the harness tools itself. Needs Direct to Azure and its own Azure Voice Live settings.",
  },
  deepgram: { name: "Deepgram speech", description: "Deepgram hears and speaks; Azure writes the reply. Needs a Deepgram key." },
};
const staleDrops: Record<string, Described> = {
  off: { name: "Never drop", description: "Keep any model speech that was already on its way after a barge-in." },
  one_gap: { name: "Drop for one pause", description: "After a barge-in, ignore stale model speech for about one pause (0.9 seconds)." },
  two_gaps: { name: "Drop for two pauses", description: "After a barge-in, ignore stale model speech for about two pauses (1.8 seconds)." },
};
const decisionModules: Record<string, Described> = {
  "azure-decision": { name: "Azure gpt-5.6-luna", description: "The real model, about 2 seconds per decision." },
  "keyword-no-credential": { name: "Keyword rules", description: "No model call: simple word matching, used when Azure has no credential." },
  "keyword-stub": { name: "Keyword rules", description: "No model call: simple word matching." },
};

const tables = { orchestrator: orchestrators, voicePath: voicePaths, staleDrop: staleDrops, decisionModule: decisionModules };

/** Strips parenthetical internals such as "(own infrastructure)" from a server label for the fallback name. */
const plain = (label: string) => label.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s*[·:].*$/, "").trim();

export function describe(kind: keyof typeof tables, id: string, serverLabel: string): Described {
  return tables[kind][id] ?? { name: plain(serverLabel) || serverLabel, description: "" };
}

/** What each slot of a voice path does, in plain words. */
export const modelRoleLabels: Record<string, string> = {
  speech_to_speech: "Live voice model",
  speech_to_text: "Listening model",
  reply: "Reply model",
  text_to_speech: "Speaking model",
};
export const providerLabels: Record<string, string> = { azure: "Azure", deepgram: "Deepgram" };

/** Why a voice path cannot run, in plain words, by the code the server sends as unavailableReason. Never a host or a key. */
const unavailableReasons: Record<string, string> = {
  azure_voice_live_env_file_not_configured: "The server has no configured settings file, so the Azure Voice Live settings cannot be read.",
  azure_voice_live_env_file_permissions_too_open: "The settings file is readable by other users, so the harness will not read the Azure Voice Live key from it.",
  azure_voice_live_env_file_unreadable: "The settings file could not be read, so the Azure Voice Live settings are missing.",
  azure_voice_live_missing_url: "AZURE_VOICE_LIVE_URL is missing from the settings file.",
  azure_voice_live_missing_key: "AZURE_VOICE_LIVE_KEY is missing from the settings file.",
  azure_voice_live_url_invalid: "AZURE_VOICE_LIVE_URL is not the address of an Azure resource that can run Voice Live.",
  pipecat_interpreter_not_configured: "The Python interpreter for Pipecat is not configured on this machine.",
  deepgram_sidecar_missing: "The Deepgram helper script is missing from the harness files.",
};

export function unavailableReasonText(code: string | undefined): string {
  return code && Object.hasOwn(unavailableReasons, code) ? unavailableReasons[code]! : "Unavailable right now.";
}
