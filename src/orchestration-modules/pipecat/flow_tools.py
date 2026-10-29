"""The CRM tool catalog (src/flow-tools/catalog.json) as Pipecat Flows direct functions.

One async handler(flow_manager, **arguments) per catalog tool whose status is
not "not_yet_built". A handler runs nothing itself: it asks Node, through the
injected request function, with request("tool_call", {"name", "arguments"}),
and Node's flow dispatcher (src/flow-tools/dispatch.ts) runs the checks, the
judge and the tool, and replies with its result ({ok, speakable, refused?,
endCall?}). Tools whose status is needs_seat_session or
needs_admin_machine_credential get a handler too: the dispatcher refuses them
with code needs_credential and the speakable line "A licensed producer will
follow up with you about that.", which the model then says in its own words.

Every handler returns (result, TRANSITION_IN_YAML), the configured-flow
contract (pipecat/flows/flow.py, _check_contract): the flow file decides
whether the call moves on, and a catalog tool with no transition_to stays on
the node, so the language model speaks the result. No reply from Node in
time gives {"ok": False, "refused": {"code": "no_reply"}, "speakable": ...}.

A direct function with **arguments gets one schema property named
"arguments", so patch_catalog_schemas replaces each catalog tool schema's
description, properties and required with the catalog's own. Importing this
module has no side effects: the catalog is read only when asked.
"""
import json
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from pipecat.flows.types import TRANSITION_IN_YAML

CATALOG_FILE = Path(__file__).resolve().parents[2] / "flow-tools" / "catalog.json"
NOT_BUILT = "not_yet_built"
NO_REPLY_SPEAKABLE = "I cannot do that right now. A licensed producer will follow up with you."

Request = Callable[[str, Mapping[str, Any]], Awaitable[Any]]


def read_catalog(path: str | Path | None = None) -> dict[str, Any]:
    """The catalog as written by the other side, unchanged."""
    return json.loads(Path(path or CATALOG_FILE).read_text(encoding="utf-8"))


def runnable_tools(catalog: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [t for t in catalog.get("tools") or [] if t.get("status") != NOT_BUILT]


def runnable_names(catalog: Mapping[str, Any]) -> set[str]:
    return {t["name"] for t in runnable_tools(catalog)}


def _make_handler(tool: Mapping[str, Any], request: Request):
    name = tool["name"]

    async def handler(flow_manager, **arguments):
        reply = await request("tool_call", {"name": name, "arguments": arguments})
        if not isinstance(reply, Mapping):
            reply = {"ok": False, "speakable": NO_REPLY_SPEAKABLE, "refused": {"code": "no_reply", "reason": "Node did not answer in time"}}
        return dict(reply), TRANSITION_IN_YAML

    handler.__name__ = name
    handler.__qualname__ = name
    handler.__doc__ = tool.get("description") or name
    return handler


def make_catalog_handlers(catalog: Mapping[str, Any], request: Request) -> dict[str, Any]:
    """One direct function per runnable catalog tool, keyed by its name."""
    return {t["name"]: _make_handler(t, request) for t in runnable_tools(catalog)}


def _patch(schema, tools: Mapping[str, Mapping[str, Any]]) -> None:
    tool = tools.get(schema.name)
    if tool is None:
        return
    parameters = tool.get("parameters") or {}
    schema.description = tool.get("description") or schema.description
    # Replaced whole, not merged: the wrapper's own "arguments" property must not survive.
    schema.properties = json.loads(json.dumps(parameters.get("properties") or {}))
    schema.required = list(parameters.get("required") or [])


def patch_catalog_schemas(flow, catalog: Mapping[str, Any]) -> None:
    """Sets every catalog tool schema in the flow (every node's own copy and the globals) from the catalog."""
    tools = {t["name"]: t for t in runnable_tools(catalog)}
    for name in flow.config.nodes:
        for schema in flow.node(name).get("functions", []):
            _patch(schema, tools)
    for schema in flow.global_functions:
        _patch(schema, tools)
