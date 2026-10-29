"""Runs a short fake Pipecat pipeline with the devtools hook, as a sidecar does."""
import asyncio
import json
import os
import runpy
import sys

from pipecat.frames.frames import EndFrame, TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner


class Pass(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if type(frame).__name__ == "StartFrame" and os.environ.get("FIXTURE_SLOW_START"):
            await asyncio.sleep(1.5)
        await self.push_frame(frame, direction)


async def main():
    if os.environ.get("FIXTURE_BLOCK_WHISKER"):
        sys.modules["pipecat_whisker"] = None  # makes `import pipecat_whisker` raise ImportError
    devtools = runpy.run_path(sys.argv[1])
    worker = PipelineWorker(Pipeline([Pass()]), enable_rtvi=False, enable_turn_tracking=False,
                            cancel_on_idle_timeout=False, cancel_timeout_secs=1.0)
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    await runner.add_workers(worker)
    sink = await devtools["attach"](runner, worker, os.environ.get("FIXTURE_CALL_ID"))
    running = asyncio.create_task(runner.run())
    await worker.queue_frame(TextFrame(text="hello"))
    await asyncio.sleep(0.3)
    print(json.dumps({"sink": type(sink).__name__ if sink else None,
                      "whisker_imported": "pipecat_whisker" in sys.modules}), flush=True)
    if os.environ.get("FIXTURE_HOLD"):
        await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline)
    if os.environ.get("FIXTURE_CANCEL"):
        await worker.cancel(reason="fixture")
    else:
        await worker.queue_frame(EndFrame())
    await asyncio.wait_for(running, 10)
    print(json.dumps({"done": True}), flush=True)


asyncio.run(main())
