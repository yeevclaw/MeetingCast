"""Audio-source plumbing shared by every STT backend in the sidecar.

`pump_audio` decouples *reading* the audio source from *consuming* it:

  * the source (mic / demo WAV) is drained on its own task from the moment
    the stream starts, so audio keeps being captured (and queued) while a
    backend is busy — a local Whisper inference, or the cloud backend's
    websocket handshake / reconnect. Nothing said during those gaps is lost.
  * input level (`level` events) is metered on that producer task, so the UI
    meter keeps moving at a steady ~250 ms cadence even while the consumer
    is blocked in a transcription.
  * a graceful stop: once `stop_event` is set the source is closed and the
    consumer sees a normal end-of-stream after the already-captured chunks,
    which is what lets each backend flush its buffered speech before
    `stopped` is emitted.

Pure asyncio + numpy; no sounddevice, so it is unit-testable.
"""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable

import numpy as np

LEVEL_INTERVAL_SEC = 0.25

_END = object()


class LevelMeter:
    """Accumulates PCM16 LE chunks and reports the linear RMS (0..1) of each
    completed ~LEVEL_INTERVAL_SEC block. Sample-count based (not wall clock)
    so it is deterministic and cheap: one sum-of-squares per chunk."""

    def __init__(self, sample_rate: int = 16000, interval_sec: float = LEVEL_INTERVAL_SEC):
        self.block = max(1, int(sample_rate * interval_sec))
        self._sumsq = 0.0
        self._n = 0

    def feed(self, chunk: bytes) -> float | None:
        if not chunk:
            return None
        a = np.frombuffer(chunk, dtype=np.int16).astype(np.float64) / 32768.0
        self._sumsq += float(np.dot(a, a))
        self._n += len(a)
        if self._n < self.block:
            return None
        rms = (self._sumsq / self._n) ** 0.5
        self._sumsq = 0.0
        self._n = 0
        return min(1.0, max(0.0, rms))


async def pump_audio(
    source: AsyncIterator[bytes],
    stop_event: asyncio.Event,
    on_level: Callable[[float], None] | None = None,
    sample_rate: int = 16000,
) -> AsyncIterator[bytes]:
    """Re-yield `source`'s chunks, read ahead on a background task.

    Ends (normally) when the source is exhausted or `stop_event` is set — in
    the latter case after yielding every chunk captured before the stop.
    An exception raised by the source (e.g. the mic failed to open) is
    re-raised to the consumer."""
    q: asyncio.Queue = asyncio.Queue()
    meter = LevelMeter(sample_rate) if on_level is not None else None

    async def produce():
        try:
            async for chunk in source:
                if meter is not None:
                    rms = meter.feed(chunk)
                    if rms is not None:
                        try:
                            on_level(rms)
                        except Exception:  # noqa: BLE001 — metering is best-effort
                            pass
                q.put_nowait(chunk)
        except asyncio.CancelledError:
            pass  # stop requested — fall through to the end marker
        except Exception as e:  # noqa: BLE001
            q.put_nowait(e)
        finally:
            q.put_nowait(_END)

    producer = asyncio.create_task(produce())
    stopper = asyncio.create_task(stop_event.wait())
    stopper.add_done_callback(lambda _t: producer.cancel())
    try:
        while True:
            item = await q.get()
            if item is _END:
                return
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        stopper.cancel()
        producer.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await producer
