"""Pipecat PipelineWorker for live voice relay. Azure gpt-live stays in the Node host.

Caller audio enters as InputAudioRawFrame, passes through the worker, and the host
forwards it to Azure. Model audio re-enters as OutputAudioRawFrame from the host.
No credentials or network calls in this process.
"""
import asyncio
import base64
import json
import sys
from dataclasses import dataclass
from importlib.metadata import version

SAMPLE_RATE = 8000
# Host may send large Azure output_audio deltas; stay under Node's read buffer.
MAX_B64_LEN = 524_288
AUDIO_STATS = {"audio_in": 0, "to_model": 0, "model_in": 0}


def emit(message):
    print(json.dumps(message), flush=True)


try:
    if version("pipecat-ai") != "1.13.0":
        raise ImportError("unsupported version")
    from pipecat.frames.frames import (
        EndFrame,
        InputAudioRawFrame,
        InterruptionFrame,
        OutputAudioRawFrame,
        StartFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.workers.runner import WorkerRunner
except Exception:
    emit({"id": 0, "error": "unavailable"})
    sys.exit(1)


@dataclass
class HostAudio(InputAudioRawFrame):
    seq: int = 0


class HostIngress(FrameProcessor):
    def __init__(self, queue: asyncio.Queue):
        super().__init__()
        self.queue = queue

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

    async def pump(self):
        while True:
            item = await self.queue.get()
            if item is None:
                return
            seq, data = item
            await self.push_frame(
                HostAudio(audio=data, sample_rate=SAMPLE_RATE, num_channels=1, seq=seq),
                FrameDirection.DOWNSTREAM,
            )


class ModelRelay(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, HostAudio):
            AUDIO_STATS["to_model"] += 1
            emit({"type": "to_model", "seq": frame.seq, "data": base64.b64encode(frame.audio).decode("ascii")})
        elif isinstance(frame, OutputAudioRawFrame):
            # Host injected this audio for ordering only; do not echo it on stdout.
            AUDIO_STATS["model_in"] += 1
        await self.push_frame(frame, direction)


async def main():
    ingress_queue: asyncio.Queue = asyncio.Queue()
    ingress = HostIngress(ingress_queue)
    # Audio relay only; no LLM context aggregators or automatic summarization
    # (pipecat-ai issue 5595 risk if those processors are introduced here).
    worker = PipelineWorker(
        Pipeline([ingress, ModelRelay()]),
        enable_rtvi=False,
        enable_turn_tracking=False,
        cancel_on_idle_timeout=False,
        cancel_timeout_secs=1.0,
    )

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
    pump = asyncio.create_task(ingress.pump())
    await worker.queue_frame(StartFrame())
    emit({"id": 0, "type": "ready", "version": version("pipecat-ai")})

    reader = asyncio.StreamReader(limit=262144)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    seq = 0
    audio_in_count = 0
    try:
        while line := await reader.readline():
            message = json.loads(line)
            kind = message.get("type")
            if kind == "audio_in":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str) or len(data_b64) > MAX_B64_LEN:
                    raise ValueError("protocol")
                seq += 1
                audio_in_count += 1
                AUDIO_STATS["audio_in"] = audio_in_count
                await ingress_queue.put((seq, base64.b64decode(data_b64)))
                if audio_in_count == 1 or audio_in_count % 50 == 0:
                    emit(
                        {
                            "type": "stats",
                            "audio_in": audio_in_count,
                            "to_model": AUDIO_STATS["to_model"],
                            "model_in": AUDIO_STATS["model_in"],
                        }
                    )
            elif kind == "model_audio":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str) or len(data_b64) > MAX_B64_LEN:
                    raise ValueError("protocol")
                await worker.queue_frame(
                    OutputAudioRawFrame(
                        audio=base64.b64decode(data_b64),
                        sample_rate=SAMPLE_RATE,
                        num_channels=1,
                    )
                )
            elif kind == "barge_in":
                # Interrupt queued model audio only. A CancelFrame here ends the whole
                # pipeline, and caller audio silently stops reaching the model.
                await worker.queue_frame(InterruptionFrame())
                emit({"type": "cleared"})
            elif kind == "end":
                await worker.queue_frame(EndFrame())
                await running
                emit({"id": message.get("id", 1), "type": "closed"})
                return
            elif kind == "cancel":
                await worker.cancel(reason="host_cancelled")
                await running
                emit({"id": message.get("id", 1), "type": "closed"})
                return
            else:
                raise ValueError("protocol")
    finally:
        await ingress_queue.put(None)
        pump.cancel()
        transport.close()
        if not running.done():
            await worker.cancel(reason="host_disconnected")
        await running


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        emit({"id": 0, "error": "provider_failed"})
        sys.exit(1)
