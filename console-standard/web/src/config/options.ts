// Plain data and types shared by the page server (configs-plugin.ts) and the configuration panel. No credentials here.

export interface Config {
  id: string;
  name: string;
  note?: string;
  sttModel: string;
  replyDeployment: string;
  voice: string;
  endpointingMs: number;
  vadStopSecs: number;
  voicePath: string;
  orchestration: string;
  promptSetup: string;
  lead: string;
  direction: string;
}

/** One allowed choice, with a plain name and a one-line description. An unavailable choice carries its reason. */
export interface Choice<T extends string | number = string> {
  id: T;
  label: string;
  description: string;
  available?: boolean;
  reason?: string;
}

export interface Options {
  voicePaths: Choice[];
  sttModels: Choice[];
  replyDeployments: Choice[];
  voices: Choice[];
  endpointingMs: Choice<number>[];
  vadStopSecs: Choice<number>[];
  orchestrations: Choice[];
  promptSetups: Choice[];
  leads: Choice[];
  directions: Choice[];
}

/** The settings fields the page sends to the bot (everything except id, name and note). */
export const SETTING_KEYS = [
  "sttModel", "replyDeployment", "voice", "endpointingMs", "vadStopSecs",
  "voicePath", "orchestration", "promptSetup", "lead", "direction",
] as const;

/** Ten common Aura-2 English voices. Any voice matching the schema's voice name pattern is still accepted when saved. */
export const COMMON_VOICES: Choice[] = [
  { id: "aura-2-thalia-en", label: "Thalia", description: "Clear, confident and energetic; a feminine voice." },
  { id: "aura-2-andromeda-en", label: "Andromeda", description: "Casual, expressive and relaxed; a feminine voice." },
  { id: "aura-2-helena-en", label: "Helena", description: "Caring, natural and friendly; a feminine voice." },
  { id: "aura-2-aurora-en", label: "Aurora", description: "Cheerful and expressive; a feminine voice." },
  { id: "aura-2-luna-en", label: "Luna", description: "Friendly, natural and engaging; a feminine voice." },
  { id: "aura-2-athena-en", label: "Athena", description: "Calm, smooth and professional; a feminine voice." },
  { id: "aura-2-apollo-en", label: "Apollo", description: "Confident and comfortable; a masculine voice." },
  { id: "aura-2-arcas-en", label: "Arcas", description: "Natural and smooth; a masculine voice." },
  { id: "aura-2-orion-en", label: "Orion", description: "Approachable and calm; a masculine voice." },
  { id: "aura-2-zeus-en", label: "Zeus", description: "Deep, trustworthy and smooth; a masculine voice." },
];

export const STT_LABELS: Record<string, [string, string]> = {
  "nova-3-general": ["Nova 3 general", "Newest general speech to text model; best accuracy for most calls."],
  "nova-2-general": ["Nova 2 general", "Previous general speech to text model."],
  "nova-2-phonecall": ["Nova 2 phone call", "Tuned for narrow-band telephone audio."],
  "nova-2-conversationalai": ["Nova 2 conversational", "Tuned for fast back-and-forth voice agents."],
};

export const REPLY_LABELS: Record<string, [string, string]> = {
  "default": ["Harness default", "Whatever reply model the harness is configured to use."],
  "gpt-5.4-mini": ["GPT 5.4 mini", "Smallest reply model: fastest answers."],
  "gpt-5.6-luna": ["GPT 5.6 luna", "Mid-sized reply model: balanced speed and wording."],
  "gpt-5.6-terra": ["GPT 5.6 terra", "Largest reply model: best wording, slower first word."],
};

export const ORCHESTRATION_LABELS: Record<string, [string, string]> = {
  single_prompt: ["Single prompt", "One instruction drives the whole call."],
  pipecat_flows: ["Pipecat Flows: decision tree", "The harness decision tree compiled as a staged flow."],
  quote_prototype: ["Pipecat Flows: quote prototype", "Greet, gather the quote details, send the quote link, hand off to the producer or take a message."],
};

export const VOICE_PATH_LABELS: Record<string, [string, string]> = {
  cascaded_deepgram: ["Cascaded Deepgram", "Speech to text, then a reply model, then Deepgram text to speech."],
  azure_speech_to_speech: ["Azure speech to speech", "One model hears and speaks directly."],
};

export const LEAD_LABELS: Record<string, [string, string]> = {
  "lead-1": ["Lead 1", "The first sample lead the agent instruction is built for."],
  "lead-2": ["Lead 2", "The second sample lead."],
  "lead-3": ["Lead 3", "The third sample lead."],
};

export const DIRECTION_LABELS: Record<string, [string, string]> = {
  inbound: ["Inbound", "The lead calls the agent."],
  outbound: ["Outbound", "The agent calls the lead."],
};

/** Endpointing (silence before the speech to text model closes a phrase) and voice detection stop values offered in the panel. */
export const ENDPOINTING_VALUES = [100, 200, 300, 450, 600, 900, 1200, 1500];
export const VAD_STOP_VALUES = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0];
