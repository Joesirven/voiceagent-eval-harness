"""Calls tools of a compiled tree flow at given flow nodes and prints where each call leads, as JSON.

Usage: <pinned Pipecat python> -I scripts/call_tree_flow_tool.py flow.yaml tree.json probes.json

probes.json is a list of {"node": flow node key, "function": tool name,
"answer": answer}. Each call goes through the tool schema tree_flow.load_flow
built, so Pipecat's own branch resolution runs. The flow manager is a minimal
stand-in that only has current_node; nothing touches the network. Prints one
{"node", "function", "answer", "result", "next"} per probe, where "next" is
the flow node the call enters, or null when the flow stays.
"""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parent.parent
# -I keeps the script's own directory off sys.path, so load the module by path.
_spec = importlib.util.spec_from_file_location("tree_flow", REPO / "src/orchestration-modules/pipecat/tree_flow.py")
tree_flow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tree_flow)


async def call(flow, probe):
    node = flow.node(probe["node"])
    tools = {s.name: s for s in [*flow.global_functions, *node.get("functions", [])]}
    schema = tools[probe["function"]]
    result, next_node = await schema.handler({"answer": probe["answer"]}, SimpleNamespace(current_node=probe["node"]))
    return {**probe, "result": result, "next": next_node["name"] if next_node else None}


async def main():
    flow = tree_flow.load_flow(Path(sys.argv[1]).read_text(encoding="utf-8"), json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
    probes = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    print(json.dumps([await call(flow, p) for p in probes]))


if __name__ == "__main__":
    asyncio.run(main())
