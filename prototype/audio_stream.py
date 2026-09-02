import asyncio
import time
import wave
from typing import AsyncIterator


async def wav_chunks(
    path: str, chunk_ms: int = 100, realtime: bool = True
) -> AsyncIterator[bytes]:
    """Yield raw PCM bytes from a 16-bit mono WAV.

    When realtime=True the generator paces yields against the wall clock so
    a 6-second WAV takes ~6 seconds to iterate — simulates a live microphone.
    Pacing is absolute (chunk N is released at t0 + N*chunk_ms), not a sleep
    per chunk: a relative sleep adds the consumer's per-chunk processing time
    (VAD, resample, websocket send) on top of every interval and drifted ~7s
    behind real time over a 90s file, which silently inflated every measured
    STT latency.
    """
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("wav must be 16-bit PCM")
        if w.getnchannels() != 1:
            raise ValueError("wav must be mono")
        sample_rate = w.getframerate()
        frames_per_chunk = int(sample_rate * chunk_ms / 1000)

        t0 = time.perf_counter()
        n = 0
        while True:
            frames = w.readframes(frames_per_chunk)
            if not frames:
                break
            yield frames
            n += 1
            if realtime:
                due = t0 + n * chunk_ms / 1000
                delay = due - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
