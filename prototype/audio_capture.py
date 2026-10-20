import asyncio
import sys
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


def refresh_devices_if_no_input() -> bool:
    """Re-scan audio devices when PortAudio sees no input device.

    PortAudio snapshots the device list once, at `import sounddevice`. On macOS
    an app without microphone permission yet sees no input devices, so a
    sidecar spawned before the user clicks 允許 keeps default input = -1
    ("Error querying device -1") until it restarts. Re-initializing PortAudio
    picks up the now-visible devices (also a mic plugged in after launch).

    Only re-initializes when no input device is visible — then no input stream
    can be open, so tearing PortAudio down is safe. Returns True if it did.
    """
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


def _default_input_name() -> str:
    try:
        return str(sd.query_devices(kind="input").get("name", "")).strip()
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
        return sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=samples_per_chunk,
            callback=callback,
            device=dev,
        )

    refresh_devices_if_no_input()
    try:
        stream = open_stream(device)
    except Exception as e:  # noqa: BLE001
        if device is None or device == "":
            raise
        stream = open_stream(None)
        name = _default_input_name()
        _report(on_warning, {
            "code": "device_fallback",
            "message": f"麥克風「{device}」無法開啟（{e}），已改用系統預設"
                       + (f"「{name}」" if name else ""),
            "device": name,
        })

    stalled = False
    with stream:
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
