export interface Choice { id: string; label: string; available?: boolean; unavailableReason?: string }
export interface ModuleInfo {
  id: string;
  label: string;
  modelChoices?: string[];
  voiceChoices?: string[];
  /** False when the server will not use the current model for calls; the reason is plain text. */
  modelAllowed?: boolean;
  modelNotAllowedReason?: string;
  config: { model: string; voice: string; latency: { firstResponseMs: number; endpointingMs: number } };
}
export interface VoiceErrorRecord {
  id: number;
  code: string;
  title: string;
  detail: string;
  fix: string;
  severity: "error" | "warning";
  canContinue: boolean;
  blocksNewCalls: boolean;
  path: string;
  callId?: string;
  at: string;
}
export interface AppState {
  voiceErrors?: VoiceErrorRecord[];
  modules: ModuleInfo[];
  orchestrators: Choice[];
  selectedOrchestratorId: string;
  voicePaths: Choice[];
  selectedVoicePathId: string;
  /** Whether Azure Voice Live runs the decision tree before each reply (off: Voice Live answers by itself). */
  voiceLiveDecisionTree?: boolean;
  /** Azure Voice Live: the five-step flow shared with the Pipecat engine (default) or one prompt. POST /api/voice/voice-live-flow. */
  voiceLiveFlow?: "step_by_step" | "one_prompt";
  /** Which fictional producer receives a simulated transfer, or whether both receive it. */
  transferRing?: "pat" | "dana" | "both";
  staleOutputDrops: Choice[];
  selectedStaleOutputDropId: string;
  decisionTrees: Array<{ id: string; label: string; nodeCount: number }>;
  selectedDecisionTreeId: string;
  decisionModules: Array<{ id: string; label: string; kind?: string; available?: boolean; selected?: boolean }>;
  decisionModuleStatus?: { available: boolean; message?: string };
  azureStatus?: { ok: boolean; code?: string; message?: string; source?: string };
  agencies: Array<{ id: string; aiCallingEnabled: boolean }>;
  scenarios: Array<{ id: string; title: string }>;
  leadStoreKind: string;
}
export type {
  VoiceOptions, OrchestratorOption, VoicePathOption, ModelOption, ModelRole, CatalogSourceStatus,
} from "../../../src/server/voice/voice-options.js";
