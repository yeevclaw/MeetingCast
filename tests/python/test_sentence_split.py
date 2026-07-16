"""Unit tests for punctuation-aware early sentence splitting in the
OpenAI Realtime STT backend (prototype/stt/openai_realtime.py).

pytest is not installed in prototype/.venv, so these use stdlib unittest.
Run (cwd = prototype/):

    .venv/bin/python -m unittest discover -s ../tests/python

Covers:
  * split_complete_sentences — split-at-last-punct, min-length gate,
    decimal-point guard, zh/en punctuation.
  * _SentenceSplitter — the delta/completed offset bookkeeping that turns
    complete sentences inside a running utterance into early finals,
    including the completed-vs-deltas drift fallback.
"""
import sys
import unittest
from pathlib import Path

# Mirror python-sidecar/stt_engine.py: put prototype/ on sys.path so the
# `stt` package imports resolve regardless of cwd.
_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "prototype"))

from stt.openai_realtime import (  # noqa: E402
    _SentenceSplitter,
    split_complete_sentences,
)


class TestSplitCompleteSentences(unittest.TestCase):
    def test_no_punctuation_returns_all_as_tail(self):
        self.assertEqual(
            split_complete_sentences("今天我們討論下一季的預算"),
            ("", "今天我們討論下一季的預算"),
        )

    def test_splits_at_last_punct_of_multiple_sentences(self):
        self.assertEqual(
            split_complete_sentences("好的。今天天氣很好。接下來"),
            ("好的。今天天氣很好。", "接下來"),
        )

    def test_text_ending_exactly_at_punct_has_empty_tail(self):
        self.assertEqual(
            split_complete_sentences("今天天氣很好。"),
            ("今天天氣很好。", ""),
        )

    def test_prefix_shorter_than_min_chars_is_not_split(self):
        self.assertEqual(split_complete_sentences("好。"), ("", "好。"))
        self.assertEqual(split_complete_sentences("好。然後"), ("", "好。然後"))

    def test_min_chars_boundary(self):
        # prefix of exactly min_chars splits
        self.assertEqual(
            split_complete_sentences("一二三四五。六", min_chars=6),
            ("一二三四五。", "六"),
        )

    def test_decimal_point_is_not_a_sentence_end(self):
        self.assertEqual(
            split_complete_sentences("溫度是3.5度左右"),
            ("", "溫度是3.5度左右"),
        )

    def test_decimal_point_with_real_punct_later(self):
        self.assertEqual(
            split_complete_sentences("價格是3.5元喔。好的"),
            ("價格是3.5元喔。", "好的"),
        )

    def test_english_punctuation(self):
        self.assertEqual(
            split_complete_sentences("Hello world! And then"),
            ("Hello world!", " And then"),
        )
        self.assertEqual(
            split_complete_sentences("How are you? I am"),
            ("How are you?", " I am"),
        )

    def test_fullwidth_question_and_exclamation(self):
        self.assertEqual(
            split_complete_sentences("你真的確定嗎？我確定"),
            ("你真的確定嗎？", "我確定"),
        )


def _texts(transcripts):
    return [(t.text, t.is_final) for t in transcripts]


class TestSentenceSplitter(unittest.TestCase):
    def test_plain_partials_before_any_sentence_end(self):
        s = _SentenceSplitter()
        self.assertEqual(_texts(s.on_delta("i1", "今天我們")), [("今天我們", False)])
        self.assertEqual(
            _texts(s.on_delta("i1", "討論預算")), [("今天我們討論預算", False)]
        )

    def test_early_final_on_sentence_end_then_tail_partial(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "今天天氣很好")
        out = s.on_delta("i1", "。接下來")
        self.assertEqual(
            _texts(out), [("今天天氣很好。", True), ("接下來", False)]
        )

    def test_completed_emits_only_unemitted_remainder(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "今天天氣很好。接下來")
        t = s.on_completed("i1", "今天天氣很好。接下來討論預算")
        self.assertEqual((t.text, t.is_final), ("接下來討論預算", True))

    def test_completed_with_nothing_left_returns_none(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "今天天氣很好。")
        self.assertIsNone(s.on_completed("i1", "今天天氣很好。"))

    def test_completed_without_any_early_final(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "好的")
        t = s.on_completed("i1", "好的")
        self.assertEqual((t.text, t.is_final), ("好的", True))

    def test_completed_drift_falls_back_to_delta_accumulation(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "今天天氣很好。接下來")
        # completed text disagrees with the delta concatenation — the
        # already-emitted sentence must not be re-emitted
        t = s.on_completed("i1", "今日天氣很好。接下來")
        self.assertEqual((t.text, t.is_final), ("接下來", True))

    def test_multiple_sentences_in_one_delta_emit_together(self):
        s = _SentenceSplitter()
        out = s.on_delta("i1", "第一句講完了。第二句也講完了。第三")
        self.assertEqual(
            _texts(out),
            [("第一句講完了。第二句也講完了。", True), ("第三", False)],
        )

    def test_short_sentence_rides_along_until_long_enough(self):
        s = _SentenceSplitter()
        self.assertEqual(_texts(s.on_delta("i1", "好。")), [("好。", False)])
        out = s.on_delta("i1", "那我們開始。然後")
        self.assertEqual(
            _texts(out), [("好。那我們開始。", True), ("然後", False)]
        )

    def test_items_are_tracked_independently(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "第一段話還沒講完")
        self.assertEqual(
            _texts(s.on_delta("i2", "第二段開始了")), [("第二段開始了", False)]
        )
        t1 = s.on_completed("i1", "第一段話還沒講完")
        self.assertEqual(t1.text, "第一段話還沒講完")
        t2 = s.on_completed("i2", "第二段開始了")
        self.assertEqual(t2.text, "第二段開始了")

    def test_state_cleared_after_completed(self):
        s = _SentenceSplitter()
        s.on_delta("i1", "今天天氣很好。")
        s.on_completed("i1", "今天天氣很好。")
        self.assertEqual(s._partials, {})
        self.assertEqual(s._emitted, {})


if __name__ == "__main__":
    unittest.main()
