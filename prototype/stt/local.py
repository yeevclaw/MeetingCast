import sys
from collections import Counter, deque
from collections.abc import Callable

import mlx.core as mx
import numpy as np
import torch
import mlx_whisper
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript
from .lang_resources import hallucination_blocklist


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

# Minimum VAD-cut speech duration. Real syllables take ~250 ms minimum;
# anything shorter is almost certainly a click / chair-creak / mouse-click
# that silero misclassified as speech. Drop these before they reach Whisper
# so it never gets the chance to hallucinate on them.
MIN_SPEECH_SEC = 0.25

# Speech-consistency gate. After silero declares a segment is speech, slice
# it into 100 ms chunks and require a fraction of them to be above the
# adaptive RMS floor. A burst-then-silence shape (e.g. a 200 ms click
# followed by 3 s of room hum that sneaks past the *segment-mean* RMS gate)
# fails this even when the segment as a whole exceeds the threshold.
CONSISTENCY_WINDOW_SAMPLES = 1600  # 100 ms @ 16 kHz
CONSISTENCY_MIN_ACTIVE_RATIO = 0.4

# Whisper segment-level confidence thresholds. mlx_whisper's `result["segments"]`
# carries the model's own per-segment metrics — using them is far more
# precise than pattern-matching the output text. Tuned a bit stricter than
# Whisper's internal retry thresholds (compression_ratio 2.4, logprob -1.0)
# so we drop segments Whisper kept under duress.
SEGMENT_NO_SPEECH_MAX = 0.7
SEGMENT_AVG_LOGPROB_MIN = -1.0
SEGMENT_COMPRESSION_RATIO_MAX = 2.0

# Adaptive noise floor params. Track recent silent-window RMS values; the
# threshold to gate Whisper is the 25th percentile × NOISE_MARGIN. 25th
# percentile (instead of mean) ignores brief speech leakage that VAD missed.
# 3× margin sits comfortably above ambient (fans / aircon / keyboard hum)
# yet below quiet speech (~0.02). Window size is ~2 seconds at 32 ms / sample.
NOISE_RING_SIZE = 60
NOISE_RING_MIN = 30  # only adapt once we have ~1 s of silence sampled
NOISE_MARGIN = 3.0

# Phrases Whisper emits when fed silence/noise — training-data leaks
# (audiobook outros, YouTube subscribe asks, subtitle credits). They are NOT
# in the user's audio; matched as case-insensitive substrings. The full
# per-language tables live in lang_resources.py; this module-level alias is
# the zh blocklist, kept as the default for the callers below and for CLI /
# test call sites that import the name.
KNOWN_HALLUCINATIONS = hallucination_blocklist("zh")


def _is_known_hallucination(
    text: str, blocklist: tuple[str, ...] = KNOWN_HALLUCINATIONS
) -> bool:
    """Whisper sometimes outputs known training-data phrases on silence."""
    head = text.strip().lower()
    if not head:
        return False
    return any(marker in head for marker in blocklist)


def _is_hallucination(
    text: str, blocklist: tuple[str, ...] = KNOWN_HALLUCINATIONS
) -> bool:
    """Detect the two structural signatures of Whisper-on-silence:
    (1) a single non-whitespace character occupying more than
    HALLUCINATION_DOMINANCE of a long output, e.g. '示示示...';
    (2) any of the well-known training-data phrases in the blocklist,
    e.g. 'Exodus', 'Thanks for watching', 'ご視聴ありがとう'."""
    if _is_known_hallucination(text, blocklist):
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
        initial_prompt: str | None = None,
        on_diag: Callable[[str, float | None, dict], None] | None = None,
    ):
        self.language = language
        # Whisper leaks language-specific outro phrases on silence — pick the
        # blocklist for the pinned decoding language (COMMON + EN always).
        self._blocklist = hallucination_blocklist(language)
        self.model_repo = model_repo or self.MODEL_REPO
        self.max_speech_sec = max_speech_sec
        self.initial_prompt = initial_prompt
        # Optional sink for gate-skip diagnostics. When wired (by the sidecar)
        # each skip is reported as a structured event; when None (CLI / tests)
        # the legacy stderr lines are printed instead, so behavior is unchanged.
        self._on_diag = on_diag
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

    def _diag(
        self, gate: str, t_start: float | None, detail: dict, stderr_msg: str
    ) -> None:
        """Report one gate skip. Routes to the injected on_diag callback when
        present (structured event), otherwise prints the legacy stderr line so
        the CLI keeps its current output. A failing callback is swallowed —
        diagnostics must never break the transcription path."""
        if self._on_diag is not None:
            try:
                self._on_diag(gate, t_start, detail)
            except Exception:  # noqa: BLE001
                pass
        else:
            print(stderr_msg, file=sys.stderr)

    def _transcribe_audio(self, audio) -> str:
        # Gate 1a: segment-mean RMS. Skip segments quieter than the adaptive
        # noise floor without ever calling Whisper. Cheapest possible drop.
        if isinstance(audio, np.ndarray):
            rms = _segment_rms(audio)
            if rms < self._dynamic_threshold:
                self._diag(
                    "rms_floor", None,
                    {"rms": round(rms, 5), "threshold": round(self._dynamic_threshold, 5)},
                    f"[low-energy skipped] rms={rms:.4f} < {self._dynamic_threshold:.4f}",
                )
                return ""

            # Gate 1b: speech-consistency. A burst-then-silence shape (a 200 ms
            # click + 3 s of room hum) can pass the segment-mean RMS check but
            # is exactly the input that hallucinates Whisper. Slice into 100 ms
            # chunks and require >= CONSISTENCY_MIN_ACTIVE_RATIO to be above
            # the dynamic floor — i.e. the speech is *distributed* through the
            # segment, not localized in one spike.
            n_chunks = len(audio) // CONSISTENCY_WINDOW_SAMPLES
            if n_chunks >= 3:  # below 300 ms there's nothing to be consistent about
                trimmed = audio[: n_chunks * CONSISTENCY_WINDOW_SAMPLES]
                chunks = trimmed.astype(np.float64).reshape(n_chunks, CONSISTENCY_WINDOW_SAMPLES)
                chunk_rms = np.sqrt(np.mean(chunks ** 2, axis=1))
                active_ratio = float((chunk_rms >= self._dynamic_threshold).mean())
                if active_ratio < CONSISTENCY_MIN_ACTIVE_RATIO:
                    self._diag(
                        "consistency", None,
                        {"active_ratio": round(active_ratio, 3),
                         "min_ratio": CONSISTENCY_MIN_ACTIVE_RATIO,
                         "n_chunks": n_chunks},
                        f"[low-consistency skipped] active_ratio={active_ratio:.2f} "
                        f"< {CONSISTENCY_MIN_ACTIVE_RATIO} ({n_chunks} chunks)",
                    )
                    return ""

        # Gate 2: Whisper itself. condition_on_previous_text=False stops a
        # hallucination from one segment poisoning the next. no_speech_threshold
        # at 0.5 (default 0.6) drops slightly more borderline non-speech
        # segments — a worthwhile trade given how aggressively VAD cuts already.
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_repo,
            language=self.language,
            condition_on_previous_text=False,
            no_speech_threshold=0.5,
            initial_prompt=self.initial_prompt,
        )
        # Return idle Metal buffers to the OS. Without this, MLX's allocator
        # holds the working set of every past transcribe call indefinitely;
        # over a meeting that's tens of GB resident for no good reason.
        _mlx_clear_cache()
        # result["language"] (Whisper auto-detect) intentionally unread — reserved for future auto-detect mode.

        # Gate 3: per-segment confidence filtering. Whisper retries low-
        # confidence segments at higher temperature internally, but if all
        # retries fail it still emits *something* (often the hallucination
        # we wanted to drop). Walk segments and keep only those that pass
        # all three of Whisper's own internal metrics. Falls back to the
        # full result text if segments aren't available — older mlx_whisper
        # versions or odd code paths.
        segments = result.get("segments") or []
        if segments:
            kept_texts: list[str] = []
            dropped_reasons: list[str] = []
            dropped_details: list[dict] = []
            for seg in segments:
                no_speech = float(seg.get("no_speech_prob", 0.0))
                avg_logprob = float(seg.get("avg_logprob", 0.0))
                compression = float(seg.get("compression_ratio", 0.0))
                if no_speech > SEGMENT_NO_SPEECH_MAX:
                    dropped_reasons.append(f"no_speech={no_speech:.2f}")
                    dropped_details.append({"no_speech_prob": round(no_speech, 3)})
                    continue
                if avg_logprob < SEGMENT_AVG_LOGPROB_MIN:
                    dropped_reasons.append(f"logprob={avg_logprob:.2f}")
                    dropped_details.append({"avg_logprob": round(avg_logprob, 3)})
                    continue
                if compression > SEGMENT_COMPRESSION_RATIO_MAX:
                    dropped_reasons.append(f"compress={compression:.2f}")
                    dropped_details.append({"compression_ratio": round(compression, 3)})
                    continue
                t = str(seg.get("text", "")).strip()
                if t:
                    kept_texts.append(t)
            text = " ".join(kept_texts).strip()
            if not text and dropped_reasons:
                self._diag(
                    "segment_confidence", None,
                    {"n_dropped": len(dropped_details), "dropped": dropped_details[:3]},
                    f"[low-confidence dropped] {len(dropped_reasons)} segments: "
                    f"{', '.join(dropped_reasons[:3])}"
                    + ("..." if len(dropped_reasons) > 3 else ""),
                )
        else:
            text = str(result.get("text", "")).strip()

        # Gate 4: known training-data phrases + single-char dominance. Catches
        # the long-form '謝謝觀看' / '示示示...' shapes the Whisper-internal
        # gates miss. Kept as the final safety net, not the primary defense.
        if _is_hallucination(text, self._blocklist):
            head = text[:40]
            if _is_known_hallucination(text, self._blocklist):
                gate, detail = "hallucination_phrase", {"text_head": head}
            else:
                # Not a known phrase, so _is_hallucination fired on single-char
                # dominance — recompute the ratio for the diagnostic.
                chars = [c for c in text if not c.isspace()]
                dominance = (
                    Counter(chars).most_common(1)[0][1] / len(chars) if chars else 0.0
                )
                gate = "single_char_dominance"
                detail = {"dominance": round(dominance, 3), "n_chars": len(chars), "text_head": head}
            self._diag(
                gate, None, detail,
                f"[hallucination filtered] {head}{'...' if len(text) > 40 else ''}",
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
                    # Gate 0: minimum speech duration. silero occasionally
                    # opens-and-closes within ~100 ms on a sharp click; a real
                    # syllable can't fit in that window. Drop pre-Whisper.
                    dur = len(full_audio) / sample_rate
                    if dur < MIN_SPEECH_SEC:
                        self._diag(
                            "min_speech", speech_start_sec,
                            {"duration_sec": round(dur, 3), "min_sec": MIN_SPEECH_SEC},
                            f"[short-speech skipped] {dur:.2f}s < {MIN_SPEECH_SEC}s",
                        )
                        speech_buffer = []
                        in_speech = False
                        continue
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
            if len(full_audio) / sample_rate < MIN_SPEECH_SEC:
                return
            text = self._transcribe_audio(full_audio)
            if text:
                yield Transcript(
                    text=text, is_final=True,
                    t_start=speech_start_sec, t_end=samples_processed / sample_rate,
                )
