/**
 * Contract for GET /api/voice/options: which orchestrator, voice path and
 * model choices are actually usable right now. The server builds it from what
 * is deployed (Azure deployments, Deepgram models), never from a hardcoded
 * list, and the settings sheet only offers what it contains. A model that is
 * not in here is refused before a call starts.
 *
 * Shared by three workstreams; change the shape only through the orchestrator
 * thread.
 */

export type ModelRole = "speech_to_speech" | "speech_to_text" | "reply" | "text_to_speech";

export interface ModelOption {
  /** Exact name sent to the provider (Azure deployment name or Deepgram model). */
  id: string;
  label: string;
  role: ModelRole;
  provider: "azure" | "deepgram";
  /** Voices this model can speak with, when it speaks. */
  voices?: string[];
}

/**
 * Who picks the next decision tree node on each caller turn:
 * - decision_model: the decision model in Node (today's behaviour);
 * - pipecat_flows: the talking model moves between nodes with tool calls (Pipecat Flows);
 * - pipecat_classifier: a Pipecat classifier (pipecat.classifiers) inside the
 *   cascaded pipeline asks the node question and the interruption check in one
 *   call while the reply waits behind a gate.
 */
export type DecisionRouterId = "decision_model" | "pipecat_flows" | "pipecat_classifier";

export interface DecisionRouterOption {
  id: DecisionRouterId;
  label: string;
  /** False when this router cannot run right now (for example the Pipecat interpreter or the compiled flow file is missing), with a plain reason in detail. */
  available: boolean;
  detail?: string;
}

export interface VoicePathOption {
  id: string;
  label: string;
  /** Each role this path needs, with the models usable for it. */
  slots: { role: ModelRole; models: ModelOption[]; defaultId?: string; selectedId?: string; selectedVoice?: string }[];
  /**
   * The decision routers this path can use. Optional so older servers and
   * fixtures stay valid. The live speech to speech path lists only
   * decision_model (Pipecat Flows needs a cascaded pipeline).
   */
  decisionRouters?: { options: DecisionRouterOption[]; defaultId: DecisionRouterId; selectedId: DecisionRouterId };
}

/**
 * Body of POST /api/voice/decision-router. Reply: 200 with the new
 * VoiceOptions, or 409 with a voice error code (decision_router_not_supported,
 * decision_router_unknown, decision_router_unavailable) and the unchanged
 * VoiceOptions.
 */
export interface DecisionRouterChoice {
  voicePathId: string;
  decisionRouterId: DecisionRouterId;
}

/**
 * Body of POST /api/voice/path-models: store the model (and voice, for a model
 * that speaks) for one slot of one voice path. The server refuses a model or
 * voice that is not in GET /api/voice/options for that slot.
 */
export interface PathModelChoice {
  voicePathId: string;
  role: ModelRole;
  modelId: string;
  voice?: string;
}

export interface OrchestratorOption {
  id: string;
  label: string;
  voicePaths: VoicePathOption[];
}

export interface CatalogSourceStatus {
  provider: "azure" | "deepgram";
  ok: boolean;
  /** Plain reason when not ok, with no secrets, host names or keys. */
  detail?: string;
  checkedAt: string;
}

export interface VoiceOptions {
  orchestrators: OrchestratorOption[];
  sources: CatalogSourceStatus[];
}

/** What a provider catalog returns; the server combines these into VoiceOptions. */
export interface ProviderCatalog {
  status: CatalogSourceStatus;
  models: ModelOption[];
}
