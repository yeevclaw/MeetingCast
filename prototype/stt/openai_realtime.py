"""OpenAI live Realtime transcription backend.

Uses `gpt-live-transcribe` — OpenAI's recommended live STT model. It emits
incremental deltas before the committed-turn completion event, so users see
the transcript build up live instead of only at the end of an utterance.

Tradeoffs vs mlx-whisper:
  * pros: streaming captions plus contextual, language, and keyword hints
  * cons: cloud audio cost and network/privacy requirements

MeetingCast keeps its existing Silero VAD client-side and disables server
turn detection, sending `input_audio_buffer.commit` itself at each utterance.
The live model accepts context, glossary keywords, and regional language hints;
Traditional Chinese is sent as `zh-tw`.
"""

import asyncio
import base64
import json
import os
import wave
from collections import deque
from typing import AsyncIterator

import numpy as np
import torch
import websockets
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript
from .openai_transcription_config import (
    DEFAULT_DELAY,
    LIVE_TRANSCRIBE_MODEL,
    TARGET_RATE,
    build_session_payload,
)


# OpenAI Realtime requires intent=transcription for STT-only sessions;
# the model is set inside session.update, not via URL query string.
WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription"

MODEL = LIVE_TRANSCRIBE_MODEL

WINDOW_SAMPLES = 512  # silero VAD requires 512-sample windows at 16kHz
MIN_SPEECH_SEC = 0.25  # drop sub-syllable VAD opens (clicks/keyboard taps)

SENTENCE_END_CHARS = "。？！?!."
MIN_SEGMENT_CHARS = 6  # don't early-emit tiny sentences; they ride along with the next one

# ---- Segment boundaries (see docs/PLAN_INCREMENTAL_INTERP.md) ----------------
# A "segment" is a semantic unit (5–15 zh chars) emitted as an early final so
# the incremental translator can start before the sentence ends. The boundary
# kind tells Rust whether the translation group stays open (clause / forced)
# or closes (sentence / pause).
BOUNDARY_CLAUSE = "clause"
BOUNDARY_SENTENCE = "sentence"
BOUNDARY_PAUSE = "pause"
BOUNDARY_FORCED = "forced"

# Early-final segmentation modes. "sentence" = today's behaviour (cut only at
# sentence-final punctuation, each final is an independent utterance for the
# sentence-level translator). "fine" = clause / marker / max-length cuts for
# the incremental interpreter, which stitches segments back into groups.
SEGMENTATION_SENTENCE = "sentence"
SEGMENTATION_FINE = "fine"

CLAUSE_CHARS = "，,、；;：:"
# ASCII punctuation directly after a digit is numeric (3.5 / 1,000 / 3:30),
# never a boundary.
_NUMERIC_GUARDED = ".,:"

# (min_chars, max_chars) per script family. CJK counts characters; spaced
# languages (en / vi) count characters too but force-cut at the last space so
# a word is never split — 12/60 chars is roughly 3–12 words.
SEGMENT_LIMITS = {"cjk": (4, 15), "spaced": (12, 60)}

# Discourse markers: cut BEFORE the marker so it opens the next segment. Only
# for languages where punctuation alone under-segments fast speech. Keep the
# list conservative — a false cut only costs one extra clause boundary, but a
# marker that is really a word-internal substring would fragment words.
DISCOURSE_MARKERS = {
    "zh": (
        "也就是說", "換句話說", "接下來",
        "然後", "所以", "但是", "不過", "另外", "那麼", "首先", "接著", "再來",
        "第一", "第二", "第三", "因為", "如果", "總之", "其實",
    ),
    "ja": ("それから", "ですので", "それで", "しかし", "つまり", "ただし", "そして", "でも", "まず", "次に"),
}


def _lang_family(language: str) -> str:
    return "cjk" if language.lower().split("-")[0] in ("zh", "ja") else "spaced"


def _marker_at(text: str, i: int, markers: tuple[str, ...]) -> str | None:
    for m in markers:  # DISCOURSE_MARKERS lists longer markers first
        if text.startswith(m, i):
            return m
    return None


def split_segments(
    text: str, language: str = "zh"
) -> tuple[list[tuple[str, str]], str]:
    """Cut `text` into semantic segments for the incremental translator.

    Returns (segments, tail): `segments` is a list of (raw_text, boundary)
    in order; `tail` is the unfinished remainder. Segment texts are raw
    slices (not stripped) so callers can track offsets into `text`;
    `"".join(seg for seg, _ in segments) + tail == text` always holds.

    Cut points, in priority order at each position:
      1. sentence-final punctuation      -> BOUNDARY_SENTENCE
      2. clause punctuation              -> BOUNDARY_CLAUSE
      3. a discourse marker starting here -> BOUNDARY_CLAUSE (cut before it)
      4. segment reached max_chars       -> BOUNDARY_FORCED
    A cut is skipped (the text rides along into the next segment) when the
    would-be segment is shorter than min_chars. ASCII . , : after a digit
    are numeric, not boundaries.
    """
    family = _lang_family(language)
    min_chars, max_chars = SEGMENT_LIMITS[family]
    markers = DISCOURSE_MARKERS.get(language.lower().split("-")[0], ())
    segments: list[tuple[str, str]] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        numeric = ch in _NUMERIC_GUARDED and i > 0 and text[i - 1].isdigit()
        cut_after: str | None = None
        if ch in SENTENCE_END_CHARS and not numeric:
            cut_after = BOUNDARY_SENTENCE
        elif ch in CLAUSE_CHARS and not numeric:
            cut_after = BOUNDARY_CLAUSE

        if cut_after is not None:
            seg = text[start : i + 1]
            if len(seg.strip()) >= min_chars:
                segments.append((seg, cut_after))
                start = i + 1
            i += 1
            continue

        if i > start and markers:
            m = _marker_at(text, i, markers)
            if m is not None and len(text[start:i].strip()) >= min_chars:
                segments.append((text[start:i], BOUNDARY_CLAUSE))
                start = i
                i += len(m)
                continue

        if i - start + 1 >= max_chars:
            # Never force-cut inside a Latin/digit run embedded in CJK text
            # ("MeetingCast", "Q3", "Claude 5.1"): the next char may still be
            # part of the token and hasn't arrived yet. Wait for the run to
            # end — a CJK char or punctuation always follows soon.
            if family == "cjk" and _continues_ascii_run(text, i):
                i += 1
                continue
            if family == "spaced":
                sp = text.rfind(" ", start, i + 1)
                if sp > start:
                    # keep the space inside the emitted segment so offsets
                    # stay contiguous; on_delta strips for display
                    segments.append((text[start : sp + 1], BOUNDARY_FORCED))
                    start = sp + 1
                    i += 1
                    continue
            segments.append((text[start : i + 1], BOUNDARY_FORCED))
            start = i + 1
        i += 1
    return segments, text[start:]


def _continues_ascii_run(text: str, i: int) -> bool:
    """True when `text[i]` is still part of an ASCII token run inside CJK
    text, so a forced cut here would split a word or a number. Covers the
    token itself ("MeetingCast", "Q3"), numeric punctuation after a digit
    ("5.1", "1,000", "3:30" — the number is not over) and a single space
    between two ASCII tokens ("Claude 5", "GPT 5.6 Terra"). Seen live
    2026-09-07: cutting at "Claude 5." made the interpreter emit
    "ahead of Claude 5." and the ".1" could never be appended.
    """
    ch = text[i]
    if ch.isascii() and ch.isalnum():
        return True
    prev = text[i - 1] if i > 0 else ""
    if ch in _NUMERIC_GUARDED and prev.isdigit():
        return True
    if ch == " " and prev.isascii() and prev.isalnum():
        return True
    return False


def _closing_boundary(text: str) -> str:
    """Boundary for the remainder emitted at item completion: `sentence` if
    it already ends with sentence-final punctuation, else `pause` (the VAD
    closed the item mid-sentence, or the 15s force-commit fired)."""
    t = text.rstrip()
    if not t:
        return BOUNDARY_PAUSE
    last = t[-1]
    if last in SENTENCE_END_CHARS:
        if last == "." and len(t) > 1 and t[-2].isdigit():
            return BOUNDARY_PAUSE
        return BOUNDARY_SENTENCE
    return BOUNDARY_PAUSE


def split_complete_sentences(
    text: str, min_chars: int = MIN_SEGMENT_CHARS
) -> tuple[str, str]:
    """Split `text` at its last sentence-final punctuation.

    Returns (complete-sentence prefix, unfinished tail). The prefix is ""
    when there is no split point, or when it would be shorter than
    `min_chars`. A '.' directly after a digit is a decimal point (3.5),
    not a sentence end.
    """
    cut = -1
    for i, ch in enumerate(text):
        if ch not in SENTENCE_END_CHARS:
            continue
        if ch == "." and i > 0 and text[i - 1].isdigit():
            continue
        cut = i
    if cut == -1 or cut + 1 < min_chars:
        return "", text
    return text[: cut + 1], text[cut + 1 :]


class _SentenceSplitter:
    """Per-item delta accumulation with segment-aware early finals.

    Translation downstream only fires on is_final transcripts, which
    normally arrive at VAD speech-end or the max_speech_sec force-flush —
    up to 15s into fast, pause-free speech. Deltas lag the audio by only
    ~1.3s, so as soon as the running delta text contains a complete
    segment (sentence, clause, discourse-marker cut or max-length cut —
    see `split_segments`) we emit it as a synthetic final tagged with its
    boundary kind and keep only the unfinished tail as the interim.
    `transcription.completed` then emits whatever part of the item wasn't
    already emitted early, tagged `sentence` or `pause`.
    """

    def __init__(self, language: str = "zh", segmentation: str = SEGMENTATION_SENTENCE):
        self.language = language
        self.segmentation = segmentation
        self._partials: dict[str, str] = {}  # full delta accumulation per item_id
        self._emitted: dict[str, str] = {}  # prefix already emitted as early finals

    def _split(self, pending: str) -> tuple[list[tuple[str, str]], str]:
        if self.segmentation == SEGMENTATION_FINE:
            return split_segments(pending, self.language)
        sentence, tail = split_complete_sentences(pending)
        return ([(sentence, BOUNDARY_SENTENCE)] if sentence else []), tail

    def on_delta(self, iid: str, delta: str) -> list[Transcript]:
        self._partials[iid] = self._partials.get(iid, "") + delta
        if not delta:
            return []
        done = self._emitted.get(iid, "")
        pending = self._partials[iid][len(done):]
        segments, tail = self._split(pending)
        out: list[Transcript] = []
        if segments:
            # offsets track the raw (unstripped) text; strip only for display
            consumed = pending[: len(pending) - len(tail)]
            self._emitted[iid] = done + consumed
            for seg, boundary in segments:
                if seg.strip():
                    out.append(
                        Transcript(text=seg.strip(), is_final=True, boundary=boundary)
                    )
        if tail.strip():
            out.append(Transcript(text=tail, is_final=False))
        return out

    def on_completed(self, iid: str, text: str) -> Transcript | None:
        done = self._emitted.pop(iid, "")
        accumulated = self._partials.pop(iid, "")
        if done and not text.startswith(done):
            # completed drifted from the delta concatenation (shouldn't
            # happen) — trust the accumulation so early-emitted sentences
            # aren't re-emitted and re-translated
            remainder = accumulated[len(done):]
        else:
            remainder = text[len(done):]
        remainder = remainder.strip()
        if not remainder:
            return None
        return Transcript(
            text=remainder, is_final=True, boundary=_closing_boundary(remainder)
        )


class OpenAILiveTranscribeSTT:
    def __init__(
        self,
        language: str = "zh",
        model: str | None = None,
        max_speech_sec: float = 15.0,
        initial_prompt: str | None = None,
        keywords: list[str] | None = None,
        delay: str = DEFAULT_DELAY,
        segmentation: str = SEGMENTATION_SENTENCE,
    ):
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY 未設定。到 https://platform.openai.com/api-keys "
                "拿一支 key，填入 prototype/.env"
            )
        self._api_key = api_key
        self.language = language
        self.model = model or MODEL
        self.max_speech_sec = max_speech_sec
        self.initial_prompt = initial_prompt
        self.keywords = keywords or []
        # gpt-live-transcribe `delay` level: lower = earlier partial text,
        # higher = more audio context per emitted word (better WER).
        self.delay = delay
        self.segmentation = segmentation
        self._vad_model = None

    def _vad(self):
        if self._vad_model is None:
            self._vad_model = load_silero_vad()
        return self._vad_model

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}"}

    @staticmethod
    def _resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int = TARGET_RATE) -> bytes:
        """16-bit mono PCM resampler. Linear interpolation — fine for
        speech STT; intelligibility is preserved well below the Nyquist
        of either rate. Uses only numpy (already a pipeline dep)."""
        if src_rate == dst_rate:
            return pcm
        a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if len(a) == 0:
            return b""
        n_out = max(1, int(round(len(a) * dst_rate / src_rate)))
        xp = np.linspace(0, len(a) - 1, n_out, dtype=np.float64)
        out = np.interp(xp, np.arange(len(a), dtype=np.float64), a)
        return (np.clip(out, -1.0, 1.0) * 32767).astype(np.int16).tobytes()

    def _session_payload(self) -> dict:
        return build_session_payload(
            model=self.model,
            language=self.language,
            prompt=self.initial_prompt,
            keywords=self.keywords,
            delay=self.delay,
        )

    def transcribe_file(self, path: str) -> Transcript:
        """One-shot transcription. Block until the `completed` event arrives."""
        return asyncio.run(self._transcribe_file_async(path))

    async def _transcribe_file_async(self, path: str) -> Transcript:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            n_channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            pcm = w.readframes(w.getnframes())

        if sampwidth != 2 or n_channels != 1:
            raise ValueError(
                f"expected 16-bit mono PCM, got sampwidth={sampwidth} channels={n_channels}"
            )

        pcm = self._resample_pcm16(pcm, sr, TARGET_RATE)

        async with websockets.connect(
            WS_URL, additional_headers=self._auth_headers()
        ) as ws:
            await ws.send(json.dumps(self._session_payload()))

            chunk_samples = TARGET_RATE // 10  # 100ms
            chunk_bytes = chunk_samples * 2
            for i in range(0, len(pcm), chunk_bytes):
                buf = pcm[i : i + chunk_bytes]
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(buf).decode("ascii"),
                }))
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

            transcript = ""
            async for raw in ws:
                event = json.loads(raw)
                etype = event.get("type", "")
                if etype.endswith("transcription.completed"):
                    transcript = event.get("transcript", "").strip()
                    break
                if etype == "error":
                    raise RuntimeError(f"OpenAI Realtime error: {event}")

        return Transcript(text=transcript, is_final=True)

    async def stream(
        self, audio_chunks: AsyncIterator[bytes], sample_rate: int = 16000
    ) -> AsyncIterator[Transcript]:
        """Live streaming. Silero VAD on the input chunks decides utterance
        boundaries; we send `input_audio_buffer.commit` on each speech-end
        to fire the `transcription.completed` event.

        Yields:
          * Transcript(is_final=False) for each incremental delta
            (build-up captioning shown to the user mid-utterance)
          * Transcript(is_final=True) for each completed utterance
            (this is what triggers translation downstream). Complete
            sentences inside a still-running utterance are emitted as
            early finals via _SentenceSplitter, so translation of fast,
            pause-free speech doesn't wait for VAD speech-end or the
            max_speech_sec force-flush.
        """
        max_samples = int(self.max_speech_sec * sample_rate)
        vad_iter = VADIterator(
            self._vad(),
            threshold=0.5,
            sampling_rate=sample_rate,
            min_silence_duration_ms=300,
            speech_pad_ms=30,
        )

        out_queue: asyncio.Queue = asyncio.Queue()
        END = object()  # sentinel — sender finished

        async with websockets.connect(
            WS_URL, additional_headers=self._auth_headers()
        ) as ws:
            await ws.send(json.dumps(self._session_payload()))

            async def reader():
                """Consume WS events, push Transcripts into out_queue."""
                splitter = _SentenceSplitter(self.language, self.segmentation)
                try:
                    async for raw in ws:
                        event = json.loads(raw)
                        etype = event.get("type", "")
                        if etype.endswith("transcription.delta"):
                            for t in splitter.on_delta(
                                event.get("item_id", ""), event.get("delta", "")
                            ):
                                await out_queue.put(t)
                        elif etype.endswith("transcription.completed"):
                            t = splitter.on_completed(
                                event.get("item_id", ""),
                                event.get("transcript", ""),
                            )
                            if t:
                                await out_queue.put(t)
                        elif etype == "error":
                            await out_queue.put(RuntimeError(
                                f"OpenAI Realtime: {event.get('error', event)}"
                            ))
                            return
                except (websockets.ConnectionClosed, asyncio.CancelledError):
                    pass

            async def sender():
                """Forward audio to OpenAI; commit on VAD speech-end."""
                leftover = b""
                in_speech = False
                speech_samples_in_utterance = 0
                speech_started_buffered = False

                try:
                    async for chunk in audio_chunks:
                        # forward to OpenAI (resampled)
                        if chunk:
                            up = self._resample_pcm16(chunk, sample_rate, TARGET_RATE)
                            await ws.send(json.dumps({
                                "type": "input_audio_buffer.append",
                                "audio": base64.b64encode(up).decode("ascii"),
                            }))

                        # run silero VAD on the original 16kHz chunk
                        leftover += chunk
                        while len(leftover) >= WINDOW_SAMPLES * 2:
                            window_bytes = leftover[: WINDOW_SAMPLES * 2]
                            leftover = leftover[WINDOW_SAMPLES * 2 :]
                            window = (
                                np.frombuffer(window_bytes, dtype=np.int16)
                                .astype(np.float32) / 32768.0
                            )

                            if in_speech:
                                speech_samples_in_utterance += WINDOW_SAMPLES

                            event = vad_iter(
                                torch.from_numpy(window), return_seconds=True
                            )

                            if event and "start" in event:
                                in_speech = True
                                speech_started_buffered = True
                                speech_samples_in_utterance = WINDOW_SAMPLES

                            if event and "end" in event and in_speech:
                                # ignore micro-blips (clicks, keyboard taps)
                                dur_sec = speech_samples_in_utterance / sample_rate
                                if dur_sec >= MIN_SPEECH_SEC and speech_started_buffered:
                                    await ws.send(json.dumps({
                                        "type": "input_audio_buffer.commit"
                                    }))
                                in_speech = False
                                speech_started_buffered = False
                                speech_samples_in_utterance = 0

                            # force-flush on overly long continuous speech
                            if in_speech and speech_samples_in_utterance >= max_samples:
                                await ws.send(json.dumps({
                                    "type": "input_audio_buffer.commit"
                                }))
                                # restart counting; we stay in_speech because
                                # VAD hasn't said end — model gets a new item
                                # for the next chunk of continuous speech
                                speech_samples_in_utterance = 0

                    # end of audio: commit any pending utterance
                    if in_speech and speech_started_buffered:
                        dur_sec = speech_samples_in_utterance / sample_rate
                        if dur_sec >= MIN_SPEECH_SEC:
                            await ws.send(json.dumps({
                                "type": "input_audio_buffer.commit"
                            }))
                except Exception as e:  # noqa: BLE001
                    await out_queue.put(RuntimeError(f"sender failed: {e}"))
                finally:
                    # give reader a moment to drain final transcription events
                    await asyncio.sleep(2.0)
                    await out_queue.put(END)

            reader_task = asyncio.create_task(reader())
            sender_task = asyncio.create_task(sender())

            try:
                while True:
                    item = await out_queue.get()
                    if item is END:
                        break
                    if isinstance(item, Exception):
                        raise item
                    yield item
            finally:
                sender_task.cancel()
                reader_task.cancel()
                for t in (sender_task, reader_task):
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):
                        pass


# Import compatibility for older dev scripts. The production factory below
# resolves to OpenAILiveTranscribeSTT, while explicit imports of the old class
# name continue to work during a rollback window.
OpenAIRealtimeWhisperSTT = OpenAILiveTranscribeSTT
