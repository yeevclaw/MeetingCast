import os

from deepgram import DeepgramClient

from .base import Transcript


class DeepgramSTT:
    def __init__(self, language: str = "zh", model: str = "nova-3"):
        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DEEPGRAM_API_KEY 未設定。請到 https://deepgram.com/ 註冊後 "
                "把 API key 填入 prototype/.env"
            )
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

    async def stream(self, audio_chunks):
        raise NotImplementedError("streaming will be added in Step 5 (mic integration)")
        yield
