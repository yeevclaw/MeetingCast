//! Script normalization at the host boundary, shared by both STT backends
//! and both translation modes. Dictionaries are embedded; no system OpenCC
//! install, Python package, network call, or hand-maintained character map.
use std::sync::OnceLock;

use ferrous_opencc::{config::BuiltinConfig, OpenCC};

pub(crate) fn normalize(language: &str, text: &str) -> String {
    if language != "zh" || text.is_empty() {
        return text.to_owned();
    }
    static CONVERTER: OnceLock<OpenCC> = OnceLock::new();
    CONVERTER
        .get_or_init(|| OpenCC::from_config(BuiltinConfig::S2tw).expect("embedded s2tw dictionary"))
        .convert(text)
}

/// Convert the complete raw prefix each time: converting SSE tokens separately
/// loses word context (e.g. 皇 + 后). A changed prefix uses the existing replace
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
            "皇后在後臺整理頭髮，軟件開發。"
        );
        let text = "繁體中文 MeetingCast API 123，頭髮與發展。";
        assert_eq!(normalize("zh", text), text);
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
        for delta in ["干", "杯，", "皇", "后", "的头", "发"] {
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
        assert_eq!(shown, "乾杯，皇后的頭髮");
        assert_eq!(shown, normalize("zh", &raw));
    }
}
