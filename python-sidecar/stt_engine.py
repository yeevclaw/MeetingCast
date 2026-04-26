"""MeetingCast STT sidecar.

Long-running daemon that consumes commands from stdin and emits transcript
events to stdout, both line-delimited JSON. See protocol.py for the schema.

For dev convenience this imports the existing STT modules from prototype/
via sys.path; PyInstaller packaging in Phase 4 will collect them properly.
"""
import asyncio
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "prototype"))

from audio_stream import wav_chunks  # noqa: E402
from stt import get_backend  # noqa: E402


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def stdin_lines():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            return
        yield line.decode("utf-8", errors="replace").strip()


def make_audio_source(source: dict):
    kind = source.get("type", "mic")
    if kind == "mic":
        from audio_capture import mic_chunks
        return mic_chunks(sample_rate=16000, chunk_ms=100)
    if kind == "wav":
        path = source.get("path")
        if not path:
            raise ValueError("source.wav requires 'path'")
        return wav_chunks(path, chunk_ms=100, realtime=True)
    raise ValueError(f"unknown source type: {kind}")


async def run_stt(cmd: dict, cancel_event: asyncio.Event):
    backend_name = cmd.get("backend", "local")
    language = cmd.get("language", "zh")
    source_cfg = cmd.get("source", {"type": "mic"})

    try:
        chunks = make_audio_source(source_cfg)
        stt = get_backend(backend_name, language=language)
    except Exception as e:
        emit({"type": "error", "message": f"setup failed: {e}"})
        return

    emit({"type": "started"})

    async def stream_with_cancel():
        async for transcript in stt.stream(chunks):
            if cancel_event.is_set():
                return
            emit({
                "type": "transcript",
                "text": transcript.text,
                "is_final": transcript.is_final,
                "t_start": transcript.t_start,
                "t_end": transcript.t_end,
            })

    try:
        await stream_with_cancel()
    except asyncio.CancelledError:
        raise
    except Exception as e:
        emit({"type": "error", "message": f"stt error: {e}"})
    finally:
        emit({"type": "stopped"})


async def main():
    emit({"type": "ready"})
    stt_task: asyncio.Task | None = None
    cancel_event: asyncio.Event | None = None

    async for raw in stdin_lines():
        if not raw:
            continue
        try:
            cmd = json.loads(raw)
        except json.JSONDecodeError as e:
            emit({"type": "error", "message": f"invalid json: {e}"})
            continue

        cmd_type = cmd.get("type")
        if cmd_type == "start":
            if stt_task and not stt_task.done():
                emit({"type": "error", "message": "already running"})
                continue
            cancel_event = asyncio.Event()
            stt_task = asyncio.create_task(run_stt(cmd, cancel_event))
        elif cmd_type == "stop":
            if stt_task and not stt_task.done():
                cancel_event.set()
                stt_task.cancel()
                try:
                    await stt_task
                except (asyncio.CancelledError, Exception):
                    pass
            stt_task = None
        elif cmd_type == "shutdown":
            if stt_task and not stt_task.done():
                stt_task.cancel()
                try:
                    await stt_task
                except (asyncio.CancelledError, Exception):
                    pass
            return
        else:
            emit({"type": "error", "message": f"unknown command: {cmd_type}"})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
