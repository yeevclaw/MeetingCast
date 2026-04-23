import os
from typing import AsyncIterator

from deepgram import AsyncDeepgramClient, DeepgramClient

from .base import Transcript


class DeepgramSTT:
    def __init__(self, language: str = "zh", model: str = "nova-2"):
        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DEEPGRAM_API_KEY 未設定。請到 https://deepgram.com/ 註冊後 "
                "把 API key 填入 prototype/.env"
            )
        self._api_key = api_key
        self.client = DeepgramClient(api_key=api_key)
        self.language = language
        self.model = model

    def transcribe_file(self, path: str) -> Transcript:
        with open(path, "rb") as f:
            buf = f.read()
        response = self.client.listen.v1.media.transcribe_file(
            request=buf,
            model=self.model,
            language=self.language,
            smart_format=True,
            punctuate=True,
        )
        alt = response.results.channels[0].alternatives[0]
        return Transcript(text=alt.transcript.strip(), is_final=True)

    async def stream(
        self, audio_chunks: AsyncIterator[bytes], sample_rate: int = 16000
    ) -> AsyncIterator[Transcript]:
        import asyncio

        client = AsyncDeepgramClient(api_key=self._api_key)
        # Workaround: SDK 6.1.1 serializes Python True as "True" which Deepgram
        # rejects with HTTP 400. Pass lowercase strings explicitly.
        async with client.listen.v1.connect(
            model=self.model,
            language=self.language,
            encoding="linear16",
            sample_rate=sample_rate,
            interim_results="true",  # type: ignore[arg-type]
            punctuate="true",  # type: ignore[arg-type]
            smart_format="true",  # type: ignore[arg-type]
            utterance_end_ms=1000,
            vad_events="true",  # type: ignore[arg-type]
        ) as conn:

            async def sender():
                async for chunk in audio_chunks:
                    await conn.send_media(chunk)
                await conn.send_close_stream()

            send_task = asyncio.create_task(sender())
            try:
                async for msg in conn:
                    if not hasattr(msg, "channel") or not hasattr(msg, "is_final"):
                        continue  # skip Metadata / SpeechStarted / UtteranceEnd
                    alts = getattr(msg.channel, "alternatives", None) or []
                    if not alts:
                        continue
                    text = alts[0].transcript or ""
                    if not text.strip():
                        continue
                    yield Transcript(
                        text=text.strip(),
                        is_final=bool(msg.is_final),
                        t_start=msg.start,
                        t_end=msg.start + msg.duration,
                    )
            finally:
                send_task.cancel()
                try:
                    await send_task
                except (asyncio.CancelledError, Exception):
                    pass
