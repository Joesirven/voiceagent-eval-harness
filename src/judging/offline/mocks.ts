/**
 * Deterministic stand-ins for the turn-level judging pieces. No network, no
 * clock, no randomness: the same input always gives the same output, so a test
 * can say exactly which verdict it expects.
 */

import type { PairwiseJudge, PairwisePick, PastCall, PastCallSource, PastTurn, ReplyAgent } from "./types.js";

/** Answers from the history alone. Pass `write` to choose the reply yourself. */
export class MockReplyAgent implements ReplyAgent {
  readonly id = "mock-reply-agent";
  /** Every history the agent was asked about, in order. */
  readonly histories: PastTurn[][] = [];

  constructor(private readonly write?: (history: PastTurn[]) => string) {}

  async reply(history: PastTurn[]): Promise<string> {
    this.histories.push(history.map((turn) => ({ ...turn })));
    if (this.write) return this.write(history);
    const lastLead = [...history].reverse().find((turn) => turn.speaker === "lead");
    const words = lastLead ? lastLead.text.split(/\s+/).filter(Boolean).length : 0;
    return `Thanks for telling me that. Could you confirm your renewal date? (${history.length} turns, ${words} words)`;
  }
}

export type MockJudgeBehavior =
  /** Prefers the longer reply; equal lengths are "same". */
  | { kind: "longer" }
  /** Always answers the same way, whatever it is shown. "first" or "second" make every pair of orders inconsistent. */
  | { kind: "fixed"; pick: PairwisePick }
  /** Favors the first position; only identical replies are "same". */
  | { kind: "position_biased" };

export class MockPairwiseJudge implements PairwiseJudge {
  readonly id = "mock-pairwise-judge";
  /** Everything the judge was shown. It holds no field that says whose reply is whose. */
  readonly inputs: Array<{ history: PastTurn[]; first: string; second: string }> = [];

  constructor(private readonly behavior: MockJudgeBehavior = { kind: "longer" }) {}

  async compare(input: { history: PastTurn[]; first: string; second: string }): Promise<PairwisePick> {
    this.inputs.push({ history: input.history.map((turn) => ({ ...turn })), first: input.first, second: input.second });
    switch (this.behavior.kind) {
      case "fixed":
        return this.behavior.pick;
      case "position_biased":
        return input.first === input.second ? "same" : "first";
      case "longer":
        if (input.first.length === input.second.length) return "same";
        return input.first.length > input.second.length ? "first" : "second";
    }
  }
}

/** Past calls held in memory, for tests. Newest first is the order given. */
export class InMemoryPastCalls implements PastCallSource {
  readonly id = "in-memory";

  constructor(private readonly calls: PastCall[]) {}

  async listCallIds(limit: number): Promise<string[]> {
    return this.calls.slice(0, Math.max(0, limit)).map((call) => call.callId);
  }

  async getCall(callId: string): Promise<PastCall | null> {
    const call = this.calls.find((candidate) => candidate.callId === callId);
    return call ? structuredClone(call) : null;
  }
}
