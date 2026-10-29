"""Run: /tmp/crm-console-standard-venv/bin/python console-standard/bot/test_lead_context.py"""
import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import lead_context as lc  # noqa: E402

SEEN = []
BODIES = []
TEXT = {"value": f"{lc.HEADING}\nCall stage: discovery."}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        BODIES.append(json.loads(self.rfile.read(length) or b"{}"))
        SEEN.append(self.path)
        if self.path.startswith("/bad/"):
            body = b"not json"
        elif self.path.startswith("/foreign/"):
            body = json.dumps({"text": "no heading"}).encode()
        else:
            body = json.dumps({"text": TEXT["value"]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


server = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"

assert lc.fetch_update("lead-1", "inbound", base, "discovery.start") == TEXT["value"]
assert SEEN[-1] == "/api/lead-context/update", SEEN[-1]  # nothing in the URL
assert BODIES[-1] == {"leadId": "lead-1", "direction": "inbound", "treeNode": "discovery.start"}, BODIES[-1]
assert lc.fetch_update("lead-1", "inbound", base, None, "yes this is Maria") == TEXT["value"]
assert BODIES[-1] == {"leadId": "lead-1", "direction": "inbound", "firstCallerLine": "yes this is Maria"}, BODIES[-1]
assert "Maria" not in SEEN[-1]
assert lc.first_caller_line([{"role": "assistant", "content": "disclosure"}]) is None
assert lc.first_caller_line([{"role": "user", "content": "  "}, {"role": "user", "content": [{"type": "text", "text": "speaking"}]}]) == "speaking"
assert lc.fetch_update("lead-1", "inbound", base + "/bad") is None
assert lc.fetch_update("lead-1", "inbound", base + "/foreign") is None  # a text without the heading is not used
assert lc.fetch_update("lead-1", "inbound", "http://example.com") is None  # not loopback: never contacted
assert lc.fetch_update("lead-1", "inbound", "http://127.0.0.1:1") is None  # unreachable


class Ctx:
    def __init__(self):
        self.messages = [{"role": "assistant", "content": "disclosure"}]

    def add_message(self, m):
        self.messages.append(m)


async def run():
    ctx = Ctx()
    state = lc.ContextState("lead-1", "inbound", base)
    assert await state.refresh(ctx) is True and len(ctx.messages) == 2
    assert ctx.messages[1]["role"] == "system" and ctx.messages[1]["content"] == TEXT["value"]
    assert await state.refresh(ctx) is False and len(ctx.messages) == 2  # unchanged: nothing added
    TEXT["value"] = f"{lc.HEADING}\nCall stage: quote_fields."
    state.note_node("discovery.start")
    assert await state.refresh(ctx) is True and len(ctx.messages) == 2  # replaced in place, not stacked
    assert ctx.messages[1]["content"].endswith("quote_fields.")
    assert BODIES[-1].get("treeNode") == "discovery.start"
    ctx.messages.append({"role": "user", "content": "yes, that's me"})
    TEXT["value"] = f"{lc.HEADING}\nCall stage: quote_fields again."
    assert await state.refresh(ctx) is True and BODIES[-1].get("firstCallerLine") == "yes, that's me"
    ctx.messages.pop(1)  # a flow reset dropped our message: it is added again
    TEXT["value"] = f"{lc.HEADING}\nCall stage: booking."
    assert await state.refresh(ctx) is True and ctx.messages[-1]["content"].endswith("booking.")
    down = lc.ContextState("lead-1", "inbound", "http://127.0.0.1:1")
    assert await down.refresh(Ctx()) is False  # a failing harness leaves the conversation alone


asyncio.run(run())
processor, state = lc.make_injector(Ctx(), "lead-1", "inbound", base)
assert state.tree_node is None
print("lead_context ok")
