import type { DecisionModel, DecisionModelOutcome, DecisionModelRequest } from "../../src/decision-models/types.js";
import type { DecisionTree } from "../../src/decision/tree.js";

/**
 * A stand-in for a real decision model: it answers from a script, node by node,
 * and never touches the network. The interrupt check answers "none" unless the
 * script says otherwise; any other node with no scripted answer left answers
 * "unclear". An answer the node does not offer fails the test.
 */
export class ScriptedModel implements DecisionModel {
  readonly id = "scripted-stand-in";
  readonly label = "Scripted stand-in (test)";
  readonly kind = "mock" as const;
  readonly asked: string[] = [];
  constructor(private readonly script: Record<string, string[]>) {}

  async decide(request: DecisionModelRequest): Promise<DecisionModelOutcome> {
    this.asked.push(request.nodeId);
    const queue = this.script[request.nodeId];
    const answer = queue?.shift() ?? (request.nodeId === "interrupts" ? "none" : "unclear");
    if (!request.answers.includes(answer)) throw new Error(`${request.nodeId} does not offer ${answer}: ${request.answers.join(", ")}`);
    return { ok: true, answer, confidence: 0.95, reason: "scripted", latencyMs: 1, modelId: this.id };
  }
}

/** The shortest chain of (node, answer) steps from a start to a node, walking the tree's own answers. */
export function stepsTo(tree: Pick<DecisionTree, "nodes">, start: string, target: string): Array<{ node: string; answer: string }> {
  const queue: Array<{ id: string; steps: Array<{ node: string; answer: string }> }> = [{ id: start, steps: [] }];
  const seen = new Set([start]);
  while (queue.length) {
    const { id, steps } = queue.shift()!;
    if (id === target) return steps;
    for (const a of tree.nodes[id]?.decision?.answers ?? []) {
      if (a.next && !seen.has(a.next)) {
        seen.add(a.next);
        queue.push({ id: a.next, steps: [...steps, { node: id, answer: a.answer }] });
      }
    }
  }
  throw new Error(`no path from ${start} to ${target}`);
}
