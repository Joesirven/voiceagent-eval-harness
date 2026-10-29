/**
 * The Claude-backed reply agent and pairwise judge for turn-level judging.
 * Offline only. Every past turn is redacted before it goes into a prompt, and
 * so is every reply shown to the judge (the producer's reply is real past-call
 * text).
 *
 * The judge prompt names the two candidates "First reply" and "Second reply"
 * and nothing else: it is never told which one the agent wrote.
 */

import { redactText } from "../../decision-models/redact.js";
import { OPUS_MODEL, type ClaudeJsonClient } from "./claude.js";
import type { PairwiseJudge, PairwisePick, PastTurn, ReplyAgent } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The history as plain lines. Both sides of the conversation are written as "Caller" and "Assistant". */
export function renderHistory(history: readonly PastTurn[]): string {
  if (history.length === 0) return "(the call has just started)";
  return history
    .map((turn) => `${turn.speaker === "lead" ? "Caller" : "Assistant"}: ${redactText(turn.text)}`)
    .join("\n");
}

const REPLY_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
} as const;

export interface ClaudeReplyAgentOptions {
  client: ClaudeJsonClient;
  /** The agent's own system prompt. Another workstream owns it; this class only passes it through. */
  systemPrompt: string;
  /** Default claude-opus-5-5. */
  model?: string;
  effort?: Effort;
  id?: string;
}

/** Writes the agent's one next line for a call cut off just before a producer turn. */
export class ClaudeReplyAgent implements ReplyAgent {
  readonly id: string;
  private readonly client: ClaudeJsonClient;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly effort: Effort;

  constructor(options: ClaudeReplyAgentOptions) {
    this.client = options.client;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? OPUS_MODEL;
    this.effort = options.effort ?? "medium";
    this.id = options.id ?? `claude-reply-agent:${this.model}`;
  }

  async reply(history: PastTurn[]): Promise<string> {
    const result = await this.client.askJson<{ reply?: unknown }>({
      model: this.model,
      system: this.systemPrompt,
      user: [
        "This is the phone call so far:",
        "",
        renderHistory(history),
        "",
        "Write the one next line the Assistant says aloud. Reply with JSON: {\"reply\": \"<the line>\"}.",
      ].join("\n"),
      schema: REPLY_SCHEMA,
      effort: this.effort,
      maxTokens: 2000,
    });
    if (typeof result?.reply !== "string" || !result.reply.trim()) throw new Error("reply_agent_empty_reply");
    return result.reply.trim();
  }
}

export const PAIRWISE_RUBRIC = [
  "You compare two candidate replies to the same phone call. The call is from an insurance agency to a small-business owner.",
  "Both candidates are the next spoken line of the same unlicensed assistant role. Decide which reply is the better next line.",
  "A better reply:",
  "- answers what the caller just said, before anything else;",
  "- moves the call one step forward;",
  "- is short enough to say aloud on a phone;",
  "- invents no facts about the caller, the business, or the policy.",
  "The assistant is unlicensed. A reply that quotes a price, gives coverage advice, or promises that coverage is bound is worse than one that does not.",
  "Judge only what is written. Do not guess who wrote either reply, and do not prefer a reply for being first or second.",
  "Pick \"same\" only when neither reply is meaningfully better.",
  "Reply with JSON: {\"pick\": \"first\" | \"second\" | \"same\", \"why\": \"<one short sentence>\"}.",
].join("\n");

const PICK_SCHEMA = {
  type: "object",
  properties: {
    pick: { type: "string", enum: ["first", "second", "same"] },
    why: { type: "string" },
  },
  required: ["pick", "why"],
  additionalProperties: false,
} as const;

export interface ClaudePairwiseJudgeOptions {
  client: ClaudeJsonClient;
  /** Default claude-opus-5-5. */
  model?: string;
  /** Default high. */
  effort?: Effort;
  id?: string;
}

export class ClaudePairwiseJudge implements PairwiseJudge {
  readonly id: string;
  private readonly client: ClaudeJsonClient;
  private readonly model: string;
  private readonly effort: Effort;

  constructor(options: ClaudePairwiseJudgeOptions) {
    this.client = options.client;
    this.model = options.model ?? OPUS_MODEL;
    this.effort = options.effort ?? "high";
    this.id = options.id ?? `claude-pairwise-judge:${this.model}`;
  }

  async compare(input: { history: PastTurn[]; first: string; second: string }): Promise<PairwisePick> {
    const result = await this.client.askJson<{ pick?: unknown }>({
      model: this.model,
      system: PAIRWISE_RUBRIC,
      user: [
        "The call so far:",
        "",
        renderHistory(input.history),
        "",
        "First reply:",
        redactText(input.first),
        "",
        "Second reply:",
        redactText(input.second),
      ].join("\n"),
      schema: PICK_SCHEMA,
      effort: this.effort,
      maxTokens: 4000,
    });
    const pick = result?.pick;
    if (pick !== "first" && pick !== "second" && pick !== "same") throw new Error("pairwise_judge_invalid_pick");
    return pick;
  }
}
