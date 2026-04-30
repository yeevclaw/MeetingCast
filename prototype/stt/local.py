import sys
from collections import Counter, deque

import mlx.core as mx
import numpy as np
import torch
import mlx_whisper
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript


# Cap MLX's idle Metal allocator cache. Without this, every transcribe call
# leaves intermediate buffers in MLX's free pool — over a long meeting
# (dozens of VAD-cut segments) the pool can balloon to 10–20+ GB on a
# 64 GB unified-memory Mac and never shrink. 1 GB is plenty of headroom for
# whisper-large-v3-turbo's working set; lower means more frequent
# allocations but capped resident memory.
_MLX_CACHE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024
try:
    # mlx 0.20+ moved the cache APIs from `mx.metal.*` to top-level `mx.*`.
    # Prefer the new path; fall back so older bundled mlx still works.
    if hasattr(mx, "set_cache_limit"):
        mx.set_cache_limit(_MLX_CACHE_LIMIT_BYTES)
    else:
        mx.metal.set_cache_limit(_MLX_CACHE_LIMIT_BYTES)
except Exception as _e:  # noqa: BLE001
    print(f"[mlx cache limit] failed: {_e}", file=sys.stderr)


def _mlx_clear_cache() -> None:
    try:
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        else:
            mx.metal.clear_cache()
    except Exception:  # noqa: BLE001
        pass


WINDOW_SAMPLES = 512  # silero VAD requires 512-sample windows at 16kHz

HALLUCINATION_MIN_CHARS = 20
HALLUCINATION_DOMINANCE = 0.5

# Float32 audio is in [-1, 1]. Conversational speech RMS ≈ 0.05–0.15;
# fans / aircon hum / keyboard ≈ 0.001–0.005. The fixed floor is used at
# session start (before we have noise samples) and as the lower bound the
# adaptive threshold can never drop below — protects against a dead-silent
# room making the threshold so tiny that fan ramp-up triggers transcription.
RMS_NOISE_THRESHOLD = 0.005

# Adaptive noise floor params. Track recent silent-window RMS values; the
# threshold to gate Whisper is the 25th percentile × NOISE_MARGIN. 25th
# percentile (instead of mean) ignores brief speech leakage that VAD missed.
# 3× margin sits comfortably above ambient (fans / aircon / keyboard hum)
# yet below quiet speech (~0.02). Window size is ~2 seconds at 32 ms / sample.
NOISE_RING_SIZE = 60
NOISE_RING_MIN = 30  # only adapt once we have ~1 s of silence sampled
NOISE_MARGIN = 3.0

# Phrases Whisper emits when fed silence/noise — these are training-data
# leaks (audiobook outros, YouTube subscribe asks, hymns/scripture). They
# are NOT in the user's audio. Match case-insensitive substrings against
# the transcript output. Keep this list short and high-signal to avoid
# eating legit translations of similar phrases.
KNOWN_HALLUCINATIONS = (
    "exodus",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "see you in the next video",
    "see you next time",
    "♪",
    "(music)",
    "[music]",
    "[silence]",
    # Chinese training-data leaks (audiobook / video outro)
    "感谢观看",
    "謝謝觀看",
    "请订阅",
    "請訂閱",
)


def _is_known_hallucination(text: str) -> bool:
    """Whisper sometimes outputs known training-data phrases on silence."""
    head = text.strip().lower()
    if not head:
        return False
    return any(marker in head for marker in KNOWN_HALLUCINATIONS)


def _is_hallucination(text: str) -> bool:
    """Detect the two structural signatures of Whisper-on-silence:
    (1) a single non-whitespace character occupying more than
    HALLUCINATION_DOMINANCE of a long output, e.g. '示示示...';
    (2) any of the well-known training-data phrases listed in
    KNOWN_HALLUCINATIONS, e.g. 'Exodus', 'Thanks for watching'."""
    if _is_known_hallucination(text):
        return True
    chars = [c for c in text if not c.isspace()]
    if len(chars) < HALLUCINATION_MIN_CHARS:
        return False
    most_common = Counter(chars).most_common(1)[0][1]
    return most_common / len(chars) > HALLUCINATION_DOMINANCE


def _segment_rms(audio: np.ndarray) -> float:
    """RMS energy of a float32 audio segment in [-1, 1]."""
    if len(audio) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


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
        # Adaptive noise floor — populated by stream() from windows that
        # silero-vad classifies as non-speech. Defaults to the static floor
        # so tests / one-shot transcribe_file callers don't break.
        self._noise_ring: deque[float] = deque(maxlen=NOISE_RING_SIZE)
        self._dynamic_threshold: float = RMS_NOISE_THRESHOLD

    def _vad(self):
        if self._vad_model is None:
            self._vad_model = load_silero_vad()
        return self._vad_model

    def ensure_loaded(self) -> None:
        """Pre-fetch model snapshot from HuggingFace. Idempotent — returns
        instantly if already cached. Use before the first transcribe to
        front-load the ~1.5GB download instead of blocking the first
        utterance for 1–2 minutes."""
        from huggingface_hub import snapshot_download

        snapshot_download(self.model_repo)

    def _update_noise_floor(self, window_rms: float) -> None:
        """Track recent silent-window RMS and update the dynamic gate. The
        threshold = 25th-percentile of the ring × NOISE_MARGIN, floored at
        the static RMS_NOISE_THRESHOLD so a dead-silent room can't drive it
        absurdly low. The 25th percentile is more robust than the mean
        because silero occasionally misses the first 1–2 windows of a real
        utterance — taking the lower quartile excludes those leaks."""
        self._noise_ring.append(window_rms)
        if len(self._noise_ring) >= NOISE_RING_MIN:
            p25 = float(np.percentile(self._noise_ring, 25))
            self._dynamic_threshold = max(RMS_NOISE_THRESHOLD, p25 * NOISE_MARGIN)

    def _transcribe_audio(self, audio) -> str:
        # B: RMS energy gate. Skip segments quieter than fan/keyboard noise
        # without ever calling Whisper. This is the cheapest hallucination
        # guard since Whisper-on-silence is the entire failure mode.
        if isinstance(audio, np.ndarray):
            rms = _segment_rms(audio)
            if rms < self._dynamic_threshold:
                print(
                    f"[low-energy skipped] rms={rms:.4f} < {self._dynamic_threshold:.4f}",
                    file=sys.stderr,
                )
                return ""

        # A: tighter Whisper guards. condition_on_previous_text=False stops a
        # hallucination from one segment poisoning the next. no_speech_threshold
        # at 0.5 (default 0.6) drops slightly more borderline non-speech
        # segments — a worthwhile trade given how aggressively VAD cuts already.
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_repo,
            language=self.language,
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
        )
        text = result["text"].strip()
        # Return idle Metal buffers to the OS. Without this, MLX's allocator
        # holds the working set of every past transcribe call indefinitely;
        # over a meeting that's tens of GB resident for no good reason.
        _mlx_clear_cache()
        # C: known-phrase blocklist + structural single-char-repeat detector.
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

                # Sample the ambient noise floor whenever silero says we're
                # not in speech. The threshold is then computed from the
                # 25th percentile of recent samples (see _update_noise_floor).
                # Done before the VAD event check so a window that starts
                # speech still counts as silence at this point.
                if not in_speech:
                    self._update_noise_floor(_segment_rms(window))

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
