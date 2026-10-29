"""Local standard-input/output bridge. No network services, model clients or credentials.

TextFrame inputs and decision replies traverse a real Pipecat PipelineWorker.
The host supplies the decision function, preserving its judge/mutation boundary.
"""
import asyncio
import json
import sys
from dataclasses import dataclass
from importlib.metadata import version


def emit(message):
    print(json.dumps(message), flush=True)


try:
    if version("pipecat-ai") != "1.13.0":
        raise ImportError("unsupported version")
    from pipecat.frames.frames import EndFrame, StartFrame, TextFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.workers.runner import WorkerRunner
except Exception:
    emit({"id": 0, "error": "unavailable"})
    sys.exit(1)


@dataclass
class CallerText(TextFrame):
    request_id: int = 0


@dataclass
class AgentText(TextFrame):
    request_id: int = 0


class DecisionBridge(FrameProcessor):
    def __init__(self, pending):
        super().__init__()
        self.pending = pending

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, CallerText):
            future = asyncio.get_running_loop().create_future()
            self.pending[frame.request_id] = future
            emit({"id": frame.request_id, "type": "decision", "text": frame.text})
            try:
                answer = await future
                await self.push_frame(AgentText(text=answer, request_id=frame.request_id), direction)
            finally:
                self.pending.pop(frame.request_id, None)
        else:
            await self.push_frame(frame, direction)


class OutputBridge(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, StartFrame):
                emit({"id": 0, "type": "ready", "version": version("pipecat-ai")})
            elif isinstance(frame, AgentText):
                emit({"id": frame.request_id, "type": "result", "text": frame.text})
        await self.push_frame(frame, direction)


async def main():
    pending = {}
    # No LLMContextAggregatorPair: agent instructions live on the host (Azure or
    # DecisionContext.systemInstruction). Do not enable Pipecat automatic context
    # summarization if aggregators are added later (pipecat-ai issue 5595 risk).
    worker = PipelineWorker(Pipeline([DecisionBridge(pending), OutputBridge()]),
                            enable_rtvi=False, enable_turn_tracking=False,
                            cancel_on_idle_timeout=False, cancel_timeout_secs=1.0)
    @worker.event_handler("on_pipeline_error")
    async def on_pipeline_error(_worker, _frame):
        emit({"id": 0, "error": "provider_failed"})

    @worker.event_handler("on_pipeline_timeout")
    async def on_pipeline_timeout(_worker, _frame):
        emit({"id": 0, "error": "timeout"})

    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    await runner.add_workers(worker)
    try:  # opt-in Whisker; see devtools.py. A missing or broken helper must never stop a call.
        await __import__("runpy").run_path(__file__.rsplit("/", 1)[0] + "/devtools.py")["attach"](runner, worker)
    except Exception:
        print("devtools: helper unavailable; continuing without it", file=sys.stderr, flush=True)
    running = asyncio.create_task(runner.run())
    # A pipe reader avoids a blocked executor thread surviving cancellation.
    reader = asyncio.StreamReader(limit=131072)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    try:
        while line := await reader.readline():
            message = json.loads(line)
            request_id = message.get("id")
            if not isinstance(request_id, int) or request_id < 1:
                raise ValueError("protocol")
            kind = message.get("type")
            if kind == "text":
                text = message.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 32000:
                    raise ValueError("protocol")
                await worker.queue_frame(CallerText(text=text, request_id=request_id))
            elif kind == "reply":
                future = pending.get(request_id)
                text = message.get("text")
                if future is None or future.done() or not isinstance(text, str) or len(text) > 32000:
                    raise ValueError("protocol")
                future.set_result(text)
            elif kind in ("end", "cancel"):
                if kind == "end":
                    await worker.queue_frame(EndFrame())
                else:
                    await worker.cancel(reason="host_cancelled")
                await running
                emit({"id": request_id, "type": "closed"})
                return
            else:
                raise ValueError("protocol")
    finally:
        transport.close()
        if not running.done():
            await worker.cancel(reason="host_disconnected")
        await running


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # Never echo messages, prompts, paths or library exception details.
        emit({"id": 0, "error": "provider_failed"})
        sys.exit(1)
