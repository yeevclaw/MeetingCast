import asyncio
from typing import AsyncIterator

import numpy as np
import sounddevice as sd


async def mic_chunks(
    sample_rate: int = 16000,
    chunk_ms: int = 100,
    device: int | str | None = None,
) -> AsyncIterator[bytes]:
    """Yield raw PCM16 LE bytes from the system microphone.

    Requires macOS microphone permission for the host process. If denied,
    sounddevice raises PortAudioError when InputStream is opened.
    """
    samples_per_chunk = int(sample_rate * chunk_ms / 1000)
    q: asyncio.Queue[bytes] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def callback(indata, frames, time_info, status):
        if status:
            print(f"sounddevice status: {status}", flush=True)
        pcm16 = np.clip(indata[:, 0] * 32768.0, -32768, 32767).astype(np.int16)
        loop.call_soon_threadsafe(q.put_nowait, pcm16.tobytes())

    stream = sd.InputStream(
        samplerate=sample_rate,
        channels=1,
        dtype="float32",
        blocksize=samples_per_chunk,
        callback=callback,
        device=device,
    )

    with stream:
        while True:
            yield await q.get()
