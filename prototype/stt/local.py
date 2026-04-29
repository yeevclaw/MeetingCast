import sys
from collections import Counter

import numpy as np
import torch
import mlx_whisper
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript


WINDOW_SAMPLES = 512  # silero VAD requires 512-sample windows at 16kHz

HALLUCINATION_MIN_CHARS = 20
HALLUCINATION_DOMINANCE = 0.5


def _is_hallucination(text: str) -> bool:
    """Whisper on silence/noise often emits one Chinese char repeated dozens of
    times (e.g. '示示示示...'). Filter when a single non-whitespace character
    occupies more than HALLUCINATION_DOMINANCE of a string longer than
    HALLUCINATION_MIN_CHARS."""
    chars = [c for c in text if not c.isspace()]
    if len(chars) < HALLUCINATION_MIN_CHARS:
        return False
    most_common = Counter(chars).most_common(1)[0][1]
    return most_common / len(chars) > HALLUCINATION_DOMINANCE


class MLXWhisperSTT:
    MODEL_REPO = "mlx-community/whisper-large-v3-turbo"

    def __init__(
        self,
        language: str = "zh",
        model_repo: str | None = None,
        max_speech_sec: float = 8.0,
    ):
        self.language = language
        self.model_repo = model_repo or self.MODEL_REPO
        self.max_speech_sec = max_speech_sec
        self._vad_model = None

    def _vad(self):
        if self._vad_model is None:
            self._vad_model = load_silero_vad()
        return self._vad_model

    def _transcribe_audio(self, audio) -> str:
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_repo,
            language=self.language,
        )
        text = result["text"].strip()
        if _is_hallucination(text):
            print(
                f"[hallucination filtered] {text[:40]}{'...' if len(text) > 40 else ''}",
                file=sys.stderr,
            )
            return ""
        return text

    def transcribe_file(self, path: str) -> Transcript:
        return Transcript(text=self._transcribe_audio(path), is_final=True)

    async def stream(self, audio_chunks, sample_rate: int = 16000):
        """PCM16 LE byte chunks → Transcript per VAD-cut utterance.

        Force-flushes after max_speech_sec to handle continuous speech
        (e.g. broadcasters, fast presenters) where VAD never sees a pause.
        """
        max_samples = int(self.max_speech_sec * sample_rate)
        vad_iter = VADIterator(
            self._vad(),
            threshold=0.5,
            sampling_rate=sample_rate,
            min_silence_duration_ms=300,
            speech_pad_ms=30,
        )
        leftover = b""
        speech_buffer: list[np.ndarray] = []
        in_speech = False
        speech_start_sec: float = 0.0
        samples_processed = 0

        async for chunk in audio_chunks:
            leftover += chunk
            while len(leftover) >= WINDOW_SAMPLES * 2:
                window_bytes = leftover[: WINDOW_SAMPLES * 2]
                leftover = leftover[WINDOW_SAMPLES * 2 :]
                window = np.frombuffer(window_bytes, dtype=np.int16).astype(np.float32) / 32768.0

                if in_speech:
                    speech_buffer.append(window)

                event = vad_iter(torch.from_numpy(window), return_seconds=True)
                samples_processed += WINDOW_SAMPLES

                if event and "start" in event:
                    speech_start_sec = float(event["start"])
                    in_speech = True
                    speech_buffer = [window]

                if event and "end" in event and speech_buffer:
                    full_audio = np.concatenate(speech_buffer)
                    text = self._transcribe_audio(full_audio)
                    if text:
                        yield Transcript(
                            text=text, is_final=True,
                            t_start=speech_start_sec, t_end=float(event["end"]),
                        )
                    speech_buffer = []
                    in_speech = False
                    continue

                # Force-flush long continuous speech (no VAD-detected pause)
                if in_speech and len(speech_buffer) * WINDOW_SAMPLES >= max_samples:
                    full_audio = np.concatenate(speech_buffer)
                    cut_at = speech_start_sec + len(full_audio) / sample_rate
                    text = self._transcribe_audio(full_audio)
                    if text:
                        yield Transcript(
                            text=text, is_final=True,
                            t_start=speech_start_sec, t_end=cut_at,
                        )
                    speech_buffer = []
                    speech_start_sec = cut_at  # next force-cut continues from here

        if in_speech and speech_buffer:
            full_audio = np.concatenate(speech_buffer)
            text = self._transcribe_audio(full_audio)
            if text:
                yield Transcript(
                    text=text, is_final=True,
                    t_start=speech_start_sec, t_end=samples_processed / sample_rate,
                )
