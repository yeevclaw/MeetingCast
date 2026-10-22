//! Script normalization at the host boundary, shared by both STT backends
//! and both translation modes. Dictionaries are embedded; no system OpenCC
//! install, Python package, or network call. A small explicit list preserves
//! ambiguous traditional glyphs unless context selects a different conversion.
//! Official glossary names retain their spelling.
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use ferrous_opencc::{config::BuiltinConfig, OpenCC};

pub(crate) fn normalize(language: &str, text: &str) -> String {
    if language != "zh" || text.is_empty() {
        return text.to_owned();
    }
    static CONVERTER: OnceLock<OpenCC> = OnceLock::new();
    let converter = CONVERTER
        .get_or_init(|| OpenCC::from_config(BuiltinConfig::S2tw).expect("embedded s2tw dictionary"));
    let converted = converter.convert(text);
    // Only these eight ambiguous glyphs may retain their original spelling
    // when conversion relies on the single-character default. Do not derive
    // this list from dictionary alternatives: those include common simplified
    // glyphs such as 万, 价, 党, 厂, 广, 几, 于, 据 and 确.
    static DEFAULTS: OnceLock<HashMap<char, char>> = OnceLock::new();
    let defaults = DEFAULTS.get_or_init(|| {
        "台干范余准里后面".chars()
            .filter_map(|original| {
                let single = converter.convert(&original.to_string());
                let mut chars = single.chars();
                let converted = chars.next()?;
                // Only cache defaults that can be aligned to one input glyph.
                chars.next().is_none().then_some((original, converted))
            })
            .collect()
    });
    // s2tw's glyph/phrase dictionaries preserve codepoint count. Fail closed
    // if a future dictionary update breaks that invariant; never misalign text.
    if text.chars().count() != converted.chars().count() {
        return text.to_owned();
    }
    // A phrase can select the SAME result as a single-character default:
    // 然后 → 然後 and 准备 → 準備. Comparing output glyphs alone cannot
    // detect these matches. Find phrase spans, including overlaps (在后 and
    // 后台), so preservation cannot undo part of a contextual conversion.
    // The converter itself still decides which phrase's output to use.
    static PHRASES: OnceLock<(HashSet<&str>, usize)> = OnceLock::new();
    let (phrases, max_bytes) = PHRASES.get_or_init(|| {
        let phrases: HashSet<_> = include_str!("../resources/opencc/STPhrases.txt")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| line.split_once('\t').map(|(key, _)| key))
            .collect();
        let max_bytes = phrases.iter().map(|key| key.len()).max().unwrap_or(0);
        (phrases, max_bytes)
    });
    let mut phrase_end = 0;
    let mut spelling_end = 0;
    text.char_indices()
        .zip(converted.chars())
        .map(|((index, original), converted)| {
            let remaining = &text[index..];
            let matched_bytes = remaining.char_indices().skip(1)
                .map(|(end, _)| end)
                .chain(std::iter::once(remaining.len()))
                .take_while(|end| end <= max_bytes)
                .filter(|end| phrases.contains(&remaining[..*end]))
                .last().unwrap_or(0);
            phrase_end = phrase_end.max(index + matched_bytes);
            // A phrase fragment such as 在台 must not rewrite an existing
            // traditional name in 现在台灣. Protect these established valid
            // spellings; glossary names receive broader exact-match protection.
            if let Some(spelling) = [
                "台灣", "台北", "台中", "台積電", "干擾", "范先生",
                "余老師", "准許", "里長",
            ].iter().find(|spelling| remaining.starts_with(**spelling)) {
                spelling_end = index + spelling.len();
            }
            if (index >= phrase_end || index < spelling_end)
                && defaults.get(&original) == Some(&converted)
            {
                original
            } else {
                converted
            }
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
            "皇后在後臺整理頭髮，軟件開發。"
        );
        let text = "繁體中文 MeetingCast API 123，頭髮與發展。";
        assert_eq!(normalize("zh", text), text);
    }

    #[test]
    fn valid_traditional_spellings_are_preserved_in_mixed_text() {
        for original in [
            "台灣", "台北", "台中市", "台積電", "干擾", "范先生",
            "余老師", "准許", "里長", "面",
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
    fn isolated_ambiguous_glyphs_use_only_the_explicit_preservation_list() {
        for original in ["台", "干", "范", "余", "准", "里", "后", "面"] {
            assert_eq!(normalize("zh", original), original);
        }
        assert_eq!(normalize("zh", "万价党厂广几于据确适"), "萬價黨廠廣幾於據確適");
    }

    #[test]
    fn common_simplified_phrases_are_fully_converted() {
        for (input, expected) in [
            ("然后我们准备一下", "然後我們準備一下"),
            ("关于这个价格", "關於這個價格"),
            ("根据范围确定", "根據範圍確定"),
            ("这里有几个工厂", "這裡有幾個工廠"),
            ("广告适合一万人", "廣告適合一萬人"),
            ("共产党", "共產黨"),
        ] {
            assert_eq!(normalize("zh", input), expected, "input: {input}");
        }
    }

    #[test]
    fn colloquial_context_overrides_ambiguous_glyph_defaults() {
        for (input, expected) in [
            ("以后我们在这里开会", "以後我們在這裡開會"),
            ("请把里面的资料发给我", "請把裡面的資料發給我"),
            ("这个项目还没准备好", "這個項目還沒準備好"),
            ("周末一起吃面吧", "週末一起吃麵吧"),
            ("干扰太多，先把衣服晾干", "干擾太多，先把衣服晾乾"),
            ("范先生说范围已经确定", "范先生說範圍已經確定"),
            ("准许里长进来准备会议", "准許里長進來準備會議"),
            ("台積電在台灣，后台正在更新", "台積電在台灣，後臺正在更新"),
            ("请打开平台后台", "請打開平臺後臺"),
            ("回家以后记得给我电话", "回家以後記得給我電話"),
            ("你先看一下后面的广告", "你先看一下後面的廣告"),
            ("里面有几个文件，请确认一下", "裡面有幾個文件，請確認一下"),
            ("今天下午三点见，别忘了带电脑", "今天下午三點見，別忘了帶電腦"),
            ("我觉得这种方法极好，大家都愿意试试", "我覺得這種方法極好，大家都願意試試"),
            ("皇后在后台", "皇后在後臺"),
        ] {
            let actual = normalize("zh", input);
            assert_eq!(actual, expected, "input: {input}");
            assert_eq!(normalize("zh", &actual), actual, "repeat: {input}");
        }
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
