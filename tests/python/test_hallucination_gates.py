"""Unit tests for the deterministic STT hallucination gates and the offline
eval parity checks.

pytest is not installed in prototype/.venv, so these use stdlib unittest to
avoid adding a dependency. Run (cwd = prototype/):

    .venv/bin/python -m unittest discover -s ../tests/python

Covers:
  * prototype/stt/local.py  — known-phrase blocklist, single-char dominance,
    and the per-segment Whisper-confidence filtering (via a monkeypatched
    mlx_whisper.transcribe, since that logic lives inside _transcribe_audio).
  * prototype/eval/checks.py — glossary parity, cjk_ratio boundaries,
    wrong-language heuristic, meta-marker scan, and the expectation runner.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

# Mirror python-sidecar/stt_engine.py: put prototype/ (for the `stt` package)
# and prototype/eval/ (for `checks`) on sys.path so imports resolve regardless
# of cwd.
_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "prototype"))
sys.path.insert(0, str(_REPO / "prototype" / "eval"))

import numpy as np  # noqa: E402

from stt.local import (  # noqa: E402
    HALLUCINATION_MIN_CHARS,
    SEGMENT_AVG_LOGPROB_MIN,
    SEGMENT_COMPRESSION_RATIO_MAX,
    SEGMENT_NO_SPEECH_MAX,
    MLXWhisperSTT,
    _is_hallucination,
    _is_known_hallucination,
)
import stt.local as local  # noqa: E402
from stt.lang_resources import (  # noqa: E402
    HALLUCINATIONS_COMMON,
    HALLUCINATIONS_EN,
    hallucination_blocklist,
)

import checks  # noqa: E402
from checks import (  # noqa: E402
    cjk_ratio,
    glossary_violations,
    is_wrong_language,
    meta_markers_hit,
    run_expectations,
)


class TestKnownHallucinationPhrases(unittest.TestCase):
    def test_english_outro_matches(self):
        self.assertTrue(_is_known_hallucination("Thanks for watching, see you soon"))

    def test_subscribe_ask_matches(self):
        self.assertTrue(_is_known_hallucination("Please subscribe to my channel!"))

    def test_chinese_outro_matches(self):
        self.assertTrue(_is_known_hallucination("感谢观看"))

    def test_music_marker_matches(self):
        self.assertTrue(_is_known_hallucination("♪"))

    def test_normal_text_does_not_match(self):
        self.assertFalse(_is_known_hallucination("我們來討論下一季的預算規劃"))

    def test_empty_does_not_match(self):
        self.assertFalse(_is_known_hallucination("   "))


class TestSingleCharDominance(unittest.TestCase):
    def test_repeated_char_over_min_length_is_hallucination(self):
        self.assertTrue(_is_hallucination("示" * 25))

    def test_repeated_char_below_min_length_is_not(self):
        # 10 chars is under HALLUCINATION_MIN_CHARS (20) — too short to judge
        # by dominance, and it's not a known phrase.
        self.assertEqual(HALLUCINATION_MIN_CHARS, 20)
        self.assertFalse(_is_hallucination("示" * 10))

    def test_varied_long_text_is_not_hallucination(self):
        self.assertFalse(
            _is_hallucination("今天的會議討論了預算行銷與人力這三個主要的議題內容")
        )

    def test_known_phrase_shortcircuits_before_length_check(self):
        # A known phrase is flagged even when far shorter than the min-length
        # dominance guard.
        self.assertTrue(_is_hallucination("♪"))

    def test_whitespace_is_ignored_in_dominance(self):
        # Spaces don't count toward the dominance denominator.
        self.assertTrue(_is_hallucination(" ".join("示" * 25)))


class TestHallucinationBlocklists(unittest.TestCase):
    """Per-language blocklist partitioning (prototype/stt/lang_resources.py)."""

    # The exact KNOWN_HALLUCINATIONS tuple as it stood before the per-language
    # split. The zh effective blocklist must stay item-identical to this set,
    # plus the newly-added "amara.org".
    LEGACY = (
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
        "感谢观看",
        "謝謝觀看",
        "请订阅",
        "請訂閱",
    )

    def test_zh_is_legacy_plus_amara(self):
        # Order changed (COMMON now leads), so compare as sets: item-identical.
        self.assertEqual(
            set(hallucination_blocklist("zh")),
            set(self.LEGACY) | {"amara.org"},
        )

    def test_en_is_common_plus_en_only(self):
        self.assertEqual(
            hallucination_blocklist("en"),
            HALLUCINATIONS_COMMON + HALLUCINATIONS_EN,
        )

    def test_ja_contains_outro_and_english_set(self):
        ja = hallucination_blocklist("ja")
        self.assertIn("ご視聴ありがとう", ja)
        for marker in HALLUCINATIONS_EN:
            self.assertIn(marker, ja)

    def test_ja_blocklist_flags_outro_but_not_normal_sentence(self):
        ja = hallucination_blocklist("ja")
        self.assertTrue(
            _is_known_hallucination("ご視聴ありがとうございました", blocklist=ja)
        )
        self.assertFalse(
            _is_known_hallucination("本日の会議では来期の予算について話し合いました", blocklist=ja)
        )


def _fake_transcribe(segments, text):
    """Build a stand-in for mlx_whisper.transcribe returning a fixed result."""
    def _inner(*_args, **_kwargs):
        return {"segments": segments, "text": text}
    return _inner


class TestSegmentConfidenceFiltering(unittest.TestCase):
    """Exercises Gate 3 in _transcribe_audio: per-segment confidence filtering.
    A short, steady, loud audio buffer clears the RMS floor (gate 1a) and is
    below the 3-chunk threshold for the consistency gate (1b), so control lands
    on the monkeypatched Whisper output."""

    def setUp(self):
        self.stt = MLXWhisperSTT()
        # np.full(1000, 0.1) → RMS 0.1 >> 0.005 floor; 1000 samples < 3*1600 so
        # the consistency gate is skipped.
        self.audio = np.full(1000, 0.1, dtype=np.float32)

    def _run(self, segments, text=""):
        with mock.patch.object(local.mlx_whisper, "transcribe", _fake_transcribe(segments, text)):
            return self.stt._transcribe_audio(self.audio)

    def test_good_segment_is_kept(self):
        seg = {"text": "這是一句正常的會議發言", "no_speech_prob": 0.1,
               "avg_logprob": -0.3, "compression_ratio": 1.2}
        self.assertEqual(self._run([seg]), "這是一句正常的會議發言")

    def test_high_no_speech_dropped(self):
        seg = {"text": "雜訊", "no_speech_prob": SEGMENT_NO_SPEECH_MAX + 0.1,
               "avg_logprob": -0.3, "compression_ratio": 1.2}
        self.assertEqual(self._run([seg]), "")

    def test_low_logprob_dropped(self):
        seg = {"text": "雜訊", "no_speech_prob": 0.1,
               "avg_logprob": SEGMENT_AVG_LOGPROB_MIN - 0.5, "compression_ratio": 1.2}
        self.assertEqual(self._run([seg]), "")

    def test_high_compression_dropped(self):
        seg = {"text": "重複重複", "no_speech_prob": 0.1,
               "avg_logprob": -0.3, "compression_ratio": SEGMENT_COMPRESSION_RATIO_MAX + 1.0}
        self.assertEqual(self._run([seg]), "")

    def test_mixed_keeps_only_confident_segment(self):
        good = {"text": "保留這句", "no_speech_prob": 0.1,
                "avg_logprob": -0.3, "compression_ratio": 1.2}
        bad = {"text": "丟掉這句", "no_speech_prob": 0.95,
               "avg_logprob": -0.3, "compression_ratio": 1.2}
        self.assertEqual(self._run([good, bad]), "保留這句")

    def test_falls_back_to_full_text_when_no_segments(self):
        # Older mlx_whisper without segments → uses result["text"].
        self.assertEqual(self._run([], text="回退到整段文字內容"), "回退到整段文字內容")


class TestGlossaryViolations(unittest.TestCase):
    ENTRY = [{"term": "紫微斗數", "en": "Zi Wei Dou Shu", "vi": "Tử Vi Đẩu Số"}]

    def test_missing_rendering_is_violation(self):
        v = glossary_violations("我們談到紫微斗數", "We talked about astrology", self.ENTRY, "en")
        self.assertEqual(v, ["紫微斗數 → Zi Wei Dou Shu"])

    def test_present_rendering_no_violation(self):
        v = glossary_violations("我們談到紫微斗數", "We talked about Zi Wei Dou Shu", self.ENTRY, "en")
        self.assertEqual(v, [])

    def test_ascii_case_insensitive(self):
        entries = [{"term": "人工智慧", "en": "AI", "vi": ""}]
        v = glossary_violations("這是人工智慧模型", "this is an ai model", entries, "en")
        self.assertEqual(v, [])

    def test_vi_target_uses_vi_field(self):
        miss = glossary_violations("我們談到紫微斗數", "Zi Wei Dou Shu là gì", self.ENTRY, "vi")
        self.assertEqual(miss, ["紫微斗數 → Tử Vi Đẩu Số"])
        ok = glossary_violations("我們談到紫微斗數", "Chúng ta nói về Tử Vi Đẩu Số", self.ENTRY, "vi")
        self.assertEqual(ok, [])

    def test_empty_target_field_skipped(self):
        entries = [{"term": "沒英文", "en": "", "vi": "Có"}]
        self.assertEqual(glossary_violations("這裡沒英文", "some english output", entries, "en"), [])

    def test_term_absent_from_source_skipped(self):
        self.assertEqual(
            glossary_violations("完全無關的句子", "totally unrelated", self.ENTRY, "en"), []
        )


class TestCjkRatio(unittest.TestCase):
    def test_pure_ascii_is_zero(self):
        self.assertEqual(cjk_ratio("hello world 2026"), 0.0)

    def test_pure_cjk_is_one(self):
        self.assertEqual(cjk_ratio("你好嗎"), 1.0)

    def test_half_and_half(self):
        self.assertAlmostEqual(cjk_ratio("你好ab"), 0.5)

    def test_whitespace_excluded(self):
        # Whitespace doesn't count in the denominator.
        self.assertEqual(cjk_ratio("你 好"), 1.0)

    def test_empty_is_zero(self):
        self.assertEqual(cjk_ratio("   "), 0.0)


class TestWrongLanguage(unittest.TestCase):
    def test_pure_chinese_reply_for_en_is_true(self):
        self.assertTrue(is_wrong_language("我無法翻譯這段內容因為它不完整", "en"))

    def test_english_with_proper_noun_is_false(self):
        self.assertFalse(
            is_wrong_language("We discussed the 紫微斗數 project during today's meeting.", "en")
        )

    def test_short_text_below_guard_is_false(self):
        self.assertFalse(is_wrong_language("你好嗎", "en"))

    def test_vietnamese_is_false(self):
        self.assertFalse(is_wrong_language("Chúng tôi đã thảo luận về vấn đề này hôm nay", "vi"))

    def test_zh_target_never_flags(self):
        self.assertFalse(is_wrong_language("整段都是中文的內容不會被判定", "zh"))

    # --- C4 canonical branches per script profile (mirror verify.rs). The
    # philosophy is "never kill a real translation", so the True cases are
    # unambiguously the wrong language and the False cases are legit output.

    def test_en_target_kana_dominant_is_true(self):
        # Model stayed in Japanese for an English slot — latin profile flags
        # (han+kana)/total > 0.5.
        self.assertTrue(is_wrong_language("これは翻訳されていない日本語の文章です", "en"))

    def test_zh_target_english_reply_is_true(self):
        # English reply for a Chinese slot — han profile: latin-dominant with
        # almost no han.
        self.assertTrue(is_wrong_language("This is the full summary of today's meeting.", "zh"))

    def test_zh_target_kana_heavy_is_true(self):
        # Japanese reply for a Chinese slot — han profile: kana/total > 0.3.
        self.assertTrue(is_wrong_language("これは今日の会議のまとめです", "zh"))

    def test_ja_target_english_reply_is_true(self):
        # English reply for a Japanese slot — japanese profile: latin-dominant
        # with < 0.1 han+kana.
        self.assertTrue(is_wrong_language("This is the full English summary of the meeting.", "ja"))

    def test_ja_target_mixed_latin_legit_is_false(self):
        # Legit Japanese carrying English product names must survive — the
        # < 0.1 han+kana clause protects it (here han+kana is ~0.23).
        self.assertFalse(is_wrong_language("MeetingCastとGoogle Slidesを統合します", "ja"))

    def test_ja_target_long_kana_free_han_is_true(self):
        # 20+ chars, zero kana, han-dominant = a Chinese reply for a Japanese
        # slot (a real Japanese sentence of this length always carries kana).
        self.assertTrue(
            is_wrong_language("我们今天在这个会议上讨论了下一季度的预算和市场营销问题", "ja")
        )

    def test_ja_target_short_all_kanji_is_false(self):
        # Below the 20-char Chinese-reply threshold — a short kanji-only
        # fragment is not killed.
        self.assertFalse(is_wrong_language("会議予算議題確認事項報告", "ja"))


class TestMetaMarkers(unittest.TestCase):
    def test_english_meta_hit(self):
        self.assertTrue(meta_markers_hit("I'd be happy to translate that for you"))

    def test_vietnamese_meta_hit(self):
        self.assertTrue(meta_markers_hit("Vui lòng cung cấp câu tiếng Trung"))

    def test_chinese_meta_hit(self):
        self.assertTrue(meta_markers_hit("我無法翻譯這個輸入"))

    def test_normal_translation_miss(self):
        self.assertFalse(meta_markers_hit("The quarterly revenue grew by 20 percent."))

    def test_marker_only_scanned_in_head(self):
        # A marker past META_SCAN_CHARS is not flagged (mirrors the Rust head-only scan).
        prefix = "x" * checks.META_SCAN_CHARS
        self.assertFalse(meta_markers_hit(prefix + " i'd be happy"))


class TestRunExpectations(unittest.TestCase):
    def test_empty_expected_and_empty_passes(self):
        case = {"zh": "示" * 25, "expect": {"empty": True}}
        self.assertEqual(run_expectations(case, "en", ""), [])

    def test_empty_expected_but_nonempty_fails(self):
        case = {"zh": "示" * 25, "expect": {"empty": True}}
        self.assertTrue(run_expectations(case, "en", "some translation"))

    def test_contains_present_passes(self):
        case = {"zh": "我們用 Whisper", "expect": {"contains": {"en": ["Whisper"]}}}
        self.assertEqual(run_expectations(case, "en", "We use Whisper as the model"), [])

    def test_contains_case_insensitive(self):
        case = {"zh": "我們用 Whisper", "expect": {"contains": {"en": ["Whisper"]}}}
        self.assertEqual(run_expectations(case, "en", "we use whisper here"), [])

    def test_contains_missing_fails(self):
        case = {"zh": "我們用 Whisper", "expect": {"contains": {"en": ["Whisper"]}}}
        self.assertTrue(run_expectations(case, "en", "We use another model"))

    def test_not_contains_forbidden_fails(self):
        case = {"zh": "明天開會", "expect": {"not_contains": {"en": ["quantum"]}}}
        self.assertTrue(run_expectations(case, "en", "We discuss quantum computers"))

    def test_max_cjk_ratio_exceeded_fails(self):
        case = {"zh": "明天開會", "expect": {"max_cjk_ratio": 0.3}}
        self.assertTrue(run_expectations(case, "en", "整段幾乎都是中文的輸出內容不合格"))

    def test_glossary_auto_check_flags_missing(self):
        case = {
            "zh": "老師講解紫微斗數",
            "glossary": [{"term": "紫微斗數", "en": "Zi Wei Dou Shu", "vi": "Tử Vi Đẩu Số"}],
            "expect": {},
        }
        failures = run_expectations(case, "en", "The teacher explains astrology")
        self.assertTrue(any("紫微斗數" in f for f in failures))

    def test_meta_marker_universal_gate_fails(self):
        case = {"zh": "翻譯這句", "expect": {}}
        self.assertTrue(run_expectations(case, "en", "I'd be happy to translate this"))

    def test_wrong_language_universal_gate_fails(self):
        case = {"zh": "翻譯這句", "expect": {}}
        self.assertTrue(run_expectations(case, "en", "我完全用中文回答沒有翻譯成英文"))

    def test_clean_translation_passes(self):
        case = {"zh": "第二季成長百分之二十", "expect": {"contains": {"en": ["20"]}}}
        self.assertEqual(
            run_expectations(case, "en", "Q2 sales grew by 20 percent."), []
        )


if __name__ == "__main__":
    unittest.main()
