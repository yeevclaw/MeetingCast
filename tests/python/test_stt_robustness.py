"""Unit tests for the STT robustness work: hallucination coverage rule,
Gate-3 segment rule + joiner, forced-cut picker, pre-roll / stop flush in the
local stream, zh script prompt, cache-first model check, level metering and
graceful-stop pump, mic stall detection, and the cloud backend's reconnect
loop (all with fakes — no model download, no mic, no network, no API spend).

stdlib unittest (pytest isn't installed in prototype/.venv). Run (cwd =
prototype/):

    .venv/bin/python -m unittest discover -s ../tests/python
"""
import asyncio
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "prototype"))

import numpy as np  # noqa: E402

import audio_capture  # noqa: E402
import audio_pump  # noqa: E402
import stt.local as local  # noqa: E402
import stt.openai_realtime as rt  # noqa: E402
import stt.vad_tools as vad_tools  # noqa: E402
from stt.lang_resources import hallucination_blocklist  # noqa: E402
from stt.local import (  # noqa: E402
    MLXWhisperSTT,
    _compose_initial_prompt,
    _is_hallucination,
    _is_known_hallucination,
    _segment_drop_reason,
)
from stt.openai_transcription_config import ZH_TW_SCRIPT_PROMPT  # noqa: E402
from stt.vad_tools import pick_cut_index, segment_joiner  # noqa: E402

W = local.WINDOW_SAMPLES


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- item 5 ----
class TestHallucinationCoverage(unittest.TestCase):
    def test_real_sentences_with_markers_are_kept(self):
        for text in (
            "an exodus of customers",
            "Please subscribe to our newsletter",
            "We saw an exodus of engineers last quarter.",
            "謝謝觀看我們今天的產品展示",
            # 6 CJK chars left after 「請訂閱」 — a whole clause, not an outro.
            "請訂閱我們的電子報",
        ):
            with self.subTest(text=text):
                self.assertFalse(_is_known_hallucination(text))
                self.assertFalse(_is_hallucination(text))

    def test_marker_dominated_outputs_are_flagged(self):
        for text in (
            "Exodus",
            "Thanks for watching!",
            "Please subscribe to my channel!",
            "謝謝觀看，下次見",
            "♪ ♪ ♪",
            "Subtitles by the Amara.org community",
            "由 Amara.org 社区提供的字幕",
            "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
        ):
            with self.subTest(text=text):
                self.assertTrue(_is_known_hallucination(text))

    def test_ja_and_vi_outros(self):
        ja = hallucination_blocklist("ja")
        vi = hallucination_blocklist("vi")
        self.assertTrue(_is_known_hallucination("ご視聴ありがとうございました", ja))
        self.assertTrue(_is_known_hallucination("Hãy đăng ký kênh nhé", vi))
        self.assertFalse(
            _is_known_hallucination("チャンネル登録の手順について来週詳しく説明します", ja)
        )

    def test_zh_prompt_echo_is_flagged_for_zh_only(self):
        zh = MLXWhisperSTT(language="zh")
        self.assertTrue(_is_known_hallucination(ZH_TW_SCRIPT_PROMPT, zh._blocklist))
        self.assertFalse(
            _is_known_hallucination("以下為繁體中文的會議內容摘要，第一點是預算", zh._blocklist)
        )


# ---------------------------------------------------------------- item 6 ----
class TestSegmentRule(unittest.TestCase):
    def test_drop_reason(self):
        self.assertEqual(_segment_drop_reason(0.9, -1.5, 1.2), "no_speech")
        self.assertIsNone(_segment_drop_reason(0.9, -0.5, 1.2))
        self.assertIsNone(_segment_drop_reason(0.1, -1.5, 1.2))
        self.assertEqual(_segment_drop_reason(0.1, -0.2, 3.0), "compression")
        self.assertIsNone(_segment_drop_reason(0.1, -0.2, 1.2))

    def test_joiner_registry_and_fallback_agree(self):
        for code, sep in (("zh", ""), ("ja", ""), ("en", " "), ("vi", " "), ("zh-TW", "")):
            with self.subTest(code=code):
                self.assertEqual(segment_joiner(code), sep)
        with mock.patch.object(vad_tools, "_registry_cache", {}):
            for code, sep in (("zh", ""), ("ja", ""), ("en", " "), ("vi", " ")):
                self.assertEqual(segment_joiner(code), sep)

    def _run(self, language, texts):
        stt = MLXWhisperSTT(language=language)
        segs = [{"text": t, "no_speech_prob": 0.1, "avg_logprob": -0.3,
                 "compression_ratio": 1.2} for t in texts]
        fake = lambda *_a, **_k: {"segments": segs, "text": ""}  # noqa: E731
        with mock.patch.object(local.mlx_whisper, "transcribe", fake):
            return stt._transcribe_audio(np.full(1000, 0.1, dtype=np.float32))

    def test_cjk_segments_joined_without_spaces(self):
        self.assertEqual(self._run("zh", [" 今天開會", " 討論預算"]), "今天開會討論預算")
        self.assertEqual(self._run("ja", ["本日は", "予算です"]), "本日は予算です")

    def test_spaced_segments_joined_with_space(self):
        self.assertEqual(self._run("en", [" Hello team.", " Let's start."]),
                         "Hello team. Let's start.")


# ---------------------------------------------------------------- item 7 ----
class TestPickCutIndex(unittest.TestCase):
    def test_picks_lowest_prob_in_lookback(self):
        probs = [0.9] * 100
        probs[80] = 0.2
        probs[30] = 0.0  # outside the lookback window → ignored
        self.assertEqual(pick_cut_index(probs, lookback=47), 80)

    def test_rms_breaks_ties_then_latest(self):
        probs = [0.5] * 10
        rms = [0.1] * 10
        rms[6] = 0.01
        self.assertEqual(pick_cut_index(probs, 10, rms), 6)
        self.assertEqual(pick_cut_index(probs, 10), 9)  # all equal → latest

    def test_edge_cases(self):
        self.assertEqual(pick_cut_index([], 5), -1)
        self.assertEqual(pick_cut_index([0.7], 5), 0)
        self.assertEqual(pick_cut_index([0.1, 0.9, 0.8], 0), 2)  # lookback ≥ 1


# ------------------------------------------------- items 7/8/11 local stream
class _FakeVADModel:
    def __init__(self, probs):
        self.probs = probs
        self.i = 0

    def __call__(self, x, sr):
        p = self.probs[self.i] if self.i < len(self.probs) else 0.0
        self.i += 1
        return mock.Mock(item=lambda p=p: p)

    def reset_states(self):
        pass


def _fake_vad_iterator(events):
    """VADIterator stand-in: calls the (probed) model once per window and
    returns the scripted event for that window index."""
    class _It:
        def __init__(self, model, **_kw):
            self.model = model
            self.n = 0

        def __call__(self, x, return_seconds=False):
            self.model(x, 16000)
            ev = events.get(self.n)
            self.n += 1
            return ev
    return _It


async def _pcm_source(n_windows, amplitude=3000, delay=0.0):
    rng = np.random.default_rng(0)
    for _ in range(n_windows):
        if delay:
            await asyncio.sleep(delay)
        yield (rng.standard_normal(W) * amplitude).astype(np.int16).tobytes()


class TestLocalStream(unittest.TestCase):
    def _stream(self, n_windows, probs, events, max_speech_sec=8.0):
        stt = MLXWhisperSTT(language="zh", max_speech_sec=max_speech_sec)
        stt._vad = lambda: _FakeVADModel(probs)
        calls = []

        def fake_transcribe(audio, gate_offset=0):
            calls.append((len(audio) // W, gate_offset // W))
            return f"w{len(audio) // W}"

        stt._transcribe_audio = fake_transcribe

        async def collect():
            return [t async for t in stt.stream(_pcm_source(n_windows))]

        with mock.patch.object(local, "VADIterator", _fake_vad_iterator(events)):
            out = run(collect())
        return out, calls

    def test_forced_cut_at_dip_and_stop_flush(self):
        # 3.2 s cap = 100 windows. Speech from window 0, never ends; a dip at
        # window 80 (inside the 1.5 s lookback) is where the cut must land.
        probs = [0.9] * 130
        probs[80] = 0.1
        out, calls = self._stream(130, probs, {0: {"start": 0.0}}, max_speech_sec=3.2)
        self.assertEqual(out[0].boundary, "forced")
        self.assertEqual(out[0].text, "w81")  # windows 0..80
        # remainder (windows 81..129 = 49 windows ≈ 1.6 s) flushed at end
        self.assertEqual(out[-1].boundary, "pause")
        self.assertEqual(out[-1].text, "w49")
        self.assertAlmostEqual(out[1].t_start, out[0].t_end)

    def test_preroll_prepended_and_excluded_from_gates(self):
        events = {20: {"start": 20 * W / 16000}, 40: {"end": 40 * W / 16000}}
        out, calls = self._stream(60, [0.9] * 60, events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].boundary, "sentence")
        n_pre = round(local.PREROLL_SEC * 16000 / W)
        # buffer = preroll + windows 20..40
        self.assertEqual(calls[0], (n_pre + 21, n_pre))

    def test_preroll_does_not_rescue_a_click(self):
        # 3-window blip (~96 ms) stays under MIN_SPEECH_SEC even with pre-roll.
        events = {20: {"start": 0.0}, 22: {"end": 0.0}}
        out, calls = self._stream(40, [0.9] * 40, events)
        self.assertEqual(out, [])
        self.assertEqual(calls, [])

    def test_short_tail_not_flushed_on_stop(self):
        # 10 windows ≈ 0.32 s of speech at stop: below STOP_FLUSH_MIN_SEC.
        out, calls = self._stream(30, [0.9] * 30, {20: {"start": 0.0}})
        self.assertEqual(out, [])


# --------------------------------------------------------------- item 10 ----
class TestZhScriptPrompt(unittest.TestCase):
    def test_zh_always_gets_carrier(self):
        self.assertEqual(_compose_initial_prompt("zh", None), ZH_TW_SCRIPT_PROMPT)
        self.assertEqual(MLXWhisperSTT(language="zh").initial_prompt, ZH_TW_SCRIPT_PROMPT)

    def test_zh_glossary_prompt_follows_carrier(self):
        g = "本段語音可能包含以下術語：紫微斗數。"
        self.assertEqual(_compose_initial_prompt("zh", g), ZH_TW_SCRIPT_PROMPT + g)

    def test_other_languages_unchanged(self):
        self.assertIsNone(_compose_initial_prompt("en", None))
        self.assertEqual(_compose_initial_prompt("ja", "用語"), "用語")


# ---------------------------------------------------------------- item 9 ----
class TestEnsureLoaded(unittest.TestCase):
    def test_cache_hit_skips_network(self):
        with mock.patch("huggingface_hub.snapshot_download") as sd:
            MLXWhisperSTT().ensure_loaded()
        sd.assert_called_once()
        self.assertTrue(sd.call_args.kwargs.get("local_files_only"))

    def test_cache_miss_falls_back_to_network(self):
        def fake(repo, local_files_only=False):
            if local_files_only:
                raise FileNotFoundError("not cached")
            return "/tmp/x"
        with mock.patch("huggingface_hub.snapshot_download", side_effect=fake) as sd:
            MLXWhisperSTT().ensure_loaded()
        self.assertEqual(sd.call_count, 2)
        self.assertFalse(sd.call_args.kwargs.get("local_files_only", False))


# --------------------------------------------------------- items 4 / 11 -----
class TestLevelMeter(unittest.TestCase):
    def test_reports_rms_every_quarter_second(self):
        m = audio_pump.LevelMeter(16000)
        chunk = (np.full(1600, 0.5) * 32768).astype(np.int16).tobytes()  # 100 ms
        got = [m.feed(chunk) for _ in range(5)]
        self.assertEqual([g is not None for g in got], [False, False, True, False, False])
        self.assertAlmostEqual(got[2], 0.5, places=3)

    def test_clipped_and_silence(self):
        m = audio_pump.LevelMeter(16000, interval_sec=0.1)
        self.assertEqual(m.feed(np.zeros(1600, dtype=np.int16).tobytes()), 0.0)
        loud = np.full(1600, -32768, dtype=np.int16).tobytes()
        self.assertLessEqual(m.feed(loud), 1.0)
        self.assertIsNone(m.feed(b""))


class TestPumpAudio(unittest.TestCase):
    def test_passes_through_and_meters(self):
        async def src():
            for _ in range(10):
                yield np.full(1600, 1000, dtype=np.int16).tobytes()

        async def main():
            levels = []
            stop = asyncio.Event()
            out = [c async for c in audio_pump.pump_audio(src(), stop, levels.append)]
            return out, levels

        out, levels = run(main())
        self.assertEqual(len(out), 10)
        # 1.0 s in 100 ms chunks → a level every 3rd chunk (≥ 250 ms)
        self.assertEqual(len(levels), 3)
        self.assertAlmostEqual(levels[0], 1000 / 32768, places=4)

    def test_stop_ends_a_blocked_source(self):
        closed = []

        async def src():
            try:
                yield b"\x00\x00" * 160
                await asyncio.Event().wait()  # stalled device: never yields again
            finally:
                closed.append(True)

        async def main():
            stop = asyncio.Event()
            got = []

            async def consume():
                async for c in audio_pump.pump_audio(src(), stop):
                    got.append(c)

            task = asyncio.create_task(consume())
            await asyncio.sleep(0.05)
            stop.set()
            await asyncio.wait_for(task, 1.0)
            return got

        self.assertEqual(len(run(main())), 1)
        self.assertEqual(closed, [True])

    def test_source_error_reaches_consumer(self):
        async def src():
            yield b"\x00\x00"
            raise RuntimeError("mic open failed")

        async def main():
            async for _ in audio_pump.pump_audio(src(), asyncio.Event()):
                pass

        with self.assertRaisesRegex(RuntimeError, "mic open failed"):
            run(main())


# ---------------------------------------------------------------- item 3 ----
class _FakeInputStream:
    instances = []
    fail_devices = set()

    def __init__(self, *, callback, device=None, **_kw):
        if device in self.fail_devices:
            raise RuntimeError("device gone")
        self.callback = callback
        self.device = device
        _FakeInputStream.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def start(self):
        self.started = True

    def close(self):
        self.closed = True

    def push(self, n=1600):
        self.callback(np.zeros((n, 1), dtype=np.float32), n, None, None)


class TestMicChunks(unittest.TestCase):
    def setUp(self):
        _FakeInputStream.instances = []
        _FakeInputStream.fail_devices = set()

    def test_stall_and_resume_warnings(self):
        warnings = []

        async def main():
            gen = audio_capture.mic_chunks(on_warning=warnings.append)
            nxt = asyncio.ensure_future(gen.__anext__())
            await asyncio.sleep(0.01)
            stream = _FakeInputStream.instances[0]
            await asyncio.sleep(0.12)  # > patched MIC_STALL_SEC, no frames
            stream.push()
            chunk = await asyncio.wait_for(nxt, 1.0)
            await gen.aclose()
            return chunk

        with mock.patch.object(audio_capture.sd, "InputStream", _FakeInputStream), \
                mock.patch.object(audio_capture, "MIC_STALL_SEC", 0.05):
            chunk = run(main())
        self.assertEqual(len(chunk), 3200)
        self.assertEqual([w["code"] for w in warnings], ["mic_stalled", "mic_resumed"])

    def test_device_fallback_warning(self):
        warnings = []
        _FakeInputStream.fail_devices = {"USB Mic"}

        async def main():
            gen = audio_capture.mic_chunks(device="USB Mic", on_warning=warnings.append)
            nxt = asyncio.ensure_future(gen.__anext__())
            await asyncio.sleep(0.01)
            _FakeInputStream.instances[0].push()
            await asyncio.wait_for(nxt, 1.0)
            await gen.aclose()

        with mock.patch.object(audio_capture.sd, "InputStream", _FakeInputStream), \
                mock.patch.object(audio_capture, "_default_input_name", lambda: "MacBook Mic"):
            run(main())
        self.assertIsNone(_FakeInputStream.instances[0].device)
        self.assertEqual(warnings[0]["code"], "device_fallback")
        self.assertEqual(warnings[0]["device"], "MacBook Mic")

    def test_status_never_printed_to_stdout(self):
        src = (_REPO / "prototype" / "audio_capture.py").read_text(encoding="utf-8")
        for line in src.splitlines():
            if "print(" in line:
                self.assertIn("sys.stderr", line)


class TestRefreshDevices(unittest.TestCase):
    """PortAudio's device list is a snapshot from import time; a sidecar that
    started before mic permission was granted sees no input (-1) forever."""

    def _patch(self, visible):
        calls = []

        def query_devices(kind=None):
            if not visible[0]:
                raise RuntimeError("Error querying device -1")
            return {"name": "Blue Snowball"}

        def terminate():
            calls.append("terminate")

        def initialize():
            calls.append("initialize")
            visible[0] = True

        return calls, mock.patch.multiple(
            audio_capture.sd,
            query_devices=query_devices,
            _terminate=terminate,
            _initialize=initialize,
        )

    def test_reinit_when_no_input_visible(self):
        visible = [False]
        calls, patcher = self._patch(visible)
        with patcher:
            self.assertTrue(audio_capture.refresh_devices_if_no_input())
        self.assertEqual(calls, ["terminate", "initialize"])
        self.assertTrue(visible[0])

    def test_no_reinit_when_input_visible(self):
        calls, patcher = self._patch([True])
        with patcher:
            self.assertFalse(audio_capture.refresh_devices_if_no_input())
        self.assertEqual(calls, [])

    def test_mic_chunks_refreshes_before_open(self):
        visible = [False]
        calls, patcher = self._patch(visible)
        opened_after_refresh = []

        class _Stream(_FakeInputStream):
            def __init__(self, **kw):
                opened_after_refresh.append(visible[0])
                super().__init__(**kw)

        async def main():
            gen = audio_capture.mic_chunks()
            nxt = asyncio.ensure_future(gen.__anext__())
            await asyncio.sleep(0.01)
            _FakeInputStream.instances[-1].push()
            await asyncio.wait_for(nxt, 1.0)
            await gen.aclose()

        with patcher, mock.patch.object(audio_capture.sd, "InputStream", _Stream):
            run(main())
        self.assertEqual(calls, ["terminate", "initialize"])
        self.assertEqual(opened_after_refresh, [True])

    def test_no_reinit_while_a_stream_is_open(self):
        """An unplugged USB mic mid-session also hides every input; tearing
        PortAudio down then would kill the live stream."""
        visible = [True]
        calls, patcher = self._patch(visible)
        with patcher, mock.patch.object(audio_capture.sd, "InputStream", _FakeInputStream):
            with audio_capture.TrackedInputStream(callback=lambda *a: None):
                self.assertEqual(audio_capture._active_streams, 1)
                visible[0] = False
                self.assertFalse(audio_capture.refresh_devices_if_no_input())
            self.assertEqual(audio_capture._active_streams, 0)
            self.assertTrue(audio_capture.refresh_devices_if_no_input())
        self.assertEqual(calls, ["terminate", "initialize"])

    def test_lock_is_free_while_a_stream_opens(self):
        """The open can sit on the macOS permission prompt; device queries on
        other threads must not wait for it — only a re-init is held off (by
        the reserved _active_streams count)."""
        free_during_open = []

        class _Probe(_FakeInputStream):
            def __init__(self, **kw):
                r = []

                def probe():
                    got = audio_capture._PA_LOCK.acquire(blocking=False)
                    if got:
                        audio_capture._PA_LOCK.release()
                    r.append(got)

                t = threading.Thread(target=probe)
                t.start()
                t.join(2)
                free_during_open.append(bool(r and r[0]))
                self.reserved = audio_capture._active_streams
                super().__init__(**kw)

        calls, patcher = self._patch([True])
        with patcher, mock.patch.object(audio_capture.sd, "InputStream", _Probe):
            s = audio_capture.TrackedInputStream(callback=lambda *a: None)
            s.close()
        self.assertEqual(free_during_open, [True])
        self.assertEqual(_FakeInputStream.instances[-1].reserved, 1)
        self.assertEqual(audio_capture._active_streams, 0)

    def test_failed_open_releases_the_reservation(self):
        class _Fail:
            def __init__(self, **kw):
                raise RuntimeError("no device")

        with mock.patch.object(audio_capture.sd, "InputStream", _Fail):
            with self.assertRaises(RuntimeError):
                audio_capture.TrackedInputStream(callback=lambda *a: None)
        self.assertEqual(audio_capture._active_streams, 0)

    def test_mic_chunks_closes_stream_on_stop(self):
        async def main():
            gen = audio_capture.mic_chunks()
            nxt = asyncio.ensure_future(gen.__anext__())
            await asyncio.sleep(0.02)
            _FakeInputStream.instances[-1].push()
            await asyncio.wait_for(nxt, 1.0)
            await gen.aclose()

        with mock.patch.object(audio_capture.sd, "InputStream", _FakeInputStream):
            run(main())
        st = _FakeInputStream.instances[-1]
        self.assertTrue(getattr(st, "started", False))
        self.assertTrue(getattr(st, "closed", False))
        self.assertEqual(audio_capture._active_streams, 0)

    def test_failed_start_releases_the_count(self):
        class _BadStart(_FakeInputStream):
            closed = False

            def __enter__(self):
                raise RuntimeError("start failed")

            def close(self):
                _BadStart.closed = True

        with mock.patch.object(audio_capture.sd, "InputStream", _BadStart):
            with self.assertRaises(RuntimeError):
                with audio_capture.TrackedInputStream(callback=lambda *a: None):
                    pass
        self.assertTrue(_BadStart.closed)
        self.assertEqual(audio_capture._active_streams, 0)

    def test_cancelled_open_closes_the_late_stream(self):
        """Stop pressed while the open waits on the permission prompt: the
        stream that opens afterwards must be closed, not leaked."""
        gate = threading.Event()
        closed = []

        class _Late:
            def close(self):
                closed.append(True)

        def slow_open(_dev):
            gate.wait(2)
            return _Late()

        async def main():
            t = asyncio.ensure_future(audio_capture._open_off_loop(slow_open, None))
            await asyncio.sleep(0.02)
            t.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await t
            gate.set()
            for _ in range(100):
                if closed:
                    break
                await asyncio.sleep(0.01)

        run(main())
        self.assertEqual(closed, [True])


# ------------------------------------------------------------- items 1 / 2 --
class TestServerErrorClassification(unittest.TestCase):
    def test_classes(self):
        c = rt.classify_server_error
        self.assertEqual(c({"type": "invalid_request_error",
                            "code": "input_audio_buffer_commit_empty"}), "ignore")
        self.assertEqual(c({"type": "invalid_request_error", "code": "invalid_api_key"}), "fatal")
        self.assertEqual(c({"code": "insufficient_quota", "message": "quota"}), "fatal")
        self.assertEqual(c({"type": "invalid_request_error", "code": "invalid_value",
                            "param": "session.audio.input.transcription.delay"}), "fatal")
        self.assertEqual(c({"type": "server_error", "message": "oops"}), "reconnect")
        self.assertEqual(c({"code": "session_expired"}), "reconnect")
        self.assertEqual(c({"type": "invalid_request_error", "code": "something_new"}), "ignore")
        self.assertEqual(c("weird"), "ignore")

    def test_retryable(self):
        class _Resp:
            def __init__(self, s):
                self.status_code = s

        class _HS(Exception):
            def __init__(self, s):
                self.response = _Resp(s)

        self.assertTrue(rt.is_retryable_connection_error(OSError("net down")))
        self.assertTrue(rt.is_retryable_connection_error(TimeoutError()))
        self.assertTrue(rt.is_retryable_connection_error(_HS(503)))
        self.assertTrue(rt.is_retryable_connection_error(_HS(429)))
        self.assertFalse(rt.is_retryable_connection_error(_HS(401)))
        self.assertFalse(rt.is_retryable_connection_error(ValueError("bug")))


class TestOutbox(unittest.TestCase):
    def test_bounded_newest_wins_and_drops_orphan_commits(self):
        ob = rt._Outbox(max_audio_bytes=10)
        ob.push_audio(b"aaaa")
        ob.push_commit()
        ob.push_audio(b"bbbb")
        ob.push_audio(b"cccc")  # 12 > 10 → drop "aaaa" and the orphan commit
        self.assertEqual(ob.audio_bytes, 8)
        self.assertEqual([ob.pop() for _ in range(len(ob))],
                         [("audio", b"bbbb"), ("audio", b"cccc")])
        self.assertEqual(ob.dropped_bytes, 4)


    def test_trim_during_inflight_send_keeps_head_and_commit(self):
        ob = rt._Outbox(max_audio_bytes=10)
        ob.push_audio(b"aaaa")
        ob.push_commit()
        inflight = ob.pop()  # writer took "aaaa" and is awaiting ws.send
        self.assertEqual(inflight, ("audio", b"aaaa"))
        ob.push_audio(b"bbbb")
        ob.push_audio(b"cccc")
        ob.push_audio(b"dddd")  # 12 > 10 → trim "bbbb" only
        # The commit for the in-flight audio survives the trim.
        self.assertEqual(list(ob._items),
                         [("commit", None), ("audio", b"cccc"), ("audio", b"dddd")])
        self.assertEqual(ob.audio_bytes, 8)
        # Send failed → requeued at the head; nothing unsent was lost.
        ob.requeue(*inflight)
        self.assertEqual(ob.pop(), ("audio", b"aaaa"))
        self.assertEqual(ob.pop(), ("commit", None))
        self.assertEqual(ob.pop(), ("audio", b"cccc"))
        self.assertEqual(ob.audio_bytes, 4)

    def test_trim_collapses_commits_left_adjacent(self):
        ob = rt._Outbox(max_audio_bytes=8)
        ob.connection_reset()
        ob.push_audio(b"aaaa")
        ob.pop()                 # sent: server holds uncommitted audio
        ob.push_commit()
        ob.push_audio(b"bbbb")
        ob.push_commit()
        ob.push_audio(b"cccc")
        ob.push_audio(b"dddd")   # 12 > 8 → drop "bbbb"; second commit redundant
        self.assertEqual(list(ob._items),
                         [("commit", None), ("audio", b"cccc"), ("audio", b"dddd")])
        ob.connection_reset()    # new socket: a head commit would be empty
        ob.push_audio(b"eeee")   # 12 > 8 → drop "cccc"
        self.assertEqual(list(ob._items), [("audio", b"dddd"), ("audio", b"eeee")])


class TestSplitterFlush(unittest.TestCase):
    def test_flush_all_emits_unfinished_items(self):
        sp = rt._SentenceSplitter("zh")
        sp.on_delta("a", "今天的會議。我們")
        sp.on_delta("b", "下一位")
        out = sp.flush_all()
        self.assertEqual([t.text for t in out], ["我們", "下一位"])
        self.assertTrue(all(t.is_final and t.boundary == "pause" for t in out))
        self.assertEqual(sp.flush_all(), [])


class _FakeWS:
    """Websocket stand-in: answers each commit with a completed event."""

    def __init__(self, transcripts):
        self.sent = []
        self.inbox = asyncio.Queue()
        self.transcripts = list(transcripts)
        self.n_items = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def send(self, msg):
        self.sent.append(json.loads(msg))
        if self.sent[-1]["type"] == "input_audio_buffer.commit":
            self.n_items += 1
            text = self.transcripts.pop(0) if self.transcripts else ""
            await self.inbox.put({
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": f"i{self.n_items}", "transcript": text,
            })

    def __aiter__(self):
        return self

    async def __anext__(self):
        return json.dumps(await self.inbox.get())


class TestCloudReconnect(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test-not-real"})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def _stt(self, warnings):
        stt = rt.OpenAILiveTranscribeSTT(language="zh", on_warning=warnings.append)
        stt._vad = lambda: _FakeVADModel([0.9] * 1000)
        return stt

    def test_initial_failure_then_connect_buffers_audio(self):
        warnings = []
        ws = _FakeWS(["你好世界。"])
        attempts = []

        def fake_connect(*_a, **_kw):
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("network unreachable")
            return ws

        async def main():
            stt = self._stt(warnings)
            events = {0: {"start": 0.0}, 20: {"end": 0.6}}
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator(events)):
                # paced like a live mic so audio is still flowing when the
                # retry connects (a stop during an outage abandons the buffer)
                return [t async for t in stt.stream(_pcm_source(30, delay=0.005))]

        with mock.patch.object(rt.websockets, "connect", fake_connect), \
                mock.patch.object(rt, "RECONNECT_DELAYS", (0.01,)), \
                mock.patch.object(rt, "RECONNECT_STABLE_SEC", 0.02):
            out = run(main())
        self.assertEqual([(t.text, t.is_final) for t in out], [("你好世界。", True)])
        self.assertEqual([w["code"] for w in warnings], ["reconnecting", "reconnected"])
        self.assertEqual(ws.sent[0]["type"], "session.update")
        types = [m["type"] for m in ws.sent[1:]]
        # audio captured before the connection existed was buffered and sent
        self.assertGreater(types.count("input_audio_buffer.append"), 0)
        self.assertEqual(types.count("input_audio_buffer.commit"), 1)

    def test_stage_connected_once_across_reconnects(self):
        """`stt_connected` fires on the first websocket only — a reconnect is
        announced by `reconnected`, never by a second startup stage."""
        stages = []
        attempts = []

        class _ClosingWS(_FakeWS):
            async def __anext__(self):
                raise StopAsyncIteration

        def fake_connect(*_a, **_kw):
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("network unreachable")
            if len(attempts) == 2:
                return _ClosingWS([])
            return _FakeWS(["你好。"])

        async def main():
            stt = rt.OpenAILiveTranscribeSTT(
                language="zh", on_warning=lambda _w: None, on_stage=stages.append
            )
            stt._vad = lambda: _FakeVADModel([0.9] * 1000)
            events = {0: {"start": 0.0}, 40: {"end": 1.2}}
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator(events)):
                return [t async for t in stt.stream(_pcm_source(60, delay=0.005))]

        with mock.patch.object(rt.websockets, "connect", fake_connect), \
                mock.patch.object(rt, "RECONNECT_DELAYS", (0.01,)), \
                mock.patch.object(rt, "RECONNECT_STABLE_SEC", 0.02):
            run(main())
        self.assertGreaterEqual(len(attempts), 3)
        self.assertEqual(stages, ["stt_connected"])

    def test_flapping_link_announces_once_per_outage(self):
        """Connect → drop → connect → drop → stable: one `reconnecting`, and
        one `reconnected` only after the link held RECONNECT_STABLE_SEC."""
        warnings = []
        attempts = []

        class _ClosingWS(_FakeWS):
            async def __anext__(self):
                raise StopAsyncIteration  # server closes right away

        def fake_connect(*_a, **_kw):
            attempts.append(1)
            n = len(attempts)
            if n == 1:
                raise OSError("network unreachable")
            if n in (2, 3):
                return _ClosingWS([])
            return _FakeWS(["你好。"])

        async def main():
            stt = self._stt(warnings)
            events = {0: {"start": 0.0}, 50: {"end": 1.6}}
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator(events)):
                return [t async for t in stt.stream(_pcm_source(70, delay=0.005))]

        with mock.patch.object(rt.websockets, "connect", fake_connect), \
                mock.patch.object(rt, "RECONNECT_DELAYS", (0.01,)), \
                mock.patch.object(rt, "RECONNECT_STABLE_SEC", 0.05):
            run(main())
        self.assertGreaterEqual(len(attempts), 4)
        self.assertEqual([w["code"] for w in warnings], ["reconnecting", "reconnected"])

    def test_short_flap_never_announces_reconnected(self):
        warnings = []
        attempts = []

        class _ClosingWS(_FakeWS):
            async def __anext__(self):
                raise StopAsyncIteration

        def fake_connect(*_a, **_kw):
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError("network unreachable")
            return _ClosingWS([])

        async def main():
            stt = self._stt(warnings)
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator({})):
                async for _ in stt.stream(_pcm_source(40, delay=0.005)):
                    pass

        with mock.patch.object(rt.websockets, "connect", fake_connect), \
                mock.patch.object(rt, "RECONNECT_DELAYS", (0.01,)), \
                mock.patch.object(rt, "RECONNECT_STABLE_SEC", 10.0):
            run(main())
        self.assertGreaterEqual(len(attempts), 3)
        self.assertEqual([w["code"] for w in warnings], ["reconnecting"])

    def test_gives_up_with_user_message(self):
        warnings = []

        def fake_connect(*_a, **_kw):
            raise OSError("network unreachable")

        async def endless():
            while True:
                await asyncio.sleep(0.005)
                yield b"\x00\x00" * W

        async def main():
            stt = self._stt(warnings)
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator({})):
                async for _ in stt.stream(endless()):
                    pass

        with mock.patch.object(rt.websockets, "connect", fake_connect), \
                mock.patch.object(rt, "RECONNECT_DELAYS", (0.01,)), \
                mock.patch.object(rt, "RECONNECT_GIVE_UP_SEC", 0.1):
            with self.assertRaises(rt.RealtimeSTTError) as cm:
                run(main())
        self.assertIn("雲端辨識連線中斷", cm.exception.user_message)
        self.assertEqual([w["code"] for w in warnings], ["reconnecting"])

    def test_auth_rejection_is_fatal_immediately(self):
        class _Resp:
            status_code = 401

        class _Rejected(Exception):
            response = _Resp()

        def fake_connect(*_a, **_kw):
            raise _Rejected("HTTP 401")

        async def main():
            stt = self._stt([])
            with mock.patch.object(rt, "VADIterator", _fake_vad_iterator({})):
                async for _ in stt.stream(_pcm_source(5)):
                    pass

        with mock.patch.object(rt.websockets, "connect", fake_connect):
            with self.assertRaises(rt.RealtimeSTTError) as cm:
                run(main())
        self.assertIn("401", cm.exception.user_message)


# ------------------------------------------------------ stopped.reason ----
sys.path.insert(0, str(_REPO / "python-sidecar"))
import stt_engine  # noqa: E402


class TestStoppedReason(unittest.TestCase):
    def test_stop_reason_table(self):
        r = stt_engine.stop_reason
        self.assertEqual(r(errored=True, stop_requested=True, source_type="mic"), "error")
        self.assertEqual(r(errored=False, stop_requested=True, source_type="wav"), "requested")
        self.assertEqual(r(errored=False, stop_requested=False, source_type="wav"), "source_ended")
        self.assertEqual(r(errored=False, stop_requested=False, source_type="mic"), "error")

    def _run(self, session, source="wav", stop=False, cancel_after=None):
        emitted = []

        async def main():
            cancel_event, stop_event = asyncio.Event(), asyncio.Event()
            if stop:
                stop_event.set()
            cmd = {"type": "start", "source": {"type": source}}
            with mock.patch.object(stt_engine, "_run_stt_session", session), \
                    mock.patch.object(stt_engine, "emit", emitted.append):
                task = asyncio.create_task(stt_engine.run_stt(cmd, cancel_event, stop_event))
                if cancel_after is not None:
                    await asyncio.sleep(cancel_after)
                    stop_event.set()
                    task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        run(main())
        stopped = [e for e in emitted if e["type"] == "stopped"]
        self.assertEqual(len(stopped), 1, emitted)
        return stopped[0]["reason"], emitted

    def test_demo_file_end_is_source_ended(self):
        async def ok(*_a):
            return True
        self.assertEqual(self._run(ok)[0], "source_ended")

    def test_requested_stop(self):
        async def ok(*_a):
            return True
        self.assertEqual(self._run(ok, source="mic", stop=True)[0], "requested")

    def test_error_path(self):
        async def failed(*_a):
            return False
        self.assertEqual(self._run(failed)[0], "error")

    def test_unexpected_exception_is_error_and_reported(self):
        async def boom(*_a):
            raise RuntimeError("bug")
        reason, emitted = self._run(boom)
        self.assertEqual(reason, "error")
        self.assertEqual(emitted[0]["type"], "error")
        self.assertEqual(emitted[-1]["type"], "stopped")

    def test_hard_cancel_after_stop_is_requested(self):
        async def hang(*_a):
            await asyncio.sleep(10)
        self.assertEqual(self._run(hang, source="mic", cancel_after=0.01)[0], "requested")



class TestStartupStages(unittest.TestCase):
    def test_mic_ready_once_on_first_chunk_and_inner_closed(self):
        emitted = []
        closed = []

        async def source():
            try:
                for _ in range(3):
                    yield b"\x00\x00"
            finally:
                closed.append(True)

        async def main():
            gen = stt_engine._announce_first_chunk(source())
            first = await gen.__anext__()
            self.assertEqual(emitted, [{"type": "stage", "stage": "mic_ready"}])
            await gen.__anext__()
            await gen.aclose()
            return first

        with mock.patch.object(stt_engine, "emit", emitted.append):
            first = run(main())
        self.assertEqual(first, b"\x00\x00")
        self.assertEqual(len(emitted), 1)
        self.assertEqual(closed, [True])

    def test_list_devices_never_blocks_the_command_loop(self):
        """A device query stuck behind the permission prompt must not hold
        up `start` / `stop`: it runs as its own task on a worker thread."""
        gate = threading.Event()
        emitted = []

        def slow_list():
            gate.wait(2)
            return [{"name": "Mic", "channels": 1}]

        async def main():
            with mock.patch.object(stt_engine, "list_input_devices", slow_list), \
                    mock.patch.object(stt_engine, "emit", emitted.append):
                t = asyncio.create_task(stt_engine._reply_devices())
                await asyncio.sleep(0.02)
                # the loop is free while the query is blocked
                self.assertFalse(t.done())
                gate.set()
                await asyncio.wait_for(t, 2)

        run(main())
        self.assertEqual(emitted, [{"type": "devices", "devices": [{"name": "Mic", "channels": 1}]}])


if __name__ == "__main__":
    unittest.main()
