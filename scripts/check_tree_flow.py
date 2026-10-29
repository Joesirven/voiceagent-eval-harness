"""Loads a compiled tree flow with tree_flow.load_flow and prints a JSON summary on stdout.

Usage: <pinned Pipecat python> -I scripts/check_tree_flow.py [flow.yaml] [tree.json]

Defaults to src/decision-tree/full-tree.flow.yaml and full-tree.json. Prints
the node count, the functions per node, the most tools offered at one node
(globals included), every handler definition, every branch's case keys as
loaded, the answer property each tool schema ends up with, and whether the
YAML validates against Pipecat's flow_config.schema.json (only when the
jsonschema module is installed). A refused flow prints {"refused": [...]} and
exits 1. Pipecat's banner goes to standard error; standard output is JSON only.
"""
import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# -I keeps the script's own directory off sys.path, so load the module by path.
_spec = importlib.util.spec_from_file_location("tree_flow", REPO / "src/orchestration-modules/pipecat/tree_flow.py")
tree_flow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tree_flow)

import pipecat.flows  # noqa: E402
import yaml  # noqa: E402


def key_check(schema, data):
    """Without jsonschema: required keys, no extra keys where the schema forbids them, and the Function if-then-else rule."""
    defs = schema["$defs"]
    errors = []

    def check(where, value, spec):
        if not isinstance(value, dict):
            errors.append(f"{where} is not a mapping")
            return False
        errors.extend(f"{where} lacks {k}" for k in spec.get("required", []) if k not in value)
        if spec.get("additionalProperties") is False:
            errors.extend(f"{where} has extra key {k}" for k in value if k not in spec.get("properties", {}))
        return True

    def function(where, fn):
        if not check(where, fn, defs["Function"]):
            return
        if not fn.get("transition_only") and "description" in fn:
            errors.append(f"{where} has a description but is not transition_only")
        if isinstance(fn.get("transition_to"), dict):
            check(f"{where} transition_to", fn["transition_to"], defs["Branch"])

    if not check("flow", data, schema):
        return errors
    for i, fn in enumerate(data.get("global_functions") or []):
        function(f"global_functions[{i}]", fn)
    for key, node in data["nodes"].items():
        if not check(f"node {key}", node, defs["Node"]):
            continue
        for i, m in enumerate(node.get("task_messages") or []):
            check(f"node {key} task_messages[{i}]", m, defs["Message"])
        for i, fn in enumerate(node.get("functions") or []):
            function(f"node {key} functions[{i}]", fn)
        for part in ("pre_actions", "post_actions"):
            for i, a in enumerate(node.get(part) or []):
                check(f"node {key} {part}[{i}]", a, defs["Action"])
    return errors


def schema_check(data):
    schema = json.loads((Path(pipecat.flows.__file__).parent / "flow_config.schema.json").read_text(encoding="utf-8"))
    keys = key_check(schema, data)[:20]
    try:
        import jsonschema
    except ImportError:
        return {"ran": False, "why": "the jsonschema module is not installed in this Python", "keyCheckErrors": keys}
    errors = [e.message for e in jsonschema.Draft202012Validator(schema).iter_errors(data)]
    return {"ran": True, "errors": errors[:20], "keyCheckErrors": keys}


def main():
    flow_file = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "src/decision-tree/full-tree.flow.yaml"
    tree_file = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "src/decision-tree/full-tree.json"
    yaml_text = flow_file.read_text(encoding="utf-8")
    tree = json.loads(tree_file.read_text(encoding="utf-8"))
    try:
        flow = tree_flow.load_flow(yaml_text, tree)
    except tree_flow.TreeFlowError as e:
        print(json.dumps({"refused": e.problems}))
        return 1
    config = flow.config
    globals_ = flow.global_functions
    functions_per_node = {name: len(flow.node(name).get("functions", [])) for name in config.nodes}
    tools = {}
    for name in config.nodes:
        for schema in flow.node(name).get("functions", []):
            tools.setdefault(schema.name, schema.to_function_schema().to_default_dict())
    for schema in globals_:
        tools.setdefault(schema.name, schema.to_function_schema().to_default_dict())
    # Every schema instance, copies included: each node holds its own.
    missing_enum = [
        f"{name}:{schema.name}"
        for name in config.nodes
        for schema in flow.node(name).get("functions", [])
        if "enum" not in schema.properties.get("answer", {})
    ] + [f"global:{schema.name}" for schema in globals_ if "enum" not in schema.properties.get("answer", {})]
    case_keys = {}
    for name, node in config.nodes.items():
        for fn in node.functions:
            case_keys.setdefault(fn.name, sorted(fn.transition_to.cases))
    for fn in config.global_functions:
        case_keys.setdefault(fn.name, sorted(fn.transition_to.cases))
    print(
        json.dumps(
            {
                "nodeCount": len(config.nodes),
                "initialNode": config.initial_node,
                "globalFunctions": [f.name for f in globals_],
                "functionsPerNode": functions_per_node,
                "maxToolsAtOneNode": max(functions_per_node.values()) + len(globals_),
                "handlers": tree_flow.handler_definitions(tree),
                "caseKeys": case_keys,
                "tools": tools,
                "schemasMissingEnum": missing_enum,
                "schemaCount": sum(functions_per_node.values()) + len(globals_),
                "schemaValidation": schema_check(yaml.safe_load(yaml_text)),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
