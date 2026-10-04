import asyncio
import sys
import threading
from collections import Counter, deque
from collections.abc import Callable

import mlx.core as mx
import numpy as np
import torch
import mlx_whisper
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript
from .lang_resources import hallucination_blocklist
from .openai_transcription_config import ZH_TW_SCRIPT_PROMPT
from .vad_tools import ProbTap, pick_cut_index, segment_joiner


# asyncio cancellation cannot stop a function already running in `to_thread`.
# Serialize every MLX/Metal inference so an old, cancelled session cannot race
# a quick restart (or startup prewarm) on the same global Metal runtime.
MLX_INFERENCE_LOCK = threading.Lock()


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

# A blocklist marker only makes the text a hallucination when the markers
# cover (almost) all of it: at most this many alphanumeric characters left
# once every marker occurrence is removed, or less than this fraction of the
# text. Plain substring matching dropped real sentences ("an exodus of
# customers", "Please subscribe to our newsletter").
HALLUCINATION_RESIDUAL_MAX_CHARS = 6
HALLUCINATION_RESIDUAL_MAX_RATIO = 0.25
# CJK carries a word or more per character, so 6 leftover han / kana is a
# whole clause of real speech (「請訂閱我們的電子報」 minus 「請訂閱」). When
# the residual contains CJK, allow at most this many leftover characters.
HALLUCINATION_RESIDUAL_MAX_CHARS_CJK = 2


def _is_cjk_char(c: str) -> bool:
    o = ord(c)
    return (
        0x3040 <= o <= 0x30FF      # hiragana + katakana
        or 0x3400 <= o <= 0x4DBF   # CJK ext A
        or 0x4E00 <= o <= 0x9FFF   # CJK unified
        or 0xAC00 <= o <= 0xD7AF   # hangul
        or 0xF900 <= o <= 0xFAFF   # CJK compatibility
        or 0x20000 <= o <= 0x2FFFF  # CJK ext B+
    )

# Pre-roll: audio kept from just before silero declares speech start and
# prepended to the utterance, so soft word onsets (unvoiced consonants that
# silero scores low) aren't clipped. ~300 ms.
PREROLL_SEC = 0.3

# Forced cut at max_speech_sec: instead of cutting exactly at the cap, pick
# the most pause-like window (lowest VAD probability) within this lookback
# and carry the rest into the next utterance.
FORCED_CUT_LOOKBACK_SEC = 1.5

# End-of-stream (stop / end of demo file) flush: transcribe the speech still
# buffered only when it holds at least this much speech.
STOP_FLUSH_MIN_SEC = 0.5

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

# Fragments of ZH_TW_SCRIPT_PROMPT that Whisper may echo back on silence.
_ZH_PROMPT_ECHO_MARKERS = ("以下為繁體中文的會議內容", "請以繁體中文輸出")


def _is_known_hallucination(
    text: str, blocklist: tuple[str, ...] = KNOWN_HALLUCINATIONS
) -> bool:
    """Whisper sometimes outputs known training-data phrases on silence.

    True only when blocklist markers make up (almost) the whole text: after
    masking every (possibly overlapping) marker occurrence, the remaining
    alphanumeric characters are at most HALLUCINATION_RESIDUAL_MAX_CHARS
    or under HALLUCINATION_RESIDUAL_MAX_RATIO of the text's alphanumerics.
    A marker embedded in a real sentence ("an exodus of customers") is kept."""
    low = text.strip().lower()
    if not low:
        return False
    # Score both the text as-is (English markers contain spaces) and with
    # whitespace removed (CJK markers vs "由 Amara.org 社区…"); the better
    # coverage wins.
    variants = (low, "".join(low.split()))
    return any(_markers_cover(v, blocklist) for v in variants)


def _markers_cover(low: str, blocklist: tuple[str, ...]) -> bool:
    covered = [False] * len(low)
    hit = False
    for marker in blocklist:
        if not marker:
            continue
        start = low.find(marker)
        while start != -1:
            hit = True
            for i in range(start, start + len(marker)):
                covered[i] = True
            start = low.find(marker, start + 1)
    if not hit:
        return False
    total = sum(1 for c in low if c.isalnum())
    left = [c for c, cov in zip(low, covered) if not cov and c.isalnum()]
    residual = len(left)
    max_chars = (
        HALLUCINATION_RESIDUAL_MAX_CHARS_CJK
        if any(_is_cjk_char(c) for c in left)
        else HALLUCINATION_RESIDUAL_MAX_CHARS
    )
    return (
        residual <= max_chars
        or residual < HALLUCINATION_RESIDUAL_MAX_RATIO * total
    )


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


def _compose_initial_prompt(language: str, glossary_prompt: str | None) -> str | None:
    """Whisper initial_prompt for the local backend. For a zh source the
    Traditional-Chinese script carrier (same text the cloud path uses) always
    leads, so mlx-whisper doesn't drift into Simplified output; the glossary
    context, if any, follows. Whisper keeps the LAST ~223 prompt tokens, and
    the Rust config layer caps the glossary at 30 terms, so the carrier fits."""
    glossary = (glossary_prompt or "").strip()
    if (language or "").strip().lower().split("-")[0] == "zh":
        return ZH_TW_SCRIPT_PROMPT + glossary
    return glossary or None


def _segment_drop_reason(no_speech: float, avg_logprob: float, compression: float) -> str | None:
    """Gate 3 decision for one Whisper segment: None to keep, else the drop
    reason. Mirrors Whisper's own silence rule — a segment is non-speech only
    when no_speech_prob is high AND the decode was low-confidence; either
    signal alone is common on real (accented / quiet / fast) speech. The
    repetition-loop guard (compression ratio) stands on its own."""
    if no_speech > SEGMENT_NO_SPEECH_MAX and avg_logprob < SEGMENT_AVG_LOGPROB_MIN:
        return "no_speech"
    if compression > SEGMENT_COMPRESSION_RATIO_MAX:
        return "compression"
    return None


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
        self.initial_prompt = _compose_initial_prompt(language, initial_prompt)
        if language.strip().lower().split("-")[0] == "zh":
            # Whisper can echo its prompt on silence; with the script carrier
            # now always present, treat an output that is just the carrier as
            # a hallucination (coverage rule keeps real sentences).
            self._blocklist = self._blocklist + _ZH_PROMPT_ECHO_MARKERS
        self._joiner = segment_joiner(language)
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

        # Cache hit must not touch the network: a plain snapshot_download
        # does an HF API round-trip on every start (slow on bad Wi-Fi, and
        # an error offline). Only go online when the files aren't local.
        try:
            snapshot_download(self.model_repo, local_files_only=True)
            return
        except Exception:  # noqa: BLE001 — LocalEntryNotFoundError & co.
            pass
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

    def _transcribe_audio(self, audio, gate_offset: int = 0) -> str:
        # `gate_offset`: leading samples (the pre-roll) excluded from the
        # energy gates below — they are pre-speech silence by construction
        # and would only dilute the RMS / consistency measurements. Whisper
        # still gets the full buffer.
        # Gate 1a: segment-mean RMS. Skip segments quieter than the adaptive
        # noise floor without ever calling Whisper. Cheapest possible drop.
        if isinstance(audio, np.ndarray):
            gated = audio[gate_offset:] if 0 < gate_offset < len(audio) else audio
            rms = _segment_rms(gated)
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
            n_chunks = len(gated) // CONSISTENCY_WINDOW_SAMPLES
            if n_chunks >= 3:  # below 300 ms there's nothing to be consistent about
                trimmed = gated[: n_chunks * CONSISTENCY_WINDOW_SAMPLES]
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
        with MLX_INFERENCE_LOCK:
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
                reason = _segment_drop_reason(no_speech, avg_logprob, compression)
                if reason == "no_speech":
                    dropped_reasons.append(
                        f"no_speech={no_speech:.2f}+logprob={avg_logprob:.2f}"
                    )
                    dropped_details.append({
                        "no_speech_prob": round(no_speech, 3),
                        "avg_logprob": round(avg_logprob, 3),
                    })
                    continue
                if reason == "compression":
                    dropped_reasons.append(f"compress={compression:.2f}")
                    dropped_details.append({"compression_ratio": round(compression, 3)})
                    continue
                t = str(seg.get("text", "")).strip()
                if t:
                    kept_texts.append(t)
            # zh / ja are written without spaces — a " " join would insert
            # stray spaces mid-sentence that leak into the translation.
            text = self._joiner.join(kept_texts).strip()
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
        The forced cut lands on the most pause-like window of the last
        FORCED_CUT_LOOKBACK_SEC (lowest VAD probability) and the audio after
        it is carried into the next utterance; such finals carry boundary
        "forced". ~PREROLL_SEC of audio before each VAD start is prepended.

        When `audio_chunks` ends (stop command / end of the demo file) any
        buffered speech of at least STOP_FLUSH_MIN_SEC is transcribed and
        emitted with boundary "pause".

        Each Whisper call runs via asyncio.to_thread so a slow inference
        (notably the first one on a cold Mac, where Metal kernels compile on
        demand and can take several seconds) never blocks the event loop. If
        it did, the sidecar couldn't read the `stop` command off stdin until
        the inference finished — which surfaced as a 5–10 s freeze on 停止錄音.
        """
        max_samples = int(self.max_speech_sec * sample_rate)
        max_windows = max(1, -(-max_samples // WINDOW_SAMPLES))
        preroll_windows = max(0, round(PREROLL_SEC * sample_rate / WINDOW_SAMPLES))
        lookback_windows = max(1, round(FORCED_CUT_LOOKBACK_SEC * sample_rate / WINDOW_SAMPLES))
        probe = ProbTap(self._vad())
        vad_iter = VADIterator(
            probe,
            threshold=0.5,
            sampling_rate=sample_rate,
            min_silence_duration_ms=300,
            speech_pad_ms=30,
        )
        leftover = b""
        # Parallel per-window lists for the current utterance: audio, VAD
        # speech probability, RMS (the latter two feed the forced-cut picker).
        speech_buffer: list[np.ndarray] = []
        speech_probs: list[float] = []
        speech_rms: list[float] = []
        # Number of leading pre-roll windows in speech_buffer (excluded from
        # the min-speech duration and the energy gates).
        utt_preroll = 0
        preroll: deque[tuple[np.ndarray, float, float]] = deque(maxlen=preroll_windows or 1)
        in_speech = False
        speech_start_sec: float = 0.0
        samples_processed = 0

        def reset_utterance():
            nonlocal speech_buffer, speech_probs, speech_rms, utt_preroll, in_speech
            speech_buffer, speech_probs, speech_rms = [], [], []
            utt_preroll = 0
            in_speech = False

        async for chunk in audio_chunks:
            leftover += chunk
            while len(leftover) >= WINDOW_SAMPLES * 2:
                window_bytes = leftover[: WINDOW_SAMPLES * 2]
                leftover = leftover[WINDOW_SAMPLES * 2 :]
                window = np.frombuffer(window_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                win_rms = _segment_rms(window)

                # Sample the ambient noise floor whenever silero says we're
                # not in speech. The threshold is then computed from the
                # 25th percentile of recent samples (see _update_noise_floor).
                # Done before the VAD event check so a window that starts
                # speech still counts as silence at this point.
                if not in_speech:
                    self._update_noise_floor(win_rms)

                event = vad_iter(torch.from_numpy(window), return_seconds=True)
                prob = probe.last
                samples_processed += WINDOW_SAMPLES

                if in_speech:
                    speech_buffer.append(window)
                    speech_probs.append(prob)
                    speech_rms.append(win_rms)

                if event and "start" in event:
                    pre = list(preroll) if preroll_windows else []
                    preroll.clear()
                    utt_preroll = len(pre)
                    speech_buffer = [w for w, _, _ in pre] + [window]
                    speech_probs = [p for _, p, _ in pre] + [prob]
                    speech_rms = [r for _, _, r in pre] + [win_rms]
                    speech_start_sec = max(
                        0.0, float(event["start"]) - utt_preroll * WINDOW_SAMPLES / sample_rate
                    )
                    in_speech = True
                elif not in_speech and preroll_windows:
                    preroll.append((window, prob, win_rms))

                if event and "end" in event and speech_buffer:
                    full_audio = np.concatenate(speech_buffer)
                    # Gate 0: minimum speech duration. silero occasionally
                    # opens-and-closes within ~100 ms on a sharp click; a real
                    # syllable can't fit in that window. Drop pre-Whisper.
                    # The pre-roll doesn't count as speech.
                    dur = (len(speech_buffer) - utt_preroll) * WINDOW_SAMPLES / sample_rate
                    if dur < MIN_SPEECH_SEC:
                        self._diag(
                            "min_speech", speech_start_sec,
                            {"duration_sec": round(dur, 3), "min_sec": MIN_SPEECH_SEC},
                            f"[short-speech skipped] {dur:.2f}s < {MIN_SPEECH_SEC}s",
                        )
                        reset_utterance()
                        continue
                    text = await asyncio.to_thread(
                        self._transcribe_audio, full_audio, utt_preroll * WINDOW_SAMPLES
                    )
                    if text:
                        yield Transcript(
                            text=text, is_final=True, boundary="sentence",
                            t_start=speech_start_sec, t_end=float(event["end"]),
                        )
                    reset_utterance()
                    continue

                # Force-cut long continuous speech (no VAD-detected pause) at
                # the most pause-like recent window; carry the rest forward.
                if in_speech and len(speech_buffer) >= max_windows:
                    cut = pick_cut_index(speech_probs, lookback_windows, speech_rms)
                    head = speech_buffer[: cut + 1]
                    full_audio = np.concatenate(head)
                    cut_at = speech_start_sec + len(full_audio) / sample_rate
                    gate_offset = utt_preroll * WINDOW_SAMPLES
                    speech_buffer = speech_buffer[cut + 1 :]
                    speech_probs = speech_probs[cut + 1 :]
                    speech_rms = speech_rms[cut + 1 :]
                    utt_preroll = 0
                    text = await asyncio.to_thread(self._transcribe_audio, full_audio, gate_offset)
                    if text:
                        yield Transcript(
                            text=text, is_final=True, boundary="forced",
                            t_start=speech_start_sec, t_end=cut_at,
                        )
                    speech_start_sec = cut_at  # next utterance continues from here

        # End of input (graceful stop / end of file): flush buffered speech.
        if in_speech and speech_buffer:
            dur = (len(speech_buffer) - utt_preroll) * WINDOW_SAMPLES / sample_rate
            if dur < STOP_FLUSH_MIN_SEC:
                return
            full_audio = np.concatenate(speech_buffer)
            text = await asyncio.to_thread(
                self._transcribe_audio, full_audio, utt_preroll * WINDOW_SAMPLES
            )
            if text:
                yield Transcript(
                    text=text, is_final=True, boundary="pause",
                    t_start=speech_start_sec, t_end=samples_processed / sample_rate,
                )
