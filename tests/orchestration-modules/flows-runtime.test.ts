import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const TREE_FILE = fileURLToPath(new URL("../../src/decision-tree/full-tree.json", import.meta.url));
const FLOW_FILE = fileURLToPath(new URL("../../src/decision-tree/full-tree.flow.yaml", import.meta.url));
const CATALOG_FILE = fileURLToPath(new URL("../../src/flow-tools/catalog.json", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../scripts/check_flows_runtime.py", import.meta.url));

interface Catalog {
  tools: Array<{ name: string; description: string; status: string; parameters: { properties: Record<string, unknown>; required: string[] } }>;
}
type Message = Record<string, unknown> & { type: string };
interface Called {
  messages: Message[];
  result: Record<string, unknown>;
  next: string | null;
  pendingAfter: number;
}
interface Output {
  schemas: { node: string; tools: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> };
  tool: Called & { noReply: Record<string, unknown> };
  gated: {
    gate: { node: string; function: string; answer: string; target: string; blockedTarget: string; gate: Record<string, unknown> };
    allow: Called;
    refuse: Called;
    timeout: Called;
  };
  start: Record<"inbound" | "outbound", { entered: string; currentNode: string; messages: Message[] }>;
}

const catalog = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Catalog;
const pythonPath = process.env.CRM_PIPECAT_PYTHON?.trim();

describe.skipIf(!pythonPath)("the flow runtime in the pinned Pipecat", () => {
  let out: Output;
  beforeAll(() => {
    const text = execFileSync(pythonPath!, ["-I", SCRIPT, FLOW_FILE, TREE_FILE, CATALOG_FILE], { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "ignore"] });
    out = JSON.parse(text) as Output;
  }, 200_000);

  it("sets each catalog tool schema from the catalog, with no leftover arguments parameter", () => {
    for (const [name, schema] of Object.entries(out.schemas.tools)) {
      const tool = catalog.tools.find((t) => t.name === name)!;
      expect(schema.description).toBe(tool.description);
      expect(schema.properties).toEqual(tool.parameters.properties);
      expect(schema.required).toEqual(tool.parameters.required);
      expect(schema.properties).not.toHaveProperty("arguments");
      expect(schema.properties).not.toHaveProperty("kwargs");
    }
  });

  it("sends a catalog tool call to Node and returns Node's result, staying on the node", () => {
    expect(out.tool.messages).toEqual([
      { type: "tool_call", requestId: "flow-1", name: "start_quote", arguments: { line: "workers_compensation", evidence_quote: "I would like a quote" } },
    ]);
    expect(out.tool.result).toMatchObject({ ok: false, refused: { code: "needs_credential" } });
    expect(out.tool.next).toBeNull();
    expect(out.tool.noReply).toMatchObject({ ok: false, refused: { code: "no_reply" } });
    expect(out.tool.pendingAfter).toBe(0);
  });

  it("asks Node's judge before a gated answer: allow takes the answer, refusal and timeout take the blocked case", () => {
    const { gate, allow, refuse, timeout } = out.gated;
    expect(gate.target).toBeTruthy();
    expect(gate.blockedTarget).toBeTruthy();
    expect(allow.next).toBe(gate.target);
    expect(refuse.next).toBe(gate.blockedTarget);
    expect(timeout.next).toBe(gate.blockedTarget);
    for (const [called, allowed, timedOut] of [[allow, true, false], [refuse, false, false], [timeout, false, true]] as const) {
      expect(called.messages.map((m) => m.type)).toEqual(["decision", "judge_request", "judge_verdict"]);
      expect(called.messages[0]).toEqual({ type: "decision", node: gate.node, treeNode: gate.node, function: gate.function, answer: gate.answer, router: "pipecat_flows" });
      expect(called.messages[1]).toMatchObject({
        type: "judge_request",
        function: gate.function,
        answer: gate.answer,
        node: gate.node,
        treeNode: gate.node,
        judge: gate.gate.judge,
        disposition: gate.gate.disposition ?? null,
      });
      expect(called.messages[2]).toMatchObject({ type: "judge_verdict", function: gate.function, answer: gate.answer, allowed, timedOut });
      expect(typeof called.messages[2]!.latencyMs).toBe("number");
      expect(called.pendingAfter).toBe(0);
    }
  });

  it("enters the start node for the call's direction and reports node_enter, caller_turn and agent_turn", () => {
    expect(out.start.inbound).toMatchObject({ entered: "open.greeting", currentNode: "open.greeting" });
    expect(out.start.outbound).toMatchObject({ entered: "entry.outbound", currentNode: "entry.outbound" });
    for (const direction of ["inbound", "outbound"] as const) {
      const { entered, messages } = out.start[direction];
      expect(messages[0]).toMatchObject({ type: "node_enter", node: entered, treeNode: entered });
      expect(typeof messages[0]!.label).toBe("string");
      expect(messages.slice(1)).toEqual([
        { type: "caller_turn", text: "hello there" },
        { type: "agent_turn", text: "hi" },
      ]);
    }
  });
});
