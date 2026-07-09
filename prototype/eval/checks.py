"""Deterministic, LLM-free checks for the offline translation eval.

Pure functions that mirror the runtime guards in
`src-tauri/src/verify.rs` (glossary / wrong-language) and the meta-leak
filter in `src-tauri/src/translator.rs`. The point is parity: an eval
failure here should correspond to something the shipped Rust code would
also flag. Any drift between these functions and their Rust originals is a
bug — keep them in sync. In particular the META_MARKERS list (per-language
meta-leak groups) and the script-profile thresholds must match
translator.rs / verify.rs verbatim.
"""
from __future__ import annotations

import json
from pathlib import Path


# Buffer this many leading characters when scanning for a meta-leak, matching
# translator.rs META_SCAN_CHARS. The Rust filter only inspects the head of the
# stream (lowercased, leading-whitespace-trimmed) before deciding to drop it.
META_SCAN_CHARS = 32

# 與 src-tauri/src/translator.rs META_MARKERS 同步；改任一邊要同步另一邊
META_MARKERS = (
    # English meta
    "per the rules",
    "following rule",
    "based on the specific rule",
    "based on the rule",
    "the rules provided",
    "appears to be incomplete",
    "appears to be garbled",
    "appears to be gibberish",
    "appears to be corrupted",
    "this input appears",
    "this input contains",
    "this input doesn't",
    "this input seems",
    "outputting an empty",
    "outputting empty",
    "empty response",
    "empty string",
    "i'm outputting",
    "i'll output",
    "i'd be happy",
    "i appreciate you",
    "i cannot translate",
    "i'm unable to translate",
    "could you provide",
    "could you clarify",
    "please provide the chinese",
    "please provide actual",
    "doesn't form coherent",
    "don't form coherent",
    "garbled or incomplete",
    "incomplete fragments",
    # Vietnamese meta
    "vui lòng cung cấp",
    "tôi không thể dịch",
    "tôi xin lỗi nhưng tôi",
    # Chinese meta (Claude responding in Chinese instead of target lang)
    "明白，我",
    "請提供",
    "我無法翻譯",
    "我没法翻译",
    "空字串",
    "空字符串",
    # Japanese meta (Claude breaking character for a ja target). Deliberately
    # NO bare 「申し訳ありません」 — a Chinese source often opens with an apology
    # that legitimately translates to that phrase, so matching it would drop
    # real translations.
    "翻訳できません",
    "翻訳することができません",
    "翻訳いたしかねます",
    "翻訳者として",
    "通訳者として",
    "テキストを提供してください",
    "テキストをご提供",
    "有効なテキストを提供",
    "空の文字列を出力",
    "入力が不完全",
    "この入力は不完全",
    "文字化けして",
    "意味を成していない",
)


def _ascii_lower(s: str) -> str:
    """Lowercase only ASCII A-Z, leaving accented codepoints untouched — this
    mirrors Rust `str::to_ascii_lowercase`, which glossary matching uses so a
    Vietnamese diacritic must still match exactly apart from ASCII case."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _load_script_profiles() -> dict[str, str]:
    """Map language code → script_profile from shared/languages.json (the same
    registry Rust `include_str!`s and TS imports). Falls back to a builtin dict
    if the repo file can't be found/parsed, so checks stay usable standalone."""
    fallback = {"zh": "han", "en": "latin", "ja": "japanese", "vi": "latin"}
    try:
        # checks.py lives at prototype/eval/; repo root is two levels up.
        path = Path(__file__).resolve().parents[2] / "shared" / "languages.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        profiles = {e["code"]: e["script_profile"] for e in data}
        return profiles or fallback
    except Exception:  # noqa: BLE001 — any I/O/parse failure → safe builtin
        return fallback


SCRIPT_PROFILES = _load_script_profiles()


def _script_counts(text: str) -> tuple[int, int, int, int]:
    """Count (han, kana, latin, non-whitespace total). Mirrors verify.rs
    `script_counts` verbatim: han = U+4E00–9FFF ∪ U+3400–4DBF; kana = U+3040–
    309F ∪ U+30A0–30FF; latin = ASCII alphabetic (A–Z / a–z)."""
    han = kana = latin = total = 0
    for c in text:
        if c.isspace():
            continue
        total += 1
        o = ord(c)
        if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF:
            han += 1
        elif 0x3040 <= o <= 0x309F or 0x30A0 <= o <= 0x30FF:
            kana += 1
        elif ("a" <= c <= "z") or ("A" <= c <= "Z"):
            latin += 1
    return han, kana, latin, total


def cjk_ratio(text: str) -> float:
    """Fraction of non-whitespace chars that are Han ideographs. 0.0 when the
    text has no non-whitespace content. (Used only by the `max_cjk_ratio`
    expectation; `is_wrong_language` uses the fuller script-profile logic.)"""
    han, _, _, total = _script_counts(text)
    if total == 0:
        return 0.0
    return han / total


def is_wrong_language(text: str, target: str) -> bool:
    """Did the model reply in the wrong script for `target`? Mirrors verify.rs
    `wrong_language` exactly — same registry-driven script profiles, the same
    thresholds, and the same min-8 non-whitespace floor. Unknown targets never
    flag. Philosophy: never kill a real translation, so every bound is loose.

      * latin (en/vi): (han+kana)/total > 0.5
      * japanese (ja): English reply — latin/total > 0.5 and (han+kana)/total <
        0.1; or Chinese reply — total >= 20 and kana == 0 and han/total > 0.5
      * han (zh): English/Vietnamese reply — latin/total > 0.5 and han/total <
        0.1; or Japanese reply — kana/total > 0.3
    """
    profile = SCRIPT_PROFILES.get(target)
    if profile is None:
        return False
    han, kana, latin, total = _script_counts(text)
    if total < 8:
        return False
    if profile == "latin":
        return (han + kana) / total > 0.5
    if profile == "japanese":
        return (latin / total > 0.5 and (han + kana) / total < 0.1) or (
            total >= 20 and kana == 0 and han / total > 0.5
        )
    if profile == "han":
        return (latin / total > 0.5 and han / total < 0.1) or kana / total > 0.3
    return False


def meta_markers_hit(text: str) -> bool:
    """True when the head of `text` looks like Claude breaking character to
    meta-comment instead of translating. Mirrors translator.rs `is_meta_prefix`:
    strip leading whitespace, full-Unicode lowercase, scan the first
    META_SCAN_CHARS characters for any blocklist substring."""
    head = text.strip().lower()[:META_SCAN_CHARS]
    return any(m in head for m in META_MARKERS)


def _entry_translation(entry: dict, target: str) -> str:
    """Target-language rendering for a glossary entry: prefer the v2
    `translations` map, then fall back to the legacy en/vi mirror keys so the
    unchanged golden cases (which carry only `en`/`vi`) still resolve."""
    val = (entry.get("translations") or {}).get(target)
    if val:
        return val
    if target in ("en", "vi"):
        return entry.get(target, "")
    return ""


def glossary_violations(
    source: str,
    translation: str,
    entries: list[dict],
    target: str,
) -> list[str]:
    """For each glossary entry whose canonical `term` appears in the source
    text, require the target-language rendering (from the entry's `translations`
    map, with legacy en/vi fallback) to appear — ASCII-case-insensitively — in
    the translation. Mirrors verify.rs `check_glossary`. Returns the violated
    entries as "紫微斗數 → Zi Wei Dou Shu"; empty list means all mandated
    renderings landed. Entries with an empty `term` or no rendering for `target`
    are skipped."""
    translation_lc = _ascii_lower(translation)
    violations: list[str] = []
    for entry in entries:
        term = entry.get("term", "")
        if not term or term not in source:
            continue
        expected = _entry_translation(entry, target)
        if not expected:
            continue
        if _ascii_lower(expected) not in translation_lc:
            violations.append(f"{term} → {expected}")
    return violations


def run_expectations(case: dict, target: str, translation: str) -> list[str]:
    """Evaluate one (case, target, model-output) triple against the case's
    `expect` block plus the universal runtime-parity gates (meta leak, wrong
    language, glossary). Returns a list of human-readable failure strings; an
    empty list means the case passed for this target."""
    failures: list[str] = []
    expect = case.get("expect", {})
    stripped = translation.strip()

    # Empty-expected cases (rule 6 hallucination shape): a non-empty answer is
    # the only failure and nothing else is meaningful, so short-circuit.
    if expect.get("empty"):
        if stripped != "":
            failures.append(f"expected empty output, got {translation[:40]!r}")
        return failures

    if expect.get("non_empty") and stripped == "":
        failures.append("expected non-empty output, got empty")

    text_lc = translation.lower()

    for needle in expect.get("contains", {}).get(target, []):
        if needle.lower() not in text_lc:
            failures.append(f"missing required substring {needle!r}")

    for needle in expect.get("not_contains", {}).get(target, []):
        if needle.lower() in text_lc:
            failures.append(f"forbidden substring present {needle!r}")

    if "max_cjk_ratio" in expect:
        ratio = cjk_ratio(translation)
        if ratio > expect["max_cjk_ratio"]:
            failures.append(
                f"cjk_ratio {ratio:.3f} > max {expect['max_cjk_ratio']}"
            )

    # Universal parity gates — these should never fire on a good translation and
    # mirror exactly what the shipped Rust path drops / flags.
    if stripped and meta_markers_hit(translation):
        failures.append(f"meta marker in head: {translation[:40]!r}")
    if is_wrong_language(translation, target):
        failures.append(f"wrong language (CJK-dominant) for target {target}")
    for term in glossary_violations(
        case.get("source", case.get("zh", "")),
        translation,
        case.get("glossary", []),
        target,
    ):
        failures.append(f"glossary miss: {term}")

    return failures


if __name__ == "__main__":
    # Lightweight self-check so `python checks.py` exercises the functions
    # without pulling in the test suite (mirrors the Rust unit assertions).
    assert cjk_ratio("abc") == 0.0
    assert cjk_ratio("你好ab") == 0.5
    assert is_wrong_language("我無法翻譯這段內容因為它不完整", "en") is True
    assert is_wrong_language("We discussed 紫微斗數 today at the meeting.", "en") is False
    assert is_wrong_language("你好嗎", "en") is False  # below 8-char guard
    assert is_wrong_language("整段都是中文的內容不會被判定", "zh") is False
    assert meta_markers_hit("I'd be happy to translate that for you") is True
    assert meta_markers_hit("The quarterly revenue grew by 20%.") is False
    assert glossary_violations(
        "我們談到紫微斗數", "We talked about astrology",
        [{"term": "紫微斗數", "en": "Zi Wei Dou Shu", "vi": "Tử Vi Đẩu Số"}], "en",
    ) == ["紫微斗數 → Zi Wei Dou Shu"]
    assert glossary_violations(
        "我們談到紫微斗數", "We talked about Zi Wei Dou Shu",
        [{"term": "紫微斗數", "en": "Zi Wei Dou Shu", "vi": "Tử Vi Đẩu Số"}], "en",
    ) == []
    # Script-profile branches (mirror verify.rs wrong_language ja / zh cases).
    assert is_wrong_language("This is the full English summary of the meeting.", "ja") is True
    assert is_wrong_language("MeetingCastとGoogle Slidesを統合します", "ja") is False
    assert is_wrong_language("これは今日の会議のまとめです", "zh") is True
    # v2 translations map preferred; legacy en/vi fallback still resolves.
    assert glossary_violations(
        "我們談到紫微斗數", "占星術について話しました",
        [{"term": "紫微斗數", "translations": {"ja": "紫微斗数"}}], "ja",
    ) == ["紫微斗數 → 紫微斗数"]
    print("checks.py self-check passed")
