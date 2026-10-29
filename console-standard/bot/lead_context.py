"""Mid-call lead context for the console bot.

Before each reply, and again on each Pipecat Flows node_enter, the bot asks the harness for the call
context update (stage, and once past confirmation the quote checklist and the days until renewal) and,
when it changed, keeps it as one separate system message in the conversation, never inside the agent
instruction and never inside a line to say. It is information for the agent, not words to recite.

The harness holds account facts back until the stage is past confirmation, so this module only passes
on the stage it is at. Without a stage (single prompt mode has no tree) the harness answers with the
stage unknown and the confirmation gate sentence. Only a loopback harness address is contacted, redirects
are never followed, and any failure leaves the conversation as it was.
"""
import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request

from loguru import logger

TIMEOUT_SECONDS = 1
MAX_BYTES = 100_000
HEADING = "Call context update (information for you, not lines to say):"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch_update(lead, direction, base, tree_node=None, first_caller_line=None):
    """The update text from POST /api/lead-context/update, or None when it cannot be had (never raises).
    The first caller line goes in the JSON body, never in the URL, and is never logged."""
    try:
        parts = urllib.parse.urlsplit(base)
        if parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost"):
            return None
        body = {"leadId": lead, "direction": direction}
        if tree_node:
            body["treeNode"] = tree_node
        if first_caller_line:
            body["firstCallerLine"] = first_caller_line[:500]
        request = urllib.request.Request(
            f"{base}/api/lead-context/update",
            data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return None
        data = json.loads(raw.decode("utf-8"))
        text = data.get("text") if isinstance(data, dict) else None
        return text if isinstance(text, str) and text.startswith(HEADING) else None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError, UnicodeDecodeError):
        return None


def first_caller_line(messages):
    """The first non-empty user message in the conversation (the caller's first line after the disclosure)."""
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        if isinstance(content, str) and content.strip():
            return content.strip()
    return None


class ContextState:
    """Keeps the one update message current in a conversation context, replacing it in place when it changes."""

    def __init__(self, lead, direction, base, fetch=fetch_update):
        self.lead = lead
        self.direction = direction
        self.base = base
        self.tree_node = None
        self._fetch = fetch
        self._last = None
        self._message = None

    def note_node(self, tree_node):
        """Called on each Flows node_enter with the tree node id; the next refresh asks about that stage."""
        self.tree_node = tree_node if isinstance(tree_node, str) else None

    async def refresh(self, context):
        line = first_caller_line(context.messages)
        text = await asyncio.to_thread(self._fetch, self.lead, self.direction, self.base, self.tree_node, line)
        if not text or text == self._last:
            return False
        messages = context.messages
        if self._message is not None and any(m is self._message for m in messages):
            self._message["content"] = text
        else:
            self._message = {"role": "system", "content": text}
            context.add_message(self._message)
        self._last = text
        logger.info(f"lead context update sent ({len(text)} characters, node {self.tree_node or 'none'})")
        return True


def make_injector(context, lead, direction, base):
    """A pipeline processor to place just before the reply model, and the state that Flows node moves report to."""
    from pipecat.frames.frames import LLMContextFrame
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    state = ContextState(lead, direction, base)

    class ContextInjector(FrameProcessor):
        async def process_frame(self, frame, direction_of_flow):
            await super().process_frame(frame, direction_of_flow)
            if isinstance(frame, LLMContextFrame) and direction_of_flow == FrameDirection.DOWNSTREAM:
                try:
                    await state.refresh(frame.context)
                except Exception as err:  # never let a context update break a reply
                    logger.warning(f"lead context update skipped: {type(err).__name__}")
            await self.push_frame(frame, direction_of_flow)

    return ContextInjector(), state
