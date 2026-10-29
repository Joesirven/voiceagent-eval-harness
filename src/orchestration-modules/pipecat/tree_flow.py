"""The decision tree as a Pipecat Flows flow: the compiled YAML joined to handlers generated from the tree.

src/decision-tree/full-tree.flow.yaml (written by scripts/compile-tree-flow.ts)
holds the nodes, the branch cases and the tree data the schema has no place
for. The schema forbids a description on any function that runs code, so each
decision's description and answer list live here instead: one async direct
function per decision function name, built from the same tree with the same
folding and naming rules as src/decision-tree/flow-compiler.ts (the tests
compare the two). Each decision handler returns the answer unchanged for now;
a later step asks the harness judge before a gated answer runs.

The interrupt handler follows the tree engine (src/decision/engine.ts,
checkInterrupt) in two places the YAML cannot express:
- an interrupt whose target is the tree node the call is on is ignored: the
  result's answer becomes "none", which has no branch case, so the flow stays
  and the language model is told to call the step's own decision function;
- an interrupt answer with "resume" has no branch case either: the result
  carries its line and tells the language model to say it in its own words,
  keeping its meaning, then ask the current step's question again. Live words
  always: no tree line is to be spoken word for word. At a start node the
  result quotes the disclosure the harness has already said (from
  crm_tree.disclosure) and says to leave out every sentence of the line
  that says the agent is an artificial intelligence assistant or that the call is recorded;
- at an ending (a flow node with a crm_disposition pre action) every
  interrupt is ignored: the end frame is already queued and the step only
  speaks its closing words.
The current tree node is read from crm_node.treeNode of the flow node
named by flow_manager.current_node, so via and blocked copies count as their
base node.

Pipecat 1.13.0 does not carry a Literal annotation into the tool schema, so
after the Flow is built the answer parameter of every decision function is
set to a string enum of the answer names. No pipeline wiring here.
"""
import re
from typing import Any, Mapping

import yaml
from pipecat.flows import Flow, FlowConfig
from pipecat.flows.types import TRANSITION_IN_YAML, FlowsFunctionSchema

INTERRUPT_FUNCTION = "interrupt"
ANSWER_FIELD = "answer"
BLOCKED_SUFFIX = "__blocked"
FUNCTION_NAME_PATTERN = re.compile(r"[a-zA-Z0-9_-]{1,64}")
MORE_PATTERN = re.compile(r"_more\d+$")
# Same words as src/decision-tree/loader.ts and flow-compiler.ts.
UNCLEAR_CRITERION = "None of the other answers clearly fits, or the caller's words are not clear enough to tell."
NO_INTERRUPT_CRITERION = "The caller is not doing any of the other things: carry on with the current step."
# Same words as GUIDANCE_LEAD in flow-compiler.ts and the decision model path in sidecar_deepgram.py.
GUIDANCE_LEAD = "Say this in your own natural words, keeping its meaning:"
# Same words as DISCLOSURE_LEAVE_OUT in flow-compiler.ts.
DISCLOSURE_LEAVE_OUT = "leave out every sentence that says you are an artificial intelligence assistant or that the call is recorded, however it is worded"
# Custom action types the compiled flow uses; a runtime registers a handler for each.
CUSTOM_ACTION_TYPES = ("crm_tree", "crm_node", "crm_answers", "crm_gates", "crm_disposition")


class TreeFlowError(Exception):
    """The flow and the tree do not fit together. Lists every problem."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__(f"tree flow refused ({len(problems)} problems): " + "; ".join(problems[:5]) + ("; ..." if len(problems) > 5 else ""))


def function_name_for(tree_id: str) -> str:
    return "decide_" + re.sub(r"[^a-zA-Z0-9]", "_", tree_id)


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _is_more_link(answer: Mapping[str, Any]) -> bool:
    nxt = answer.get("next")
    return answer.get("answer") == "other" and isinstance(nxt, str) and bool(MORE_PATTERN.search(nxt))


def _folded_answers(node: Mapping[str, Any], by_id: Mapping[str, Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The node's answers with its follow-ups folded in: no "other" link, the root's "unclear" only."""
    answers: list[Mapping[str, Any]] = []
    cur = node
    while True:
        link = next((a for a in cur["decision"]["answers"] if _is_more_link(a)), None)
        for a in cur["decision"]["answers"]:
            if a is link or (cur is not node and a["answer"] == "unclear"):
                continue
            answers.append(a)
        if link is None:
            return answers
        cur = by_id[link["next"]]


def _meaning(answer: Mapping[str, Any], interrupt: bool) -> str:
    if answer["answer"] == "unclear":
        return UNCLEAR_CRITERION
    if interrupt and answer["answer"] == "none":
        return NO_INTERRUPT_CRITERION
    return _one_line(answer.get("meaning") or answer["answer"])


def handler_doc(question: str, answers: list[Mapping[str, Any]], interrupt: bool) -> str:
    """The docstring: the question and every answer above a Google style Args section."""
    return "\n".join(
        [
            _one_line(question),
            "",
            "Call this with the one answer that fits the caller's last line. The answers:",
            *(f"- {a['answer']}: {_meaning(a, interrupt)}" for a in answers),
            "",
            "Args:",
            "    answer: The name of the one answer that fits, exactly as listed above.",
        ]
    )


def handler_definitions(tree: Mapping[str, Any]) -> list[dict[str, Any]]:
    """One definition per decision function: name, tree node, answer names and docstring."""
    by_id = {n["id"]: n for n in tree["nodes"]}
    out = []
    for node in tree["nodes"]:
        if MORE_PATTERN.search(node["id"]) or not node.get("decision"):
            continue
        answers = _folded_answers(node, by_id)
        out.append(
            {
                "name": function_name_for(node["id"]),
                "treeId": node["id"],
                "answers": [a["answer"] for a in answers],
                "doc": handler_doc(node["decision"]["question"], answers, False),
            }
        )
    interrupts = tree["interrupts"]
    out.append(
        {
            "name": INTERRUPT_FUNCTION,
            "treeId": "interrupts",
            "answers": [a["answer"] for a in interrupts["answers"]],
            "doc": handler_doc(interrupts["question"], interrupts["answers"], True),
        }
    )
    return out


def _name(handler, definition: Mapping[str, Any]):
    handler.__name__ = definition["name"]
    handler.__qualname__ = definition["name"]
    handler.__doc__ = definition["doc"]
    return handler


def _make_handler(definition: Mapping[str, Any], gates: Mapping[str, Mapping[str, Any]] | None = None, gate=None):
    gates = gates or {}

    async def handler(flow_manager, answer: str):
        spec = gates.get(answer)
        if spec is not None and gate is not None and not await gate(definition["name"], answer, spec, flow_manager):
            # Refused: the blocked case enters the copy whose guidance is the onBlocked line.
            return {ANSWER_FIELD: spec["blockedCase"], "blocked": answer}, TRANSITION_IN_YAML
        return {ANSWER_FIELD: answer}, TRANSITION_IN_YAML

    return _name(handler, definition)


def node_tree_ids(flow_data: Mapping[str, Any]) -> dict[str, str]:
    """Flow node key to its crm_node.treeNode, copies included. Endings have none."""
    out = {}
    for key, node in ((flow_data or {}).get("nodes") or {}).items():
        for action in (node or {}).get("pre_actions") or []:
            if isinstance(action, Mapping) and action.get("type") == "crm_node" and isinstance(action.get("treeNode"), str):
                out[key] = action["treeNode"]
    return out


def ending_keys(flow_data: Mapping[str, Any]) -> frozenset[str]:
    """Flow node keys of the endings: the nodes with a crm_disposition pre action."""
    return frozenset(
        key
        for key, node in ((flow_data or {}).get("nodes") or {}).items()
        if any(isinstance(a, Mapping) and a.get("type") == "crm_disposition" for a in (node or {}).get("pre_actions") or [])
    )


def disclosure_words(flow_data: Mapping[str, Any]) -> dict[str, str]:
    """The disclosure words the flow says the harness speaks, per direction, from crm_tree.disclosure."""
    for node in ((flow_data or {}).get("nodes") or {}).values():
        for action in (node or {}).get("pre_actions") or []:
            if isinstance(action, Mapping) and action.get("type") == "crm_tree" and isinstance(action.get("disclosure"), Mapping):
                return {k: v for k, v in action["disclosure"].items() if isinstance(v, str)}
    return {}


def _ask_again_line(node: Mapping[str, Any]) -> str:
    """What the engine says after a resume line: the node's own agent line, or its clarifying line."""
    lines = node.get("agentLines") or []
    return (lines[0]["line"] if lines else "") or node.get("clarify") or ""


def _make_interrupt_handler(
    definition: Mapping[str, Any], tree: Mapping[str, Any], tree_ids: Mapping[str, str], endings: frozenset[str], disclosure: Mapping[str, str]
):
    by_id = {n["id"]: n for n in tree["nodes"]}
    targets = {a["answer"]: a["next"] for a in tree["interrupts"]["answers"] if a.get("next")}
    resumes = {a["answer"]: a.get("say") or "" for a in tree["interrupts"]["answers"] if a.get("resume")}
    # Start tree id to the disclosure the harness said before it.
    starts = {tree["starts"].get(direction): disclosure.get(direction, "") for direction in ("outbound", "inbound") if tree["starts"].get(direction)}

    async def handler(flow_manager, answer: str):
        current = getattr(flow_manager, "current_node", None)
        if isinstance(current, str) and current in endings:
            # The call is ending: no transition, and no second disposition from another ending.
            return {
                ANSWER_FIELD: "none",
                "ignoredInterrupt": answer,
                "instruction": "The call is ending. Do not call any function: only speak the closing words this step asks for.",
            }, TRANSITION_IN_YAML
        here = tree_ids.get(current) if isinstance(current, str) else None
        node = by_id.get(here) if here else None
        if answer in resumes:
            ask = _ask_again_line(node) if node else ""
            question = _one_line(node["decision"]["question"]) if node and node.get("decision") else ""
            return {
                ANSWER_FIELD: answer,
                "say": resumes[answer],
                "instruction": (
                    f'{GUIDANCE_LEAD} "{resumes[answer]}" Then ask this step\'s question again in your own natural words'
                    + (f', keeping the meaning of: "{ask}"' if ask else "")
                    + (f" (the question: {question})" if question else "")
                    + (
                        ". The harness has already said the opening compliance disclosure"
                        + (f' in full: "{starts[here]}"' if starts[here] else "")
                        + f"; do not say it again, or any part of it: {DISCLOSURE_LEAVE_OUT}"
                        if here in starts
                        else ""
                    )
                    + ". Stay on this step; do not call any function until the caller answers."
                ),
            }, TRANSITION_IN_YAML
        if node is not None and targets.get(answer) == here:
            # The tree engine ignores this interrupt: the node's own question takes the line.
            return {
                ANSWER_FIELD: "none",
                "ignoredInterrupt": answer,
                "instruction": (
                    f'You are already at this step ({here}), which is where "{answer}" leads. '
                    f"Do not call {INTERRUPT_FUNCTION} again for this line: call {function_name_for(here)} now with the answer that fits the caller's last line."
                ),
            }, TRANSITION_IN_YAML
        return {ANSWER_FIELD: answer}, TRANSITION_IN_YAML

    return _name(handler, definition)


def gate_specs(flow_data: Mapping[str, Any]) -> dict[str, dict[str, Mapping[str, Any]]]:
    """Decision function name to {answer: gate} from the crm_gates actions (copies repeat the same gates)."""
    out: dict[str, dict[str, Mapping[str, Any]]] = {}
    for node in (flow_data.get("nodes") or {}).values():
        for action in (node or {}).get("pre_actions") or []:
            if isinstance(action, Mapping) and action.get("type") == "crm_gates" and isinstance(action.get("function"), str):
                for g in action.get("gates") or []:
                    if isinstance(g, Mapping) and isinstance(g.get("answer"), str) and isinstance(g.get("blockedCase"), str):
                        out.setdefault(action["function"], {})[g["answer"]] = g
    return out


def make_handlers(
    tree: Mapping[str, Any],
    tree_ids: Mapping[str, str],
    endings: frozenset[str],
    disclosure: Mapping[str, str],
    gates: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
    gate=None,
) -> dict[str, Any]:
    """One handler per decision function. All arguments are required, read from the flow data:
    tree_ids (node_tree_ids) so the interrupt handler can tell where the call is and does not re-enter the current node;
    endings (ending_keys) so an interrupt at an ending is ignored; disclosure (disclosure_words) so a resume line at a
    start node can quote the disclosure the harness already said. gates (gate_specs) and gate are optional together:
    gate(function_name, answer, gate_spec, flow_manager) -> bool is awaited before a gated answer is taken, and a
    refusal takes the answer's blocked case. With no gate every answer is taken as the model gave it."""
    return {
        d["name"]: _make_interrupt_handler(d, tree, tree_ids, endings, disclosure) if d["name"] == INTERRUPT_FUNCTION else _make_handler(d, (gates or {}).get(d["name"]), gate)
        for d in handler_definitions(tree)
    }


def flow_problems(data: Any, handler_names: set[str]) -> list[str]:
    """Every missing node target and every decision function with no handler, before Pipecat sees the flow."""
    if not isinstance(data, dict):
        return ["the flow's top level is not a mapping"]
    nodes = data.get("nodes") if isinstance(data.get("nodes"), dict) else {}
    problems = []
    if data.get("initial_node") not in nodes:
        problems.append(f"initial_node {data.get('initial_node')!r} is not a node")

    def check(where: str, fn: Any) -> None:
        if not isinstance(fn, dict):
            problems.append(f"{where} has a function that is not a mapping")
            return
        name = fn.get("name")
        if not isinstance(name, str) or not FUNCTION_NAME_PATTERN.fullmatch(name):
            problems.append(f"{where} function {name!r} is not a valid tool name")
        if not fn.get("transition_only") and name not in handler_names:
            problems.append(f"{where} function {name!r} has no handler generated from the tree or the tool catalog")
        to = fn.get("transition_to")
        targets = []
        if isinstance(to, str):
            targets = [to]
        elif isinstance(to, dict):
            targets = list((to.get("cases") or {}).values()) + ([to["default"]] if to.get("default") is not None else [])
        for target in targets:
            if target not in nodes:
                problems.append(f"{where} function {name!r} points at missing node {target!r}")

    for fn in data.get("global_functions") or []:
        check("global_functions", fn)
    for key, node in nodes.items():
        for fn in (node or {}).get("functions") or []:
            check(f"node {key!r}", fn)
    return problems


def _answer_property(definition: Mapping[str, Any]) -> dict[str, Any]:
    return {"type": "string", "enum": list(definition["answers"]), "description": "The name of the one answer that fits, exactly as listed in the description."}


def _set_enum(schema: FlowsFunctionSchema, definitions: Mapping[str, Mapping[str, Any]]) -> None:
    definition = definitions.get(schema.name)
    if definition is None:
        return
    # A fresh dict: the wrapper's own properties stay as Pipecat built them.
    schema.properties = {**schema.properties, ANSWER_FIELD: _answer_property(definition)}
    if ANSWER_FIELD not in schema.required:
        schema.required = [*schema.required, ANSWER_FIELD]


def _flow_handlers_module():
    """flow_handlers.py, loaded by path only when a catalog is given (-I keeps this directory off sys.path)."""
    import importlib.util
    import sys
    from pathlib import Path

    key = "crm_pipecat_flow_handlers"
    module = sys.modules.get(key)
    if module is None:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).resolve().parent / "flow_handlers.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        spec.loader.exec_module(module)
    return module


def load_flow(yaml_text: str, tree_json: str | Mapping[str, Any], gate=None, catalog: Mapping[str, Any] | None = None, request=None) -> Flow:
    """The compiled flow joined to handlers generated from the tree. Raises TreeFlowError before building a broken one.
    gate, when given, is asked before every judge-gated answer (see make_handlers). catalog (src/flow-tools/catalog.json,
    parsed) and request, optional together, add one handler per runnable catalog tool (flow_tools.py); each asks Node
    through request("tool_call", {"name", "arguments"}), and the tool schemas are then set from the catalog."""
    import json

    tree = json.loads(tree_json) if isinstance(tree_json, str) else tree_json
    definitions = {d["name"]: d for d in handler_definitions(tree)}
    data = yaml.safe_load(yaml_text)
    handlers_module = _flow_handlers_module() if catalog is not None else None
    tool_names = handlers_module.sibling("flow_tools").runnable_names(catalog) if handlers_module else set()
    problems = flow_problems(data, set(definitions) | tool_names)
    if problems:
        raise TreeFlowError(problems)
    config = FlowConfig.from_yaml(yaml_text)
    handlers = make_handlers(tree, node_tree_ids(data), ending_keys(data), disclosure_words(data), gate_specs(data), gate)
    if handlers_module:
        handlers = handlers_module.build_handlers(handlers, catalog, request)
    flow = Flow(config, handlers=handlers)
    for name in config.nodes:
        for schema in flow.node(name).get("functions", []):
            _set_enum(schema, definitions)
    for schema in flow.global_functions:
        _set_enum(schema, definitions)
    if handlers_module:
        handlers_module.sibling("flow_tools").patch_catalog_schemas(flow, catalog)
    return flow
