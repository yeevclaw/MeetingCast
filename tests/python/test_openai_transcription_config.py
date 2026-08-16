"""Offline tests for the OpenAI Realtime transcription session contract."""

import sys
import unittest
from pathlib import Path


_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "prototype"))

from stt.openai_transcription_config import (  # noqa: E402
    LEGACY_REALTIME_WHISPER_MODEL,
    LIVE_TRANSCRIBE_MODEL,
    MAX_KEYWORDS,
    build_session_payload,
    sanitize_keywords,
)


class TestLiveTranscriptionSession(unittest.TestCase):
    def test_default_contract_uses_live_model_and_traditional_chinese_hint(self):
        payload = build_session_payload(language="zh")
        audio_input = payload["session"]["audio"]["input"]
        transcription = audio_input["transcription"]

        self.assertEqual(payload["type"], "session.update")
        self.assertEqual(payload["session"]["type"], "transcription")
        self.assertEqual(transcription["model"], LIVE_TRANSCRIBE_MODEL)
        self.assertEqual(transcription["languages"], ["zh-tw"])
        self.assertEqual(transcription["delay"], "low")
        self.assertIsNone(audio_input["turn_detection"])
        self.assertEqual(audio_input["format"], {"type": "audio/pcm", "rate": 24000})

    def test_iso_language_and_optional_context_are_forwarded(self):
        payload = build_session_payload(
            language="ja",
            prompt="この音声には専門用語が含まれます。",
            keywords=["MeetingCast", "議事録"],
        )
        transcription = payload["session"]["audio"]["input"]["transcription"]

        self.assertEqual(transcription["languages"], ["ja"])
        self.assertEqual(transcription["prompt"], "この音声には専門用語が含まれます。")
        self.assertEqual(transcription["keywords"], ["MeetingCast", "議事録"])

    def test_empty_optional_context_is_omitted(self):
        payload = build_session_payload(language="en", prompt="  ", keywords=[])
        transcription = payload["session"]["audio"]["input"]["transcription"]

        self.assertNotIn("prompt", transcription)
        self.assertNotIn("keywords", transcription)

    def test_legacy_model_keeps_legacy_schema_for_rollback(self):
        payload = build_session_payload(
            model=LEGACY_REALTIME_WHISPER_MODEL,
            language="zh",
            prompt="ignored",
            keywords=["ignored"],
        )
        audio_input = payload["session"]["audio"]["input"]

        self.assertEqual(
            audio_input["transcription"],
            {"model": LEGACY_REALTIME_WHISPER_MODEL, "language": "zh"},
        )
        self.assertNotIn("turn_detection", audio_input)


class TestKeywordSanitization(unittest.TestCase):
    def test_invalid_and_duplicate_terms_are_omitted(self):
        self.assertEqual(
            sanitize_keywords(
                [" MeetingCast ", "MeetingCast", "bad<term", "line\nbreak", "議事錄"]
            ),
            ["MeetingCast", "議事錄"],
        )

    def test_existing_glossary_cap_is_preserved(self):
        terms = [f"term-{i}" for i in range(MAX_KEYWORDS + 5)]
        self.assertEqual(sanitize_keywords(terms), terms[:MAX_KEYWORDS])


if __name__ == "__main__":
    unittest.main()
