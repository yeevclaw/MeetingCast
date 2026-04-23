from .base import Transcript


def get_backend(name: str, **kwargs):
    if name == "local":
        from .local import MLXWhisperSTT
        return MLXWhisperSTT(**kwargs)
    if name == "cloud":
        from .cloud import DeepgramSTT
        return DeepgramSTT(**kwargs)
    raise ValueError(f"unknown STT backend: {name!r} (expected 'local' or 'cloud')")


__all__ = ["Transcript", "get_backend"]
