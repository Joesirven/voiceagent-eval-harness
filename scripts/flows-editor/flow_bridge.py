"""Bridge between the Pipecat flows editor and the CRM harness.

Run as (never from inside the pipecat/flows directory, whose types.py shadows
the standard library):

    /tmp/voice-harness-pipecat-venv/bin/python -I scripts/flows-editor/flow_bridge.py <command> ...

Commands:
    export <source-flow> [destination]   validate a compiled flow, write it for the editor
    import <editor-file> --to <path>     validate an editor-saved file, write it atomically
    check <file>                         validate only (exit 0 or 1)

Problems go to standard error one per line. Non-fatal warnings start with "warning:".
"""

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

# Keep the Pipecat start-up banner off standard error so only real problems appear there.
os.environ.setdefault("LOGURU_LEVEL", "WARNING")

import yaml  # noqa: E402
from pipecat.flows import FlowConfig  # noqa: E402
from pydantic import ValidationError  # noqa: E402

DEFAULT_EXPORT_DIR = Path("artifacts") / "flows-editor"
DEFAULT_RUNTIME_FILE = str(Path(__file__).resolve().parents[2] / "src" / "decision-tree" / "full-tree.flow.yaml")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
DOUBLE_BRACE = re.compile(r"\{\{.*?\}\}", re.DOTALL)
SINGLE_BRACE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_.]*)\}")

# Pydantic messages that our explicit pass already reports with more detail.
COVERED_BY_CROSS_REFERENCE = (
    "is not a defined node",
    "transitions to unknown node",
    "duplicate function",
    "is also a global function",
)


class Refusal(Exception):
    def __init__(self, problems):
        super().__init__("; ".join(problems))
        self.problems = problems


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe loader that refuses a mapping key written twice (plain loading keeps only the last)."""


def construct_unique_mapping(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        try:
            key = loader.construct_object(key_node, deep=True)
            hash(key)
        except Exception:
            continue
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r}", key_node.start_mark
            )
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping
)


def is_mapping(value):
    return isinstance(value, dict)


def function_targets(func):
    """Return (label, target) pairs for a raw function mapping."""
    target = func.get("transition_to")
    if isinstance(target, str):
        return [("transition_to", target)]
    if is_mapping(target):
        out = []
        cases = target.get("cases")
        if is_mapping(cases):
            for key, node in cases.items():
                if isinstance(node, str):
                    out.append((f"branch case '{key}'", node))
        default = target.get("default")
        if isinstance(default, str):
            out.append(("branch default", default))
        return out
    return []


def cross_reference_problems(raw):
    problems = []
    nodes = raw.get("nodes")
    node_map = nodes if is_mapping(nodes) else {}
    initial = raw.get("initial_node")
    if isinstance(initial, str) and initial not in node_map:
        problems.append(f"initial_node '{initial}' is not a defined node")

    globals_raw = raw.get("global_functions")
    global_funcs = [f for f in globals_raw if is_mapping(f)] if isinstance(globals_raw, list) else []
    global_names = set()
    for func in global_funcs:
        name = func.get("name")
        if name in global_names:
            problems.append(f"duplicate global function '{name}'")
        global_names.add(name)

    for node_name, node in node_map.items():
        if not is_mapping(node):
            continue
        funcs = node.get("functions")
        seen = set()
        for func in funcs if isinstance(funcs, list) else []:
            if not is_mapping(func):
                continue
            name = func.get("name")
            if name in seen:
                problems.append(f"node '{node_name}': duplicate function '{name}'")
            seen.add(name)
            if name in global_names:
                problems.append(f"node '{node_name}': function '{name}' clashes with a global function")
            for label, target in function_targets(func):
                if target not in node_map:
                    problems.append(
                        f"node '{node_name}': function '{name}' {label} names missing node '{target}'"
                    )
    for func in global_funcs:
        for label, target in function_targets(func):
            if target not in node_map:
                problems.append(
                    f"global function '{func.get('name')}' {label} names missing node '{target}'"
                )
    return problems


def warnings_for(raw):
    warnings = []

    def check_name(where, name):
        if isinstance(name, str) and not SAFE_NAME.match(name):
            warnings.append(
                f"warning: {where} function name '{name}' has characters outside [A-Za-z0-9_-]; "
                "the model provider may reject it as a tool name"
            )

    def check_text(where, text):
        if not isinstance(text, str):
            return
        stripped = DOUBLE_BRACE.sub("", text)
        for match in SINGLE_BRACE.finditer(stripped):
            warnings.append(
                f"warning: {where} has single-brace placeholder '{{{match.group(1)}}}' that the "
                "flow manager will not fill (use double braces)"
            )

    nodes = raw.get("nodes")
    for node_name, node in (nodes.items() if is_mapping(nodes) else []):
        if not is_mapping(node):
            continue
        where = f"node '{node_name}'"
        for func in node.get("functions") or []:
            if is_mapping(func):
                check_name(where, func.get("name"))
                check_text(f"{where} function '{func.get('name')}' description", func.get("description"))
        check_text(f"{where} role_message", node.get("role_message"))
        for message in node.get("task_messages") or []:
            if is_mapping(message):
                check_text(f"{where} task message", message.get("content"))
        for key in ("pre_actions", "post_actions"):
            for action in node.get(key) or []:
                if is_mapping(action) and action.get("type") == "tts_say":
                    check_text(f"{where} {key} tts_say", action.get("text"))
    for func in raw.get("global_functions") or []:
        if is_mapping(func):
            check_name("global", func.get("name"))
    return warnings


def validate_text(text):
    """Return (raw mapping, warnings). Raise Refusal listing every problem."""
    stripped = text.lstrip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, list) or (is_mapping(parsed) and isinstance(parsed.get("nodes"), list)):
            raise Refusal(
                ["old editor JSON format (top-level nodes as a list) is not supported; "
                 "open the exported YAML file in the editor and save it again"]
            )
    try:
        raw = yaml.load(text, Loader=UniqueKeyLoader)  # noqa: S506 (safe loader subclass)
    except yaml.YAMLError as error:
        message = str(error).replace("\n", " ")
        if "!include" in text and "include" in message:
            raise Refusal(["!include is not allowed in imported flows"])
        raise Refusal([f"not valid YAML or JSON: {message}"])
    if not is_mapping(raw):
        raise Refusal(["top level must be a mapping with initial_node and nodes"])

    problems = cross_reference_problems(raw)
    try:
        FlowConfig.from_yaml(text)
    except ValidationError as error:
        for item in error.errors():
            message = str(item.get("msg", "")).replace("Value error, ", "")
            where = ".".join(str(part) for part in item.get("loc", ()))
            line = f"{where}: {message}" if where else message
            if problems and any(marker in message for marker in COVERED_BY_CROSS_REFERENCE):
                continue
            problems.append(f"schema: {line}")
    except Exception as error:
        problems.append(f"schema: {str(error)}".replace("\n", " "))
    if problems:
        raise Refusal(problems)
    return raw, warnings_for(raw)


def read_text(path):
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError) as error:
        raise Refusal([f"cannot read {path}: {error}"])


def write_atomically(destination, text):
    """Write through any symlink, keep the existing file mode, and report failures as a Refusal."""
    temporary = None
    try:
        destination = Path(os.path.realpath(destination))
        try:
            mode = destination.stat().st_mode & 0o7777
        except FileNotFoundError:
            current_mask = os.umask(0)
            os.umask(current_mask)
            mode = 0o666 & ~current_mask
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp"
        )
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
        temporary = None
    except OSError as error:
        raise Refusal([f"cannot write {destination}: {error}"])
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def load_handlers(spec):
    """Load a handlers module from a .py file path or a dotted module name."""
    import importlib
    import importlib.util

    try:
        if spec.endswith(".py"):
            module_spec = importlib.util.spec_from_file_location("crm_flow_handlers", spec)
            module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            return module
        return importlib.import_module(spec)
    except Exception as error:  # noqa: BLE001 (any failure refuses the import)
        raise Refusal([f"cannot load handlers {spec}: {error}".replace("\n", " ")])


def missing_handler_problems(raw, handlers):
    """Every direct (not transition_only) function must have a handler of the same name."""
    problems = []
    places = [(f"node '{name}'", node.get("functions"))
              for name, node in (raw.get("nodes") or {}).items() if is_mapping(node)]
    places.append(("global_functions", raw.get("global_functions")))
    for where, functions in places:
        for func in functions or []:
            if not is_mapping(func) or func.get("transition_only"):
                continue
            name = func.get("name")
            if not callable(getattr(handlers, str(name), None)):
                problems.append(f"{where} function '{name}' has no handler named '{name}' in the handlers")
    return problems


def check_handlers(raw, spec):
    if spec:
        problems = missing_handler_problems(raw, load_handlers(spec))
        if problems:
            raise Refusal(problems)


def emit_warnings(warnings):
    for line in warnings:
        print(line, file=sys.stderr)


def command_check(args):
    raw, warnings = validate_text(read_text(args.file))
    check_handlers(raw, args.handlers)
    emit_warnings(warnings)
    print("ok")


def looks_like_json(path, text):
    return Path(path).suffix.lower() == ".json" or text.lstrip().startswith("{")


def command_export(args):
    text = read_text(args.source)
    raw, warnings = validate_text(text)
    if looks_like_json(args.source, text):
        text = yaml.safe_dump(raw, sort_keys=False, allow_unicode=True)
    destination = Path(args.destination) if args.destination else DEFAULT_EXPORT_DIR
    if args.destination is None or destination.is_dir() or str(args.destination).endswith(os.sep):
        name = Path(args.source).name
        for suffix in (".flow.yaml", ".yaml", ".yml", ".json"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        destination = destination / f"{name}.flow.yaml"
    write_atomically(destination, text)
    emit_warnings(warnings)
    print(destination)


def command_import(args):
    text = read_text(args.editor_file)
    raw, warnings = validate_text(text)
    check_handlers(raw, args.handlers)
    destination = args.to or os.environ.get("VOICE_HARNESS_FLOW_FILE") or DEFAULT_RUNTIME_FILE
    write_atomically(destination, text)
    emit_warnings(warnings)
    print(destination)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_export = sub.add_parser("export")
    p_export.add_argument("source")
    p_export.add_argument("destination", nargs="?")
    p_export.set_defaults(run=command_export)
    p_import = sub.add_parser("import")
    p_import.add_argument("editor_file")
    p_import.add_argument("--to", help="runtime path to write (default: VOICE_HARNESS_FLOW_FILE, else src/decision-tree/full-tree.flow.yaml)")
    p_import.add_argument("--handlers", help="handlers .py file or dotted module; refuse a direct function without a handler")
    p_import.set_defaults(run=command_import)
    p_check = sub.add_parser("check")
    p_check.add_argument("file")
    p_check.add_argument("--handlers", help="handlers .py file or dotted module; refuse a direct function without a handler")
    p_check.set_defaults(run=command_check)
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except Refusal as refusal:
        for problem in refusal.problems:
            print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
