//! Script normalization at the host boundary, shared by both STT backends
//! and both translation modes. Dictionaries are embedded; no system OpenCC
//! install, Python package, network call, or hand-maintained character map.
//! Shared traditional glyphs and official glossary names retain their spelling.
use std::collections::HashSet;
use std::sync::OnceLock;

use ferrous_opencc::{config::BuiltinConfig, OpenCC};

pub(crate) fn normalize(language: &str, text: &str) -> String {
    if language != "zh" || text.is_empty() {
        return text.to_owned();
    }
    static CONVERTER: OnceLock<OpenCC> = OnceLock::new();
    let converted = CONVERTER
        .get_or_init(|| OpenCC::from_config(BuiltinConfig::S2tw).expect("embedded s2tw dictionary"))
        .convert(text);
    // STCharacters explicitly lists the input among the valid traditional
    // alternatives for shared glyphs (台, 干, 范, 余, …). Preserve those glyphs
    // even when a phrase rule would prefer another spelling. Nearby simplified
    // text is not evidence that a person's surname or a brand should change.
    static SHARED: OnceLock<HashSet<char>> = OnceLock::new();
    let shared = SHARED.get_or_init(|| {
        include_str!("../resources/opencc/STCharacters.txt")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| line.split_once('\t'))
            .filter(|(key, values)| values.split_whitespace().any(|value| value == *key))
            .filter_map(|(key, _)| key.chars().next())
            .collect()
    });
    // s2tw's glyph/phrase dictionaries preserve codepoint count. Fail closed
    // if a future dictionary update breaks that invariant; never misalign text.
    if text.chars().count() != converted.chars().count() {
        return text.to_owned();
    }
    text.chars()
        .zip(converted.chars())
        .map(|(original, converted)| {
            if shared.contains(&original) { original } else { converted }
        })
        .collect()
}

/// A per-request snapshot of official glossary spellings. Protect exact
/// matches before normalization, including canonical terms containing simplified
/// glyphs; the user's spelling wins over a dictionary. Longest match wins.
#[derive(Clone, Debug, Default)]
pub(crate) struct Normalizer {
    protected: Vec<String>,
}

impl Normalizer {
    pub(crate) fn new(terms: impl IntoIterator<Item = String>) -> Self {
        let mut protected: Vec<_> = terms.into_iter().filter(|term| !term.is_empty()).collect();
        protected.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        protected.dedup();
        Self { protected }
    }

    pub(crate) fn normalize(&self, language: &str, text: &str) -> String {
        if language != "zh" || self.protected.is_empty() {
            return normalize(language, text);
        }
        let mut out = String::with_capacity(text.len());
        let mut start = 0;
        let mut i = 0;
        while i < text.len() {
            if let Some(term) = self.protected.iter()
                .find(|term| text[i..].starts_with(term.as_str()))
            {
                out.push_str(&normalize(language, &text[start..i]));
                out.push_str(term);
                i += term.len();
                start = i;
            } else {
                i += text[i..].chars().next().unwrap().len_utf8();
            }
        }
        out.push_str(&normalize(language, &text[start..]));
        out
    }
}

/// Convert the complete raw prefix each time: converting SSE tokens separately
/// loses word context (e.g. 发 + 型). A changed prefix uses the existing replace
/// event; an unchanged prefix still streams only the newly appended suffix.
pub(crate) fn update(previous: &str, next: &str) -> (bool, String) {
    match next.strip_prefix(previous) {
        Some(suffix) => (false, suffix.to_owned()),
        None => (true, next.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_14_mixed_script_becomes_taiwan_traditional() {
        assert_eq!(
            normalize("zh", "現在赶着很顺风的对不对？让队友前期非常的辛苦的。"),
            "現在趕著很順風的對不對？讓隊友前期非常的辛苦的。"
        );
        assert_eq!(
            normalize("zh", "这些地端产这个已经是大概是三十个新的场景"),
            "這些地端產這個已經是大概是三十個新的場景"
        );
    }

    #[test]
    fn phrases_disambiguate_without_rewriting_vocabulary() {
        assert_eq!(
            normalize("zh", "皇后在后台整理头发，软件开发。"),
            "皇后在后台整理頭髮，軟件開發。"
        );
        let text = "繁體中文 MeetingCast API 123，頭髮與發展。";
        assert_eq!(normalize("zh", text), text);
    }

    #[test]
    fn valid_traditional_spellings_are_preserved_in_mixed_text() {
        for original in [
            "台灣", "台北", "台中市", "台積電", "干擾", "范先生",
            "余老師", "准許", "里長", "吃面", "平台",
        ] {
            assert_eq!(normalize("zh", original), original);
            assert_eq!(
                normalize("zh", &format!("现在{original}的软件")),
                format!("現在{original}的軟件")
            );
        }
        assert_eq!(normalize("zh", "现在台灣的软件"), "現在台灣的軟件");
    }

    #[test]
    fn official_glossary_names_override_script_conversion() {
        let normalizer = Normalizer::new(["开发平台".into(), "开发平台软件".into(), "台積電".into()]);
        assert_eq!(
            normalizer.normalize("zh", "现在开发平台软件与台積電开会"),
            "現在开发平台软件與台積電開會"
        );
        let text = normalizer.normalize("zh", "开发平台与台積電");
        assert_eq!(normalizer.normalize("zh", &text), text);
        assert_eq!(normalizer.normalize("ja", "软件の会議"), "软件の会議");
    }

    #[test]
    fn streaming_official_name_matches_display_and_persistence_spelling() {
        let normalizer = Normalizer::new(["开发平台".into()]);
        let mut raw = String::new();
        let mut shown = String::new();
        let mut replaced = false;
        for delta in ["现在", "开", "发", "平台", "的软件"] {
            raw.push_str(delta);
            let next = normalizer.normalize("zh", &raw);
            let (replace, delta) = update(&shown, &next);
            if replace {
                replaced = true;
                shown = delta;
            } else {
                shown.push_str(&delta);
            }
        }
        assert!(replaced, "a completed official name must restore its exact spelling");
        assert_eq!(shown, "現在开发平台的軟件");
        assert_eq!(normalizer.normalize("zh", &shown), shown);
    }

    #[test]
    fn other_languages_are_byte_for_byte_unchanged() {
        for lang in ["ja", "en", "km", "vi"] {
            let text = "日本語の会議と软件 / Tiếng Việt / ភាសាខ្មែរ / API";
            assert_eq!(normalize(lang, text), text);
        }
    }

    #[test]
    fn split_phrase_can_correct_an_already_shown_prefix() {
        let mut raw = String::new();
        let mut shown = String::new();
        let mut corrected = false;
        for delta in ["发", "型，", "皇", "后", "的头", "发"] {
            raw.push_str(delta);
            let next = normalize("zh", &raw);
            let (replace, text) = update(&shown, &next);
            if replace {
                corrected = true;
                shown = text;
            } else {
                shown.push_str(&text);
            }
        }
        assert!(corrected, "a longer phrase must be able to correct the script");
        assert_eq!(shown, "髮型，皇后的頭髮");
        assert_eq!(shown, normalize("zh", &raw));
    }
}
