"""The standard console's voice bot: the harness's cascaded Deepgram path over SmallWebRTC.

Same models as the harness's Deepgram voice path: Deepgram Nova-3 speech to text, an
Azure reply model, Deepgram Aura-2 text to speech. The harness's own agent instruction
and opening line arrive in the environment from the launcher (console-standard/launch-bot.ts),
which reads credentials the same way the dev server does. Credentials are never printed.
Not yet wired: the harness decision tree and judges (the stock console shows Pipecat's own events).
"""
import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from loguru import logger
import os.path
sys.path.insert(0, os.path.dirname(__file__))
from settings import SettingsError, from_body  # noqa: E402
import lead_context  # noqa: E402
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import TTSSpeakFrame
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams

# Pipecat Flows is written separately; when its module is missing, flows are simply unavailable.
try:
    from flows import attach as attach_flows, FlowsUnavailable  # noqa: E402
except ImportError:
    attach_flows = None

    class FlowsUnavailable(Exception):
        pass

logger.remove()
logger.add(sys.stderr, level=os.environ.get("CONSOLE_LOG_LEVEL", "WARNING"))

# The harness copy that serves the agent instruction route. Loopback only, whatever the environment says.
HARNESS_URL = os.environ.get("CONSOLE_STANDARD_HARNESS_URL", "http://127.0.0.1:4311")
if not re.fullmatch(r"http://127\.0\.0\.1:\d{2,5}", HARNESS_URL):
    HARNESS_URL = "http://127.0.0.1:4311"
QUOTE_PROTOTYPE_FLOW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "flows", "quote-prototype.flow.json")
# First names of the three play leads, used for the flow's name placeholder.
LEAD_FIRST_NAMES = {"lead-1": "Maria", "lead-2": "Tom", "lead-3": "Priya"}
INSTRUCTION_TIMEOUT_SECONDS = 3
INSTRUCTION_MAX_BYTES = 1_000_000


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch_instruction(setup, lead, direction, fallback, base=HARNESS_URL):
    """Returns (instruction, source). The source reads "harness route" or "launch value because <reason>".
    Only a loopback address is contacted and redirects are never followed."""
    try:
        parts = urllib.parse.urlsplit(base)
        if parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost"):
            return fallback, "launch value because the harness address is not loopback"
        query = urllib.parse.urlencode({"setup": setup, "lead": lead, "direction": direction})
        request = urllib.request.Request(f"{base}/api/agent-instructions?{query}")
        opener = urllib.request.build_opener(_NoRedirect)
        with opener.open(request, timeout=INSTRUCTION_TIMEOUT_SECONDS) as response:
            raw = response.read(INSTRUCTION_MAX_BYTES + 1)
            kind = response.headers.get("Content-Type", "")
        if len(raw) > INSTRUCTION_MAX_BYTES:
            return fallback, "launch value because the harness answer was too large"
        text = raw.decode("utf-8")
        if "json" in kind.lower() or text.lstrip().startswith("{"):
            data = json.loads(text)
            text = None
            if isinstance(data, dict):
                text = data.get("instruction", data.get("text"))
            if not isinstance(text, str):
                return fallback, "launch value because the harness answer had no instruction"
        if not text.strip():
            return fallback, "launch value because the harness answer was empty"
        return text, "harness route"
    except urllib.error.HTTPError as err:
        reason = "the harness route does not exist yet" if err.code == 404 else f"the harness route answered {err.code}"
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        reason = "the harness route was unreachable"
    except (ValueError, UnicodeDecodeError):
        reason = "the harness answer could not be read"
    return fallback, f"launch value because {reason}"


def build_summary(*, stt_model, reply_model, voice, endpointing_ms, vad_stop_secs, orchestration, prompt_setup, instruction_source, flow_text=None):
    """One line of the settings this call is actually built with: model ids and numbers only."""
    summary = (
        f"configuration: voice path cascaded, speech to text {stt_model}, reply {reply_model}, voice {voice}, "
        f"endpointing {endpointing_ms} ms, voice detection stop {vad_stop_secs} s, "
        f"orchestration {orchestration}, prompt setup {prompt_setup}, instruction from {instruction_source}"
    )
    return f"{summary}; {flow_text}" if flow_text else summary


transport_params = {
    "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
}


async def bot(runner_args: RunnerArguments):
    # The runner starts at debug level, which logs prompts and conversation text; keep warnings and errors only.
    logger.remove()
    logger.add(sys.stderr, level=os.environ.get("CONSOLE_LOG_LEVEL", "WARNING"))
    # The page sends its chosen configuration in the /start request; only allowlisted values are accepted.
    body = getattr(runner_args, "body", None)
    try:
        cfg = from_body(body)
    except SettingsError as err:
        logger.error(f"configuration refused: {err}")
        # Close the peer connection the runner already created, so the browser does not sit on a silent call.
        connection = getattr(runner_args, "webrtc_connection", None)
        if connection is not None:
            try:
                await connection.disconnect()
            except Exception as close_err:  # closing is best effort
                logger.error(f"could not close refused connection: {close_err}")
        return
    transport = await create_transport(runner_args, transport_params)
    env = os.environ
    # The agent instruction is built per call by the harness; the launch-time value is the fallback.
    instruction, instruction_source = await asyncio.to_thread(
        fetch_instruction, cfg["promptSetup"], cfg["lead"], cfg["direction"], env["AGENT_INSTRUCTIONS"]
    )
    # The values the pipeline below is built from; the same variables feed the services and the announcement.
    stt_model = cfg["sttModel"]
    reply_model = env.get("AZURE_REPLY_DEPLOYMENT", "gpt-5.6-luna") if cfg["replyDeployment"] == "default" else cfg["replyDeployment"]
    voice = cfg["voice"]
    endpointing_ms = cfg["endpointingMs"]
    vad_stop_secs = cfg["vadStopSecs"]
    stt = DeepgramSTTService(
        api_key=env["DEEPGRAM_API_KEY"],
        settings=DeepgramSTTService.Settings(
            model=stt_model, language="en", interim_results=True,
            punctuate=True, smart_format=True, endpointing=endpointing_ms,
        ),
    )
    llm = OpenAILLMService(
        api_key=env["AZURE_FOUNDRY_KEY"],
        base_url=env["AZURE_FOUNDRY_URL"],
        default_headers={"api-key": env["AZURE_FOUNDRY_KEY"]},
        settings=OpenAILLMService.Settings(
            model=reply_model,
            system_instruction=instruction,
        ),
    )
    tts = DeepgramTTSService(
        api_key=env["DEEPGRAM_API_KEY"],
        settings=DeepgramTTSService.Settings(voice=voice),
    )
    disclosure = env["AGENT_DISCLOSURE"]
    # The quote prototype flow says its own opening line (with the disclosure); the others start after the harness disclosure.
    speaks_own_opening = cfg["orchestration"] == "quote_prototype"
    context = LLMContext([] if speaks_own_opening else [{"role": "assistant", "content": disclosure}])
    pair = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=vad_stop_secs)))
    )
    # Keeps the stage, quote checklist and renewal count current mid-call, as its own system message (information, never a line to say).
    context_injector, context_state = lead_context.make_injector(context, cfg["lead"], cfg["direction"], HARNESS_URL)
    pipeline = Pipeline([transport.input(), stt, pair.user(), context_injector, llm, tts, transport.output(), pair.assistant()])
    worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True, enable_usage_metrics=True))

    # Pipecat Flows, when asked for and available; otherwise the single prompt runs and the summary says why.
    flow = None
    orchestration_note = None
    if cfg["orchestration"] in ("pipecat_flows", "quote_prototype"):
        # The quote prototype is its own flow file; the decision tree flow uses the launcher's flow file or the compiled tree.
        flow_env = {**os.environ, "CRM_FLOW_FILE": QUOTE_PROTOTYPE_FLOW} if cfg["orchestration"] == "quote_prototype" else os.environ
        try:
            if attach_flows is None:
                raise FlowsUnavailable("the flows module is not present")
            flow = attach_flows(worker=worker, llm=llm, context_aggregator=pair, transport=transport, cfg={**cfg, "leadFirstName": LEAD_FIRST_NAMES.get(cfg["lead"])}, env=flow_env, instructions=instruction, on_node=context_state.note_node)
        except (FlowsUnavailable, ImportError) as err:
            flow = None
            orchestration_note = f"orchestration: {cfg['orchestration']} unavailable because {err}; using single prompt"

    @transport.event_handler("on_client_connected")
    async def on_connected(_transport, _client):
        # Shows which settings this call actually runs with: model ids and numbers only.
        summary = build_summary(
            stt_model=stt_model, reply_model=reply_model, voice=voice, endpointing_ms=endpointing_ms,
            vad_stop_secs=vad_stop_secs, orchestration=cfg["orchestration"] if flow is not None else "single_prompt" if orchestration_note else cfg["orchestration"],
            prompt_setup=cfg["promptSetup"], instruction_source=instruction_source,
            flow_text=flow.describe() if flow is not None else orchestration_note,
        )
        logger.warning(summary)
        if speaks_own_opening and flow is not None:
            # The quote prototype opening, word for word, with the selected lead's first name.
            first = LEAD_FIRST_NAMES.get(cfg["lead"], "there")
            greeting = f"This is {env.get('CRM_DEMO_PRODUCER', 'Dana Reyes')}'s automated assistant with {env.get('CRM_DEMO_AGENCY', 'Northwind Insurance Agency')}. Am I speaking with {first}?"
            context.add_message({"role": "assistant", "content": greeting})
            opening = [TTSSpeakFrame(greeting)]
        else:
            opening = [TTSSpeakFrame(disclosure)]
        await worker.queue_frames([RTVIServerMessageFrame(data={"type": "configuration", "text": summary}), *opening])
        if flow is not None:
            await flow.start(direction=cfg["direction"])

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        await worker.cancel()

    from pipecat.workers.runner import WorkerRunner

    await WorkerRunner(handle_sigint=False).run(worker)


if __name__ == "__main__":
    from pipecat.runner.run import main

    # The runner configures debug-level logging when it starts, which would write prompts, the lead's
    # context and connection details to the log. Keep the level we chose for every sink it adds.
    _add = logger.add
    _floor = os.environ.get("CONSOLE_LOG_LEVEL", "WARNING")
    logger.add = lambda sink, *args, **kwargs: _add(sink, *args, **{**kwargs, "level": _floor})

    main()
