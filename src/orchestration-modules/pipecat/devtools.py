"""Opt-in local debugging for the Pipecat sidecars (Whisker session recording).

Off unless CRM_WHISKER is "file" or "live". Nothing is imported in the
off state, so production needs only requirements.txt. Call content stays on
this machine: recordings go to data/whisker/<call id>.whisk (git-ignored) and
the live server binds 127.0.0.1 only. Never the hosted interface or ngrok.
Loopback does not stop web pages open in your own browser: the Whisker server
accepts a websocket from any origin, so use live mode only in a browser with no
other pages open. File mode has no such exposure.

    "file"  record the call to a .whisk file, load it in a local Whisker interface
    "live"  also run a Whisker server on 127.0.0.1:9090 (override the port with
            CRM_WHISKER_PORT); a browser on this machine can attach
            while the call is running

CRM_WHISKER_DIR overrides the recording directory (tests use it).

Call from a sidecar after runner.add_workers(worker) and before runner.run():

    await devtools.attach(runner, worker, call_id=None)

The call id falls back to CRM_CALL_ID, then to a timestamp and process id.
This helper never raises and never writes to standard output (the sidecar
protocol); problems are reported with fixed strings on standard error.
"""
import asyncio
import os
import re
import socket
import sys
import time
from pathlib import Path

LOOPBACK = "127.0.0.1"
DEFAULT_PORT = 9090
# src/orchestration-modules/pipecat/devtools.py -> repository root.
DEFAULT_DIRECTORY = Path(__file__).resolve().parents[3] / "data" / "whisker"


# Keeps the release tasks referenced until they finish.
_release_tasks = set()


def _warn(text):
    print(f"devtools: {text}", file=sys.stderr, flush=True)


def _mode():
    mode = os.environ.get("CRM_WHISKER", "").strip().lower()
    return mode if mode in ("file", "live") else None


def _safe_id(call_id):
    raw = str(call_id or os.environ.get("CRM_CALL_ID") or "")
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", raw)[:64].strip(".")
    return cleaned or f"{int(time.time())}-{os.getpid()}"


def _port():
    try:
        port = int(os.environ.get("CRM_WHISKER_PORT", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT
    return port if 0 < port < 65536 else DEFAULT_PORT


def _loopback_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((LOOPBACK, port))
        except OSError:
            return False
    return True


def _recording_path(directory, call_id):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{call_id}.whisk"
    if path.exists():
        path = directory / f"{call_id}-{int(time.time())}-{os.getpid()}.whisk"
    return path


async def attach(runner, worker, call_id=None, *, directory=None):
    """Record (and optionally serve) this pipeline worker. Returns the sink or None."""
    mode = _mode()
    if mode is None:
        return None
    try:
        try:
            from pipecat_whisker import WhiskerFile, WhiskerServer
        except ImportError:
            _warn("pipecat-ai-whisker is not installed; see requirements-dev.txt")
            return None
        where = directory or os.environ.get("CRM_WHISKER_DIR") or DEFAULT_DIRECTORY
        path = str(_recording_path(Path(where), _safe_id(call_id)))
        port = _port()
        if mode == "live" and _loopback_port_free(port):
            sink = WhiskerServer(host=LOOPBACK, port=port, file_name=path)
        else:
            if mode == "live":
                _warn("live port is taken; recording to file only")
            sink = WhiskerFile(path)
        await runner.add_workers(sink)
        try:
            worker.add_observer(sink.create_observer(worker))

            # The sink is a peer root worker; the runner only ends once every root
            # worker has finished, so stop it when the pipeline worker is done
            # (on_pipeline_finished does not fire when the worker is cancelled early).
            async def release():
                await worker.wait()
                await sink.stop()

            _release_tasks.add(asyncio.get_running_loop().create_task(release()))
        except Exception:
            await sink.stop()
            raise
        return sink
    except Exception:
        _warn("could not start; continuing without it")
        return None
