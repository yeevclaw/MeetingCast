"""Unit tests for punctuation-aware early sentence splitting in the
OpenAI live Realtime STT backend (prototype/stt/openai_realtime.py).

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
    BOUNDARY_CLAUSE,
    BOUNDARY_FORCED,
    BOUNDARY_PAUSE,
    BOUNDARY_SENTENCE,
    SEGMENTATION_FINE,
    _SentenceSplitter,
    _closing_boundary,
    split_complete_sentences,
    split_segments,
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


def _fine():
    return _SentenceSplitter("zh", SEGMENTATION_FINE)


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

    def test_multiple_sentences_in_one_delta_emit_together_in_sentence_mode(self):
        # Default (sentence) mode keeps today's behaviour: one final at the
        # last sentence end, tagged `sentence`.
        s = _SentenceSplitter()
        out = s.on_delta("i1", "第一句講完了。第二句也講完了。第三")
        self.assertEqual(
            _texts(out),
            [("第一句講完了。第二句也講完了。", True), ("第三", False)],
        )
        self.assertEqual(out[0].boundary, BOUNDARY_SENTENCE)

    def test_multiple_sentences_emit_as_separate_segments_in_fine_mode(self):
        # Fine mode: each complete sentence is its own final so the incremental
        # translator can close one group and open the next.
        s = _fine()
        out = s.on_delta("i1", "第一句講完了。第二句也講完了。第三")
        self.assertEqual(
            _texts(out),
            [("第一句講完了。", True), ("第二句也講完了。", True), ("第三", False)],
        )
        self.assertEqual([t.boundary for t in out[:2]], [BOUNDARY_SENTENCE] * 2)

    def test_sentence_mode_never_cuts_at_comma(self):
        s = _SentenceSplitter()
        out = s.on_delta("i1", "今天我們討論預算，然後")
        self.assertEqual(_texts(out), [("今天我們討論預算，然後", False)])

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


class TestSplitSegments(unittest.TestCase):
    def _join(self, text, lang="zh"):
        segs, tail = split_segments(text, lang)
        return "".join(t for t, _ in segs) + tail

    def test_no_cut_point_returns_all_as_tail(self):
        self.assertEqual(split_segments("今天我們討論預算"), ([], "今天我們討論預算"))

    def test_comma_is_a_clause_boundary(self):
        segs, tail = split_segments("今天我們討論預算，然後看")
        self.assertEqual(segs, [("今天我們討論預算，", BOUNDARY_CLAUSE)])
        self.assertEqual(tail, "然後看")

    def test_sentence_end_is_a_sentence_boundary(self):
        segs, tail = split_segments("今天天氣很好。接下來")
        self.assertEqual(segs, [("今天天氣很好。", BOUNDARY_SENTENCE)])
        self.assertEqual(tail, "接下來")

    def test_discourse_marker_cuts_before_marker(self):
        segs, tail = split_segments("我們先看業績然後討論預算")
        self.assertEqual(segs, [("我們先看業績", BOUNDARY_CLAUSE)])
        self.assertEqual(tail, "然後討論預算")

    def test_marker_at_segment_start_does_not_cut(self):
        # "然後" opens the text — nothing before it to emit
        self.assertEqual(split_segments("然後我們討論"), ([], "然後我們討論"))

    def test_marker_after_too_short_prefix_is_held(self):
        # "好，" is 2 chars < min 4 — no cut at the comma; then "然後" at index 2
        # sees a 2-char prefix and also holds; everything rides along
        self.assertEqual(split_segments("好，然後我們"), ([], "好，然後我們"))

    def test_short_sentence_rides_along(self):
        segs, tail = split_segments("好。那我們開始。然後")
        self.assertEqual(segs, [("好。那我們開始。", BOUNDARY_SENTENCE)])
        self.assertEqual(tail, "然後")

    def test_forced_cut_at_max_chars_cjk(self):
        text = "一二三四五六七八九十甲乙丙丁戊己庚"  # 17 chars, no punctuation
        segs, tail = split_segments(text)
        self.assertEqual(segs, [("一二三四五六七八九十甲乙丙丁戊", BOUNDARY_FORCED)])
        self.assertEqual(tail, "己庚")

    def test_forced_cut_never_splits_a_latin_word_in_cjk_text(self):
        # "我們的產品叫做 Meeting" is exactly 15 chars — the cut is postponed
        # until the Latin run ends, so "MeetingCast" stays whole.
        segs, tail = split_segments("我們的產品叫做 MeetingCast，主打即時會議翻譯")
        self.assertEqual(segs, [("我們的產品叫做 MeetingCast，", BOUNDARY_CLAUSE)])
        self.assertEqual(tail, "主打即時會議翻譯")
        # run still open at the end of the delta: nothing emitted yet
        self.assertEqual(
            split_segments("我們的產品叫做 Meeting"), ([], "我們的產品叫做 Meeting")
        )
        # run ends on a CJK char: forced cut lands right after that char
        segs, tail = split_segments("我們的產品叫做 MeetingCast主打即時")
        self.assertEqual(segs, [("我們的產品叫做 MeetingCast主", BOUNDARY_FORCED)])
        self.assertEqual(tail, "打即時")

    def test_forced_cut_never_splits_a_number_or_spaced_ascii_phrase(self):
        # Live failure 2026-09-07: "而且也领先于 Claude 5" is exactly 15 chars
        # and the next char is the decimal point of "5.1". The old rule only
        # deferred on alnum chars, so the forced cut landed at "Claude 5."
        # and the interpreter emitted "ahead of Claude 5." — the ".1" could
        # never be appended. Numeric punctuation after a digit and a space
        # between two ASCII tokens now keep the run open.
        segs, tail = split_segments("而且也领先于 Claude 5.1。然后这一项就是商业工作流。")
        self.assertEqual(
            segs,
            [
                ("而且也领先于 Claude 5.1。", BOUNDARY_SENTENCE),
                ("然后这一项就是商业工作流。", BOUNDARY_SENTENCE),
            ],
        )
        self.assertEqual(tail, "")
        # Still open while the number is being spoken: nothing emitted.
        self.assertEqual(split_segments("而且也领先于 Claude 5."), ([], "而且也领先于 Claude 5."))
        # A space between two ASCII tokens is part of the run.
        segs, tail = split_segments("我們用的模型是 GPT 5.6 Terra，效果不錯")
        self.assertEqual(segs, [("我們用的模型是 GPT 5.6 Terra，", BOUNDARY_CLAUSE)])
        self.assertEqual(tail, "效果不錯")
        # A space followed by CJK ends the run: the forced cut lands right
        # after that CJK char (same as the no-space case above).
        segs, tail = split_segments("我們的產品叫做 MeetingCast 主打即時")
        self.assertEqual(segs, [("我們的產品叫做 MeetingCast 主", BOUNDARY_FORCED)])

    def test_numeric_punctuation_is_not_a_boundary(self):
        self.assertEqual(split_segments("溫度是3.5度左右"), ([], "溫度是3.5度左右"))
        self.assertEqual(split_segments("預算是1,000萬元"), ([], "預算是1,000萬元"))
        self.assertEqual(split_segments("會議在3:30開始"), ([], "會議在3:30開始"))

    def test_mixed_boundaries_in_order(self):
        segs, tail = split_segments("第一季業績不錯，所以我們加碼。第二季")
        self.assertEqual(
            segs,
            [
                ("第一季業績不錯，", BOUNDARY_CLAUSE),
                ("所以我們加碼。", BOUNDARY_SENTENCE),
            ],
        )
        self.assertEqual(tail, "第二季")

    def test_segments_and_tail_reconstruct_input(self):
        for text in [
            "今天天氣很好。接下來討論，然後結束。",
            "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸",
            "We will review the numbers, and then move on to the roadmap for next year.",
            "",
        ]:
            self.assertEqual(self._join(text), text)
            self.assertEqual(self._join(text, "en"), text)

    def test_english_uses_spaced_limits(self):
        # 13 chars < 60 max and comma present but prefix < 12 -> held
        self.assertEqual(split_segments("Hi there, ok", "en"), ([], "Hi there, ok"))
        segs, tail = split_segments("We will review the numbers, and then", "en")
        self.assertEqual(segs, [("We will review the numbers,", BOUNDARY_CLAUSE)])
        self.assertEqual(tail, " and then")

    def test_english_forced_cut_lands_on_a_space(self):
        words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"
        segs, tail = split_segments(words, "en")
        self.assertEqual(len(segs), 1)
        seg, boundary = segs[0]
        self.assertEqual(boundary, BOUNDARY_FORCED)
        self.assertTrue(seg.endswith(" "))
        self.assertLessEqual(len(seg), 60)
        self.assertEqual(seg + tail, words)
        # never split a word
        self.assertTrue(tail[0] != " " and seg.rstrip().split(" ")[-1] in words.split(" "))

    def test_english_markers_are_not_applied(self):
        # "so" / "then" are not markers for en — only punctuation cuts
        self.assertEqual(
            split_segments("we did this so then we did that", "en"),
            ([], "we did this so then we did that"),
        )

    def test_japanese_marker_and_punctuation(self):
        segs, tail = split_segments("今日は天気が良いですね、しかし明日は雨です。", "ja")
        self.assertEqual(
            segs,
            [
                ("今日は天気が良いですね、", BOUNDARY_CLAUSE),
                ("しかし明日は雨です。", BOUNDARY_SENTENCE),
            ],
        )
        self.assertEqual(tail, "")


class TestClosingBoundary(unittest.TestCase):
    def test_sentence_final_punct_closes_as_sentence(self):
        self.assertEqual(_closing_boundary("我們開始。"), BOUNDARY_SENTENCE)
        self.assertEqual(_closing_boundary("Really? "), BOUNDARY_SENTENCE)

    def test_no_punct_closes_as_pause(self):
        self.assertEqual(_closing_boundary("我們開始"), BOUNDARY_PAUSE)
        self.assertEqual(_closing_boundary(""), BOUNDARY_PAUSE)

    def test_trailing_decimal_is_pause(self):
        self.assertEqual(_closing_boundary("版本 3."), BOUNDARY_PAUSE)


class TestSplitterBoundaries(unittest.TestCase):
    def test_char_by_char_deltas_keep_version_number_whole(self):
        # Same live case as above but fed one character per delta, the way
        # gpt-live-transcribe streams it: the first early final must be the
        # whole first sentence, never "…Claude 5." (forced).
        s = _fine()
        text = "而且也领先于 Claude 5.1。然后这一项就是商业工作流。"
        finals = []
        for ch in text:
            finals += [(t.text, t.boundary) for t in s.on_delta("i1", ch) if t.is_final]
        done = s.on_completed("i1", text)
        if done is not None:
            finals.append((done.text, done.boundary))
        self.assertEqual(
            finals,
            [
                ("而且也领先于 Claude 5.1。", BOUNDARY_SENTENCE),
                ("然后这一项就是商业工作流。", BOUNDARY_SENTENCE),
            ],
        )

    def test_clause_final_carries_clause_boundary_and_tail_interim(self):
        s = _fine()
        out = s.on_delta("i1", "今天我們討論預算，然後")
        self.assertEqual(_texts(out), [("今天我們討論預算，", True), ("然後", False)])
        self.assertEqual(out[0].boundary, BOUNDARY_CLAUSE)
        self.assertIsNone(out[1].boundary)

    def test_completed_remainder_is_pause_without_punct(self):
        s = _fine()
        s.on_delta("i1", "今天我們討論預算，然後")
        t = s.on_completed("i1", "今天我們討論預算，然後看下一季")
        self.assertEqual((t.text, t.boundary), ("然後看下一季", BOUNDARY_PAUSE))

    def test_completed_remainder_is_sentence_with_punct(self):
        s = _fine()
        s.on_delta("i1", "好的")
        t = s.on_completed("i1", "好的。")
        self.assertEqual((t.text, t.boundary), ("好的。", BOUNDARY_SENTENCE))

    def test_marker_cut_across_deltas(self):
        # marker arrives one char at a time: no cut on "然", cut once "後" lands
        s = _fine()
        self.assertEqual(_texts(s.on_delta("i1", "我們先看業績然")), [("我們先看業績然", False)])
        out = s.on_delta("i1", "後討論")
        self.assertEqual(_texts(out), [("我們先看業績", True), ("然後討論", False)])
        self.assertEqual(out[0].boundary, BOUNDARY_CLAUSE)

    def test_english_language_uses_spaced_rules(self):
        s = _SentenceSplitter("en", SEGMENTATION_FINE)
        out = s.on_delta("i1", "We will review the numbers, and then")
        self.assertEqual(
            _texts(out), [("We will review the numbers,", True), (" and then", False)]
        )
        self.assertEqual(out[0].boundary, BOUNDARY_CLAUSE)

    def test_emitted_offsets_stay_aligned_after_forced_space_cut(self):
        s = _SentenceSplitter("en", SEGMENTATION_FINE)
        words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"
        s.on_delta("i1", words)
        t = s.on_completed("i1", words)
        # completed must emit exactly the unemitted tail, no duplicated word
        self.assertTrue(words.endswith(t.text))
        self.assertNotIn(t.text.split(" ")[0], s._emitted.get("i1", ""))


if __name__ == "__main__":
    unittest.main()
