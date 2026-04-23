import mlx_whisper

from .base import Transcript


class MLXWhisperSTT:
    MODEL_REPO = "mlx-community/whisper-large-v3-turbo"

    def __init__(self, language: str = "zh", model_repo: str | None = None):
        self.language = language
        self.model_repo = model_repo or self.MODEL_REPO

    def transcribe_file(self, path: str) -> Transcript:
        result = mlx_whisper.transcribe(
            path,
            path_or_hf_repo=self.model_repo,
            language=self.language,
        )
        return Transcript(text=result["text"].strip(), is_final=True)

    async def stream(self, audio_chunks):
        raise NotImplementedError("streaming will be added in Step 5 (mic integration)")
        yield  # noqa: make this an async generator for typing purposes
