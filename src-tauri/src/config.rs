use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::errors;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiConfig {
    #[serde(default)]
    pub anthropic_api_key: String,
    #[serde(default)]
    pub deepgram_api_key: String,
    #[serde(default)]
    pub openai_api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_model() -> String {
    "claude-haiku-4-5".into()
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            anthropic_api_key: String::new(),
            deepgram_api_key: String::new(),
            openai_api_key: String::new(),
            model: default_model(),
        }
    }
}

/// One glossary entry. `term` is the canonical zh form (what we want
/// produced); `aliases` is a list of common Whisper mistranscriptions of
/// that term — those get string-replaced back to the canonical form before
/// the transcript reaches the UI. The per-target translation is taken from
/// `en` / `vi` — empty means "no override, model decides".
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GlossaryEntry {
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub en: String,
    #[serde(default)]
    pub vi: String,
}

/// A named glossary "book". The user can have several (e.g. one per recurring
/// meeting type) and switch which one is active. Only the active book feeds
/// into Whisper / translation / summary prompts.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GlossaryBook {
    pub name: String,
    #[serde(default)]
    pub entries: Vec<GlossaryEntry>,
}

/// Audio capture preferences. `input_device` is the sounddevice device name
/// (e.g. "MacBook Pro Microphone"); empty string means "use system default".
/// Names are persisted instead of integer indices because indices reshuffle
/// when USB/Bluetooth devices are plugged in or out.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AudioConfig {
    #[serde(default)]
    pub input_device: String,
}

/// Legacy 0.1.5 single-glossary entry, BTreeMap-keyed. Kept solely so
/// `load()` can read pre-0.1.6 configs and migrate them into a default
/// "預設" book. Removed from the on-disk schema after the next save.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct LegacyGlossaryEntry {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    en: String,
    #[serde(default)]
    vi: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub api: ApiConfig,
    #[serde(default)]
    pub audio: AudioConfig,

    /// Legacy 0.1.5 single-glossary BTreeMap. Read for migration only;
    /// emptied (and therefore omitted from disk) after the first save under
    /// the new schema.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    glossary: BTreeMap<String, LegacyGlossaryEntry>,

    /// All named glossary books the user has defined.
    #[serde(default)]
    pub glossaries: Vec<GlossaryBook>,

    /// Name of the currently-active book (must match one of `glossaries[].name`).
    /// `None` means no book is active — Whisper bias / alias rewrite / prompt
    /// injection all behave as if the glossary were empty.
    #[serde(default)]
    pub active_glossary: Option<String>,

    /// Minutes of recorded silence (no real-speech final transcripts) before
    /// the session auto-stops. Primary motivation: OpenAI Realtime Whisper is
    /// billed per minute of session time, so leaving the recording on after a
    /// meeting ends silently burns budget. The check runs against any
    /// non-empty final transcript regardless of backend (the safety applies
    /// to all three — local/cloud/openai), so a user forgetting to stop
    /// after a meal break gets caught even on the free mlx path.
    /// `0` disables the auto-stop entirely.
    #[serde(default = "default_idle_minutes")]
    pub idle_auto_stop_minutes: u32,
}

fn default_idle_minutes() -> u32 {
    5
}

impl Config {
    /// Resolve the currently-active book by name, or return `None` if no
    /// book is active or the active name doesn't match any book.
    fn active_book(&self) -> Option<&GlossaryBook> {
        let name = self.active_glossary.as_ref()?;
        self.glossaries.iter().find(|b| &b.name == name)
    }

    /// Iterate the entries that should drive STT bias + alias rewrite +
    /// prompt injection. Empty when no active book or the active book is empty.
    fn active_entries(&self) -> &[GlossaryEntry] {
        self.active_book()
            .map(|b| b.entries.as_slice())
            .unwrap_or(&[])
    }

    /// Replace known mistranscriptions with their canonical term. Implemented
    /// as a single left-to-right pass that, at each position, tries aliases
    /// longest-first and emits the canonical term on match. The single-pass
    /// design is critical: a naive "for each alias, str.replace(alias, term)"
    /// loop cascades — replacing alias A→term may produce a substring that
    /// alias B then catches and rewrites again, mangling the output. Example:
    /// {AI助理 → AI 助理工具, AI → 人工智慧} on "AI助理" should yield
    /// "AI 助理工具", not "人工智慧 助理工具".
    pub fn apply_glossary_aliases(&self, text: &str) -> String {
        let entries = self.active_entries();
        if entries.is_empty() {
            return text.to_string();
        }
        let mut pairs: Vec<(&str, &str)> = entries
            .iter()
            .flat_map(|e| e.aliases.iter().map(move |a| (a.as_str(), e.term.as_str())))
            .filter(|(a, t)| !a.is_empty() && !t.is_empty() && a != t)
            .collect();
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        while i < text.len() {
            let rest = &text[i..];
            let matched = pairs
                .iter()
                .find(|(alias, _)| rest.starts_with(*alias))
                .copied();
            if let Some((alias, canonical)) = matched {
                out.push_str(canonical);
                i += alias.len();
            } else {
                // Step forward by one full UTF-8 codepoint so we don't slice
                // mid-byte. The unwrap is safe — we're inside `i < text.len()`.
                let ch_len = text[i..].chars().next().unwrap().len_utf8();
                out.push_str(&text[i..i + ch_len]);
                i += ch_len;
            }
        }
        out
    }

    /// Build the Chinese-language initial_prompt fed to mlx-whisper's decoder.
    /// Canonical terms are joined with 、 inside a carrier sentence — Whisper
    /// prompt-conditioning works best when the prompt is grammatically natural,
    /// not a bare list. Capped at 30 terms (decoder prompt has a ~224 BPE token
    /// hard limit, and over-long prompts make the decoder hallucinate
    /// continuations of the prompt itself).
    /// Aliases are deliberately excluded — they're mistranscriptions we want
    /// to bias AGAINST, not toward; they're applied via post-hoc substitution.
    pub fn whisper_initial_prompt(&self) -> Option<String> {
        let entries = self.active_entries();
        if entries.is_empty() {
            return None;
        }
        let terms: Vec<&str> = entries
            .iter()
            .map(|e| e.term.as_str())
            .filter(|s| !s.is_empty())
            .take(30)
            .collect();
        if terms.is_empty() {
            None
        } else {
            Some(format!(
                "本段語音可能包含以下術語：{}。",
                terms.join("、")
            ))
        }
    }

    /// Render the glossary section appended to translation / summary system
    /// prompts. Only emits entries with a non-empty translation for the
    /// current target.
    pub fn render_glossary_section(&self, target: &str) -> String {
        let entries = self.active_entries();
        if entries.is_empty() {
            return String::new();
        }
        let mut lines: Vec<String> = Vec::new();
        for entry in entries {
            if entry.term.is_empty() {
                continue;
            }
            let translated = match target {
                "vi" => &entry.vi,
                _ => &entry.en,
            };
            if translated.is_empty() {
                continue;
            }
            lines.push(format!("- {} → {}", entry.term, translated));
        }
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n術語表（以下中文一律使用對應譯法，不要意譯）：\n{}",
                lines.join("\n")
            )
        }
    }

    /// One-time migration from the 0.1.5 BTreeMap-style glossary into a
    /// "預設" book. Runs automatically inside `load()` whenever the legacy
    /// field is non-empty and there are no books yet — so the user's existing
    /// terms aren't dropped on first launch under the new schema.
    fn migrate_legacy_glossary(&mut self) {
        if self.glossary.is_empty() || !self.glossaries.is_empty() {
            return;
        }
        let entries: Vec<GlossaryEntry> = std::mem::take(&mut self.glossary)
            .into_iter()
            .map(|(term, e)| GlossaryEntry {
                term,
                aliases: e.aliases,
                en: e.en,
                vi: e.vi,
            })
            .collect();
        let book = GlossaryBook {
            name: "預設".into(),
            entries,
        };
        self.active_glossary = Some(book.name.clone());
        self.glossaries.push(book);
    }
}

pub type SharedConfig = Arc<Mutex<Config>>;

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("MeetingCast/config.toml"))
        .unwrap_or_else(|| PathBuf::from("config.toml"))
}

pub fn load() -> Config {
    let path = config_path();
    let mut cfg: Config = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| toml::from_str::<Config>(&s).ok())
        .unwrap_or_default();
    cfg.migrate_legacy_glossary();
    cfg
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let content = toml::to_string_pretty(cfg).map_err(|e| format!("toml encode: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// On first launch, seed empty fields from prototype/.env so dev mode "just works".
pub fn seed_from_dotenv(cfg: &mut Config) {
    if cfg.api.anthropic_api_key.is_empty() {
        if let Ok(v) = std::env::var("ANTHROPIC_API_KEY") {
            cfg.api.anthropic_api_key = v;
        }
    }
    if cfg.api.deepgram_api_key.is_empty() {
        if let Ok(v) = std::env::var("DEEPGRAM_API_KEY") {
            cfg.api.deepgram_api_key = v;
        }
    }
    if cfg.api.openai_api_key.is_empty() {
        if let Ok(v) = std::env::var("OPENAI_API_KEY") {
            cfg.api.openai_api_key = v;
        }
    }
}

#[tauri::command]
pub async fn get_config(state: tauri::State<'_, SharedConfig>) -> Result<Config, String> {
    Ok(state.lock().await.clone())
}

#[tauri::command]
pub async fn set_config(
    state: tauri::State<'_, SharedConfig>,
    config: Config,
) -> Result<(), String> {
    if let Err(e) = save(&config) {
        errors::record("config_save", &e, None);
        return Err(e);
    }
    *state.lock().await = config;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(term: &str, aliases: &[&str], en: &str, vi: &str) -> GlossaryEntry {
        GlossaryEntry {
            term: term.into(),
            aliases: aliases.iter().map(|s| (*s).into()).collect(),
            en: en.into(),
            vi: vi.into(),
        }
    }

    fn cfg_with_book(name: &str, entries: Vec<GlossaryEntry>) -> Config {
        let mut cfg = Config::default();
        cfg.glossaries.push(GlossaryBook {
            name: name.into(),
            entries,
        });
        cfg.active_glossary = Some(name.into());
        cfg
    }

    #[test]
    fn whisper_prompt_empty_when_no_active_book() {
        let cfg = Config::default();
        assert!(cfg.whisper_initial_prompt().is_none());
    }

    #[test]
    fn whisper_prompt_empty_when_active_book_has_no_terms() {
        let cfg = cfg_with_book("預設", vec![]);
        assert!(cfg.whisper_initial_prompt().is_none());
    }

    #[test]
    fn whisper_prompt_joins_terms_with_chinese_comma() {
        let cfg = cfg_with_book(
            "x",
            vec![
                entry("紫微斗數", &[], "", ""),
                entry("TPI Software", &[], "", ""),
            ],
        );
        let prompt = cfg.whisper_initial_prompt().unwrap();
        assert!(prompt.contains("紫微斗數、TPI Software"));
        assert!(prompt.starts_with("本段語音可能"));
    }

    #[test]
    fn whisper_prompt_skips_empty_terms_and_caps_at_30() {
        let mut entries: Vec<GlossaryEntry> = (0..40).map(|i| entry(&format!("詞{i}"), &[], "", "")).collect();
        entries.insert(0, entry("", &[], "", "")); // empty term should be filtered
        let cfg = cfg_with_book("x", entries);
        let prompt = cfg.whisper_initial_prompt().unwrap();
        // Empty term filtered → first kept term is 詞0; cap is 30 so 詞29 should
        // appear, 詞30 should not.
        assert!(prompt.contains("詞0、"));
        assert!(prompt.contains("詞29"));
        assert!(!prompt.contains("詞30"));
    }

    #[test]
    fn alias_substitution_replaces_known_misspellings() {
        let cfg = cfg_with_book(
            "x",
            vec![entry("紫微斗數", &["紫薇斗數", "子位斗數"], "", "")],
        );
        assert_eq!(
            cfg.apply_glossary_aliases("我覺得紫薇斗數很有趣"),
            "我覺得紫微斗數很有趣"
        );
        assert_eq!(
            cfg.apply_glossary_aliases("子位斗數和紫薇斗數"),
            "紫微斗數和紫微斗數"
        );
    }

    #[test]
    fn alias_substitution_prefers_longer_match() {
        // "AI助理" must win over "AI" — without longest-first sorting, the
        // shorter alias would clobber the longer one.
        let cfg = cfg_with_book(
            "x",
            vec![
                entry("AI 助理工具", &["AI助理"], "", ""),
                entry("人工智慧", &["AI"], "", ""),
            ],
        );
        // "AI助理" should map to "AI 助理工具", not partial-replace as "人工智慧助理"
        assert_eq!(
            cfg.apply_glossary_aliases("這個AI助理很好用"),
            "這個AI 助理工具很好用"
        );
    }

    #[test]
    fn alias_substitution_noop_when_no_active_book() {
        let cfg = Config::default();
        assert_eq!(cfg.apply_glossary_aliases("紫薇斗數"), "紫薇斗數");
    }

    #[test]
    fn alias_substitution_skips_self_referential_aliases() {
        // alias == term is a no-op; an unguarded `replace` would still loop
        // forever in some implementations.
        let cfg = cfg_with_book(
            "x",
            vec![entry("紫微斗數", &["紫微斗數"], "", "")],
        );
        assert_eq!(cfg.apply_glossary_aliases("紫微斗數"), "紫微斗數");
    }

    #[test]
    fn glossary_section_empty_when_no_translations() {
        let cfg = cfg_with_book("x", vec![entry("紫微斗數", &[], "", "")]);
        assert_eq!(cfg.render_glossary_section("en"), "");
    }

    #[test]
    fn glossary_section_picks_target_language() {
        let cfg = cfg_with_book(
            "x",
            vec![entry("紫微斗數", &[], "Zi Wei Dou Shu", "Tử Vi Đẩu Số")],
        );
        let en = cfg.render_glossary_section("en");
        let vi = cfg.render_glossary_section("vi");
        assert!(en.contains("紫微斗數 → Zi Wei Dou Shu"));
        assert!(!en.contains("Tử Vi"));
        assert!(vi.contains("紫微斗數 → Tử Vi Đẩu Số"));
        assert!(!vi.contains("Zi Wei"));
    }

    #[test]
    fn glossary_section_skips_entries_with_empty_target() {
        let cfg = cfg_with_book(
            "x",
            vec![
                entry("有英文", &[], "Yes", ""),
                entry("沒英文", &[], "", "Có"),
            ],
        );
        let en = cfg.render_glossary_section("en");
        assert!(en.contains("有英文"));
        assert!(!en.contains("沒英文"));
    }

    #[test]
    fn migration_converts_legacy_btreemap_into_default_book() {
        let mut cfg = Config::default();
        cfg.glossary.insert(
            "紫微斗數".into(),
            LegacyGlossaryEntry {
                aliases: vec!["紫薇斗數".into()],
                en: "Zi Wei Dou Shu".into(),
                vi: "Tử Vi Đẩu Số".into(),
            },
        );
        cfg.migrate_legacy_glossary();
        assert!(cfg.glossary.is_empty(), "legacy field should be drained");
        assert_eq!(cfg.glossaries.len(), 1);
        assert_eq!(cfg.glossaries[0].name, "預設");
        assert_eq!(cfg.glossaries[0].entries.len(), 1);
        assert_eq!(cfg.glossaries[0].entries[0].term, "紫微斗數");
        assert_eq!(cfg.glossaries[0].entries[0].aliases, vec!["紫薇斗數"]);
        assert_eq!(cfg.active_glossary.as_deref(), Some("預設"));
    }

    #[test]
    fn migration_is_noop_when_already_migrated() {
        let mut cfg = cfg_with_book(
            "我的術語表",
            vec![entry("詞", &[], "term", "tu")],
        );
        let snapshot = cfg.clone();
        cfg.migrate_legacy_glossary();
        assert_eq!(cfg.glossaries.len(), snapshot.glossaries.len());
        assert_eq!(cfg.active_glossary, snapshot.active_glossary);
    }

    #[test]
    fn migration_is_noop_when_legacy_empty() {
        let mut cfg = Config::default();
        cfg.migrate_legacy_glossary();
        assert!(cfg.glossaries.is_empty());
        assert!(cfg.active_glossary.is_none());
    }

    #[test]
    fn config_serializes_without_legacy_glossary_when_empty() {
        // After migration, the legacy `[glossary]` table should not pollute
        // saved config.toml — verify skip_serializing_if works.
        let cfg = cfg_with_book("x", vec![entry("詞", &[], "term", "tu")]);
        let serialized = toml::to_string(&cfg).unwrap();
        assert!(
            !serialized.contains("[glossary"),
            "legacy [glossary] table should be omitted: {serialized}"
        );
        assert!(serialized.contains("[[glossaries]]"));
    }
}
