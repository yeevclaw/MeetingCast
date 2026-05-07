import os
from typing import AsyncIterator

from deepgram import AsyncDeepgramClient, DeepgramClient

from .base import Transcript


class DeepgramSTT:
    def __init__(self, language: str = "zh", model: str = "nova-3"):
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
        # MINIMAL CONFIG (debug): everything optional stripped to find which
        # param causes Deepgram's generic 400. Add back one at a time.
        async with client.listen.v1.connect(
            model=self.model,
            language=self.language,
            encoding="linear16",
            sample_rate=sample_rate,
        ) as conn:

            async def sender():
                async for chunk in audio_chunks:
                    await conn.send_media(chunk)
                await conn.send_close_stream()

            send_task = asyncio.create_task(sender())
            pending_parts: list[str] = []
            pending_start: float | None = None
            pending_end: float = 0.0

            def flush_pending():
                nonlocal pending_parts, pending_start, pending_end
                text = " ".join(pending_parts).strip()
                if not text:
                    return None
                transcript = Transcript(
                    text=text,
                    is_final=True,
                    t_start=pending_start or 0.0,
                    t_end=pending_end,
                )
                pending_parts = []
                pending_start = None
                pending_end = 0.0
                return transcript

            try:
                async for msg in conn:
                    if not hasattr(msg, "channel") or not hasattr(msg, "is_final"):
                        # UtteranceEnd is the strongest signal that the final
                        # chunks collected so far form one translatable thought.
                        # Some SDK versions expose it as a class name rather
                        # than a field, so use a loose type-name check.
                        if "utteranceend" in type(msg).__name__.lower():
                            transcript = flush_pending()
                            if transcript:
                                yield transcript
                        continue  # skip Metadata / SpeechStarted
                    alts = getattr(msg.channel, "alternatives", None) or []
                    if not alts:
                        continue
                    text = alts[0].transcript or ""
                    if not text.strip():
                        continue
                    start = float(getattr(msg, "start", 0.0) or 0.0)
                    end = start + float(getattr(msg, "duration", 0.0) or 0.0)
                    if bool(msg.is_final):
                        if pending_start is None:
                            pending_start = start
                        pending_parts.append(text.strip())
                        pending_end = end
                        if bool(getattr(msg, "speech_final", False)):
                            transcript = flush_pending()
                            if transcript:
                                yield transcript
                    else:
                        yield Transcript(
                            text=text.strip(),
                            is_final=False,
                            t_start=start,
                            t_end=end,
                        )
                transcript = flush_pending()
                if transcript:
                    yield transcript
            finally:
                send_task.cancel()
                try:
                    await send_task
                except (asyncio.CancelledError, Exception):
                    pass
