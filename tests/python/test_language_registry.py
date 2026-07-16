"""Machine gate for the language registry (shared/languages.json).

This is the single source of truth Rust `include_str!`s, the TS frontend
imports, and Python (checks.py / run_eval.py) reads. The ADD_LANGUAGE SOP
(docs/ADD_LANGUAGE.md) relies on this test to catch a malformed or incomplete
registry entry before it ever reaches the shipped pipeline.

pytest is not installed in prototype/.venv, so these use stdlib unittest. Run
(cwd = prototype/):

    .venv/bin/python -m unittest discover -s ../tests/python
"""
import json
import unittest
from pathlib import Path

# tests/python/<file> → repo root is two levels up (matches checks.py locator).
_REPO = Path(__file__).resolve().parents[2]
_REGISTRY_PATH = _REPO / "shared" / "languages.json"

EXPECTED_CODES = ["zh", "en", "ja", "vi", "km"]  # also the UI display order
ALLOWED_SCRIPT_PROFILES = {"latin", "han", "japanese", "khmer"}
# code → source_capable. km is translation-target only: Whisper transcription
# quality for Khmer is unusable, so it must never be offered as a source.
EXPECTED_SOURCE_CAPABLE = {"zh": True, "en": True, "ja": True, "vi": True, "km": False}
# Top-level string fields every entry must carry, non-empty.
REQUIRED_STRING_FIELDS = (
    "code",
    "native_name",
    "zh_ui_name",
    "prompt_name",
    "whisper_code",
    "script_profile",
    "carrier",
    "term_join",
)


def _load_registry() -> list[dict]:
    return json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))


class TestLanguageRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = _load_registry()

    def test_registry_is_nonempty_list(self):
        self.assertIsInstance(self.registry, list)
        self.assertTrue(self.registry)

    def test_exactly_the_expected_codes(self):
        self.assertEqual({e["code"] for e in self.registry}, set(EXPECTED_CODES))

    def test_display_order_is_zh_en_ja_vi_km(self):
        self.assertEqual([e["code"] for e in self.registry], EXPECTED_CODES)

    def test_source_capable_present_and_expected(self):
        for entry in self.registry:
            with self.subTest(code=entry["code"]):
                self.assertIn("source_capable", entry)
                self.assertIsInstance(entry["source_capable"], bool)
                self.assertEqual(
                    entry["source_capable"], EXPECTED_SOURCE_CAPABLE[entry["code"]]
                )

    def test_codes_are_unique(self):
        codes = [e["code"] for e in self.registry]
        self.assertEqual(len(codes), len(set(codes)))

    def test_required_string_fields_present_and_non_empty(self):
        for entry in self.registry:
            for field in REQUIRED_STRING_FIELDS:
                with self.subTest(code=entry.get("code"), field=field):
                    self.assertIn(field, entry)
                    self.assertIsInstance(entry[field], str)
                    self.assertNotEqual(entry[field].strip(), "")

    def test_script_profile_in_allowed_set(self):
        for entry in self.registry:
            with self.subTest(code=entry["code"]):
                self.assertIn(entry["script_profile"], ALLOWED_SCRIPT_PROFILES)

    def test_carrier_contains_terms_placeholder(self):
        # The carrier is a whisper initial_prompt template; the terms slot is
        # substituted at runtime, so every entry must expose it.
        for entry in self.registry:
            with self.subTest(code=entry["code"]):
                self.assertIn("{terms}", entry["carrier"])

    def test_term_join_is_non_empty(self):
        for entry in self.registry:
            with self.subTest(code=entry["code"]):
                self.assertNotEqual(entry["term_join"], "")

    def test_empty_state_waiting_and_hint_non_empty(self):
        for entry in self.registry:
            with self.subTest(code=entry["code"]):
                empty_state = entry.get("empty_state")
                self.assertIsInstance(empty_state, dict)
                for key in ("waiting", "hint"):
                    self.assertIn(key, empty_state)
                    self.assertIsInstance(empty_state[key], str)
                    self.assertNotEqual(empty_state[key].strip(), "")


if __name__ == "__main__":
    unittest.main()
