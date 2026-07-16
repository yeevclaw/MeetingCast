"""OpenAI Realtime Whisper STT backend.

Uses `gpt-realtime-whisper` — OpenAI's true-streaming STT model. Its
deltas arrive ~1.3s after a word is spoken (vs ~6s for non-streaming
4o-mini-transcribe, vs end-of-utterance for mlx), so users see the
transcript build up live instead of in chunks.

Tradeoffs vs mlx-whisper:
  * pros: ~1s post-utterance final latency (better than mlx on long
    segments), correct technical vocab (陣雨/鋒面/備雨具 vs mlx's
    真雨/封面/被雨拒), and the streaming UX bonus
  * cons: simplified-Chinese output when language=zh (model rejects the
    `prompt` field that flips simp→繁; other languages unaffected), no
    glossary/term injection (same reason)

The model also rejects `turn_detection`, so we run silero VAD
client-side and send `input_audio_buffer.commit` ourselves when an
utterance ends — that's what fires the `transcription.completed`
event.
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


# OpenAI Realtime requires intent=transcription for STT-only sessions;
# the model is set inside session.update, not via URL query string.
WS_URL = "wss://api.openai.com/v1/realtime?intent=transcription"

MODEL = "gpt-realtime-whisper"
TARGET_RATE = 24000  # OpenAI Realtime requires rate >= 24kHz

WINDOW_SAMPLES = 512  # silero VAD requires 512-sample windows at 16kHz
MIN_SPEECH_SEC = 0.25  # drop sub-syllable VAD opens (clicks/keyboard taps)

SENTENCE_END_CHARS = "。？！?!."
MIN_SEGMENT_CHARS = 6  # don't early-emit tiny sentences; they ride along with the next one


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
    """Per-item delta accumulation with punctuation-aware early finals.

    Translation downstream only fires on is_final transcripts, which
    normally arrive at VAD speech-end or the max_speech_sec force-flush —
    up to 15s into fast, pause-free speech. Deltas lag the audio by only
    ~1.3s, so once the running delta text contains a complete sentence we
    emit it as a synthetic final immediately and keep only the unfinished
    tail as the interim. `transcription.completed` then emits whatever
    part of the item wasn't already emitted early.
    """

    def __init__(self):
        self._partials: dict[str, str] = {}  # full delta accumulation per item_id
        self._emitted: dict[str, str] = {}  # prefix already emitted as early finals

    def on_delta(self, iid: str, delta: str) -> list[Transcript]:
        self._partials[iid] = self._partials.get(iid, "") + delta
        if not delta:
            return []
        done = self._emitted.get(iid, "")
        pending = self._partials[iid][len(done):]
        sentence, tail = split_complete_sentences(pending)
        out: list[Transcript] = []
        if sentence:
            # offsets track the raw (unstripped) text; strip only for display
            self._emitted[iid] = done + sentence
            if sentence.strip():
                out.append(Transcript(text=sentence.strip(), is_final=True))
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
        return Transcript(text=remainder, is_final=True)


class OpenAIRealtimeWhisperSTT:
    def __init__(
        self,
        language: str = "zh",
        model: str | None = None,
        max_speech_sec: float = 15.0,
        # initial_prompt is accepted but ignored — gpt-realtime-whisper
        # rejects the prompt field. Kept in the signature so callers
        # built around mlx can pass it without changes.
        initial_prompt: str | None = None,
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
        # gpt-realtime-whisper rejects both `prompt` and `turn_detection`.
        # Keep the payload minimal — model + language + audio format only.
        return {
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": TARGET_RATE},
                        "transcription": {
                            "model": self.model,
                            "language": self.language,
                        },
                    },
                },
            },
        }

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
                splitter = _SentenceSplitter()
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
