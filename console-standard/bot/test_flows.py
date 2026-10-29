"""Plain-assert tests for the console's Pipecat Flows seam. No network.
Run: /tmp/crm-console-standard-venv/bin/python console-standard/bot/test_flows.py"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import flows  # noqa: E402
from flows import DEFAULT_FLOW, FlowsUnavailable, attach, console_gate, load  # noqa: E402


def refused(env):
    try:
        load(env)
    except FlowsUnavailable as err:
        return str(err)
    return None


# The compiled tree loads, the agent instruction leads the start nodes' role message, placeholders are filled.
flow, path = load({"AGENT_INSTRUCTIONS": "STANDING RULES"}, {"leadFirstName": "Maria"})
assert path == DEFAULT_FLOW
assert len(flow.config.nodes) > 90
starts = [n for n in flow.config.nodes if flow.node(n).get("role_message")]
assert set(starts) >= {"open.greeting", "entry.outbound"}, starts
for name in starts:
    assert flow.node(name)["role_message"].startswith("STANDING RULES\n\n")
texts = [m["content"] for n in flow.config.nodes for m in flow.node(n)["task_messages"]]
assert not any("{firstName}" in t or "{slotWords}" in t for t in texts)
assert any("Maria" in t for t in texts)
# With no lead name, nothing invents one.
flow2, _ = load({}, {})
assert any("do not say a name" in m["content"] for n in flow2.config.nodes for m in flow2.node(n)["task_messages"])

# Clear refusals for a missing or broken file.
assert "cannot read" in refused({"CRM_FLOW_FILE": "/nonexistent/flow.yaml"})
with tempfile.TemporaryDirectory() as tmp:
    broken = Path(tmp) / "flow.yaml"
    broken.write_text(DEFAULT_FLOW.read_text().replace('"initial_node": "open.greeting"', '"initial_node": "open.nowhere"'))
    assert "broken" in refused({"CRM_FLOW_FILE": str(broken)})
    broken.write_text("nodes: [unclosed")
    assert "did not load" in refused({"CRM_FLOW_FILE": str(broken)})


# The console gate: an ending runs, an action with no harness behind it refuses.
class Manager:
    worker = None
    current_node = "close.confirm_booking"


run = asyncio.run
assert run(console_gate("decide_close_confirm_booking", "yes", {"action": {"type": "book"}, "blockedCase": "yes__blocked"}, Manager())) is False
assert run(console_gate("decide_open_ai_question", "refuses_and_ends_the_call", {"disposition": "declined_ai_or_recording", "blockedCase": "x__blocked"}, Manager())) is True


# A refused booking takes the blocked case through Pipecat's own branch logic.
async def booking_branch():
    fn = next(f for f in flow.node("close.confirm_booking")["functions"] if f.name == "decide_close_confirm_booking")
    _, target = await fn.handler({"answer": "yes"}, Manager())
    return target


target = run(booking_branch())
# The refusal copy is named for the node the onBlocked line leads to (here close.offer_times).
assert target is flow.node("close.offer_times.blocked.yes"), target.get("name")


# attach builds a flow manager over a real (not running) worker, and start enters the right node.
async def attached(direction):
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.services.openai.llm import OpenAILLMService

    llm = OpenAILLMService(api_key="test", settings=OpenAILLMService.Settings(model="test"))
    pair = LLMContextAggregatorPair(LLMContext())
    worker = PipelineWorker(Pipeline([llm]))
    moves = []
    console = attach(worker=worker, llm=llm, context_aggregator=pair, transport=None, cfg={}, env={}, instructions="RULES", on_node=moves.append)
    assert console.describe().startswith("pipecat_flows: full-tree.flow.yaml (compiled tree)")
    await console.start(direction)
    assert moves == [console._manager.current_node], moves
    return console._manager.current_node


assert run(attached("inbound")) == "entry.greeting"
assert run(attached("outbound")) == "entry.greeting"
print("console flows tests passed")


# The quote prototype: a plain flow file with simulated tools, chosen through CRM_FLOW_FILE.
PROTOTYPE = Path(__file__).resolve().parents[1] / "flows" / "quote-prototype.flow.json"
proto, proto_path = load({"CRM_FLOW_FILE": str(PROTOTYPE), "CRM_DEMO_PRODUCER": "Dana Reyes", "CRM_DEMO_AGENCY": "Northwind Insurance Agency"}, {"leadFirstName": "Maria"})
assert proto_path == PROTOTYPE and len(proto.config.nodes) == 6
greet = proto.node("greet")["task_messages"][0]["content"]
assert "This is Dana Reyes's automated assistant with Northwind Insurance Agency." in greet and "Am I speaking with Maria?" in greet, greet


class ProtoManager:
    def __init__(self):
        self.state = {}
        self.worker = None
        self.current_node = "collect_quote_info"


async def call(node, name, args, manager):
    fn = next(f for f in proto.node(node)["functions"] if f.name == name)
    return await fn.handler(args, manager)


m = ProtoManager()
result, nxt = run(call("collect_quote_info", "save_quote_field", {"field": "employee_count", "value": "twelve"}, m))
assert result["success"] and nxt is None and m.state["quote"] == {"employee_count": "twelve"}
result, _ = run(call("collect_quote_info", "start_quote", {}, m))
assert result["quote_id"].startswith("demo-")
result, nxt = run(call("deliver_quote", "send_quote_link", {"channel": "text", "destination": "555 0100"}, m))
assert result["link"] == f"https://example.com/quotes/{m.state['quote_id']}" and nxt is proto.node("wrap_up")
result, _ = run(call("producer_request", "check_producer_available", {}, m))
assert result["available"] is False
_, nxt = run(call("producer_request", "take_message", {"message": "call me back"}, m))
assert nxt is proto.node("wrap_up")
_, nxt = run(call("producer_request", "transfer_to_producer", {}, m))
assert nxt is proto.node("end")
print("quote prototype tests passed")

# The map carries actual routes, including conditional cases, without prompts or lead data.
prototype_map = flows._map_nodes(PROTOTYPE)
assert next(n for n in prototype_map if n["id"] == "greet")["branches"][0] == {"label": "confirm_identity", "target": "collect_quote_info"}
compiled_map = flows._map_nodes(DEFAULT_FLOW)
assert {"label": "decide_entry_outbound: yes", "target": "open.identity_role"} in next(n for n in compiled_map if n["id"] == "entry.outbound")["branches"]
assert all(set(n) == {"id", "branches"} for n in compiled_map)
assert all(any(a.get("type") == "crm_node" for a in proto.node(n)["pre_actions"]) for n in proto.config.nodes)

async def map_stream():
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.services.openai.llm import OpenAILLMService
    llm = OpenAILLMService(api_key="test", settings=OpenAILLMService.Settings(model="test"))
    pair = LLMContextAggregatorPair(LLMContext())
    worker = PipelineWorker(Pipeline([llm]))
    messages = []
    async def capture(frame, *args, **kwargs):
        if hasattr(frame, "data"):
            messages.append(frame.data)
    worker.queue_frame = capture
    console = attach(worker=worker, llm=llm, context_aggregator=pair, transport=None, cfg={}, env={"CRM_FLOW_FILE": str(PROTOTYPE)})
    await console.start()
    await console._manager.set_node_from_config(console._flow.node("collect_quote_info"))
    assert messages[0]["event"] == "map" and len(messages[0]["nodes"]) == 6
    assert [m["node"] for m in messages if m.get("event") == "node_enter"] == ["greet", "collect_quote_info"]
run(map_stream())
print("decision map stream tests passed")
