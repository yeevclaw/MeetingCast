from dataclasses import dataclass

import numpy as np
import torch
from silero_vad import get_speech_timestamps, load_silero_vad


@dataclass
class SpeechSegment:
    audio: np.ndarray  # float32 mono at sample_rate, range [-1, 1]
    t_start: float     # seconds from stream start
    t_end: float

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start


class VADSegmenter:
    def __init__(
        self,
        threshold: float = 0.5,
        min_silence_ms: int = 400,
        min_speech_ms: int = 250,
        max_speech_sec: float = 15.0,
        sample_rate: int = 16000,
    ):
        self.model = load_silero_vad()
        self.threshold = threshold
        self.min_silence_ms = min_silence_ms
        self.min_speech_ms = min_speech_ms
        self.max_speech_sec = max_speech_sec
        self.sample_rate = sample_rate

    def segment(self, audio: np.ndarray) -> list[SpeechSegment]:
        audio = _to_float32_mono(audio)
        tensor = torch.from_numpy(audio)
        timestamps = get_speech_timestamps(
            tensor,
            self.model,
            threshold=self.threshold,
            sampling_rate=self.sample_rate,
            min_silence_duration_ms=self.min_silence_ms,
            min_speech_duration_ms=self.min_speech_ms,
            max_speech_duration_s=self.max_speech_sec,
            return_seconds=True,
        )
        segments: list[SpeechSegment] = []
        for ts in timestamps:
            s = int(ts["start"] * self.sample_rate)
            e = int(ts["end"] * self.sample_rate)
            segments.append(
                SpeechSegment(audio=audio[s:e], t_start=ts["start"], t_end=ts["end"])
            )
        return segments


def _to_float32_mono(audio: np.ndarray) -> np.ndarray:
    if audio.ndim > 1:
        audio = audio.mean(axis=-1)
    if audio.dtype == np.int16:
        return (audio.astype(np.float32) / 32768.0).copy()
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
    if np.abs(audio).max() > 1.5:
        # looks like raw int16 in float form
        audio = audio / 32768.0
    return audio


def load_wav_float32(path: str) -> tuple[np.ndarray, int]:
    """Read WAV as float32 mono array."""
    import wave
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("wav must be 16-bit PCM")
        if w.getnchannels() != 1:
            raise ValueError("wav must be mono")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    pcm = np.frombuffer(raw, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0, sr
