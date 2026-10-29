"""Plain-assert tests for the instruction fetch and the summary line, against a local stub server.
Run: /tmp/crm-console-standard-venv/bin/python console-standard/bot/test_bot_helpers.py < /dev/null"""
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import bot  # noqa: E402

SEEN = []


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        SEEN.append(self.path)
        path = self.path.split("?")[0]
        if path == "/json/api/agent-instructions":
            self.reply(200, "application/json", b'{"instruction": "from json"}')
        elif path == "/text/api/agent-instructions":
            self.reply(200, "application/json", b'{"text": "from json text"}')
        elif path == "/plain/api/agent-instructions":
            self.reply(200, "text/plain", b"from plain text")
        elif path == "/nofield/api/agent-instructions":
            self.reply(200, "application/json", b'{"other": 1}')
        elif path == "/bad/api/agent-instructions":
            self.reply(200, "application/json", b"{not json")
        elif path == "/redirect/api/agent-instructions":
            self.send_response(302)
            self.send_header("Location", "http://example.invalid/x")
            self.end_headers()
        else:
            self.reply(500 if path.startswith("/error") else 404, "text/plain", b"no")

    def reply(self, code, kind, body):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = HTTPServer(("127.0.0.1", 0), Stub)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_address[1]}"


def get(prefix):
    return bot.fetch_instruction("default", "lead-1", "inbound", "launch text", base=base + prefix)


assert get("/json") == ("from json", "harness route")
assert get("/text") == ("from json text", "harness route")
assert get("/plain") == ("from plain text", "harness route")
assert SEEN[0] == "/json/api/agent-instructions?setup=default&lead=lead-1&direction=inbound", SEEN[0]
for prefix, reason in (("/nofield", "no instruction"), ("/bad", "could not be read"), ("/error", "answered 500"), ("/missing", "does not exist yet"), ("/redirect", "answered 302")):
    text, source = get(prefix)
    assert text == "launch text" and source.startswith("launch value because") and reason in source, (prefix, source)
server.shutdown()
text, source = get("")
assert text == "launch text" and source == "launch value because the harness route was unreachable", source
text, source = bot.fetch_instruction("default", "lead-1", "inbound", "launch text", base="http://example.com")
assert text == "launch text" and "not loopback" in source

line = bot.build_summary(stt_model="nova-3-general", reply_model="gpt-5.6-luna", voice="aura-2-thalia-en", endpointing_ms=300, vad_stop_secs=0.2,
                         orchestration="single_prompt", prompt_setup="default", instruction_source="harness route")
assert line == ("configuration: voice path cascaded, speech to text nova-3-general, reply gpt-5.6-luna, voice aura-2-thalia-en, endpointing 300 ms, "
                "voice detection stop 0.2 s, orchestration single_prompt, prompt setup default, instruction from harness route"), line
assert bot.build_summary(stt_model="a", reply_model="b", voice="c", endpointing_ms=1, vad_stop_secs=0.1, orchestration="pipecat_flows",
                         prompt_setup="x", instruction_source="s", flow_text="flow: two steps").endswith("; flow: two steps")
print("bot helper tests passed")
