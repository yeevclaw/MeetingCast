from .base import Transcript


def get_backend(name: str, **kwargs):
    if name == "local":
        from .local import MLXWhisperSTT
        return MLXWhisperSTT(**kwargs)
    if name == "openai":
        from .openai_realtime import OpenAIRealtimeWhisperSTT
        return OpenAIRealtimeWhisperSTT(**kwargs)
    raise ValueError(f"unknown STT backend: {name!r} (expected 'local' / 'openai')")


__all__ = ["Transcript", "get_backend"]
