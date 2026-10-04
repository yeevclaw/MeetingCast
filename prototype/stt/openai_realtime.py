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
import contextlib
import json
import os
import sys
import wave
from collections import deque
from collections.abc import Callable
from typing import AsyncIterator

import numpy as np
import torch
import websockets
from silero_vad import VADIterator, load_silero_vad

from .base import Transcript
from .vad_tools import ProbTap
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

# ---- Connection resilience --------------------------------------------------
# Backoff between reconnect attempts (the last value repeats). The outage is
# abandoned once it has lasted RECONNECT_GIVE_UP_SEC in total.
RECONNECT_DELAYS = (0.5, 1.0, 2.0, 4.0, 8.0)
RECONNECT_GIVE_UP_SEC = 60.0
# A connection that stayed up at least this long counts as healthy and resets
# the outage clock; one that drops sooner (connect → immediate close loop)
# keeps accumulating toward the give-up limit.
HEALTHY_CONNECTION_SEC = 5.0
# `reconnected` is only announced once a new connection has stayed up this
# long, so a flapping link yields one `reconnecting` + one `reconnected` per
# outage instead of a toast pair per flap.
RECONNECT_STABLE_SEC = 5.0
CONNECT_TIMEOUT_SEC = 10.0
# Audio captured while disconnected (and during the first handshake) is kept,
# newest-wins, up to this much and sent once the session is (re)established.
OUTAGE_BUFFER_SEC = 10.0
# After the audio source ends (stop / end of file): how long to wait for the
# transcriptions of already-committed utterances before giving up.
DRAIN_TIMEOUT_SEC = 2.0

# Forced commit of over-long continuous speech: within the last
# FORCED_CUT_LOOKBACK_SEC before max_speech_sec, commit early at the first
# window whose VAD probability dips below this (a breath / word gap) instead
# of hard-cutting at the cap. Audio is streamed live, so the cut has to be
# decided online rather than by looking back for the minimum.
FORCED_CUT_LOOKBACK_SEC = 1.5
FORCED_CUT_DIP_PROB = 0.35


class RealtimeSTTError(RuntimeError):
    """Unrecoverable cloud-STT failure. `user_message` is 繁體中文 and is
    surfaced as-is in the sidecar's `error` event."""

    def __init__(self, user_message: str, detail: str = ""):
        super().__init__(f"{user_message} {detail}".strip())
        self.user_message = user_message


class _Disconnected(Exception):
    """The session ended (server closed / asked us to reconnect)."""


_IGNORABLE_ERROR_HINTS = (
    "input_audio_buffer_commit_empty",
    "buffer too small",
    "buffer_too_small",
)
_FATAL_ERROR_HINTS = (
    "invalid_api_key",
    "api key",
    "api_key",
    "authentication",
    "unauthorized",
    "insufficient_quota",
    "quota",
    "billing",
    "permission",
    "model_not_found",
    "invalid_model",
)
_RECONNECT_ERROR_HINTS = (
    "server_error",
    "session_expired",
    "rate_limit",
    "overloaded",
)


def classify_server_error(error) -> str:
    """Classify a Realtime `error` event payload.

    Returns:
      "ignore"    — harmless, keep the session (e.g. a commit on an empty
                    buffer after an outage trimmed its audio);
      "fatal"     — retrying can't help (auth, quota, rejected session
                    config): stop and tell the user;
      "reconnect" — transient server-side trouble or an expired session:
                    drop this connection and reconnect.
    Unknown errors are logged and ignored; if the server really is broken
    it will close the socket, which triggers a reconnect anyway."""
    if not isinstance(error, dict):
        error = {"message": str(error)}
    blob = " ".join(
        str(error.get(k) or "") for k in ("code", "type", "message")
    ).lower()
    param = str(error.get("param") or "").lower()
    if any(h in blob for h in _IGNORABLE_ERROR_HINTS):
        return "ignore"
    if any(h in blob for h in _FATAL_ERROR_HINTS):
        return "fatal"
    if param.startswith("session"):
        return "fatal"
    if any(h in blob for h in _RECONNECT_ERROR_HINTS):
        return "reconnect"
    return "ignore"


def _handshake_status(exc: BaseException) -> int | None:
    resp = getattr(exc, "response", None)
    status = getattr(resp, "status_code", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def is_retryable_connection_error(exc: BaseException) -> bool:
    """True for transport-level failures worth a reconnect: network errors,
    timeouts, dropped sockets, 408/429/5xx handshakes. 4xx handshakes (bad
    key, no access) are not."""
    status = _handshake_status(exc)
    if status is not None:
        return status in (408, 429) or status >= 500
    return isinstance(
        exc,
        (
            _Disconnected,
            websockets.ConnectionClosed,
            websockets.exceptions.WebSocketException,
            OSError,
            TimeoutError,
        ),
    )


class _Outbox:
    """Ordered queue of messages waiting to go out on the websocket:
    ("audio", pcm24k_bytes) and ("commit", None). Bounded to
    `max_audio_bytes` of audio, newest-wins: when an outage overflows it the
    oldest queued audio is dropped.

    The writer `pop()`s an item BEFORE sending it and `requeue()`s it on a
    failed send, so a trim running while a send is in flight can never drop
    the in-flight item (and a later pop can never remove an unsent one —
    the old peek/send/pop order could lose a commit that way).

    Commits are only dropped when they became redundant: a commit at the head
    with no audio sent to the server since the last commit (it would only
    produce `input_audio_buffer_commit_empty`), or a commit directly after
    another commit once the audio between them was trimmed. A commit whose
    utterance already has audio on the server is kept."""

    def __init__(self, max_audio_bytes: int):
        self.max_audio_bytes = max_audio_bytes
        self.audio_bytes = 0
        self.dropped_bytes = 0
        self._items: deque[tuple[str, bytes | None]] = deque()
        self.event = asyncio.Event()
        # Audio handed to the socket (in flight or sent) since the last
        # commit on the current connection — a head commit then still has
        # something to commit.
        self.server_has_audio = False

    def __len__(self) -> int:
        return len(self._items)

    def push_audio(self, pcm: bytes) -> None:
        if not pcm:
            return
        self._items.append(("audio", pcm))
        self.audio_bytes += len(pcm)
        if self.audio_bytes > self.max_audio_bytes:
            self._trim()
        self.event.set()

    def _trim(self) -> None:
        items = list(self._items)
        i = 0
        while self.audio_bytes > self.max_audio_bytes and i < len(items):
            kind, payload = items[i]
            if kind == "audio":
                self.audio_bytes -= len(payload)
                self.dropped_bytes += len(payload)
                items[i] = None
            i += 1
        kept: deque[tuple[str, bytes | None]] = deque()
        # A head commit is redundant unless the server holds uncommitted audio.
        prev = "audio" if self.server_has_audio else "commit"
        for item in items:
            if item is None:
                continue
            if item[0] == "commit" and prev == "commit":
                continue
            kept.append(item)
            prev = item[0]
        self._items = kept

    def push_commit(self) -> None:
        self._items.append(("commit", None))
        self.event.set()

    def pop(self) -> tuple[str, bytes | None]:
        """Take the head item for sending (it leaves the queue now)."""
        kind, payload = self._items.popleft()
        if kind == "audio":
            self.audio_bytes -= len(payload)
            self.server_has_audio = True
        else:
            self.server_has_audio = False
        return kind, payload

    def requeue(self, kind: str, payload: bytes | None) -> None:
        """Put back an item whose send failed, at the head, for the next
        connection."""
        self._items.appendleft((kind, payload))
        if kind == "audio":
            self.audio_bytes += len(payload)

    def connection_reset(self) -> None:
        """A new connection starts with an empty server-side buffer."""
        self.server_has_audio = False

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

    def flush_item(self, iid: str) -> Transcript | None:
        """Close an item that will never complete (transcription failed, or
        its connection dropped): emit the not-yet-emitted part of the delta
        text accumulated so far as a final, so text the user already saw as
        an interim isn't lost."""
        done = self._emitted.pop(iid, "")
        accumulated = self._partials.pop(iid, "")
        remainder = accumulated[len(done):].strip()
        if not remainder:
            return None
        return Transcript(
            text=remainder, is_final=True, boundary=_closing_boundary(remainder)
        )

    def flush_all(self) -> list[Transcript]:
        """flush_item for every open item, in arrival order."""
        out: list[Transcript] = []
        for iid in list(self._partials):
            t = self.flush_item(iid)
            if t:
                out.append(t)
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
        on_warning: Callable[[dict], None] | None = None,
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
        # Sink for structured warnings ({code, message}); the sidecar turns
        # them into `warning` events. None (CLI) → stderr.
        self._on_warning = on_warning
        self._vad_model = None

    def _vad(self):
        if self._vad_model is None:
            self._vad_model = load_silero_vad()
        return self._vad_model

    def _warn(self, code: str, message: str) -> None:
        if self._on_warning is not None:
            try:
                self._on_warning({"code": code, "message": message})
                return
            except Exception:  # noqa: BLE001
                pass
        print(f"[openai {code}] {message}", file=sys.stderr, flush=True)

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

        Structure: the audio loop (VAD + outbox) runs independently of the
        websocket, starting before the handshake, so speech during connect
        or an outage is buffered (last OUTAGE_BUFFER_SEC) instead of lost.
        The connection loop (re)connects with exponential backoff, resends
        session.update, drains the outbox and reads events; it reports
        `reconnecting` / `reconnected` warnings and raises RealtimeSTTError
        after RECONNECT_GIVE_UP_SEC of continuous outage. When the audio
        source ends, pending commits get up to DRAIN_TIMEOUT_SEC to complete.
        """
        loop = asyncio.get_running_loop()
        max_samples = int(self.max_speech_sec * sample_rate)
        dip_from = max(0, max_samples - int(FORCED_CUT_LOOKBACK_SEC * sample_rate))
        probe = ProbTap(self._vad())
        vad_iter = VADIterator(
            probe,
            threshold=0.5,
            sampling_rate=sample_rate,
            min_silence_duration_ms=300,
            speech_pad_ms=30,
        )

        out_queue: asyncio.Queue = asyncio.Queue()
        END = object()  # sentinel — stream finished
        splitter = _SentenceSplitter(self.language, self.segmentation)
        outbox = _Outbox(max_audio_bytes=int(OUTAGE_BUFFER_SEC * TARGET_RATE * 2))
        audio_done = asyncio.Event()
        commits_idle = asyncio.Event()
        commits_idle.set()
        state = {"pending_commits": 0, "audio_done_at": 0.0}

        def commit_sent():
            state["pending_commits"] += 1
            commits_idle.clear()

        def commit_finished():
            state["pending_commits"] = max(0, state["pending_commits"] - 1)
            if state["pending_commits"] == 0:
                commits_idle.set()

        def commits_lost():
            state["pending_commits"] = 0
            commits_idle.set()

        async def audio_loop():
            """Consume the audio source: queue resampled audio + VAD commits."""
            leftover = b""
            in_speech = False
            utt_samples = 0
            try:
                async for chunk in audio_chunks:
                    if chunk:
                        outbox.push_audio(
                            self._resample_pcm16(chunk, sample_rate, TARGET_RATE)
                        )
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
                            utt_samples += WINDOW_SAMPLES
                        event = vad_iter(torch.from_numpy(window), return_seconds=True)
                        prob = probe.last

                        if event and "start" in event:
                            in_speech = True
                            utt_samples = WINDOW_SAMPLES

                        if event and "end" in event and in_speech:
                            # ignore micro-blips (clicks, keyboard taps)
                            if utt_samples / sample_rate >= MIN_SPEECH_SEC:
                                outbox.push_commit()
                            in_speech = False
                            utt_samples = 0
                        elif in_speech and (
                            utt_samples >= max_samples
                            or (utt_samples >= dip_from and prob < FORCED_CUT_DIP_PROB)
                        ):
                            # Over-long continuous speech: commit at a dip in
                            # the last FORCED_CUT_LOOKBACK_SEC, or hard at the
                            # cap. We stay in_speech (VAD hasn't said end) —
                            # the model gets a new item for what follows.
                            outbox.push_commit()
                            utt_samples = 0

                # end of audio: commit any pending utterance
                if in_speech and utt_samples / sample_rate >= MIN_SPEECH_SEC:
                    outbox.push_commit()
            except Exception as e:  # noqa: BLE001
                await out_queue.put(RuntimeError(f"audio input failed: {e}"))
            finally:
                state["audio_done_at"] = loop.time()
                audio_done.set()
                outbox.event.set()

        async def reader(ws):
            """Consume WS events, push Transcripts into out_queue."""
            async for raw in ws:
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                etype = event.get("type", "")
                if etype.endswith("transcription.delta"):
                    for t in splitter.on_delta(
                        event.get("item_id", ""), event.get("delta", "")
                    ):
                        await out_queue.put(t)
                elif etype.endswith("transcription.completed"):
                    commit_finished()
                    t = splitter.on_completed(
                        event.get("item_id", ""), event.get("transcript", "")
                    )
                    if t:
                        await out_queue.put(t)
                elif etype.endswith("transcription.failed"):
                    commit_finished()
                    t = splitter.flush_item(event.get("item_id", ""))
                    if t:
                        await out_queue.put(t)
                elif etype == "error":
                    err = event.get("error", event)
                    kind = classify_server_error(err)
                    msg = err.get("message") if isinstance(err, dict) else str(err)
                    if kind == "fatal":
                        raise RealtimeSTTError(f"OpenAI 雲端辨識錯誤：{msg}", detail=str(err))
                    if kind == "reconnect":
                        raise _Disconnected(f"server error: {err}")
                    if "commit" in json.dumps(err).lower():
                        commit_finished()
                    print(f"[openai realtime] ignored error: {err}", file=sys.stderr, flush=True)
            # iteration ends when the server closes the socket cleanly

        async def writer(ws):
            """Drain the outbox to the socket. Returns once the audio source
            has ended and everything was sent. Each item is popped before its
            send (so a concurrent trim can't touch it) and requeued at the
            head if the send fails, so a drop keeps it for the next session."""
            while True:
                while len(outbox):
                    kind, payload = outbox.pop()
                    if kind == "audio":
                        msg = json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(payload).decode("ascii"),
                        })
                    else:
                        msg = json.dumps({"type": "input_audio_buffer.commit"})
                    try:
                        await ws.send(msg)
                    except BaseException:
                        outbox.requeue(kind, payload)
                        raise
                    if kind == "commit":
                        commit_sent()
                if audio_done.is_set():
                    return
                outbox.event.clear()
                if len(outbox):
                    continue
                await outbox.event.wait()

        async def run_session(ws):
            reader_t = asyncio.create_task(reader(ws))
            writer_t = asyncio.create_task(writer(ws))
            try:
                done, _ = await asyncio.wait(
                    {reader_t, writer_t}, return_when=asyncio.FIRST_COMPLETED
                )
                if reader_t in done:
                    reader_t.result()  # fatal / reconnect errors propagate
                    raise _Disconnected("server closed the connection")
                writer_t.result()  # a failed send propagates (ConnectionClosed)
                # Audio finished and fully sent: give in-flight utterances a
                # bounded moment to come back.
                remaining = state["audio_done_at"] + DRAIN_TIMEOUT_SEC - loop.time()
                if remaining > 0 and not commits_idle.is_set():
                    idle_t = asyncio.create_task(commits_idle.wait())
                    try:
                        done, _ = await asyncio.wait(
                            {reader_t, idle_t},
                            timeout=remaining,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        idle_t.cancel()
                    if reader_t in done:
                        try:
                            reader_t.result()
                        except RealtimeSTTError:
                            raise
                        except Exception:  # noqa: BLE001 — stopping anyway
                            pass
            finally:
                for t in (reader_t, writer_t):
                    t.cancel()
                for t in (reader_t, writer_t):
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await t

        # `announced`: a `reconnecting` went out and its `reconnected` has
        # not — shared with the stability timer below.
        conn_state = {"announced": False}

        async def confirm_reconnected():
            """Announce recovery only after the link held RECONNECT_STABLE_SEC;
            cancelled if it drops first (the outage — and its single
            `reconnecting` — continues)."""
            await asyncio.sleep(RECONNECT_STABLE_SEC)
            if conn_state["announced"]:
                conn_state["announced"] = False
                self._warn("reconnected", "雲端辨識已重新連線")

        async def connection_loop():
            delays = iter(RECONNECT_DELAYS)
            outage_since: float | None = None
            ever_connected = False
            while True:
                # Audio already over: stopped while disconnected (the buffered
                # audio is abandoned), or before anything was captured.
                if audio_done.is_set() and (
                    ever_connected or outage_since is not None or not len(outbox)
                ):
                    return
                connected_at: float | None = None
                confirm_t: asyncio.Task | None = None
                try:
                    async with websockets.connect(
                        WS_URL,
                        additional_headers=self._auth_headers(),
                        open_timeout=CONNECT_TIMEOUT_SEC,
                    ) as ws:
                        await ws.send(json.dumps(self._session_payload()))
                        connected_at = loop.time()
                        ever_connected = True
                        outbox.connection_reset()
                        if conn_state["announced"]:
                            confirm_t = asyncio.create_task(confirm_reconnected())
                        await run_session(ws)
                        return
                except (RealtimeSTTError, asyncio.CancelledError):
                    raise
                except Exception as e:  # noqa: BLE001
                    if not is_retryable_connection_error(e):
                        status = _handshake_status(e)
                        if status is not None:
                            raise RealtimeSTTError(
                                f"OpenAI 雲端辨識連線被拒（HTTP {status}），"
                                "請確認 OpenAI API key 是否正確、帳戶是否有額度",
                                detail=repr(e),
                            ) from e
                        raise
                    print(f"[openai realtime] connection lost: {e!r}", file=sys.stderr, flush=True)
                finally:
                    if confirm_t is not None:
                        confirm_t.cancel()

                # Disconnected (or failed to connect). Close open items so
                # their interim text isn't lost; their commits never return.
                for t in splitter.flush_all():
                    await out_queue.put(t)
                commits_lost()
                if audio_done.is_set():
                    return
                now = loop.time()
                if connected_at is not None and now - connected_at >= HEALTHY_CONNECTION_SEC:
                    outage_since = None
                    delays = iter(RECONNECT_DELAYS)
                if outage_since is None:
                    outage_since = now
                if now - outage_since >= RECONNECT_GIVE_UP_SEC:
                    raise RealtimeSTTError(
                        f"雲端辨識連線中斷超過 {RECONNECT_GIVE_UP_SEC:.0f} 秒，已停止辨識。"
                        "請檢查網路後重新開始錄音。"
                    )
                if not conn_state["announced"]:
                    self._warn(
                        "reconnecting",
                        "雲端辨識連線中斷，正在重新連線…（錄音持續進行，恢復後補送最近 "
                        f"{OUTAGE_BUFFER_SEC:.0f} 秒）"
                        if ever_connected
                        else "無法連線雲端辨識，正在重試…",
                    )
                    conn_state["announced"] = True
                delay = next(delays, RECONNECT_DELAYS[-1])
                delay = max(0.0, min(delay, outage_since + RECONNECT_GIVE_UP_SEC - now))
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(audio_done.wait(), timeout=delay)

        async def connection_main():
            try:
                await connection_loop()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                for t in splitter.flush_all():
                    await out_queue.put(t)
                await out_queue.put(e)
                return
            for t in splitter.flush_all():
                await out_queue.put(t)
            await out_queue.put(END)

        audio_task = asyncio.create_task(audio_loop())
        conn_task = asyncio.create_task(connection_main())
        try:
            while True:
                item = await out_queue.get()
                if item is END:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            for t in (audio_task, conn_task):
                t.cancel()
            for t in (audio_task, conn_task):
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t


# Import compatibility for older dev scripts. The production factory below
# resolves to OpenAILiveTranscribeSTT, while explicit imports of the old class
# name continue to work during a rollback window.
OpenAIRealtimeWhisperSTT = OpenAILiveTranscribeSTT
