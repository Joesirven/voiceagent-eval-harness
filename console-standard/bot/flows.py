"""Pipecat Flows in the console bot: the harness decision tree drives the reply model.

bot.py calls attach(...) when the chosen configuration's orchestration is
"pipecat_flows", then flow.start(direction) right after it queues the
disclosure. Everything is loaded fresh on each session, so a recompiled or
editor-saved flow applies on the next Connect with no restart.

The flow file is CRM_FLOW_FILE when set (for example a flow saved by the
editor), else the compiled tree, src/decision-tree/full-tree.flow.yaml. The
tree it was compiled from is CRM_DECISION_TREE, else
src/decision-tree/full-tree.json. Handlers come from the same tree through
src/orchestration-modules/pipecat/tree_flow.py.

What the console cannot run yet refuses clearly: a judge-gated answer that
carries an action (book, transfer, send a text, save details or a quote
field) has no harness behind it here, so it takes its blocked case and the
model says the tree's refusal line in its own words. A gated answer that only
ends the call with a disposition runs, because ending a console call writes
nothing anywhere; the disposition goes to the log and the event stream.

Tree lines are guidance for the model (live words always). The disclosure is
bot.py's own spoken line; the start nodes are told it has already been said.
"""
import json
import os
import re
import secrets
import sys
from pathlib import Path

from loguru import logger
from pipecat.flows import TRANSITION_IN_YAML

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "orchestration-modules" / "pipecat"))

DEFAULT_FLOW = REPO / "src" / "decision-tree" / "full-tree.flow.yaml"
DEFAULT_TREE = REPO / "src" / "decision-tree" / "full-tree.json"
# Gated actions with no harness behind them in the console.
NOT_BUILT_ACTIONS = ("book", "transfer", "send_text", "save_details", "save_quote_field")
OUTBOUND_START = "entry.outbound"
PLACEHOLDER = re.compile(r"\{(firstName|slotWords|producer|agency)\}")


class FlowsUnavailable(Exception):
    """The flow cannot run this session; the message is a plain reason for the event line."""


def _paths(env):
    flow = Path(env.get("CRM_FLOW_FILE") or DEFAULT_FLOW)
    tree = Path(env.get("CRM_DECISION_TREE") or DEFAULT_TREE)
    return flow, tree


def _fill(text, values):
    """Fills the tree's single-brace placeholders; an unknown value becomes a plain description, never a guess."""
    return PLACEHOLDER.sub(lambda m: values.get(m.group(1)) or _UNKNOWN[m.group(1)], text)


_UNKNOWN = {
    "firstName": "(the person's first name, which is not known here: do not say a name)",
    "slotWords": "(the time the caller chose)",
    "producer": "the producer",
    "agency": "the agency",
}


async def console_gate(function_name, answer, spec, flow_manager):
    """The console's stand-in for the harness judge: endings run, actions that are not built here refuse."""
    action = spec.get("action") or {}
    if action.get("type") in NOT_BUILT_ACTIONS:
        logger.warning(f"flow: {function_name} {answer} refused, {action.get('type')} is not built in the console")
        await _send(flow_manager, {"event": "action_not_built", "function": function_name, "answer": answer, "action": action.get("type")})
        return False
    return True


async def _send(flow_manager, data):
    """Best effort: one flow event to the page through the worker's server message, and to the log."""
    logger.info(f"flow: {data}")
    try:
        from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame

        await flow_manager.worker.queue_frame(RTVIServerMessageFrame(data={"type": "flow", **data}))
    except Exception as err:  # the page may not listen; the call goes on
        logger.debug(f"flow event not sent: {err}")


# The quote prototype's tools (console-standard/flows/quote-prototype.flow.json). Simulated: nothing is
# written or sent anywhere; each returns plausible data and reports itself to the Events panel.
async def _tool(flow_manager, name, args, result):
    # Tool calls go to the bot log only, not to the Events panel.
    logger.warning(f"flow tool: {name} {args}")
    return {"success": True, **result}, TRANSITION_IN_YAML


async def save_quote_field(flow_manager, field: str, value: str):
    """Save one quote detail the caller just gave.

    Args:
        field: One of business_name, business_description, employee_count, annual_payroll, current_carrier, renewal_date.
        value: The value, in the caller's words.
    """
    flow_manager.state.setdefault("quote", {})[field] = value
    return await _tool(flow_manager, "save_quote_field", {"field": field, "value": value}, {"saved": field})


async def start_quote(flow_manager):
    """Start building the quote from the details gathered so far."""
    quote_id = f"demo-{secrets.token_hex(3)}"
    flow_manager.state["quote_id"] = quote_id
    return await _tool(flow_manager, "start_quote", {"details": flow_manager.state.get("quote", {})}, {"quote_id": quote_id, "status": "in progress"})


async def send_quote_link(flow_manager, channel: str, destination: str):
    """Send the caller the quote link.

    Args:
        channel: "text" or "email".
        destination: The phone number or email address the caller confirmed.
    """
    quote_id = flow_manager.state.get("quote_id") or f"demo-{secrets.token_hex(3)}"
    link = f"https://example.com/quotes/{quote_id}"
    return await _tool(flow_manager, "send_quote_link", {"channel": channel, "destination": destination}, {"sent": True, "link": link})


async def check_producer_available(flow_manager):
    """Check whether the producer can take the call right now."""
    available = os.environ.get("CRM_DEMO_PRODUCER_AVAILABLE", "false").lower() in ("1", "true", "yes")
    return await _tool(flow_manager, "check_producer_available", {}, {"available": available})


async def transfer_to_producer(flow_manager):
    """Hand the caller to the producer now."""
    return await _tool(flow_manager, "transfer_to_producer", {}, {"transferred": True})


async def take_message(flow_manager, message: str):
    """Take a message for the producer, who will call back.

    Args:
        message: The caller's message, in their words.
    """
    return await _tool(flow_manager, "take_message", {"message": message}, {"recorded": True})


PROTOTYPE_TOOLS = {
    f.__name__: f
    for f in (save_quote_field, start_quote, send_quote_link, check_producer_available, transfer_to_producer, take_message)
}


class ConsoleFlow:
    def __init__(self, flow, manager, flow_path, instructions):
        self._flow = flow
        self._manager = manager
        self._path = flow_path
        self._instructions = instructions
        self._map = _map_nodes(flow_path)

    def describe(self):
        """One line for the configuration event line."""
        nodes = len(self._flow.config.nodes)
        source = "editor or override file" if self._path != DEFAULT_FLOW else "compiled tree"
        return f"pipecat_flows: {self._path.name} ({source}), {nodes} nodes"

    async def start(self, direction="inbound"):
        # A plain flow (the quote prototype) has one start for both directions.
        start = OUTBOUND_START if direction == "outbound" and OUTBOUND_START in self._flow.config.nodes else self._flow.config.initial_node
        await _send(self._manager, {"event": "map", "nodes": self._map})
        await self._manager.initialize(self._flow.node(start))


def _map_nodes(path):
    """Publish route names only, never prompts, arguments, or lead details."""
    import yaml

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    result = []
    for name, node in data.get("nodes", {}).items():
        branches = []
        for fn in [*node.get("functions", []), *data.get("global_functions", [])]:
            if not isinstance(fn, dict):
                continue
            target = fn.get("transition_to")
            if isinstance(target, dict):
                for answer, route in target.get("cases", {}).items():
                    if isinstance(route, str):
                        branches.append({"label": f"{fn.get('name', 'tool')}: {answer}", "target": route})
            else:
                branches.append({"label": fn.get("name", "tool"), **({"target": target} if isinstance(target, str) else {})})
        result.append({"id": name, "branches": branches})
    return result


def _register_actions(manager, on_node=None):
    """The five custom action types carry data for the runtime; here they report node moves and endings."""

    async def node_entered(action, flow_manager):
        await _send(flow_manager, {"event": "node_enter", "node": action.get("flowNode", action.get("treeNode")), "treeNode": action.get("treeNode")})
        if on_node is not None:
            on_node(action.get("treeNode"))

    async def on_disposition(action, flow_manager):
        await _send(flow_manager, {"event": "disposition", "disposition": action.get("disposition")})

    async def ignore(action, flow_manager):
        return None

    manager.register_action("crm_node", node_entered)
    manager.register_action("crm_disposition", on_disposition)
    for kind in ("crm_tree", "crm_answers", "crm_gates"):
        manager.register_action(kind, ignore)


def _prepare_nodes(flow, instructions, values):
    """The agent instruction stays the system instruction: a node's role message replaces it in Pipecat
    (LLMUpdateSettingsFrame), so the start nodes' role message is appended to it. Placeholders are filled."""
    for name in flow.config.nodes:
        node = flow.node(name)
        actions = node.setdefault("pre_actions", [])
        if not any(a.get("type") == "crm_node" for a in actions):
            actions.append({"type": "crm_node", "treeNode": name})
        for action in actions:
            if action.get("type") == "crm_node":
                action["flowNode"] = name
        if node.get("role_message"):
            role = _fill(node["role_message"], values)
            node["role_message"] = f"{instructions}\n\n{role}" if instructions else role
        for message in node.get("task_messages", []):
            message["content"] = _fill(message["content"], values)


def load(env, cfg=None, instructions=None):
    """The flow for one session, with its file path. Raises FlowsUnavailable with a plain reason."""
    cfg = cfg or {}
    flow_path, tree_path = _paths(env)
    try:
        from tree_flow import TreeFlowError, load_flow
    except Exception as err:
        raise FlowsUnavailable(f"the flow runtime could not load ({type(err).__name__})") from err
    try:
        yaml_text = flow_path.read_text(encoding="utf-8")
        tree_json = tree_path.read_text(encoding="utf-8")
    except OSError as err:
        raise FlowsUnavailable(f"cannot read {err.filename}") from err
    if "crm_tree" not in yaml_text:
        # A plain flow (the quote prototype, or one made in the editor): its tools are the prototype's.
        return _load_plain(flow_path, yaml_text, cfg, instructions, env)
    try:
        flow = load_flow(yaml_text, tree_json, gate=console_gate)
    except TreeFlowError as err:
        raise FlowsUnavailable(f"the flow file is broken: {err}") from err
    except Exception as err:
        raise FlowsUnavailable(f"the flow file did not load: {type(err).__name__}: {err}") from err
    values = _values(cfg, env)
    _prepare_nodes(flow, instructions if instructions is not None else env.get("AGENT_INSTRUCTIONS", ""), values)
    return flow, flow_path


def _values(cfg, env):
    return {
        "firstName": cfg.get("leadFirstName") or "",
        "producer": cfg.get("producerName") or env.get("CRM_DEMO_PRODUCER", ""),
        "agency": cfg.get("agencyName") or env.get("CRM_DEMO_AGENCY", ""),
    }


def _load_plain(flow_path, text, cfg, instructions, env):
    from pipecat.flows import Flow, FlowConfig

    try:
        config = FlowConfig.from_json(text) if flow_path.suffix == ".json" else FlowConfig.from_yaml(text)
        flow = Flow(config, handlers=PROTOTYPE_TOOLS)
    except Exception as err:
        raise FlowsUnavailable(f"the flow file did not load: {type(err).__name__}: {err}") from err
    _prepare_nodes(flow, instructions if instructions is not None else env.get("AGENT_INSTRUCTIONS", ""), _values(cfg, env))
    return flow, flow_path


def attach(*, worker, llm, context_aggregator, transport, cfg, env=os.environ, instructions=None, on_node=None):
    """Builds a FlowManager over bot.py's own reply model and context pair; the pipeline is unchanged.
    instructions is the agent instruction this session uses (default AGENT_INSTRUCTIONS); on_node(treeNode),
    when given, is called on every node move (copies report their tree node)."""
    from pipecat.flows import FlowManager

    flow, flow_path = load(env, cfg, instructions)
    manager = FlowManager(
        worker=worker,
        llm=llm,
        context_aggregator=context_aggregator,
        transport=transport,
        global_functions=flow.global_functions,
    )
    _register_actions(manager, on_node)
    return ConsoleFlow(flow, manager, flow_path, instructions)
