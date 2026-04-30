"""MeetingCast STT sidecar.

Long-running daemon that consumes commands from stdin and emits transcript
events to stdout, both line-delimited JSON. See protocol.py for the schema.

For dev convenience this imports the existing STT modules from prototype/
via sys.path; PyInstaller packaging in Phase 4 will collect them properly.
"""
import asyncio
import json
import os
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
        # Empty string from UI means "system default" — pass None so sounddevice
        # picks the OS default. A non-empty string is treated as a device name
        # (sounddevice accepts either an int index or a substring of the name).
        device = source.get("device") or None
        return mic_chunks(sample_rate=16000, chunk_ms=100, device=device)
    if kind == "wav":
        path = source.get("path")
        if not path:
            raise ValueError("source.wav requires 'path'")
        return wav_chunks(path, chunk_ms=100, realtime=True)
    raise ValueError(f"unknown source type: {kind}")


def list_input_devices() -> list[dict]:
    """Enumerate microphone-capable devices via sounddevice.

    Returns a list of {name, channels} dicts, filtering to devices with at
    least one input channel. Names are not unique on macOS when multiple
    interfaces share a label (rare), but they're stable across runs whereas
    the integer index can shift when a USB/Bluetooth device is plugged in
    or out — so the UI persists by name.
    """
    import sounddevice as sd

    seen: set[str] = set()
    out: list[dict] = []
    for d in sd.query_devices():
        channels = int(d.get("max_input_channels", 0) or 0)
        if channels <= 0:
            continue
        name = str(d.get("name", "")).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "channels": channels})
    return out


async def run_stt(cmd: dict, cancel_event: asyncio.Event):
    backend_name = cmd.get("backend", "local")
    language = cmd.get("language", "zh")
    source_cfg = cmd.get("source", {"type": "mic"})
    api_cfg = cmd.get("api") or {}

    deepgram_api_key = api_cfg.get("deepgram_api_key")
    if deepgram_api_key:
        os.environ["DEEPGRAM_API_KEY"] = deepgram_api_key

    # Validate the requested mic device early. If the user's persisted device
    # got unplugged (USB / Bluetooth) we want to fall back to the system
    # default and warn — not crash, get re-spawned by the watchdog, and crash
    # again with the same dead device.
    if source_cfg.get("type") == "mic":
        device_pref = source_cfg.get("device") or ""
        if device_pref:
            try:
                import sounddevice as sd
                sd.check_input_settings(
                    device=device_pref,
                    samplerate=16000,
                    channels=1,
                    dtype="float32",
                )
            except Exception as e:
                emit({
                    "type": "warning",
                    "message": f"麥克風「{device_pref}」無法使用（{e}），已改用系統預設",
                })
                source_cfg = {**source_cfg, "device": ""}

    try:
        stt = get_backend(backend_name, language=language)
        # Front-load the local model snapshot before opening the mic, so the
        # user sees a clear "preparing" state instead of a 1–2 min freeze on
        # first start. No-op if cached.
        if hasattr(stt, "ensure_loaded"):
            emit({"type": "model_loading"})
            await asyncio.to_thread(stt.ensure_loaded)
            emit({"type": "model_ready"})
        chunks = make_audio_source(source_cfg)
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
        # Extract any nested detail Deepgram/SDK may have attached so we don't
        # lose useful diagnostics inside the exception's __str__.
        detail = []
        for attr in ("status_code", "body", "reason", "code", "headers"):
            v = getattr(e, attr, None)
            if v is not None:
                detail.append(f"{attr}={v!r}")
        suffix = f" [{type(e).__name__}: {'; '.join(detail)}]" if detail else f" [{type(e).__name__}]"
        emit({"type": "error", "message": f"stt error: {e}{suffix}"})
    finally:
        emit({"type": "stopped"})


def _prewarm_mic():
    """Briefly open and read from the mic so macOS triggers its privacy
    prompt during startup, not at first 開始錄音 click. After the user
    grants permission once, this becomes a no-op on subsequent launches.

    Mirrors the InputStream args used by the real audio_capture.mic_chunks
    so we exercise the same CoreAudio code path — opening with mismatched
    args (no callback / different blocksize) doesn't reliably trigger the
    permission probe. Failures are non-fatal — the sidecar still serves
    WAV demo sources and the real start_stt will surface a friendly error
    if the mic is unavailable when actually needed.
    """
    try:
        import time
        import sounddevice as sd  # type: ignore

        def _no_op(indata, frames, time_info, status):
            pass

        stream = sd.InputStream(
            samplerate=16000,
            channels=1,
            dtype="float32",
            blocksize=1600,
            callback=_no_op,
        )
        stream.start()
        # Hold the stream open just long enough for macOS to probe CoreAudio
        # and either show its permission prompt or succeed silently.
        time.sleep(0.1)
        stream.stop()
        stream.close()
    except Exception as e:  # noqa: BLE001
        print(f"[mic prewarm] {e}", file=sys.stderr, flush=True)


def _prewarm_local_model():
    """Force the mlx-whisper Metal weights to load before the user's first
    click on Start. snapshot_download alone only fetches files to disk;
    it does NOT push weights into GPU memory. The first real transcribe
    therefore pays a 5–10 s lazy-load on top of decode time. Run one
    no-op transcribe on a silent buffer here to amortize that cost
    against app launch (already covered by the "正在啟動辨識引擎" overlay)
    so click-time becomes near-instant.

    Also doubles as ensure_loaded() — if the snapshot is missing, the
    underlying mlx_whisper.transcribe call performs the download.

    Non-fatal — if the user only ever uses the cloud backend or the demo
    WAV, this overhead is wasted but the sidecar still works.
    """
    try:
        import numpy as np
        import mlx.core as mx  # type: ignore
        import mlx_whisper  # type: ignore

        from stt.local import MLXWhisperSTT
        engine = MLXWhisperSTT(language="zh")
        # Bypass _transcribe_audio's RMS gate (which would skip silent input
        # and never actually load the model) — call mlx_whisper directly.
        mlx_whisper.transcribe(
            np.zeros(16000, dtype=np.float32),
            path_or_hf_repo=engine.model_repo,
            language="zh",
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
        )
        # Drop the prewarm's intermediate buffers. The model weights remain
        # in mlx's per-path cache (the whole point of prewarming) but the
        # 1 s of silent audio's activations and decoder KV are released.
        try:
            (mx.clear_cache if hasattr(mx, "clear_cache") else mx.metal.clear_cache)()
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        print(f"[model prewarm] {e}", file=sys.stderr, flush=True)


async def _run_prewarm_step(step: str, fn) -> None:
    """Wrap a prewarm function with start/done (or error) status events so
    the frontend can paint a stage-by-stage checklist instead of a single
    opaque spinner. Failures are non-fatal — emitted as state=error and
    the rest of startup continues; the user-facing overlay shows ❌ on
    that row but the app still becomes usable for whatever paths don't
    depend on the failed step (e.g. cloud STT works without the local
    model prewarm)."""
    emit({"type": "prewarm", "step": step, "state": "start"})
    try:
        await asyncio.to_thread(fn)
        emit({"type": "prewarm", "step": step, "state": "done"})
    except Exception as e:  # noqa: BLE001
        emit({"type": "prewarm", "step": step, "state": "error", "message": str(e)})


async def main():
    # Run heavy prewarm in threads so the asyncio loop stays responsive
    # to incoming commands. Order matters: the model load is the longest
    # step (~10 s first run) so kick it off first; the mic prewarm runs
    # in parallel and triggers the macOS permission prompt while the model
    # warms in the background. Each task emits prewarm events so the UI
    # can show progress instead of a featureless 5–10 s freeze.
    model_task = asyncio.create_task(_run_prewarm_step("model", _prewarm_local_model))
    mic_task = asyncio.create_task(_run_prewarm_step("mic", _prewarm_mic))
    await asyncio.gather(model_task, mic_task)
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
        elif cmd_type == "list_devices":
            try:
                devices = list_input_devices()
            except Exception as e:
                # Always emit `devices` so the Rust-side oneshot resolves —
                # without it the UI hangs until the timeout fires.
                emit({"type": "devices", "devices": []})
                emit({"type": "error", "message": f"list_devices: {e}"})
            else:
                emit({"type": "devices", "devices": devices})
        else:
            emit({"type": "error", "message": f"unknown command: {cmd_type}"})


if __name__ == "__main__":
    # CRITICAL for PyInstaller --onefile: when any dependency (torch,
    # huggingface_hub's parallel download workers, etc.) uses
    # multiprocessing.spawn, child workers re-execute *this* binary as
    # `sys.executable`. Without freeze_support, each re-exec runs main()
    # again — a fork bomb that loads mlx + whisper N times and pushed RSS
    # past 20 GB. freeze_support() detects spawn-children via env markers
    # and routes them straight to the multiprocessing worker target instead
    # of re-running our entry. No-op in the original parent process.
    import multiprocessing
    multiprocessing.freeze_support()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
