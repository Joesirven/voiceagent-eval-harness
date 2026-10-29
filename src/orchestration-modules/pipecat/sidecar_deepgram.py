"""Pipecat pipeline for live voice on Deepgram: speech to text, an Azure reply, text to speech.

Caller audio (mu-law, 8 kilohertz) enters from the Node host and runs through
Deepgram speech to text (Nova-3), the harness's turn logic, an Azure language
model reply and Deepgram text to speech (Aura-2). Speech goes back to the host
as mu-law, 8 kilohertz. The host keeps the decision step, the traces, the
opening disclosure record and the five minute cap; this process keeps turn
taking and interruption. Pipecat cancels the interrupted reply and the speech
queued behind it at the source, so no speech of an interrupted line reaches the
host after `cleared`, whatever stale_output_cap_gaps says; the field is checked
and accepted for the host's protocol but needs no separate drop here.

Credentials arrive only in the spawn environment: DEEPGRAM_API_KEY,
AZURE_FOUNDRY_URL (the /openai/v1 route), AZURE_FOUNDRY_KEY and optionally
AZURE_REPLY_DEPLOYMENT. DEEPGRAM_BASE_URL is for tests against a fake server.
They are never printed, logged or sent back to the host. Wire format, one JSON
object per line, is documented in docs/orchestration-modules.md.
"""
import asyncio
import base64
import json
import logging
import os
import re
import sys
import threading
import time
from importlib.metadata import version

SAMPLE_RATE = 8000
MAX_B64_LEN = 524_288
DEFAULT_VOICE = "aura-2-thalia-en"
STT_MODEL = "nova-3-general"
# The speech to text model is part of a URL query string too: plain model names only.
STT_MODEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}")
DEFAULT_REPLY_DEPLOYMENT = "gpt-5.6-luna"
GUIDANCE_TIMEOUT_SECS = 4.0
VERDICT_TIMEOUT_SECS = 2.0
STATS_EVERY = 50
# Who picks the next tree node. decision_model is the host's own decision step
# (the guidance wait below); the others are a router module in this folder that
# the router hook loads (see load_router_hook).
DECISION_ROUTERS = ("decision_model", "pipecat_flows", "pipecat_classifier")
ROUTER_MODULES = {"pipecat_flows": "flows_runtime.py", "pipecat_classifier": "classifier_runtime.py"}
# Spoken when a reply fails without ending the call (a non-fatal pipeline error).
FALLBACK_LINE = "Sorry, could you say that again?"
# An interim transcript interrupts the agent only from this many words on.
INTERIM_MIN_WORDS = 2

# Aura-2 English voices: any id of the form aura-2-<name>-en. The server offers
# only voices the Deepgram catalog lists (src/modules/deepgram-catalog.ts, which
# keeps aura-2-<letters>-en names), so a fixed list here would refuse voices
# Deepgram adds. The voice is part of a URL query string, so the shape stays
# strict (lowercase letters only, at most 64).
VOICE_PATTERN = re.compile(r"aura-2-[a-z]{1,64}-en")


def emit(message):
    print(json.dumps(message), flush=True)


class NoTextFormatter(logging.Formatter):
    """A level and a logger name only: never the message, the exception or a traceback."""

    def format(self, record):
        return f"{record.levelname} {record.name}"


def log_location(_record):
    # A callable format gets no automatic {exception}, so no traceback and no
    # exception text is ever added; it must end the line itself.
    return "{level} {name}:{function}:{line}\n"


# Standard error reaches the host's log, so no message text: Pipecat's
# messages, exceptions and tracebacks can quote provider error bodies and
# addresses. Where it was logged from and at what level is enough to find the
# cause. The standard logging module (asyncio's "never retrieved" task errors
# among them), warnings and exceptions no handler caught get the same treatment.
_stderr_handler = logging.StreamHandler(sys.stderr)
_stderr_handler.setFormatter(NoTextFormatter())
logging.basicConfig(level=logging.WARNING, handlers=[_stderr_handler], force=True)
logging.captureWarnings(True)
sys.excepthook = lambda kind, _value, _tb: print(f"ERROR uncaught {kind.__name__}", file=sys.stderr, flush=True)
sys.unraisablehook = lambda unraisable: print(f"ERROR unraisable {type(unraisable.exc_value).__name__}", file=sys.stderr, flush=True)
threading.excepthook = lambda args: print(f"ERROR thread {args.exc_type.__name__}", file=sys.stderr, flush=True)

try:
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, level="WARNING", format=log_location, diagnose=False, backtrace=False)
    import certifi

    # The interpreter runs isolated and with an allowlisted environment.
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    if version("pipecat-ai") != "1.13.0":
        raise ImportError("unsupported version")
    from pipecat.audio.utils import create_stream_resampler, pcm_to_ulaw, ulaw_to_pcm
    from pipecat.frames.frames import (
        EndFrame,
        InputAudioRawFrame,
        InterimTranscriptionFrame,
        InterruptionFrame,
        LLMContextFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
        MetricsFrame,
        TranscriptionFrame,
        TTSAudioRawFrame,
        TTSSpeakFrame,
        TTSStoppedFrame,
        TTSTextFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.metrics.metrics import ProcessingMetricsData, TTFBMetricsData
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.deepgram.tts import DeepgramTTSService
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.utils.string import TextPartForConcatenation, concatenate_aggregated_text
    from pipecat.workers.runner import WorkerRunner
except Exception:
    emit({"id": 0, "error": "unavailable"})
    sys.exit(1)


class ProtocolError(Exception):
    pass


def join_pieces(pieces):
    """Joins (text, includes_inter_frame_spaces) pieces the way Pipecat's aggregator does.

    Pieces that carry no spacing of their own (the text to speech service
    reports each sentence that way) are joined with a single space.
    """
    parts = [TextPartForConcatenation(text, spaced) for text, spaced in pieces]
    return re.sub(r" {2,}", " ", concatenate_aggregated_text(parts))


class Session:
    """State shared by the pipeline processors. One per process."""

    def __init__(self, start):
        instructions = start.get("instructions")
        disclosure = start.get("disclosure")
        voice = start.get("voice", DEFAULT_VOICE)
        stt_model = start.get("stt_model", STT_MODEL)
        gap = start.get("turn_gap_ms", 900)
        cap = start.get("stale_output_cap_gaps", 1)
        if not isinstance(instructions, str) or not instructions.strip():
            raise ProtocolError("instructions")
        if not isinstance(disclosure, str) or not disclosure.strip():
            raise ProtocolError("disclosure")
        if not isinstance(voice, str) or not VOICE_PATTERN.fullmatch(voice):
            raise ProtocolError("voice")
        if not isinstance(stt_model, str) or not STT_MODEL_PATTERN.fullmatch(stt_model):
            raise ProtocolError("stt_model")
        if isinstance(gap, bool) or not isinstance(gap, int) or not 300 <= gap <= 3000:
            raise ProtocolError("turn_gap_ms")
        if isinstance(cap, bool) or cap not in (0, 1, 2):
            raise ProtocolError("stale_output_cap_gaps")
        self.instructions = instructions
        self.disclosure = disclosure
        self.voice = voice
        self.stt_model = stt_model
        self.turn_gap_secs = gap / 1000
        self.cap_gaps = cap
        self.guard = start.get("guard") is True
        router = start.get("decision_router", "decision_model")
        direction = start.get("direction", "inbound")
        if router not in DECISION_ROUTERS:
            raise ProtocolError("decision_router")
        if direction not in ("inbound", "outbound"):
            raise ProtocolError("direction")
        self.router = router
        self.direction = direction
        # Set for a router other than decision_model: it owns the reply's context and node moves.
        self.router_hook = None
        # The conversation so far: user and assistant lines only. The standing
        # instruction is the language model's system instruction.
        self.history = [{"role": "assistant", "content": disclosure}]
        self.turn = 0
        self.guidance = {}
        self.context_update = None
        self.verdicts = {}
        self.line_seq = 0
        # {"id", "kind", "turn", "spoken": [(str, bool)], "announced", "fallback", "text_seen", "interrupted"}
        self.line = None
        # The line settled last: a reply the line check settled before its error arrived is found here.
        self.last_line = None
        # The reply line the reply model was producing when it reported an error, until its end frame.
        self.failed_reply = None
        self.reply_active = False
        self.speaking_until = 0.0
        # The disclosure (line 0) is protected from interruption until it has
        # stopped and its audio has played (disclosure_audible_until).
        self.disclosure_done = False
        self.disclosure_audible_until = 0.0
        # Called after any line is settled, so a held caller line can go on.
        self.on_line_done = None
        # Why each pending `cleared` happens, in the order the interruptions were sent.
        self.clear_reasons = []
        # The caller turn that last got a fallback line: at most one per turn.
        self.fallback_turn = None
        self.stats = {"audio_in": 0, "stt_final": 0, "tts_chunks": 0}

    def audible(self):
        return time.monotonic() < self.speaking_until

    def busy(self):
        return self.reply_active or self.audible()

    def protecting_disclosure(self):
        return not self.disclosure_done or time.monotonic() < self.disclosure_audible_until

    def replying(self):
        """A reply line (not the disclosure) is current."""
        return self.reply_active and self.line is not None and self.line["id"] != 0

    def begin_line(self, kind, fallback=False):
        # The opening disclosure is line 0: informational, never checked.
        if kind != "disclosure":
            self.line_seq += 1
        line_id = 0 if kind == "disclosure" else self.line_seq
        if kind == "reply" and not fallback:
            # A marker an interruption kept from its end frame must not cut this reply.
            self.failed_reply = None
        self.line = {
            "id": line_id,
            "kind": kind,
            "turn": self.turn,
            "spoken": [],
            "announced": False,
            "fallback": fallback,
            # Reply text has left the reply model, so speech for it may be under way.
            "text_seen": False,
            "interrupted": False,
        }
        self.reply_active = True
        return self.line

    def finish_line(self, interrupted, release=True):
        """Records the line in the conversation and tells the host what was said.

        With release false, a caller line held behind this one stays held: the
        failed reply's fallback is settled first, and releases it then.
        """
        line, self.line = self.line, None
        self.reply_active = False
        if line is None:
            return
        line["interrupted"] = interrupted
        self.last_line = line
        if line["id"] == 0:
            self.disclosure_done = True
            self.disclosure_audible_until = self.speaking_until
            if self.router_hook is not None:
                asyncio.get_running_loop().create_task(self.router_hook.start(self.direction))
        text = join_pieces(line["spoken"])
        if not text and line["kind"] == "disclosure" and not interrupted:
            text = self.disclosure
        # Line 0 is always reported, even empty: the host keys the end of the
        # disclosure's protection off it. A reply that failed before any word
        # was spoken is not reported; the host has the `warning`.
        if text or line["id"] == 0:
            if text and line["kind"] == "reply":
                self.history.append({"role": "assistant", "content": text})
            # A line announced before speech (the line check) was already reported
            # whole; the host sees an interruption through `cleared`.
            if not line["announced"]:
                emit({"type": "agent_line", "line_id": line["id"], "text": text, "interrupted": interrupted})
        # Last, so a caller line held behind this one comes after it in the history.
        if release and self.on_line_done:
            self.on_line_done()

    def note_interruption(self):
        self.speaking_until = time.monotonic()


class HostIngress(FrameProcessor):
    """Feeds caller audio from the host into the pipeline as 16-bit samples."""

    def __init__(self, queue):
        super().__init__()
        self.queue = queue
        self.resampler = create_stream_resampler()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

    async def pump(self):
        while True:
            data = await self.queue.get()
            if data is None:
                return
            pcm = await ulaw_to_pcm(data, SAMPLE_RATE, SAMPLE_RATE, self.resampler)
            await self.push_frame(
                InputAudioRawFrame(audio=pcm, sample_rate=SAMPLE_RATE, num_channels=1),
                FrameDirection.DOWNSTREAM,
            )


class TurnProcessor(FrameProcessor):
    """Joins transcripts into caller lines, asks the host what to say, starts the reply."""

    def __init__(self, session):
        super().__init__()
        self.s = session
        self.pending = []
        self.timer = None
        self.turn_task = None
        # A caller line that ended during the disclosure waits for it to stop.
        self.held = False
        session.on_line_done = self.release_held

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterimTranscriptionFrame):
            text = frame.text.strip()
            if text:
                emit({"type": "caller_partial", "text": text})
                # Only an interim of two words or more, while the agent is
                # actually audible, interrupts: a lone "uh" or a word heard
                # after the speech has played does not. Final transcripts and
                # typed text still interrupt a busy agent (see caller_said).
                # This and the disclosure protection in interrupt() stand in
                # for Pipecat's MinWordsUserTurnStartStrategy and
                # MuteUntilFirstBotCompleteUserMuteStrategy, which need an
                # output transport this pipeline does not have yet.
                if len(text.split()) >= INTERIM_MIN_WORDS and self.s.audible():
                    await self.interrupt("interim_transcript")
            return
        if isinstance(frame, TranscriptionFrame):
            text = frame.text.strip()
            if text:
                self.s.stats["stt_final"] += 1
                speech_final = bool(getattr(getattr(frame, "result", None), "speech_final", False))
                await self.caller_said(text, speech_final)
            return
        await self.push_frame(frame, direction)

    async def interrupt(self, reason):
        """The caller talks over the agent: cancel the reply and the queued speech."""
        if self.s.protecting_disclosure():
            return  # The disclosure is always heard whole.
        if self.s.busy():
            # Settle the line now, not when the interruption reaches the end of
            # the pipeline: a reply started right after must not be wiped by it.
            self.s.finish_line(True)
            self.s.note_interruption()
            self.s.clear_reasons.append(reason)
            await self.broadcast_interruption()

    async def caller_said(self, text, speech_final):
        if self.s.busy():
            await self.interrupt("final_transcript")
        self.pending.append(text)
        if self.timer:
            self.timer.cancel()
            self.timer = None
        if speech_final:
            self.finish_turn()
        else:
            self.timer = asyncio.create_task(self.wait_for_gap())

    async def wait_for_gap(self):
        await asyncio.sleep(self.s.turn_gap_secs)
        self.timer = None
        self.finish_turn()

    async def typed(self, text):
        if self.s.busy():
            await self.interrupt("typed_text")
        self.pending.append(text)
        self.finish_turn()

    def release_held(self):
        """A line has been settled: a caller line held behind it is answered now.

        A gap timer still running means the caller is still talking; the line
        finishes when that timer fires, as any other line does.
        """
        if self.held:
            self.held = False
            if self.timer is None:
                self.finish_turn()

    def finish_turn(self):
        s = self.s
        if not s.disclosure_done or (s.protecting_disclosure() and s.replying()):
            # Words spoken over the disclosure are kept, but the reply waits
            # for line 0's stop frame: it must not take over line 0. While the
            # disclosure is still audible a reply that has begun cannot be
            # interrupted either, so a line finished then waits for that reply.
            self.held = True
            return
        self.held = False
        text = " ".join(self.pending).strip()
        self.pending = []
        if not text:
            return
        self.s.turn += 1
        turn = self.s.turn
        self.s.history.append({"role": "user", "content": text})
        self.turn_task = asyncio.create_task(self.run_turn(turn, text))

    async def run_turn(self, turn, text):
        if self.s.router_hook is not None:
            # The router decides and replies itself: no guidance wait. The host still hears the line.
            emit({"type": "caller_final", "turn": turn, "text": text})
            self.s.begin_line("reply")
            await self.push_frame(await self.s.router_hook.caller_turn(text), FrameDirection.DOWNSTREAM)
            return
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.s.guidance[turn] = future
        emit({"type": "caller_final", "turn": turn, "text": text})
        try:
            guidance = await asyncio.wait_for(future, GUIDANCE_TIMEOUT_SECS)
        except asyncio.TimeoutError:
            guidance = None
        finally:
            self.s.guidance.pop(turn, None)
        if turn != self.s.turn:
            return  # The caller has said more since; that line gets the reply.
        messages = list(self.s.history)
        if self.s.context_update:
            # The latest call context: information for the agent, kept apart from the guidance line it may say.
            messages.append({"role": "system", "content": self.s.context_update})
        if guidance:
            messages.append(
                {
                    "role": "system",
                    "content": "The decision module chose what to say next. Say this in your own natural words, "
                    f'keeping its meaning: "{guidance}"',
                }
            )
        self.s.begin_line("reply")
        await self.push_frame(LLMContextFrame(LLMContext(messages=messages)), FrameDirection.DOWNSTREAM)


class ReplyModel(OpenAILLMService):
    """The reply model. Marks the reply it was producing as failed the moment it reports an error.

    The error goes upstream to the worker, which takes several hops; the end of
    the failed response goes downstream at once, so ReplyText must know first.
    """

    def __init__(self, session, **kwargs):
        super().__init__(**kwargs)
        self.s = session

    async def push_error(self, *args, **kwargs):
        if self.s.line is not None and self.s.line["kind"] == "reply":
            self.s.failed_reply = self.s.line
        await super().push_error(*args, **kwargs)


class ReplyText(FrameProcessor):
    """Sits right after the reply model: notes reply text, and cuts the speech of a reply that failed."""

    def __init__(self, session):
        super().__init__()
        self.s = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame) and self.s.line is None and self.s.router_hook is not None:
            # A reply the router started on its own (entering a node that responds at once) is a line too.
            self.s.begin_line("reply")
        if isinstance(frame, LLMTextFrame) and self.s.line is not None:
            self.s.line["text_seen"] = True
        elif isinstance(frame, LLMFullResponseEndFrame) and self.s.failed_reply is not None:
            failed, self.s.failed_reply = self.s.failed_reply, None
            if not failed["text_seen"]:
                await self.push_frame(frame, direction)
                return
            # Part of the failed reply has gone to text to speech. Its end frame
            # would speak the rest of it, and that speech and its stop frame
            # would be taken for the fallback line's, so the end frame goes no
            # further and the partial speech is cut (on_error settles the line).
            self.s.note_interruption()
            self.s.clear_reasons.append("reply_failed")
            await self.broadcast_interruption()
            return
        await self.push_frame(frame, direction)


class LineCheck(FrameProcessor):
    """With the line check on, holds a reply's text until the host answers."""

    def __init__(self, session):
        super().__init__()
        self.s = session
        self.parts = []
        self.collecting = False
        self.task = None
        self.owner = None  # The line the reply being collected belongs to.

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            self.parts, self.collecting = [], False
            if self.task:
                self.task.cancel()
                self.task = None
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMFullResponseStartFrame):
            self.parts, self.collecting, self.owner = [], True, self.s.line
        elif isinstance(frame, LLMTextFrame) and self.collecting:
            self.parts.append((frame.text, frame.includes_inter_frame_spaces))
        elif isinstance(frame, LLMFullResponseEndFrame) and self.collecting:
            self.collecting = False
            text = join_pieces(self.parts)
            self.parts = []
            self.task = asyncio.create_task(self.check(text, self.owner))
        else:
            await self.push_frame(frame, direction)

    async def check(self, text, line):
        # Only the line the reply was for: after a failed reply the current
        # line may already be the fallback, which must not be settled here.
        if line is None or self.s.line is not line:
            return
        if not text:
            self.s.finish_line(False)
            return
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.s.verdicts[line["id"]] = future
        line["announced"] = True
        emit({"type": "agent_line", "line_id": line["id"], "text": text, "interrupted": False})
        try:
            verdict = await asyncio.wait_for(future, VERDICT_TIMEOUT_SECS)
        except asyncio.TimeoutError:
            verdict = text
        finally:
            self.s.verdicts.pop(line["id"], None)
        if self.s.line is not line:
            return
        if verdict is None or not str(verdict).strip():
            self.s.finish_line(False)
            return
        await self.push_frame(LLMFullResponseStartFrame())
        await self.push_frame(LLMTextFrame(str(verdict)))
        await self.push_frame(LLMFullResponseEndFrame())


class Egress(FrameProcessor):
    """The end of the pipeline: speech goes back to the host as mu-law."""

    def __init__(self, session, stages):
        super().__init__()
        self.s = session
        self.resampler = create_stream_resampler()
        # Processor name to the stage a metric is reported under. Speech to
        # text never reports one in this pipeline: Pipecat starts its time to
        # first byte only at a voice activity detector's stop frame, and
        # Deepgram speech to text has no processing metric. That needs a voice
        # activity detector (later work, alongside the output transport).
        self.stages = stages

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        s = self.s
        if isinstance(frame, MetricsFrame):
            self.report_metrics(frame)
        if isinstance(frame, TTSAudioRawFrame):
            ulaw = await pcm_to_ulaw(frame.audio, frame.sample_rate, SAMPLE_RATE, self.resampler)
            now = time.monotonic()
            s.speaking_until = max(s.speaking_until, now) + len(ulaw) / SAMPLE_RATE
            s.stats["tts_chunks"] += 1
            emit({"type": "audio_out", "data": base64.b64encode(ulaw).decode("ascii")})
            return
        if isinstance(frame, TTSTextFrame):
            if s.line is not None:
                s.line["spoken"].append((frame.text, frame.includes_inter_frame_spaces))
        elif isinstance(frame, TTSStoppedFrame):
            if s.line is not None:
                s.finish_line(False)
        elif isinstance(frame, InterruptionFrame):
            # Every interruption here comes from TurnProcessor.interrupt or a failed reply, which queue their reason.
            reason = s.clear_reasons.pop(0) if s.clear_reasons else "host_barge_in"
            emit({"type": "cleared", "reason": reason})
        await self.push_frame(frame, direction)

    def report_metrics(self, frame):
        """Time to first byte and processing time per stage, in milliseconds. Numbers and fixed names only."""
        for data in frame.data:
            if isinstance(data, TTFBMetricsData):
                kind = "time_to_first_byte"
            elif isinstance(data, ProcessingMetricsData):
                kind = "processing"
            else:
                continue
            stage = self.stages.get(data.processor)
            # The worker's first metrics frame carries zeros for every processor.
            if stage is None or not isinstance(data.value, (int, float)) or data.value <= 0:
                continue
            emit({"type": "metrics", "turn": self.s.turn, "stage": stage, "kind": kind, "milliseconds": round(data.value * 1000)})


def build(session, env):
    """The pipeline and the handles the main loop needs."""
    deepgram_key = env.get("DEEPGRAM_API_KEY")
    azure_url = env.get("AZURE_FOUNDRY_URL")
    azure_key = env.get("AZURE_FOUNDRY_KEY")
    if not deepgram_key or not azure_url or not azure_key:
        raise RuntimeError("missing_credentials")
    deployment = env.get("AZURE_REPLY_DEPLOYMENT") or DEFAULT_REPLY_DEPLOYMENT
    deepgram_base = env.get("DEEPGRAM_BASE_URL", "").rstrip("/")

    queue = asyncio.Queue()
    ingress = HostIngress(queue)
    stt_kwargs = {"base_url": deepgram_base} if deepgram_base else {}
    stt = DeepgramSTTService(
        api_key=deepgram_key,
        encoding="linear16",
        sample_rate=SAMPLE_RATE,
        audio_passthrough=False,
        settings=DeepgramSTTService.Settings(
            model=session.stt_model,
            language="en",
            interim_results=True,
            punctuate=True,
            smart_format=True,
            endpointing=300,
        ),
        **stt_kwargs,
    )
    turn = TurnProcessor(session)
    llm = ReplyModel(
        session,
        api_key=azure_key,
        base_url=azure_url,
        default_headers={"api-key": azure_key},
        settings=OpenAILLMService.Settings(model=deployment, system_instruction=session.instructions),
    )
    tts_kwargs = {"base_url": deepgram_base} if deepgram_base else {}
    tts = DeepgramTTSService(
        api_key=deepgram_key,
        sample_rate=SAMPLE_RATE,
        encoding="linear16",
        settings=DeepgramTTSService.Settings(voice=session.voice),
        **tts_kwargs,
    )
    egress = Egress(session, {stt.name: "speech_to_text", llm.name: "reply", tts.name: "text_to_speech"})
    stages = [ingress, stt, turn, llm, ReplyText(session)]
    if session.guard:
        stages.append(LineCheck(session))
    stages += [tts, egress]
    if session.router != "decision_model":
        session.router_hook = load_router_hook(session, env)
        stages = session.router_hook.wrap_stages(stages, turn, llm)
    worker = PipelineWorker(
        Pipeline(stages),
        params=PipelineParams(
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        enable_rtvi=False,
        enable_turn_tracking=False,
        cancel_on_idle_timeout=False,
        idle_timeout_secs=None,
        cancel_timeout_secs=1.0,
    )
    if session.router_hook is not None:
        session.router_hook.attach(worker, llm)
    return worker, queue, ingress, turn, llm, tts


def load_router_hook(session, env):
    """The router module for a router other than decision_model, loaded from this folder.

    The interpreter runs isolated (no script folder on the path), so the module
    is loaded by file. It exposes router_hook(start, emit, env), returning an
    object with wrap_stages(stages, turn, llm) -> stages, attach(worker, llm),
    async start(direction), async caller_turn(text) -> frame to push after the
    turn processor, and resolve(message) for the host's flow_reply lines.
    """
    import importlib.util

    folder = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(folder, ROUTER_MODULES[session.router])
    if folder not in sys.path:
        sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location(f"crm_{session.router}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.router_hook({"router": session.router, "direction": session.direction, "instructions": session.instructions}, emit, env)


def is_fatal(frame):
    """Pipecat's own worker rule: the call ends on a fatal error, or when a processor can no longer be used.

    `fatal` is deprecated in Pipecat (gone in 2.0.0), but the worker still
    honors it, so it is read here too.
    """
    processor = getattr(frame, "processor", None)
    return bool(getattr(frame, "fatal", False)) or (processor is not None and not processor.is_usable)


def classify_failure(frame, llm):
    """Fixed code for a pipeline error. Only a code leaves this process, never the error text."""
    text = " ".join(str(getattr(frame, name, "") or "") for name in ("error", "exception")).lower()
    azure = getattr(frame, "processor", None) is llm
    if re.search(r"\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|invalid_api_key|authentication", text):
        return "azure_auth_failed" if azure else "deepgram_key_rejected"
    if azure and re.search(r"\b404\b|deployment_?not_?found|deployment .*not (found|exist)", text):
        return "azure_deployment_not_found"
    if azure and re.search(r"\b429\b|rate.?limit|too many requests", text):
        return "azure_rate_limited"
    return "azure_failed" if azure else "deepgram_failed"


async def main():
    reader = asyncio.StreamReader(limit=262144)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    failure = asyncio.Event()
    failed_code = []

    def fail(code):
        if not failed_code:
            failed_code.append(code)
            failure.set()

    first = await reader.readline()
    try:
        start = json.loads(first)
        if start.get("type") != "start":
            raise ProtocolError("start")
        session = Session(start)
        worker, queue, ingress, turn, llm, tts = build(session, os.environ)
    except Exception:
        emit({"id": 0, "error": "failed"})
        sys.exit(1)

    ready = False

    @worker.event_handler("on_pipeline_started")
    async def on_started(_worker, _frame):
        nonlocal ready
        if not ready:
            ready = True
            # Line 0 is current before the host hears `ready`, so nothing it
            # sends can interrupt the disclosure or take its line.
            session.begin_line("disclosure")
            emit({"id": 0, "type": "ready", "version": version("pipecat-ai")})
            await worker.queue_frame(TTSSpeakFrame(session.disclosure, append_to_context=False))

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame):
        code = classify_failure(frame, llm)
        if is_fatal(frame):
            fail(code)
            return
        # The call goes on: Pipecat's services retry or reconnect on their own.
        emit({"type": "warning", "code": code})
        processor = getattr(frame, "processor", None)
        if processor is not None and processor is not llm and processor is not tts:
            return  # Speech to text trouble leaves the agent's line alone.
        # A failed reply or speech: settle the current line, or busy() stays
        # true for good, and speak one short fallback in its place, once per
        # caller turn and never in place of a fallback (a failing text to
        # speech service would otherwise loop).
        line = session.line
        failed = line
        if failed is None and processor is llm:
            # With the line check on, the reply's end frame reaches it before
            # the error reaches the worker, and the empty reply is settled
            # there: the failed reply is the line settled last.
            last = session.last_line
            if last is not None and last["kind"] == "reply" and not last["interrupted"] and last["turn"] == session.turn:
                failed = last
        fallback = (
            failed is not None
            and failed["kind"] != "disclosure"
            and not failed["fallback"]
            and failed["turn"] == session.turn
            and session.fallback_turn != session.turn
        )
        if line is not None:
            # A caller line held behind the failed reply waits for the fallback.
            session.finish_line(True, release=not fallback)
        if not fallback:
            return  # A disclosure that failed is reported as cut off; no fallback in its place.
        # Speech of a reply that failed mid-stream was already cut by ReplyText.
        session.fallback_turn = session.turn
        session.begin_line("reply", fallback=True)
        await worker.queue_frame(TTSSpeakFrame(FALLBACK_LINE, append_to_context=False))

    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    await runner.add_workers(worker)
    await __import__("runpy").run_path(__file__.rsplit("/", 1)[0] + "/devtools.py")["attach"](runner, worker)  # opt-in Whisker; see devtools.py
    running = asyncio.create_task(runner.run())
    pump = asyncio.create_task(ingress.pump())

    async def listen():
        audio_in = 0
        while line := await reader.readline():
            message = json.loads(line)
            kind = message.get("type")
            if kind == "audio_in":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str) or len(data_b64) > MAX_B64_LEN:
                    raise ProtocolError("audio_in")
                audio_in += 1
                session.stats["audio_in"] = audio_in
                await queue.put(base64.b64decode(data_b64))
                if audio_in == 1 or audio_in % STATS_EVERY == 0:
                    emit({"type": "stats", **{k: v for k, v in session.stats.items()}})
            elif kind == "caller_text":
                text = message.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ProtocolError("caller_text")
                await turn.typed(text.strip())
            elif kind == "guidance":
                future = session.guidance.get(message.get("turn"))
                text = message.get("text")
                context = message.get("context")
                if isinstance(context, str) and context.strip() and len(context) <= 8000:
                    session.context_update = context.strip()
                if future is not None and not future.done():
                    future.set_result(text if isinstance(text, str) and text.strip() else None)
            elif kind == "flow_reply":
                if session.router_hook is None:
                    raise ProtocolError("flow_reply")
                session.router_hook.resolve(message)
            elif kind == "line_verdict":
                future = session.verdicts.get(message.get("line_id"))
                text = message.get("text")
                if future is not None and not future.done():
                    future.set_result(text if isinstance(text, str) else None)
            elif kind == "barge_in":
                await turn.interrupt("host_barge_in")
            elif kind == "end":
                await worker.queue_frame(EndFrame())
                await running
                return
            elif kind == "cancel":
                await worker.cancel(reason="host_cancelled")
                await running
                return
            else:
                raise ProtocolError("unknown")

    async def listen_guarded():
        try:
            await listen()
        except Exception:
            fail("protocol_error")

    listener = asyncio.create_task(listen_guarded())
    waiting = {asyncio.create_task(failure.wait()), listener}
    await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
    if failed_code:
        emit({"type": "error", "code": failed_code[0]})
        if not running.done():
            await worker.cancel(reason="sidecar_error")
    listener.cancel()
    await ingress.queue.put(None)
    pump.cancel()
    transport.close()
    if not running.done():
        await worker.cancel(reason="host_disconnected")
    try:
        await running
    except Exception:
        pass
    emit({"type": "ended"})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        emit({"id": 0, "error": "failed"})
        sys.exit(1)
