import asyncio
import wave
from typing import AsyncIterator


async def wav_chunks(
    path: str, chunk_ms: int = 100, realtime: bool = True
) -> AsyncIterator[bytes]:
    """Yield raw PCM bytes from a 16-bit mono WAV.

    When realtime=True the generator sleeps chunk_ms between yields, so a
    6-second WAV takes ~6 seconds to iterate — simulates a live microphone.
    """
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("wav must be 16-bit PCM")
        if w.getnchannels() != 1:
            raise ValueError("wav must be mono")
        sample_rate = w.getframerate()
        frames_per_chunk = int(sample_rate * chunk_ms / 1000)

        while True:
            frames = w.readframes(frames_per_chunk)
            if not frames:
                break
            yield frames
            if realtime:
                await asyncio.sleep(chunk_ms / 1000)
