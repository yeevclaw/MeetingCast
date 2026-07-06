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
import threading
from pathlib import Path

# Point SSL libs at the certifi-bundled CA file BEFORE importing anything
# that opens an HTTPS connection (huggingface_hub, deepgram-sdk via aiohttp,
# etc.). PyInstaller bundles cacert.pem when --collect-all certifi is set,
# but the macOS system trust store isn't visible inside the bundle, so
# without this, every HTTPS request fails with CERTIFICATE_VERIFY_FAILED on
# user machines (dev machine works because Python finds the OpenSSL system
# certs there). setdefault preserves any explicit override.
try:
    import certifi  # type: ignore
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    # certifi missing only happens in dev mode without the optional dep —
    # falling through is fine because the system trust store is reachable.
    pass

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "prototype"))

from audio_stream import wav_chunks  # noqa: E402
from stt import get_backend  # noqa: E402


# Serializes stdout writes. The async command loop emits from the event-loop
# thread while the background model-download poller (see _poll_model_download)
# emits from a daemon thread — without this lock two interleaved half-lines
# would corrupt the line-delimited JSON protocol. json.dumps runs outside the
# lock to keep the critical section as short as the write itself.
_emit_lock = threading.Lock()


def emit(event: dict) -> None:
    line = json.dumps(event, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
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
    initial_prompt = cmd.get("initial_prompt") or None

    deepgram_api_key = api_cfg.get("deepgram_api_key")
    if deepgram_api_key:
        os.environ["DEEPGRAM_API_KEY"] = deepgram_api_key

    openai_api_key = api_cfg.get("openai_api_key")
    if openai_api_key:
        os.environ["OPENAI_API_KEY"] = openai_api_key

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
        # Cloud backend ignores initial_prompt — Deepgram has its own keyword
        # boost mechanism that we can wire later. Avoid passing the kwarg so
        # we don't break DeepgramSTT's __init__ signature.
        backend_kwargs = {"language": language}
        if backend_name == "local" and initial_prompt:
            backend_kwargs["initial_prompt"] = initial_prompt
        stt = get_backend(backend_name, **backend_kwargs)
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
    permission probe.

    A genuine open failure (no input device, unsupported format, CoreAudio
    HAL error) is left to propagate so _run_prewarm_step surfaces it as a
    prewarm mic error instead of hiding it in stderr. NOTE: this does NOT
    detect a macOS TCC permission denial — a denied mic delivers silence,
    not an exception, so opening succeeds either way.
    """
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
    # Teardown errors are harmless — the probe has already exercised the mic
    # by this point — so keep the narrow swallow only here.
    try:
        stream.stop()
        stream.close()
    except Exception:  # noqa: BLE001
        pass


# Total on-disk size of the whisper-large-v3-turbo snapshot, measured on a
# fully-cached machine (sum of non-symlink files under the HF hub model dir).
# Revision a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb of
# mlx-community/whisper-large-v3-turbo. Used only to render a download-progress
# percentage — an approximation is fine; a future re-quantized upload would
# shift this but the bar just reads slightly off until re-measured.
WHISPER_MODEL_TOTAL_BYTES = 1_613_979_798

# HF hub cache dir name for the whisper model repo (repo id with '/' → '--').
_WHISPER_CACHE_DIRNAME = "models--mlx-community--whisper-large-v3-turbo"


def _dir_size(path: Path) -> int:
    """Sum the sizes of all regular, non-symlink files under `path`. Symlinks
    are skipped so we don't double-count HF's snapshot/*→blobs/* links against
    the real blob (which we already count directly). In-progress downloads land
    as `blobs/*.incomplete`, which are real files and thus included."""
    if not path.exists():
        return 0
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_symlink() or not f.is_file():
                continue
            total += f.stat().st_size
        except OSError:
            continue
    return total


def _poll_model_download(stop_event: threading.Event) -> None:
    """Emit `prewarm/model/progress` events roughly every 2s by polling the
    growing HF cache dir. Runs on a daemon thread; stops when `stop_event` is
    set. All internal failures are swallowed — on any error we simply stop
    reporting and the UI degrades to today's indeterminate spinner."""
    try:
        import huggingface_hub.constants as hf_constants
        model_dir = Path(hf_constants.HF_HUB_CACHE) / _WHISPER_CACHE_DIRNAME
    except Exception:  # noqa: BLE001
        return
    # Never report 100% while the download/GPU-load is still in flight — clamp
    # to 99% of total so the real `done` event is what completes the bar.
    cap = int(WHISPER_MODEL_TOTAL_BYTES * 0.99)
    while not stop_event.is_set():
        try:
            downloaded = min(_dir_size(model_dir), cap)
            emit({
                "type": "prewarm",
                "step": "model",
                "state": "progress",
                "downloaded_bytes": downloaded,
                "total_bytes": WHISPER_MODEL_TOTAL_BYTES,
            })
        except Exception:  # noqa: BLE001
            pass
        stop_event.wait(2.0)


def _prewarm_local_model():
    """Force the mlx-whisper Metal weights to load before the user's first
    click on Start. snapshot_download alone only fetches files to disk;
    it does NOT push weights into GPU memory. The first real transcribe
    therefore pays a 5–10 s lazy-load on top of decode time. Run one
    no-op transcribe on a silent buffer here to amortize that cost
    against app launch (already covered by the "正在啟動辨識引擎" overlay)
    so click-time becomes near-instant.

    Also doubles as ensure_loaded() — if the snapshot is missing, the
    underlying mlx_whisper.transcribe call performs the download. On a cache
    miss a poller thread reports download progress; on a cache hit we skip the
    poller entirely so a returning user never sees a progress flash.

    Non-fatal — if the user only ever uses the cloud backend or the demo
    WAV, this overhead is wasted but the sidecar still works.
    """
    stop_event = threading.Event()
    poller: threading.Thread | None = None
    try:
        import numpy as np
        import mlx.core as mx  # type: ignore
        import mlx_whisper  # type: ignore
        import huggingface_hub  # type: ignore

        from stt.local import MLXWhisperSTT
        engine = MLXWhisperSTT(language="zh")

        # Cache-hit fast path: if every file is already local, report nothing
        # (no UI flash) and go straight to the warm-up transcribe.
        cache_hit = False
        try:
            huggingface_hub.snapshot_download(engine.model_repo, local_files_only=True)
            cache_hit = True
        except Exception:  # noqa: BLE001
            cache_hit = False

        if not cache_hit:
            poller = threading.Thread(
                target=_poll_model_download, args=(stop_event,), daemon=True
            )
            poller.start()

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
    finally:
        # Stop the poller before _run_prewarm_step emits `done`, so the last
        # progress event can't arrive after completion and re-open the row.
        stop_event.set()
        if poller is not None:
            poller.join(timeout=3)


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
    # Start heavy prewarm in background threads, but do not block the command
    # loop on it. If HuggingFace is slow or the user wants cloud STT, the
    # sidecar should still be "ready" enough to accept start/stop/list_devices
    # commands instead of freezing the whole app behind the startup overlay.
    # A local start still runs ensure_loaded() in run_stt, so correctness does
    # not depend on this speculative warmup finishing first.
    model_task = asyncio.create_task(_run_prewarm_step("model", _prewarm_local_model))
    mic_task = asyncio.create_task(_run_prewarm_step("mic", _prewarm_mic))
    emit({"type": "ready"})
    stt_task: asyncio.Task | None = None
    cancel_event: asyncio.Event | None = None

    try:
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
    finally:
        for task in (model_task, mic_task):
            if not task.done():
                task.cancel()


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
