//! Shared language registry — single source of truth for the supported
//! languages (zh/en/ja/vi), loaded from `shared/languages.json` at compile
//! time via `include_str!`. The same JSON is read by the Python eval harness
//! and imported by the TS frontend, so all three layers agree on codes,
//! display names, translation prompt names, script profiles, the per-language
//! Whisper glossary carrier sentence, and empty-state copy.
//!
//! Adding a language = one entry here (plus per-language hallucination
//! blocklist, summary headings, and golden cases — see docs/ADD_LANGUAGE.md).

use std::sync::OnceLock;

use serde::Deserialize;

/// Per-language empty-state copy shown in a translation window before any
/// text arrives, written in that language's own script.
#[derive(Debug, Clone, Deserialize)]
pub struct EmptyState {
    pub waiting: String,
    pub hint: String,
}

/// One language's registry entry. Deserialized from `shared/languages.json`
/// with NO serde defaults — a missing field fails the parse loudly at first
/// access rather than silently degrading to an empty string.
#[derive(Debug, Clone, Deserialize)]
pub struct LanguageDef {
    /// Canonical code (zh/en/ja/vi). Used everywhere as the language key.
    pub code: String,
    /// Endonym shown as the translation window title (e.g. `日本語`).
    pub native_name: String,
    /// Traditional-Chinese label for pickers/UI (e.g. `日文`).
    pub zh_ui_name: String,
    /// Full name substituted into the translation system prompt's `{lang}` /
    /// `{source_lang}` slots (e.g. `Japanese (日本語)`).
    pub prompt_name: String,
    /// Deepgram nova-3 single-language code.
    pub deepgram_code: String,
    /// Whisper language code (pins mlx-whisper / OpenAI Realtime decoding).
    pub whisper_code: String,
    /// verify.rs / checks.py language-correctness profile:
    /// `latin` | `han` | `japanese`.
    pub script_profile: String,
    /// Whisper `initial_prompt` glossary carrier sentence, in this language,
    /// with a `{terms}` placeholder for the joined term list.
    pub carrier: String,
    /// Separator used to join glossary terms inside `carrier`.
    pub term_join: String,
    pub empty_state: EmptyState,
}

const LANGUAGES_JSON: &str = include_str!("../../shared/languages.json");

static REGISTRY: OnceLock<Vec<LanguageDef>> = OnceLock::new();

/// All languages in registry (UI display) order: zh → en → ja → vi.
pub fn all() -> &'static [LanguageDef] {
    REGISTRY
        .get_or_init(|| {
            serde_json::from_str(LANGUAGES_JSON).expect("shared/languages.json is malformed")
        })
        .as_slice()
}

/// Look up a language by its canonical `code` (zh/en/ja/vi).
pub fn get(code: &str) -> Option<&'static LanguageDef> {
    all().iter().find(|l| l.code == code)
}

/// Whether `code` names a language in the registry.
pub fn is_valid(code: &str) -> bool {
    get(code).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_parses_and_has_exactly_four() {
        assert_eq!(all().len(), 4);
    }

    #[test]
    fn registry_order_is_zh_en_ja_vi() {
        let codes: Vec<&str> = all().iter().map(|l| l.code.as_str()).collect();
        assert_eq!(codes, vec!["zh", "en", "ja", "vi"]);
    }

    #[test]
    fn codes_are_unique() {
        let mut codes: Vec<&str> = all().iter().map(|l| l.code.as_str()).collect();
        let n = codes.len();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), n, "duplicate language code in registry");
    }

    #[test]
    fn all_string_fields_non_empty() {
        for l in all() {
            for (name, val) in [
                ("code", &l.code),
                ("native_name", &l.native_name),
                ("zh_ui_name", &l.zh_ui_name),
                ("prompt_name", &l.prompt_name),
                ("deepgram_code", &l.deepgram_code),
                ("whisper_code", &l.whisper_code),
                ("script_profile", &l.script_profile),
                ("carrier", &l.carrier),
                ("term_join", &l.term_join),
                ("empty_state.waiting", &l.empty_state.waiting),
                ("empty_state.hint", &l.empty_state.hint),
            ] {
                assert!(!val.is_empty(), "{} empty for {}", name, l.code);
            }
        }
    }

    #[test]
    fn carrier_contains_terms_placeholder() {
        for l in all() {
            assert!(
                l.carrier.contains("{terms}"),
                "carrier for {} missing {{terms}}",
                l.code
            );
        }
    }

    #[test]
    fn script_profile_in_allowed_set() {
        for l in all() {
            assert!(
                matches!(l.script_profile.as_str(), "latin" | "han" | "japanese"),
                "unexpected script_profile {:?} for {}",
                l.script_profile,
                l.code
            );
        }
    }

    #[test]
    fn get_resolves_and_is_valid_rejects_unknown() {
        assert_eq!(get("ja").unwrap().native_name, "日本語");
        assert!(is_valid("zh") && is_valid("en") && is_valid("ja") && is_valid("vi"));
        assert!(!is_valid("fr"));
        assert!(get("fr").is_none());
    }

    // ---- Byte-compat invariants ----
    // These literals are currently hardcoded in translator.rs / config.rs. The
    // registry must reproduce them exactly so switching those call sites to the
    // registry is behavior-preserving (guarded by the zh-source eval A/B).

    #[test]
    fn byte_compat_prompt_name_en_vi() {
        // translator.rs target_lang_name: "vi" => "Vietnamese (Tiếng Việt)", _ => "English".
        assert_eq!(get("en").unwrap().prompt_name, "English");
        assert_eq!(get("vi").unwrap().prompt_name, "Vietnamese (Tiếng Việt)");
    }

    #[test]
    fn byte_compat_zh_ui_name_is_zhongwen() {
        assert_eq!(get("zh").unwrap().zh_ui_name, "中文");
    }

    #[test]
    fn byte_compat_zh_carrier_matches_whisper_initial_prompt() {
        // config.rs whisper_initial_prompt literal with {} → {terms}, join 、.
        assert_eq!(
            get("zh").unwrap().carrier,
            "本段語音可能包含以下術語：{terms}。"
        );
        assert_eq!(get("zh").unwrap().term_join, "、");
    }

    #[test]
    fn byte_compat_native_name_matches_target_lang_label() {
        // translator.rs target_lang_label: zh => 繁體中文, en => English, vi => Tiếng Việt.
        assert_eq!(get("zh").unwrap().native_name, "繁體中文");
        assert_eq!(get("en").unwrap().native_name, "English");
        assert_eq!(get("vi").unwrap().native_name, "Tiếng Việt");
    }
}
