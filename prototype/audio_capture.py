import asyncio
import sys
import threading
import time
from collections.abc import Callable
from typing import AsyncIterator

import numpy as np
import sounddevice as sd

# No audio frames for this long while the stream is open → the device most
# likely disappeared (USB / Bluetooth unplugged) or CoreAudio stalled.
MIC_STALL_SEC = 3.0

# PortAudio status flags (input overflow etc.) can fire on every callback when
# the machine is busy; log them at most this often.
_STATUS_LOG_INTERVAL_SEC = 5.0


# PortAudio is not thread-safe across a re-init, and the sidecar reaches it
# from several threads (prewarm probe, recording, list_devices). _PA_LOCK
# guards Pa_Terminate/Pa_Initialize against every other PortAudio call;
# _active_streams counts streams that are opening or open, so a re-init never
# tears one down (a USB mic unplugged mid-session also hides every input).
# The lock is only ever held briefly — never across a stream open, which can
# sit on the macOS permission prompt for as long as the user takes.
_PA_LOCK = threading.RLock()
_active_streams = 0


def refresh_devices_if_no_input() -> bool:
    """Re-scan audio devices when PortAudio sees no input device.

    PortAudio snapshots the device list once, at `import sounddevice`. On macOS
    an app without microphone permission yet sees no input devices, so a
    sidecar spawned before the user clicks 允許 keeps default input = -1
    ("Error querying device -1") until it restarts. Re-initializing PortAudio
    picks up the now-visible devices (also a mic plugged in after launch).

    Skipped while any stream is opening or open. Returns True if it re-initialized.
    """
    with _PA_LOCK:
        if _active_streams > 0:
            return False
        try:
            sd.query_devices(kind="input")
            return False
        except Exception:  # noqa: BLE001
            pass
        try:
            sd._terminate()
            sd._initialize()
        except Exception as e:  # noqa: BLE001
            print(f"PortAudio re-init failed: {e}", file=sys.stderr, flush=True)
        return True


def pa_query(fn):
    """Run a PortAudio query (device list, default device, format check) after
    a device re-scan, with no re-init able to run underneath it. Blocking —
    call it off the event loop."""
    with _PA_LOCK:
        refresh_devices_if_no_input()
        return fn()


class TrackedInputStream:
    """`sd.InputStream` opened after a device re-scan and counted in
    _active_streams (reserved before the open, so no re-init can run while it
    is in progress) until it is closed. Blocking — open, start and close it
    off the event loop. Usable as a context manager (start/close) on a worker
    thread, or via `start()` / `close()`."""

    def __init__(self, **kwargs):
        global _active_streams
        with _PA_LOCK:
            refresh_devices_if_no_input()
            _active_streams += 1
        self._released = False
        try:
            self._stream = sd.InputStream(**kwargs)
        except BaseException:
            self._release()
            raise

    def start(self) -> None:
        self._stream.start()

    def __enter__(self):
        try:
            self._stream.__enter__()
        except BaseException:
            self.close()
            raise
        return self._stream

    def __exit__(self, *exc):
        try:
            return self._stream.__exit__(*exc)
        finally:
            self._release()

    def close(self) -> None:
        """Close (Pa_CloseStream aborts an active stream). Idempotent."""
        if self._released:
            return
        try:
            self._stream.close()
        finally:
            self._release()

    def _release(self) -> None:
        global _active_streams
        if self._released:
            return
        self._released = True
        with _PA_LOCK:
            _active_streams -= 1


async def _open_off_loop(open_fn, device):
    """Run a blocking stream open (+ start) on a worker thread. If the caller
    is cancelled meanwhile (stop pressed while the permission prompt is up),
    the open still completes on its thread — close that stream then, also off
    the loop, so it neither keeps the mic on nor leaks an _active_streams count."""
    loop = asyncio.get_running_loop()
    fut = asyncio.ensure_future(asyncio.to_thread(open_fn, device))
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        def _close_late(f):
            if not f.cancelled() and f.exception() is None:
                loop.run_in_executor(None, f.result().close)
        fut.add_done_callback(_close_late)
        raise


def _default_input_name() -> str:
    try:
        return str(pa_query(lambda: sd.query_devices(kind="input")).get("name", "")).strip()
    except Exception:  # noqa: BLE001
        return ""


def _report(on_warning: Callable[[dict], None] | None, warning: dict) -> None:
    """Route a structured warning ({code, message, ...}) to the sidecar's
    emitter, or to stderr for the CLI. Never raises."""
    if on_warning is not None:
        try:
            on_warning(warning)
            return
        except Exception:  # noqa: BLE001
            pass
    print(f"[mic {warning.get('code')}] {warning.get('message')}", file=sys.stderr, flush=True)


async def mic_chunks(
    sample_rate: int = 16000,
    chunk_ms: int = 100,
    device: int | str | None = None,
    on_warning: Callable[[dict], None] | None = None,
) -> AsyncIterator[bytes]:
    """Yield raw PCM16 LE bytes from the system microphone.

    Requires macOS microphone permission for the host process. If denied,
    sounddevice raises PortAudioError when InputStream is opened.

    Robustness:
      * if `device` can't be opened, falls back to the system default and
        reports a `device_fallback` warning (with the device actually opened);
      * never blocks forever on a vanished device: after MIC_STALL_SEC with
        no frames a `mic_stalled` warning is reported once, and `mic_resumed`
        when frames come back. The generator itself keeps waiting.

    NOTE: nothing here may print to stdout — in the sidecar stdout is the
    line-delimited JSON protocol channel. Diagnostics go to stderr.
    """
    samples_per_chunk = int(sample_rate * chunk_ms / 1000)
    q: asyncio.Queue[bytes] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    last_status_log = [0.0]

    def callback(indata, frames, time_info, status):
        if status:
            now = time.monotonic()
            if now - last_status_log[0] >= _STATUS_LOG_INTERVAL_SEC:
                last_status_log[0] = now
                print(f"sounddevice status: {status}", file=sys.stderr, flush=True)
        pcm16 = np.clip(indata[:, 0] * 32768.0, -32768, 32767).astype(np.int16)
        try:
            loop.call_soon_threadsafe(q.put_nowait, pcm16.tobytes())
        except RuntimeError:
            pass  # event loop already closed during teardown

    def open_stream(dev):
        stream = TrackedInputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=samples_per_chunk,
            callback=callback,
            device=dev,
        )
        try:
            stream.start()
        except BaseException:
            stream.close()
            raise
        return stream

    # Off the event loop: the first open can wait on the macOS permission
    # prompt, and the sidecar's command loop (stop, list_devices) must stay
    # responsive meanwhile.
    fallback_error: Exception | None = None
    try:
        stream = await _open_off_loop(open_stream, device)
    except Exception as e:  # noqa: BLE001
        if device is None or device == "":
            raise
        fallback_error = e
        stream = await _open_off_loop(open_stream, None)

    stalled = False
    try:
        if fallback_error is not None:
            name = await asyncio.to_thread(_default_input_name)
            _report(on_warning, {
                "code": "device_fallback",
                "message": f"麥克風「{device}」無法開啟（{fallback_error}），已改用系統預設"
                           + (f"「{name}」" if name else ""),
                "device": name,
            })
        while True:
            try:
                chunk = await asyncio.wait_for(q.get(), timeout=MIC_STALL_SEC)
            except TimeoutError:
                if not stalled:
                    stalled = True
                    _report(on_warning, {
                        "code": "mic_stalled",
                        "message": f"麥克風超過 {MIC_STALL_SEC:.0f} 秒沒有收到聲音資料，"
                                   "請確認裝置是否已拔除或被其他程式占用",
                    })
                continue
            if stalled:
                stalled = False
                _report(on_warning, {
                    "code": "mic_resumed",
                    "message": "麥克風已恢復收音",
                })
            yield chunk
    finally:
        # Close off the loop too (CoreAudio teardown can block). Shielded: if
        # this await is cancelled, the worker thread still finishes the close.
        await asyncio.shield(asyncio.ensure_future(asyncio.to_thread(stream.close)))
