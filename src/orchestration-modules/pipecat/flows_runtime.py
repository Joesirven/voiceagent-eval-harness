"""Runs the compiled decision tree flow in a Pipecat pipeline and reports to Node as JSON lines.

Node keeps the tree state, the records and the judge. This runtime only runs
the flow (src/decision-tree/full-tree.flow.yaml, joined to its handlers by
tree_flow.load_flow) and tells Node what happened; when it needs Node it
sends a request line and waits for the reply line with the same requestId,
each with a timeout. The messages (see docs/decision-tree-flow.md, "The flow
runtime protocol"):

To Node (through emit):
- {"type":"node_enter","node","treeNode","label","flowStep"?}: a flow node was entered (crm_node pre action);
- {"type":"disposition","node","disposition","durable","guidance"}: an ending was entered (crm_disposition);
- {"type":"decision","node","treeNode","function","answer","router":"pipecat_flows"}: the language model called a
  decision function (a decide_ function or interrupt), sent before the handler runs;
- {"type":"judge_request","requestId","function","answer","node","treeNode","judge","action","disposition"}: before a
  judge-gated answer; the answer is taken only on a reply {"allow": true}, and no reply within 2 seconds refuses;
- {"type":"judge_verdict","function","answer","node","treeNode","allowed","timedOut","latencyMs","reason"?}: either way;
- {"type":"tool_call","requestId","name","arguments"}: a catalog tool (flow_tools.py), answered with the dispatcher's result;
- {"type":"caller_turn","text"} and {"type":"agent_turn","text"}: every finished caller line, before the flow sees it, and
  every finished agent line, so Node's stop detector and the judge's transcript see them. Node answers a stop by
  ending the call; the runtime only reports.

From Node (into handle_message): {"type":"flow_reply","requestId","result"}.

The request ids are "flow-<n>" in the field requestId, never "id", so they cannot be taken for the Deepgram
sidecar's own lines. Independent of sidecar_deepgram.py; the hook there comes later.
"""
import asyncio
import importlib.util
import itertools
import json
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

import yaml

ROUTER = "pipecat_flows"
JUDGE_TIMEOUT_SECONDS = 2.0
TOOL_TIMEOUT_SECONDS = 8.0
REPLY_TYPE = "flow_reply"
NODE_ACTION = "crm_node"
DISPOSITION_ACTION = "crm_disposition"
FLOW_NODE_KEY = "flowNode"

Emit = Callable[[dict[str, Any]], None]
RequestFunction = Callable[[str, Mapping[str, Any], float], Awaitable[Any]]


def _module(name: str):
    """A sibling module loaded by path, shared with flow_handlers.sibling (-I keeps this directory off sys.path)."""
    key = "crm_pipecat_flow_handlers"
    handlers = sys.modules.get(key)
    if handlers is None:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).resolve().parent / "flow_handlers.py")
        handlers = importlib.util.module_from_spec(spec)
        sys.modules[key] = handlers
        spec.loader.exec_module(handlers)
    return handlers if name == "flow_handlers" else handlers.sibling(name)


class Requests:
    """Request and reply correlation over JSON lines: send writes a line with a requestId and waits for resolve."""

    def __init__(self, emit: Emit):
        self._emit = emit
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)

    async def send(self, kind: str, payload: Mapping[str, Any], timeout: float) -> Any:
        """Node's result for this request, or None when none came within timeout seconds."""
        request_id = f"flow-{next(self._ids)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            self._emit({**payload, "type": kind, "requestId": request_id})
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            # A reply that comes after the timeout finds nothing and is ignored.
            self._pending.pop(request_id, None)

    def resolve(self, request_id: Any, result: Any) -> bool:
        future = self._pending.pop(request_id, None) if isinstance(request_id, str) else None
        if future is None or future.done():
            return False
        future.set_result(result)
        return True

    @property
    def pending(self) -> int:
        return len(self._pending)


class FlowsRuntime:
    def __init__(
        self,
        flow_yaml: str,
        tree_json: str | Mapping[str, Any],
        emit: Emit,
        request: RequestFunction | None = None,
        catalog: Mapping[str, Any] | None = None,
        judge_timeout: float = JUDGE_TIMEOUT_SECONDS,
        tool_timeout: float = TOOL_TIMEOUT_SECONDS,
    ):
        self.emit = emit
        self.requests = Requests(emit)
        self.request = request or self.requests.send
        self.judge_timeout = judge_timeout
        self.tool_timeout = tool_timeout
        self.flow_manager = None
        tree_flow = _module("tree_flow")
        tree = json.loads(tree_json) if isinstance(tree_json, str) else tree_json
        data = yaml.safe_load(flow_yaml)
        self.tree_ids = tree_flow.node_tree_ids(data)
        self.decision_names = {d["name"] for d in tree_flow.handler_definitions(tree)}
        self.starts = self._start_nodes(data)
        self.flow = tree_flow.load_flow(flow_yaml, tree, gate=self._gate, catalog=catalog, request=self._tool_request if catalog is not None else None)
        self._mark_nodes()
        self._wrap_decisions()

    # Setup

    @staticmethod
    def _start_nodes(data: Mapping[str, Any]) -> dict[str, str]:
        """Direction to the start node's flow key, from crm_node.start (copies never count)."""
        out = {}
        for key, node in (data.get("nodes") or {}).items():
            for action in (node or {}).get("pre_actions") or []:
                if isinstance(action, Mapping) and action.get("type") == NODE_ACTION and action.get("start") and action.get("treeNode") == key:
                    out[action["start"]] = key
        out.setdefault("inbound", data.get("initial_node"))
        return out

    def _mark_nodes(self) -> None:
        """Pre actions run before the manager updates current_node, so each one carries its flow node key."""
        for name in self.flow.config.nodes:
            for action in self.flow.node(name).get("pre_actions", []):
                if action.get("type") in (NODE_ACTION, DISPOSITION_ACTION):
                    action[FLOW_NODE_KEY] = name

    def _wrap_decisions(self) -> None:
        schemas = [s for name in self.flow.config.nodes for s in self.flow.node(name).get("functions", [])] + list(self.flow.global_functions)
        for schema in schemas:
            if schema.name in self.decision_names and not getattr(schema.handler, "_crm_reports", False):
                schema.handler = self._reporting(schema.name, schema.handler)

    def _reporting(self, function: str, handler):
        async def reporting(args, flow_manager):
            node = getattr(flow_manager, "current_node", None)
            self.emit(
                {
                    "type": "decision",
                    "node": node,
                    "treeNode": self.tree_ids.get(node) if isinstance(node, str) else None,
                    "function": function,
                    "answer": (args or {}).get("answer"),
                    "router": ROUTER,
                }
            )
            return await handler(args, flow_manager)

        reporting._crm_reports = True
        return reporting

    # Requests to Node

    async def _tool_request(self, kind: str, payload: Mapping[str, Any]) -> Any:
        return await self.request(kind, payload, self.tool_timeout)

    async def _gate(self, function: str, answer: str, spec: Mapping[str, Any], flow_manager) -> bool:
        node = getattr(flow_manager, "current_node", None)
        tree_node = self.tree_ids.get(node) if isinstance(node, str) else None
        started = time.monotonic()
        try:
            reply = await self.request(
                "judge_request",
                {
                    "function": function,
                    "answer": answer,
                    "node": node,
                    "treeNode": tree_node,
                    "judge": spec.get("judge"),
                    "action": spec.get("action"),
                    "disposition": spec.get("disposition"),
                },
                self.judge_timeout,
            )
        except Exception:
            reply = None
        allowed = isinstance(reply, Mapping) and reply.get("allow") is True
        verdict = {
            "type": "judge_verdict",
            "function": function,
            "answer": answer,
            "node": node,
            "treeNode": tree_node,
            "allowed": allowed,
            "timedOut": reply is None,
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
        if isinstance(reply, Mapping) and isinstance(reply.get("reason"), str):
            verdict["reason"] = reply["reason"]
        self.emit(verdict)
        return allowed

    def handle_message(self, message: Mapping[str, Any]) -> bool:
        """A line from Node. Returns whether it was a reply this runtime was waiting for."""
        if not isinstance(message, Mapping) or message.get("type") != REPLY_TYPE:
            return False
        return self.requests.resolve(message.get("requestId"), message.get("result"))

    # Custom actions

    async def _on_node(self, action, flow_manager=None) -> None:
        message = {"type": "node_enter", "node": action.get(FLOW_NODE_KEY), "treeNode": action.get("treeNode"), "label": action.get("label")}
        if action.get("flowStep"):
            message["flowStep"] = action["flowStep"]
        self.emit(message)

    async def _on_disposition(self, action, flow_manager=None) -> None:
        self.emit(
            {
                "type": "disposition",
                "node": action.get(FLOW_NODE_KEY),
                "disposition": action.get("disposition"),
                "durable": bool(action.get("durable")),
                "guidance": action.get("guidance"),
            }
        )

    @staticmethod
    async def _no_op(action, flow_manager=None) -> None:
        return None

    # Running

    def attach(self, worker, llm, context_aggregator, transport=None):
        """Builds the flow manager over the pipeline's worker, language model and context aggregator."""
        from pipecat.flows import FlowManager

        manager = FlowManager(worker=worker, llm=llm, context_aggregator=context_aggregator, transport=transport, global_functions=self.flow.global_functions)
        for action_type in _module("tree_flow").CUSTOM_ACTION_TYPES:
            handler = {NODE_ACTION: self._on_node, DISPOSITION_ACTION: self._on_disposition}.get(action_type, self._no_op)
            manager.register_action(action_type, handler)
        self.flow_manager = manager
        return manager

    def start_node(self, direction: str) -> str:
        key = self.starts.get(direction)
        if not key:
            raise ValueError(f"the flow has no {direction} start node")
        return key

    async def start(self, direction: str) -> str:
        """Enters the start node for the call's direction: open.greeting inbound, entry.outbound outbound."""
        if self.flow_manager is None:
            raise RuntimeError("attach the runtime to a pipeline first")
        key = self.start_node(direction)
        await self.flow_manager.initialize(self.flow.node(key))
        return key

    def caller_turn(self, text: str) -> None:
        """Called by the sidecar on every finished caller line, before the flow sees it."""
        self.emit({"type": "caller_turn", "text": text})

    def agent_turn(self, text: str) -> None:
        """Called by the sidecar on every finished agent line, so the judge's transcript has it."""
        self.emit({"type": "agent_turn", "text": text})


# The Deepgram sidecar's router hook (sidecar_deepgram.load_router_hook): the sidecar loads this file when the
# start line names decision_router "pipecat_flows" and calls router_hook(start, emit, env).
PIPECAT_FOLDER = Path(__file__).resolve().parent
DEFAULT_FLOW_FILE = PIPECAT_FOLDER.parents[1] / "decision-tree" / "full-tree.flow.yaml"
DEFAULT_TREE_FILE = PIPECAT_FOLDER.parents[1] / "decision-tree" / "full-tree.json"
DEFAULT_CATALOG_FILE = PIPECAT_FOLDER.parents[1] / "flow-tools" / "catalog.json"


class SidecarHook:
    def __init__(self, runtime: FlowsRuntime, instructions: str):
        from pipecat.processors.aggregators.llm_context import LLMContext
        from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

        self.runtime = runtime
        self.pair = LLMContextAggregatorPair(LLMContext())
        # A node's role message replaces the reply model's system instruction, so the agent instruction leads it.
        for name in runtime.flow.config.nodes:
            node = runtime.flow.node(name)
            if node.get("role_message") and instructions:
                node["role_message"] = f"{instructions}\n\n{node['role_message']}"

    def wrap_stages(self, stages, turn, llm):
        """The flow manager needs a context pair: the user side after the turn processor, the assistant side last."""
        at = stages.index(turn) + 1
        return [*stages[:at], self.pair.user(), *stages[at:], self.pair.assistant()]

    def attach(self, worker, llm):
        self.runtime.attach(worker, llm, self.pair)

    async def start(self, direction):
        await self.runtime.start(direction)

    async def caller_turn(self, text):
        from pipecat.frames.frames import LLMMessagesAppendFrame

        self.runtime.caller_turn(text)
        return LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}], run_llm=True)

    def resolve(self, message):
        self.runtime.handle_message(message)


def router_hook(start: Mapping[str, Any], emit: Emit, env: Mapping[str, str]) -> SidecarHook:
    flow_file = Path(env.get("CRM_FLOW_FILE") or DEFAULT_FLOW_FILE)
    tree_file = Path(env.get("CRM_DECISION_TREE") or DEFAULT_TREE_FILE)
    catalog = json.loads(DEFAULT_CATALOG_FILE.read_text(encoding="utf-8")) if DEFAULT_CATALOG_FILE.exists() else None
    runtime = FlowsRuntime(flow_file.read_text(encoding="utf-8"), tree_file.read_text(encoding="utf-8"), emit, catalog=catalog)
    return SidecarHook(runtime, start.get("instructions") or "")
