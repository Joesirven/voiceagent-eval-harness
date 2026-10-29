"""Runs the flow runtime (flows_runtime.py) through fixed scenarios with no network and prints what happened, as JSON.

Usage: <pinned Pipecat python> -I scripts/check_flows_runtime.py flow.yaml tree.json catalog.json

Scenarios:
- "schemas": the flow with three catalog tools added to the inbound start node; each tool schema as built;
- "tool": one catalog tool called; the tool_call request it sent and what it returned;
- "gated": the first judge-gated answer in the flow, called with Node replying allow, refuse, or not at all
  (a 0.05 second judge timeout); the messages emitted and the flow node each call leads to;
- "start": a runtime attached to a real pipeline worker that is never run (OpenAILLMService with a dummy key,
  LLMContextAggregatorPair over LLMContext), started inbound and outbound; the node entered and the messages.
The replies go through the runtime's own request and reply correlation (Requests, handle_message).
Pipecat's banner and logs go to standard error; standard output is JSON only.
"""
import asyncio
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import yaml

REPO = Path(__file__).resolve().parent.parent
# -I keeps the script's own directory off sys.path, so load the module by path.
_spec = importlib.util.spec_from_file_location("crm_pipecat_flows_runtime", REPO / "src/orchestration-modules/pipecat/flows_runtime.py")
flows_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(flows_runtime)

ADDED_TOOLS = ["save_message", "start_quote", "end_call"]


def with_tools(data, node: str) -> str:
    data = copy.deepcopy(data)
    data["nodes"][node].setdefault("functions", []).extend({"name": name} for name in ADDED_TOOLS)
    return yaml.dump(data, Dumper=getattr(yaml, "CSafeDumper", yaml.SafeDumper), sort_keys=False, allow_unicode=True)


class Harness:
    """One runtime whose emit records every message and answers requests through handle_message, as set per scenario."""

    def __init__(self, yaml_text, tree, catalog):
        self.messages = []
        self.result_for = lambda message: None
        self.runtime = flows_runtime.FlowsRuntime(yaml_text, tree, self.emit, catalog=catalog)

    def emit(self, message):
        self.messages.append(message)
        if "requestId" in message:
            result = self.result_for(message)
            if result is not None:
                reply = {"type": "flow_reply", "requestId": message["requestId"], "result": result}
                asyncio.get_running_loop().call_soon(lambda: self.runtime.handle_message(reply))

    def scenario(self, result_for, **timeouts):
        self.messages = []
        self.result_for = result_for
        self.runtime.judge_timeout = timeouts.get("judge_timeout", flows_runtime.JUDGE_TIMEOUT_SECONDS)
        self.runtime.tool_timeout = timeouts.get("tool_timeout", flows_runtime.TOOL_TIMEOUT_SECONDS)
        return self.runtime


def schemas_at(runtime, node):
    return {s.name: s for s in runtime.flow.node(node).get("functions", [])} | {s.name: s for s in runtime.flow.global_functions}


async def scenario_schemas(harness, start):
    tools = schemas_at(harness.runtime, start)
    return {
        "node": start,
        "tools": {
            name: {"description": tools[name].description, "properties": tools[name].properties, "required": tools[name].required}
            for name in ADDED_TOOLS
        },
    }


async def scenario_tool(harness, start):
    reply = {"ok": False, "speakable": "A licensed producer will follow up with you about that.", "refused": {"code": "needs_credential", "reason": "x"}}
    runtime = harness.scenario(lambda m: reply if m["type"] == "tool_call" else None)
    arguments = {"line": "workers_compensation", "evidence_quote": "I would like a quote"}
    result, next_node = await schemas_at(runtime, start)["start_quote"].handler(arguments, SimpleNamespace(current_node=start))
    messages = harness.messages
    runtime = harness.scenario(lambda m: None, tool_timeout=0.05)
    late, _ = await schemas_at(runtime, start)["save_message"].handler({"kind": "message", "body": "b", "evidence_quote": "b"}, SimpleNamespace(current_node=start))
    return {"messages": messages, "result": result, "next": next_node["name"] if next_node else None, "noReply": late, "pendingAfter": runtime.requests.pending}


def first_gate(data):
    for key, node in data["nodes"].items():
        for action in node.get("pre_actions") or []:
            if action.get("type") == "crm_gates" and action.get("gates"):
                gate = action["gates"][0]
                fn = next(f for f in node["functions"] if f["name"] == action["function"])
                cases = fn["transition_to"]["cases"]
                return {"node": key, "function": action["function"], "answer": gate["answer"], "target": cases.get(gate["answer"]), "blockedTarget": cases.get(gate["blockedCase"]), "gate": gate}
    raise SystemExit("no judge-gated answer in the flow")


async def scenario_gated(harness, data):
    gate = first_gate(data)
    out = {"gate": gate}
    for name, result, timeout in (("allow", {"allow": True, "reason": "fine"}, 2.0), ("refuse", {"allow": False, "reason": "no"}, 2.0), ("timeout", None, 0.05)):
        runtime = harness.scenario(lambda m, r=result: r if m["type"] == "judge_request" else None, judge_timeout=timeout)
        schema = schemas_at(runtime, gate["node"])[gate["function"]]
        res, next_node = await schema.handler({"answer": gate["answer"]}, SimpleNamespace(current_node=gate["node"]))
        out[name] = {"messages": harness.messages, "result": res, "next": next_node["name"] if next_node else None, "pendingAfter": runtime.requests.pending}
    return out


async def scenario_start(harness):
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.services.openai.llm import OpenAILLMService

    out = {}
    for direction in ("inbound", "outbound"):
        # The flow is reused; each call gets its own pipeline and flow manager.
        runtime = harness.scenario(lambda m: None)
        llm = OpenAILLMService(api_key="dummy-key-no-network", settings=OpenAILLMService.Settings(model="gpt-4o"))
        aggregators = LLMContextAggregatorPair(LLMContext())
        worker = PipelineWorker(Pipeline([aggregators.user(), llm, aggregators.assistant()]))
        manager = runtime.attach(worker, llm, aggregators)
        entered = await runtime.start(direction)
        runtime.caller_turn("hello there")
        runtime.agent_turn("hi")
        out[direction] = {"entered": entered, "currentNode": manager.current_node, "messages": harness.messages}
    return out


async def main():
    yaml_text = Path(sys.argv[1]).read_text(encoding="utf-8")
    tree = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    catalog = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    data = yaml.load(yaml_text, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    start = flows_runtime.FlowsRuntime._start_nodes(data)["inbound"]
    with_catalog = Harness(with_tools(data, start), tree, catalog)
    plain = Harness(yaml_text, tree, catalog)
    out = {
        "schemas": await scenario_schemas(with_catalog, start),
        "tool": await scenario_tool(with_catalog, start),
        "gated": await scenario_gated(plain, data),
        "start": await scenario_start(plain),
    }
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    asyncio.run(main())
