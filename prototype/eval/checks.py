"""Deterministic, LLM-free checks for the offline translation eval.

Pure functions that mirror the runtime guards in
`src-tauri/src/verify.rs` (glossary / wrong-language) and the meta-leak
filter in `src-tauri/src/translator.rs`. The point is parity: an eval
failure here should correspond to something the shipped Rust code would
also flag. Any drift between these functions and their Rust originals is a
bug — keep them in sync.
"""
from __future__ import annotations


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
)


def _ascii_lower(s: str) -> str:
    """Lowercase only ASCII A-Z, leaving accented codepoints untouched — this
    mirrors Rust `str::to_ascii_lowercase`, which glossary matching uses so a
    Vietnamese diacritic must still match exactly apart from ASCII case."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _cjk_and_total(text: str) -> tuple[int, int]:
    """Count (CJK ideographs, non-whitespace chars). CJK = U+4E00–U+9FFF main
    block + U+3400–U+4DBF ext-A, matching verify.rs `wrong_language`."""
    cjk = 0
    total = 0
    for c in text:
        if c.isspace():
            continue
        total += 1
        if "一" <= c <= "鿿" or "㐀" <= c <= "䶿":
            cjk += 1
    return cjk, total


def cjk_ratio(text: str) -> float:
    """Fraction of non-whitespace chars that are CJK ideographs. 0.0 when the
    text has no non-whitespace content."""
    cjk, total = _cjk_and_total(text)
    if total == 0:
        return 0.0
    return cjk / total


def is_wrong_language(text: str, target: str) -> bool:
    """Did the model answer in Chinese when we asked for en/vi? Mirrors
    verify.rs `wrong_language`: only for en/vi targets, only when the reply is
    long enough to be real (>= 8 non-whitespace chars) AND more than half of it
    is CJK. The min-length + >0.5 threshold deliberately tolerates the few Han
    chars a legit translation keeps for rule-3 proper nouns."""
    if target not in ("en", "vi"):
        return False
    cjk, total = _cjk_and_total(text)
    if total < 8:
        return False
    return (cjk / total) > 0.5


def meta_markers_hit(text: str) -> bool:
    """True when the head of `text` looks like Claude breaking character to
    meta-comment instead of translating. Mirrors translator.rs `is_meta_prefix`:
    strip leading whitespace, full-Unicode lowercase, scan the first
    META_SCAN_CHARS characters for any blocklist substring."""
    head = text.strip().lower()[:META_SCAN_CHARS]
    return any(m in head for m in META_MARKERS)


def glossary_violations(
    zh: str,
    translation: str,
    entries: list[dict],
    target: str,
) -> list[str]:
    """For each glossary entry whose canonical `term` appears in the Chinese
    source, require the target-language rendering (en for any non-vi target, vi
    for vi) to appear — ASCII-case-insensitively — in the translation. Mirrors
    verify.rs `check_glossary`. Returns the violated entries as
    "紫微斗數 → Zi Wei Dou Shu"; empty list means all mandated renderings landed.
    Entries with an empty `term` or empty target field are skipped."""
    translation_lc = _ascii_lower(translation)
    violations: list[str] = []
    for entry in entries:
        term = entry.get("term", "")
        if not term or term not in zh:
            continue
        expected = entry.get("vi", "") if target == "vi" else entry.get("en", "")
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
        case.get("zh", ""), translation, case.get("glossary", []), target
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
    print("checks.py self-check passed")
