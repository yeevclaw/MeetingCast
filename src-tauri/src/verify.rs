//! Deterministic, LLM-free post-checks for translation and summary output.
//!
//! Every function here is pure string logic — no network, no model calls. The
//! philosophy is "observe, don't block": glossary and structure findings are
//! surfaced (trace / error log / UI warning) but never rewrite or suppress the
//! model's output. The one exception is `wrong_language`, which the caller uses
//! to clear an obviously mis-languaged reply the same way the meta filter does
//! — but the decision is still a cheap string heuristic, not another API round
//! trip.

use crate::config::GlossaryEntry;
use crate::languages;

/// For each active glossary entry whose canonical `term` appears in the
/// source text, require the target-language translation (from the entry's
/// `translations` map, keyed by target code) to appear — case-insensitively —
/// somewhere in the produced translation. Entries with an empty `term` or no
/// (non-empty) translation for `target` are skipped (no override requested).
/// Returns the list of violated entries in `"紫微斗數 → Zi Wei Dou Shu"` form.
///
/// Case-insensitivity uses ASCII lowercasing on both sides: `AI` matches `ai`,
/// while Vietnamese diacritics must match exactly apart from ASCII case (ASCII
/// lowercasing leaves accented codepoints untouched, so `Tử` still requires a
/// `Tử`/`tử`).
pub fn check_glossary(
    source: &str,
    translation: &str,
    entries: &[GlossaryEntry],
    target: &str,
) -> Vec<String> {
    let translation_lc = translation.to_ascii_lowercase();
    let mut violations = Vec::new();
    for entry in entries {
        if entry.term.is_empty() || !source.contains(&entry.term) {
            continue;
        }
        let expected = match entry.translations.get(target) {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        if !translation_lc.contains(&expected.to_ascii_lowercase()) {
            violations.push(format!("{} → {}", entry.term, expected));
        }
    }
    violations
}

/// Count `(han, kana, latin, total_non_whitespace)` over `text`. Character
/// domains (canonical — mirrored verbatim by checks.py `_script_counts`):
///   han   = U+4E00–9FFF (CJK Unified) ∪ U+3400–4DBF (ext-A)
///   kana  = U+3040–309F (hiragana) ∪ U+30A0–30FF (katakana)
///   latin = ASCII alphabetic (A–Z / a–z)
fn script_counts(text: &str) -> (usize, usize, usize, usize) {
    let (mut han, mut kana, mut latin, mut total) = (0usize, 0usize, 0usize, 0usize);
    for c in text.chars() {
        if c.is_whitespace() {
            continue;
        }
        total += 1;
        if ('\u{4E00}'..='\u{9FFF}').contains(&c) || ('\u{3400}'..='\u{4DBF}').contains(&c) {
            han += 1;
        } else if ('\u{3040}'..='\u{309F}').contains(&c) || ('\u{30A0}'..='\u{30FF}').contains(&c) {
            kana += 1;
        } else if c.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    (han, kana, latin, total)
}

/// Heuristic: did the model reply in the wrong script for `target`?
///
/// The only destructive action in the pipeline is *clearing* a translation, so
/// the guiding philosophy is "never kill a real translation": every threshold
/// below is deliberately loose, biased to miss a bad reply rather than drop a
/// good one (`translation_wrong_language` in errors.log gives us the data to
/// tighten later). Unknown targets (not in the registry) never flag; the reply
/// must clear a min 8 non-whitespace-char floor before any ratio is trusted, as
/// a one- or two-word fragment can't be classified reliably.
///
/// Dispatch is by the target's registry `script_profile`:
///
/// * **latin** (en/vi): `(han+kana)/total > 0.5` → wrong. A Latin-script reply
///   that is majority Han/kana stayed in the source language. Rule 3 of the
///   translation prompt keeps proper nouns in their original script, so a
///   legitimate en/vi sentence carries a few Han chars — the > 0.5 bar tolerates
///   them (adding kana over the old CJK-only count is a superset that is
///   behavior-identical for zh→en/vi, since zh replies carry no kana).
///
/// * **japanese** (ja): flag an *English* reply —
///   `latin/total > 0.5 && (han+kana)/total < 0.1`; the `< 0.1` clause protects a
///   legitimately mixed sentence like 「MeetingCastとGoogle Slidesを統合します」,
///   whose kana particles keep it above the floor. Also flag a *Chinese* reply —
///   `total >= 20 && kana == 0 && han/total > 0.5`: a genuine Japanese sentence
///   of that length always carries kana (particles / okurigana), so all-kanji
///   with zero kana at length reads as Chinese. Short all-kanji headings stay
///   safe — the length gate keeps them below the bar.
///
/// * **han** (zh): flag an English/Vietnamese reply —
///   `latin/total > 0.5 && han/total < 0.1`; or a Japanese reply —
///   `kana/total > 0.3`.
pub fn wrong_language(text: &str, target: &str) -> bool {
    let Some(profile) = languages::get(target).map(|l| l.script_profile.as_str()) else {
        return false;
    };
    let (han, kana, latin, total) = script_counts(text);
    if total < 8 {
        return false;
    }
    let total_f = total as f64;
    let han_f = han as f64;
    let kana_f = kana as f64;
    let latin_f = latin as f64;
    match profile {
        "latin" => (han_f + kana_f) / total_f > 0.5,
        "japanese" => {
            (latin_f / total_f > 0.5 && (han_f + kana_f) / total_f < 0.1)
                || (total >= 20 && kana == 0 && han_f / total_f > 0.5)
        }
        "han" => (latin_f / total_f > 0.5 && han_f / total_f < 0.1) || kana_f / total_f > 0.3,
        _ => false,
    }
}

/// Extract H2 headings (`## ...`) from markdown in document order, trimmed.
fn h2_headings(md: &str) -> Vec<String> {
    md.lines()
        .filter_map(|l| l.strip_prefix("## "))
        .map(|h| h.trim().to_string())
        .collect()
}

/// Verify a heading-template summary carries every expected H2 heading in the
/// expected relative order. Missing headings are reported as `"缺少段落: X"`.
/// Only when every expected heading is present but the order differs are the
/// out-of-order ones reported as `"順序不符: X"`. Returns an empty vec when the
/// structure is exactly as expected.
pub fn check_summary_structure(expected_headings: &[String], md: &str) -> Vec<String> {
    let found = h2_headings(md);

    let mut issues = Vec::new();
    for h in expected_headings {
        if !found.iter().any(|f| f == h) {
            issues.push(format!("缺少段落: {h}"));
        }
    }
    if !issues.is_empty() {
        return issues;
    }

    // All present — check relative order. Build the found sequence limited to
    // expected headings (first occurrence each), then flag any heading whose
    // index in that sequence differs from its expected index.
    let mut found_order: Vec<&String> = Vec::new();
    for f in &found {
        if expected_headings.contains(f) && !found_order.contains(&f) {
            found_order.push(f);
        }
    }
    for (expected_idx, h) in expected_headings.iter().enumerate() {
        if found_order.iter().position(|f| *f == h) != Some(expected_idx) {
            issues.push(format!("順序不符: {h}"));
        }
    }
    issues
}

/// True when `line` is a `## Slide N:` heading (N = one or more ASCII digits).
/// Manual parse — `regex` is not a dependency and adding one for this is not
/// worth it.
fn is_slide_heading(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("## Slide ") else {
        return false;
    };
    let digit_len = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    digit_len > 0 && rest[digit_len..].starts_with(':')
}

/// The `slide_outline` template uses a variable number of `## Slide N: 標題`
/// sections instead of a fixed heading list. Returns a warning unless the slide
/// count lands in the supported 6–10 range; `None` means the structure is fine.
pub fn check_slide_outline(md: &str) -> Option<String> {
    let count = md.lines().filter(|l| is_slide_heading(l)).count();
    if (6..=10).contains(&count) {
        None
    } else {
        Some(format!("投影片張數 {count}，建議 6–10 張"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(term: &str, en: &str, vi: &str) -> GlossaryEntry {
        let mut translations = std::collections::BTreeMap::new();
        if !en.is_empty() {
            translations.insert("en".to_string(), en.to_string());
        }
        if !vi.is_empty() {
            translations.insert("vi".to_string(), vi.to_string());
        }
        GlossaryEntry {
            term: term.into(),
            en: en.into(),
            vi: vi.into(),
            translations,
            ..Default::default()
        }
    }

    /// Build an entry from an explicit `(target, translation)` list — lets a
    /// test exercise ja (or any non-en/vi) glossary translations.
    fn entry_map(term: &str, pairs: &[(&str, &str)]) -> GlossaryEntry {
        let mut translations = std::collections::BTreeMap::new();
        for (k, v) in pairs {
            translations.insert((*k).to_string(), (*v).to_string());
        }
        GlossaryEntry {
            term: term.into(),
            translations,
            ..Default::default()
        }
    }

    #[test]
    fn glossary_hit_reports_violation() {
        let entries = vec![entry("紫微斗數", "Zi Wei Dou Shu", "Tử Vi Đẩu Số")];
        let v = check_glossary("我們談到紫微斗數", "We talked about astrology", &entries, "en");
        assert_eq!(v, vec!["紫微斗數 → Zi Wei Dou Shu"]);
    }

    #[test]
    fn glossary_miss_no_violation_when_translation_present() {
        let entries = vec![entry("紫微斗數", "Zi Wei Dou Shu", "Tử Vi Đẩu Số")];
        let v = check_glossary("我們談到紫微斗數", "We talked about Zi Wei Dou Shu", &entries, "en");
        assert!(v.is_empty());
    }

    #[test]
    fn glossary_case_insensitive() {
        let entries = vec![entry("人工智慧", "AI", "")];
        // Output lowercases the term — still counts as present, no violation.
        let v = check_glossary("這是人工智慧模型", "this is an ai model", &entries, "en");
        assert!(v.is_empty());
    }

    #[test]
    fn glossary_skips_empty_target() {
        // en override empty → no requirement for en target.
        let entries = vec![entry("沒英文", "", "Có")];
        let v = check_glossary("這裡沒英文", "some english output", &entries, "en");
        assert!(v.is_empty());
    }

    #[test]
    fn glossary_skips_term_not_in_source() {
        let entries = vec![entry("紫微斗數", "Zi Wei Dou Shu", "")];
        // Term absent from zh → not required in the translation.
        let v = check_glossary("完全無關的句子", "totally unrelated sentence", &entries, "en");
        assert!(v.is_empty());
    }

    #[test]
    fn glossary_uses_vi_field_for_vi_target() {
        let entries = vec![entry("紫微斗數", "Zi Wei Dou Shu", "Tử Vi Đẩu Số")];
        // en present but vi missing — for vi target this is a violation.
        let v = check_glossary("我們談到紫微斗數", "Zi Wei Dou Shu là gì", &entries, "vi");
        assert_eq!(v, vec!["紫微斗數 → Tử Vi Đẩu Số"]);
        let ok = check_glossary("我們談到紫微斗數", "Chúng ta nói về Tử Vi Đẩu Số", &entries, "vi");
        assert!(ok.is_empty());
    }

    #[test]
    fn wrong_language_pure_chinese_reply_is_true() {
        assert!(wrong_language("我無法翻譯這段內容因為它不完整", "en"));
    }

    #[test]
    fn wrong_language_english_with_proper_noun_is_false() {
        assert!(!wrong_language(
            "We discussed the 紫微斗數 project during today's meeting.",
            "en"
        ));
    }

    #[test]
    fn wrong_language_short_text_is_false() {
        // Below the 8-char min-length guard even though it's all CJK.
        assert!(!wrong_language("你好嗎", "en"));
    }

    #[test]
    fn wrong_language_vietnamese_is_false() {
        assert!(!wrong_language("Chúng tôi đã thảo luận về vấn đề này hôm nay", "vi"));
    }

    #[test]
    fn wrong_language_zh_target_never_flags() {
        // zh target isn't meaningful for this check.
        assert!(!wrong_language("整段都是中文的內容不會被判定", "zh"));
    }

    // ---- script-profile wrong_language: ja target (japanese profile) ----

    #[test]
    fn wrong_language_ja_english_reply_is_true() {
        // Latin-dominant, almost no han/kana → English reply for a ja target.
        assert!(wrong_language(
            "This is the summary of today's project meeting discussion.",
            "ja"
        ));
    }

    #[test]
    fn wrong_language_ja_mixed_latin_and_kana_is_false() {
        // Legit ja sentence embedding Latin product names — the kana particles
        // push (han+kana)/total above 0.1 so the English clause never fires.
        assert!(!wrong_language("MeetingCastとGoogle Slidesを統合します", "ja"));
    }

    #[test]
    fn wrong_language_ja_chinese_reply_zero_kana_is_true() {
        // 20+ chars, zero kana, majority han → reads as Chinese, not Japanese.
        assert!(wrong_language(
            "這是今天會議的總結內容包含了所有討論事項與決議結果的說明",
            "ja"
        ));
    }

    #[test]
    fn wrong_language_ja_medium_all_kanji_heading_is_false() {
        // 8+ chars (clears the min-length guard) but under the 20-char Chinese
        // clause, no Latin → a kanji-only Japanese heading must survive.
        assert!(!wrong_language("会議決定事項報告書一覧", "ja"));
    }

    // ---- script-profile wrong_language: zh target (han profile) ----

    #[test]
    fn wrong_language_zh_english_reply_is_true() {
        assert!(wrong_language(
            "The meeting covered budget, marketing and hiring topics today.",
            "zh"
        ));
    }

    #[test]
    fn wrong_language_zh_chinese_reply_is_false() {
        // A real zh reply for a zh target — the han backstop must not flag it.
        assert!(!wrong_language("這是今天會議的完整總結與決議內容", "zh"));
    }

    #[test]
    fn wrong_language_zh_japanese_reply_is_true() {
        // Kana-heavy Japanese reply for a zh target → kana/total > 0.3.
        assert!(wrong_language("これは今日の会議のまとめです", "zh"));
    }

    // ---- script-profile wrong_language: en target catches ja ----

    #[test]
    fn wrong_language_en_kana_dominant_ja_reply_is_true() {
        assert!(wrong_language("これはとても重要な会議のまとめです", "en"));
    }

    // ---- glossary check via translations map (incl. ja) ----

    #[test]
    fn glossary_uses_ja_translation_for_ja_target() {
        let entries = vec![entry_map(
            "紫微斗數",
            &[("en", "Zi Wei Dou Shu"), ("ja", "紫微斗数")],
        )];
        let miss = check_glossary("我們談到紫微斗數", "占星術について話しました", &entries, "ja");
        assert_eq!(miss, vec!["紫微斗數 → 紫微斗数"]);
        let ok = check_glossary("我們談到紫微斗數", "紫微斗数について話しました", &entries, "ja");
        assert!(ok.is_empty());
    }

    #[test]
    fn glossary_skips_target_absent_from_translations() {
        // Entry has en only; a ja target has no mandated rendering → skipped.
        let entries = vec![entry("紫微斗數", "Zi Wei Dou Shu", "")];
        assert!(check_glossary("我們談到紫微斗數", "占星術", &entries, "ja").is_empty());
    }

    fn headings(hs: &[&str]) -> Vec<String> {
        hs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn summary_structure_complete_and_ordered_is_empty() {
        let expected = headings(&["摘要", "決議事項", "Action items", "待澄清議題"]);
        let md = "## 摘要\n內容\n## 決議事項\n- x\n## Action items\n- [ ] y\n## 待澄清議題\n- z\n";
        assert!(check_summary_structure(&expected, md).is_empty());
    }

    #[test]
    fn summary_structure_missing_heading_reported() {
        let expected = headings(&["摘要", "決議事項", "Action items", "待澄清議題"]);
        // "Action items" dropped.
        let md = "## 摘要\n內容\n## 決議事項\n- x\n## 待澄清議題\n- z\n";
        let issues = check_summary_structure(&expected, md);
        assert_eq!(issues, vec!["缺少段落: Action items"]);
    }

    #[test]
    fn summary_structure_reordered_reported() {
        let expected = headings(&["摘要", "決議事項", "Action items", "待澄清議題"]);
        // 決議事項 and Action items swapped.
        let md = "## 摘要\n內容\n## Action items\n- [ ] y\n## 決議事項\n- x\n## 待澄清議題\n- z\n";
        let issues = check_summary_structure(&expected, md);
        assert_eq!(issues.len(), 2);
        assert!(issues.contains(&"順序不符: 決議事項".to_string()));
        assert!(issues.contains(&"順序不符: Action items".to_string()));
    }

    #[test]
    fn slide_outline_in_range_is_none() {
        let mut md = String::new();
        for i in 1..=7 {
            md.push_str(&format!("## Slide {i}: 標題\n- 重點\n"));
        }
        // A speaker-notes H3 and a stray H2 must not be miscounted as slides.
        md.push_str("### Speaker Notes\n補充\n## 附錄\n- x\n");
        assert!(check_slide_outline(&md).is_none());
    }

    #[test]
    fn slide_outline_out_of_range_is_some() {
        let mut md = String::new();
        for i in 1..=3 {
            md.push_str(&format!("## Slide {i}: 標題\n- 重點\n"));
        }
        let warn = check_slide_outline(&md).expect("3 slides should warn");
        assert!(warn.contains('3'));
    }
}
