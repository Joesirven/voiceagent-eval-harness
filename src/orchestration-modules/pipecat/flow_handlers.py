"""The handler mapping for Flow(...): the decision handlers built from the tree plus the catalog tool handlers.

The sibling modules are loaded by file path (cached in sys.modules under
fixed names), because the scripts and sidecars run Python with -I, which
keeps this directory off sys.path. A name in both sets is refused.
"""
import importlib.util
import sys
from pathlib import Path
from typing import Any, Mapping

HERE = Path(__file__).resolve().parent


def sibling(name: str):
    """This directory's module `name`, loaded once by path and shared under the name crm_pipecat_<name>."""
    key = f"crm_pipecat_{name}"
    module = sys.modules.get(key)
    if module is None:
        spec = importlib.util.spec_from_file_location(key, HERE / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        spec.loader.exec_module(module)
    return module


def build_handlers(tree_handlers: Mapping[str, Any], catalog: Mapping[str, Any] | None, request=None) -> dict[str, Any]:
    """The tree handlers, and with a catalog the catalog handlers asking Node through `request`."""
    handlers = dict(tree_handlers)
    if catalog is None:
        return handlers
    if request is None:
        raise ValueError("a catalog needs a request function to reach Node")
    tools = sibling("flow_tools").make_catalog_handlers(catalog, request)
    clash = sorted(set(tools) & set(handlers))
    if clash:
        raise ValueError(f"catalog tools named like decision functions: {', '.join(clash)}")
    handlers.update(tools)
    return handlers
