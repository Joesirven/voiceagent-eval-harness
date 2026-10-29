/**
 * The model (and voice) chosen for each slot of a voice path, from
 * POST /api/voice/path-models. It imports only the Azure catalog, so the
 * manager and the Deepgram runtime can read it without an import cycle. The Azure gpt-live speech_to_speech slot is
 * not kept here: it lives on the azure-gpt-live module config, which the live
 * session reads. Choices last until the server restarts.
 */

import { azureCatalogSnapshot } from "../../modules/azure-catalog.js";
import type { ModelRole } from "./voice-options.js";

export interface StoredPathModel {
  modelId: string;
  voice?: string;
}

const choices = new Map<string, StoredPathModel>();
const key = (voicePathId: string, role: ModelRole) => `${voicePathId}:${role}`;

export function chosenPathModel(voicePathId: string, role: ModelRole): StoredPathModel | undefined {
  return choices.get(key(voicePathId, role));
}

export function storePathModel(voicePathId: string, role: ModelRole, choice: StoredPathModel): void {
  choices.set(key(voicePathId, role), { ...choice });
}

export function resetPathModelChoices(): void {
  choices.clear();
}

/**
 * The reply deployment the Deepgram path uses, the same one GET /api/voice/options
 * reports as its default: the stored choice while the Azure listing still has
 * it, else the deployment in the settings file, else the first reply
 * deployment listed. Undefined only when none of those is known.
 */
export function deepgramReplyDeployment(configured?: string): string | undefined {
  const snap = azureCatalogSnapshot();
  const listed = snap?.models.filter((m) => m.role === "reply").map((m) => m.id);
  const usable = (id: string | undefined): id is string => Boolean(id) && (!listed || !snap?.status.ok || listed.includes(id!));
  const stored = chosenPathModel("deepgram", "reply")?.modelId;
  if (usable(stored)) return stored;
  if (usable(configured)) return configured;
  return listed?.[0] ?? configured;
}
