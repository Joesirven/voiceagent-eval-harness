/**
 * The OpenAI Decisions API (public beta), model `gpt-6-luna`. Same idea as the
 * other adapters with a different shape: the conversation goes in `input`, the
 * questions are a list with named `choices`, and the reply carries a list of
 * `{ value, probability }` that becomes a map here.
 * Guide: https://developers.openai.com/api/docs/guides/decisions.md
 */

import { systemClock, type Clock } from "../types/clock.js";
import { asRecord, DEFAULT_TIMEOUT_MS, postJson, type FetchLike } from "./http.js";
import { buildQuestion, buildState, QUESTION_NAME, resolveChoice } from "./state.js";
import type {
  DecisionModel,
  DecisionModelCallOptions,
  DecisionModelOutcome,
  DecisionModelRequest,
} from "./types.js";

export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";

/** `[{ value, probability }]` to `{ value: probability }`. Entries that are not well formed are skipped. */
function probabilityMap(list: unknown): Record<string, number> | undefined {
  if (!Array.isArray(list)) return undefined;
  const map: Record<string, number> = {};
  for (const entry of list) {
    const item = asRecord(entry);
    if (item && typeof item.value === "string" && typeof item.probability === "number") map[item.value] = item.probability;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export class OpenAiDecisionModel implements DecisionModel {
  readonly id = "openai-decisions";
  readonly label = "OpenAI Decisions API (gpt-6-luna, public beta)";
  readonly kind = "real" as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl?: FetchLike,
    private readonly clock: Clock = systemClock,
  ) {}

  async decide(request: DecisionModelRequest, options: DecisionModelCallOptions = {}): Promise<DecisionModelOutcome> {
    const modelId = OPENAI_DECISIONS_MODEL;
    if (!this.apiKey) return { ok: false, reason: "off", latencyMs: 0, modelId, code: "no_credential" };
    const question = buildQuestion(request);
    const result = await postJson({
      url: OPENAI_DECISIONS_URL,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: {
        model: modelId,
        input: buildState(request),
        questions: [
          {
            type: "choice",
            name: QUESTION_NAME,
            instructions: question.instructions,
            choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
          },
        ],
      },
      modelId,
      fetch: this.fetchImpl,
      clock: this.clock,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!result.ok) return result;
    const answers = asRecord(result.json)?.answers;
    const answer = Array.isArray(answers)
      ? answers.map(asRecord).find((a) => a?.name === QUESTION_NAME) ?? null
      : null;
    const invalid = (code: string): DecisionModelOutcome => ({
      ok: false,
      reason: "invalid_answer",
      latencyMs: result.latencyMs,
      modelId,
      code,
    });
    if (!answer) return invalid("invalid_answer");
    if (answer.type === "refusal") return invalid("refused");
    const parsed =
      answer.type === "choice"
        ? resolveChoice(request, answer.choice, probabilityMap(answer.probabilities), answer.confidence)
        : null;
    if (!parsed) return invalid("invalid_answer");
    return { ok: true, ...parsed, reason: `${this.id} answered ${parsed.answer}`, latencyMs: result.latencyMs, modelId };
  }
}
