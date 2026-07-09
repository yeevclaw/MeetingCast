use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::errors;
use crate::languages;

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
    /// Model used for meeting summaries (History → 產生總結). Kept separate from
    /// `model` (live translation) so the user can spend on a stronger model for
    /// the one-shot summary while keeping translation cheap/fast.
    #[serde(default = "default_summary_model")]
    pub summary_model: String,
}

fn default_model() -> String {
    "claude-haiku-4-5".into()
}

fn default_summary_model() -> String {
    "claude-sonnet-4-6".into()
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            anthropic_api_key: String::new(),
            deepgram_api_key: String::new(),
            openai_api_key: String::new(),
            model: default_model(),
            summary_model: default_summary_model(),
        }
    }
}

/// One glossary entry. `term` is the canonical source-language form (what we
/// want produced); `aliases` is a list of common Whisper mistranscriptions of
/// that term — those get string-replaced back to the canonical form before
/// the transcript reaches the UI. Per-target translations live in
/// `translations` (keyed by language code, e.g. `en` / `ja` / `vi`); empty or
/// missing means "no override, model decides". The `en` / `vi` fields are
/// legacy mirrors kept serialized so a downgrade to 0.1.x still reads those two
/// targets — they are re-derived from `translations` on every load/save and
/// never treated as truth once `translations` is populated.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GlossaryEntry {
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    // Legacy 0.1.x mirror fields, re-derived from `translations` on load/save.
    #[serde(default)]
    pub en: String,
    #[serde(default)]
    pub vi: String,
    // Kept last: a map serializes as a TOML sub-table, which must follow all
    // scalar fields of the entry.
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
}

/// A named glossary "book". The user can have several (e.g. one per recurring
/// meeting type) and switch which one is active. Only the active book feeds
/// into Whisper / translation / summary prompts, and only when its
/// `source_lang` matches the meeting's configured source language (see
/// `glossary_applies`) — a zh-authored book contributes nothing to a ja meeting.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlossaryBook {
    pub name: String,
    /// Source language the entries' `term`s are written in. Old books without
    /// the field parse as zh (the only source before multi-language support).
    #[serde(default = "default_glossary_source")]
    pub source_lang: String,
    #[serde(default)]
    pub entries: Vec<GlossaryEntry>,
}

fn default_glossary_source() -> String {
    "zh".into()
}

impl Default for GlossaryBook {
    fn default() -> Self {
        Self {
            name: String::new(),
            source_lang: default_glossary_source(),
            entries: Vec::new(),
        }
    }
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

/// Opt-in post-meeting auto-summary. When `auto_generate` is true, stopping a
/// recording (manually or via idle timeout) kicks off `generate_summary` for
/// each language in `auto_targets` using `auto_template`, writing the results
/// into the session folder so they're waiting in History. Defaults keep the
/// feature off; old configs without a `[summary]` table parse with these.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SummaryConfig {
    #[serde(default)]
    pub auto_generate: bool,
    #[serde(default = "default_auto_template")]
    pub auto_template: String,
    #[serde(default = "default_auto_targets")]
    pub auto_targets: Vec<String>,
}

fn default_auto_template() -> String {
    "exec_brief".into()
}

fn default_auto_targets() -> Vec<String> {
    vec!["zh".into()]
}

impl Default for SummaryConfig {
    fn default() -> Self {
        Self {
            auto_generate: false,
            auto_template: default_auto_template(),
            auto_targets: default_auto_targets(),
        }
    }
}

/// Source + target-slot language selection. `source` is the meeting language
/// being transcribed; `target_slots` is always exactly length 2 (one per
/// translation window), where `""` means that slot is closed. serde defaults
/// reproduce the pre-multi-language behavior (zh → en + vi) for old configs
/// with no `[language]` table.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct LanguageConfig {
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_target_slots")]
    pub target_slots: Vec<String>,
}

fn default_source() -> String {
    "zh".into()
}

fn default_target_slots() -> Vec<String> {
    vec!["en".into(), "vi".into()]
}

impl Default for LanguageConfig {
    fn default() -> Self {
        Self {
            source: default_source(),
            target_slots: default_target_slots(),
        }
    }
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
    #[serde(default)]
    pub language: LanguageConfig,

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

    /// True once the Welcome wizard has been finished (or explicitly
    /// skipped), so it isn't shown again on later launches. Old configs
    /// without the field parse as `false`.
    #[serde(default)]
    pub onboarding_complete: bool,

    /// Post-meeting auto-summary preferences. Absent in old configs; defaults
    /// leave the feature disabled.
    #[serde(default)]
    pub summary: SummaryConfig,
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
    pub(crate) fn active_entries(&self) -> &[GlossaryEntry] {
        self.active_book()
            .map(|b| b.entries.as_slice())
            .unwrap_or(&[])
    }

    /// Whether the active glossary book applies to the current source language.
    /// A book's `term`s are authored in one source language; when the meeting
    /// source differs, the book's Whisper carrier / alias rewrite / prompt
    /// injection all behave as if the glossary were empty. `false` when there's
    /// no active book.
    pub fn glossary_applies(&self) -> bool {
        self.active_book()
            .map(|b| b.source_lang == self.language.source)
            .unwrap_or(false)
    }

    /// The distinct, non-closed target languages (dedup-preserving order).
    /// Drives how many translation calls / windows are live.
    // Consumed by the multi-target translate orchestration wired in a later
    // batch; defined here as part of the [language] config contract.
    #[allow(dead_code)]
    pub fn effective_targets(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for slot in &self.language.target_slots {
            if !slot.is_empty() && !out.contains(slot) {
                out.push(slot.clone());
            }
        }
        out
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
        if !self.glossary_applies() {
            return text.to_string();
        }
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
        if !self.glossary_applies() {
            return None;
        }
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
            return None;
        }
        // Carrier sentence is per-source-language (registry), so a ja meeting
        // biases Whisper with a Japanese prompt, an en meeting an English one.
        let lang = languages::get(&self.language.source)?;
        Some(lang.carrier.replace("{terms}", &terms.join(lang.term_join.as_str())))
    }

    /// Render the glossary section appended to translation / summary system
    /// prompts. Only emits entries with a non-empty translation for the
    /// current target (read from the `translations` map). Empty when the active
    /// book doesn't apply to the current source language.
    pub fn render_glossary_section(&self, target: &str) -> String {
        if !self.glossary_applies() {
            return String::new();
        }
        let entries = self.active_entries();
        if entries.is_empty() {
            return String::new();
        }
        let mut lines: Vec<String> = Vec::new();
        for entry in entries {
            if entry.term.is_empty() {
                continue;
            }
            let translated = match entry.translations.get(target) {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };
            lines.push(format!("- {} → {}", entry.term, translated));
        }
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n術語表（以下原文術語一律使用對應譯法，不要意譯）：\n{}",
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
                translations: BTreeMap::new(),
                en: e.en,
                vi: e.vi,
            })
            .collect();
        let book = GlossaryBook {
            name: "預設".into(),
            source_lang: "zh".into(),
            entries,
        };
        self.active_glossary = Some(book.name.clone());
        self.glossaries.push(book);
    }

    /// Normalize every glossary entry into the v2 shape. Idempotent, so it runs
    /// both on load() (migrate old configs) and before every save (keep the
    /// legacy `en`/`vi` mirrors in sync). When `translations` is empty it is
    /// seeded from the legacy `en`/`vi` fields; then the mirrors are ALWAYS
    /// re-derived from `translations` so a downgrade to 0.1.x reads whatever the
    /// map holds. Precedence: a non-empty `translations` map wins over mirrors.
    fn migrate_glossary_entries(&mut self) {
        for book in &mut self.glossaries {
            for entry in &mut book.entries {
                if entry.translations.is_empty() {
                    if !entry.en.is_empty() {
                        entry.translations.insert("en".into(), entry.en.clone());
                    }
                    if !entry.vi.is_empty() {
                        entry.translations.insert("vi".into(), entry.vi.clone());
                    }
                }
                entry.en = entry.translations.get("en").cloned().unwrap_or_default();
                entry.vi = entry.translations.get("vi").cloned().unwrap_or_default();
            }
        }
    }

    /// Force the `[language]` selection into an always-valid shape. Runs on
    /// load() and again before every set_config save so neither a hand-edited
    /// config.toml nor a frontend bug can leave an out-of-registry source, a
    /// wrong-length slot list, a slot that duplicates the source or the other
    /// slot, or a summary target the registry doesn't recognize.
    pub fn sanitize_language(&mut self) {
        if !languages::is_valid(&self.language.source) {
            self.language.source = "zh".into();
        }
        let source = self.language.source.clone();

        // Exactly two slots: truncate extras, pad missing with "" (closed).
        self.language.target_slots.truncate(2);
        while self.language.target_slots.len() < 2 {
            self.language.target_slots.push(String::new());
        }

        // A non-empty slot must be a known language, not the source, and not a
        // duplicate of an earlier slot; anything else collapses to "".
        let mut seen: Vec<String> = Vec::new();
        for i in 0..2 {
            let slot = self.language.target_slots[i].clone();
            let ok = !slot.is_empty()
                && languages::is_valid(&slot)
                && slot != source
                && !seen.contains(&slot);
            if ok {
                seen.push(slot);
            } else {
                self.language.target_slots[i] = String::new();
            }
        }

        // Slot A must always carry a target. Prefer en (or zh when the source
        // is already en so they can't collide); fall back to any registry
        // language that is neither the source nor whatever slot B holds.
        if self.language.target_slots[0].is_empty() {
            let other = self.language.target_slots[1].clone();
            let preferred = if source == "en" { "zh" } else { "en" };
            let pick = std::iter::once(preferred.to_string())
                .chain(languages::all().iter().map(|l| l.code.clone()))
                .find(|c| *c != source && *c != other);
            if let Some(c) = pick {
                self.language.target_slots[0] = c;
            }
        }

        // Auto-summary targets must all be real languages.
        self.summary
            .auto_targets
            .retain(|t| languages::is_valid(t));
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
    cfg.migrate_glossary_entries();
    cfg.sanitize_language();
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
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedConfig>,
    mut config: Config,
) -> Result<(), String> {
    // Normalize before persisting: fix up the language selection and re-derive
    // the glossary mirrors from the translations map so on-disk config is
    // always in the canonical v2 shape regardless of what the frontend sent.
    config.sanitize_language();
    config.migrate_glossary_entries();

    let prev_language = state.lock().await.language.clone();
    if let Err(e) = save(&config) {
        errors::record("config_save", &e, None);
        return Err(e);
    }
    let language_changed = config.language != prev_language;
    let new_language = config.language.clone();
    *state.lock().await = config;

    // Signal windows to re-read config (they re-`get_config`, don't trust the
    // payload). Only fire when the language selection actually changed.
    if language_changed {
        let _ = app.emit(
            "language:changed",
            serde_json::json!({
                "source": new_language.source,
                "target_slots": new_language.target_slots,
            }),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a v2 entry: populate the `translations` map (source of truth) AND
    /// the legacy en/vi mirrors, matching what `migrate_glossary_entries`
    /// produces post-load.
    fn entry(term: &str, aliases: &[&str], en: &str, vi: &str) -> GlossaryEntry {
        let mut translations = BTreeMap::new();
        if !en.is_empty() {
            translations.insert("en".to_string(), en.to_string());
        }
        if !vi.is_empty() {
            translations.insert("vi".to_string(), vi.to_string());
        }
        GlossaryEntry {
            term: term.into(),
            aliases: aliases.iter().map(|s| (*s).into()).collect(),
            en: en.into(),
            vi: vi.into(),
            translations,
        }
    }

    fn cfg_with_book(name: &str, entries: Vec<GlossaryEntry>) -> Config {
        let mut cfg = Config::default();
        cfg.glossaries.push(GlossaryBook {
            name: name.into(),
            source_lang: "zh".into(),
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
    fn onboarding_flag_defaults_false_and_round_trips() {
        // Old configs (pre-flag) must parse with onboarding_complete = false.
        let old: Config = toml::from_str("[api]\nanthropic_api_key = \"sk\"\n").unwrap();
        assert!(!old.onboarding_complete);

        // And a saved `true` must survive serialize → parse.
        let mut cfg = Config::default();
        cfg.onboarding_complete = true;
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: Config = toml::from_str(&serialized).unwrap();
        assert!(reparsed.onboarding_complete);
    }

    #[test]
    fn summary_model_defaults_when_absent_and_round_trips() {
        // Old configs (pre-field) must parse with the Sonnet default.
        let old: Config = toml::from_str("[api]\nmodel = \"claude-haiku-4-5\"\n").unwrap();
        assert_eq!(old.api.summary_model, "claude-sonnet-4-6");

        // A saved override must survive serialize → parse.
        let mut cfg = Config::default();
        cfg.api.summary_model = "claude-haiku-4-5".into();
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: Config = toml::from_str(&serialized).unwrap();
        assert_eq!(reparsed.api.summary_model, "claude-haiku-4-5");
    }

    #[test]
    fn summary_config_defaults_when_absent_and_round_trips() {
        // Old configs (pre-[summary]) must parse with auto-summary disabled
        // and the documented defaults.
        let old: Config = toml::from_str("[api]\nmodel = \"claude-haiku-4-5\"\n").unwrap();
        assert!(!old.summary.auto_generate);
        assert_eq!(old.summary.auto_template, "exec_brief");
        assert_eq!(old.summary.auto_targets, vec!["zh".to_string()]);

        // A saved config must survive serialize → parse unchanged.
        let mut cfg = Config::default();
        cfg.summary.auto_generate = true;
        cfg.summary.auto_template = "minutes".into();
        cfg.summary.auto_targets = vec!["zh".into(), "en".into()];
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: Config = toml::from_str(&serialized).unwrap();
        assert!(reparsed.summary.auto_generate);
        assert_eq!(reparsed.summary.auto_template, "minutes");
        assert_eq!(
            reparsed.summary.auto_targets,
            vec!["zh".to_string(), "en".to_string()]
        );
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

    // ---- [language] table ----

    #[test]
    fn old_config_without_language_table_defaults_zh_en_vi() {
        let old: Config = toml::from_str("[api]\nmodel = \"claude-haiku-4-5\"\n").unwrap();
        assert_eq!(old.language.source, "zh");
        assert_eq!(
            old.language.target_slots,
            vec!["en".to_string(), "vi".to_string()]
        );
        assert_eq!(
            old.effective_targets(),
            vec!["en".to_string(), "vi".to_string()]
        );
    }

    #[test]
    fn language_config_round_trips() {
        let mut cfg = Config::default();
        cfg.language.source = "ja".into();
        cfg.language.target_slots = vec!["zh".into(), "en".into()];
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: Config = toml::from_str(&serialized).unwrap();
        assert_eq!(reparsed.language.source, "ja");
        assert_eq!(
            reparsed.language.target_slots,
            vec!["zh".to_string(), "en".to_string()]
        );
    }

    #[test]
    fn effective_targets_dedupes_and_skips_empty() {
        let mut cfg = Config::default();
        cfg.language.target_slots = vec!["en".into(), "".into()];
        assert_eq!(cfg.effective_targets(), vec!["en".to_string()]);
        cfg.language.target_slots = vec!["en".into(), "en".into()];
        assert_eq!(cfg.effective_targets(), vec!["en".to_string()]);
    }

    // ---- sanitize_language ----

    #[test]
    fn sanitize_fixes_invalid_source() {
        let mut cfg = Config::default();
        cfg.language.source = "xx".into();
        cfg.sanitize_language();
        assert_eq!(cfg.language.source, "zh");
    }

    #[test]
    fn sanitize_forces_exactly_two_slots() {
        let mut cfg = Config::default();
        cfg.language.target_slots = vec!["en".into(), "vi".into(), "ja".into()];
        cfg.sanitize_language();
        assert_eq!(
            cfg.language.target_slots,
            vec!["en".to_string(), "vi".to_string()]
        );

        let mut empty = Config::default();
        empty.language.target_slots = vec![];
        empty.sanitize_language();
        assert_eq!(empty.language.target_slots.len(), 2);
        assert_eq!(empty.language.target_slots[0], "en"); // slot A always filled
        assert_eq!(empty.language.target_slots[1], ""); // slot B stays closed
    }

    #[test]
    fn sanitize_clears_slot_equal_to_source_and_refills_a() {
        let mut cfg = Config::default();
        cfg.language.source = "zh".into();
        cfg.language.target_slots = vec!["zh".into(), "en".into()];
        cfg.sanitize_language();
        assert_eq!(cfg.language.target_slots[1], "en");
        // slot A ("zh"==source) was cleared, then refilled with a valid code
        // that is neither the source nor a duplicate of slot B.
        let a = &cfg.language.target_slots[0];
        assert!(languages::is_valid(a));
        assert_ne!(a, "zh");
        assert_ne!(a, "en");
    }

    #[test]
    fn sanitize_clears_duplicate_slot() {
        let mut cfg = Config::default();
        cfg.language.target_slots = vec!["en".into(), "en".into()];
        cfg.sanitize_language();
        assert_eq!(cfg.language.target_slots[0], "en");
        assert_eq!(cfg.language.target_slots[1], "");
    }

    #[test]
    fn sanitize_fills_slot_a_with_zh_when_source_is_en() {
        let mut cfg = Config::default();
        cfg.language.source = "en".into();
        cfg.language.target_slots = vec!["".into(), "vi".into()];
        cfg.sanitize_language();
        assert_eq!(cfg.language.target_slots[0], "zh");
        assert_eq!(cfg.language.target_slots[1], "vi");
    }

    #[test]
    fn sanitize_filters_summary_auto_targets_to_registry() {
        let mut cfg = Config::default();
        cfg.summary.auto_targets = vec!["zh".into(), "xx".into(), "ja".into()];
        cfg.sanitize_language();
        assert_eq!(
            cfg.summary.auto_targets,
            vec!["zh".to_string(), "ja".to_string()]
        );
    }

    // ---- glossary v2 migration / mirrors / precedence ----

    #[test]
    fn glossary_v1_entry_seeds_translations_and_keeps_mirrors() {
        let toml_str = "\
[[glossaries]]\n\
name = \"預設\"\n\
source_lang = \"zh\"\n\
[[glossaries.entries]]\n\
term = \"紫微斗數\"\n\
en = \"Zi Wei Dou Shu\"\n\
vi = \"Tử Vi Đẩu Số\"\n";
        let mut cfg: Config = toml::from_str(toml_str).unwrap();
        assert!(cfg.glossaries[0].entries[0].translations.is_empty());
        cfg.migrate_glossary_entries();
        let e = &cfg.glossaries[0].entries[0];
        assert_eq!(e.translations.get("en").map(String::as_str), Some("Zi Wei Dou Shu"));
        assert_eq!(e.translations.get("vi").map(String::as_str), Some("Tử Vi Đẩu Số"));
        // mirrors intact for downgrade
        assert_eq!(e.en, "Zi Wei Dou Shu");
        assert_eq!(e.vi, "Tử Vi Đẩu Số");
    }

    #[test]
    fn glossary_v2_entry_with_ja_round_trips() {
        let mut translations = BTreeMap::new();
        translations.insert("en".to_string(), "Zi Wei Dou Shu".to_string());
        translations.insert("ja".to_string(), "紫微斗数".to_string());
        let mut cfg = Config::default();
        cfg.glossaries.push(GlossaryBook {
            name: "x".into(),
            source_lang: "zh".into(),
            entries: vec![GlossaryEntry {
                term: "紫微斗數".into(),
                translations,
                ..Default::default()
            }],
        });
        cfg.active_glossary = Some("x".into());
        cfg.migrate_glossary_entries();
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: Config = toml::from_str(&serialized).unwrap();
        let e = &reparsed.glossaries[0].entries[0];
        assert_eq!(e.translations.get("ja").map(String::as_str), Some("紫微斗数"));
        assert_eq!(e.translations.get("en").map(String::as_str), Some("Zi Wei Dou Shu"));
    }

    #[test]
    fn glossary_translations_win_over_mirrors() {
        let mut translations = BTreeMap::new();
        translations.insert("en".to_string(), "NewEn".to_string());
        let mut cfg = Config::default();
        cfg.glossaries.push(GlossaryBook {
            name: "x".into(),
            source_lang: "zh".into(),
            entries: vec![GlossaryEntry {
                term: "詞".into(),
                en: "OldEn".into(),
                vi: "OldVi".into(),
                translations,
                ..Default::default()
            }],
        });
        cfg.active_glossary = Some("x".into());
        cfg.migrate_glossary_entries();
        let e = &cfg.glossaries[0].entries[0];
        // Non-empty map is authoritative; mirrors re-derived from it.
        assert_eq!(e.translations.get("en").map(String::as_str), Some("NewEn"));
        assert_eq!(e.en, "NewEn");
        assert_eq!(e.vi, ""); // vi absent from map → mirror cleared
    }

    #[test]
    fn glossary_serialized_toml_carries_translations_and_mirrors() {
        let mut cfg = cfg_with_book("x", vec![entry("詞", &[], "Term", "Tu")]);
        cfg.migrate_glossary_entries();
        let serialized = toml::to_string(&cfg).unwrap();
        assert!(
            serialized.contains("translations"),
            "translations map missing: {serialized}"
        );
        assert!(
            serialized.contains("en = \"Term\""),
            "en mirror missing: {serialized}"
        );
        assert!(
            serialized.contains("vi = \"Tu\""),
            "vi mirror missing: {serialized}"
        );
    }

    // ---- glossary_applies gating + registry carrier ----

    #[test]
    fn glossary_does_not_apply_when_source_differs_from_book() {
        let mut cfg = cfg_with_book(
            "x",
            vec![entry("紫微斗數", &["紫薇斗數"], "Zi Wei Dou Shu", "Tử Vi Đẩu Số")],
        );
        cfg.language.source = "ja".into(); // book is zh → does not apply
        assert!(!cfg.glossary_applies());
        assert!(cfg.whisper_initial_prompt().is_none());
        assert_eq!(cfg.apply_glossary_aliases("紫薇斗數"), "紫薇斗數");
        assert_eq!(cfg.render_glossary_section("en"), "");
    }

    #[test]
    fn glossary_section_uses_source_neutral_header() {
        let cfg = cfg_with_book("x", vec![entry("紫微斗數", &[], "Zi Wei Dou Shu", "")]);
        let en = cfg.render_glossary_section("en");
        assert!(en.contains("術語表（以下原文術語一律使用對應譯法，不要意譯）："));
        assert!(!en.contains("以下中文"));
    }

    #[test]
    fn carrier_uses_source_registry_ja_join() {
        let mut cfg = Config::default();
        cfg.language.source = "ja".into();
        cfg.glossaries.push(GlossaryBook {
            name: "x".into(),
            source_lang: "ja".into(),
            entries: vec![entry("会議", &[], "", ""), entry("議事録", &[], "", "")],
        });
        cfg.active_glossary = Some("x".into());
        let p = cfg.whisper_initial_prompt().unwrap();
        assert!(p.starts_with("この音声には"), "ja carrier: {p}");
        assert!(p.contains("会議、議事録"), "ja join 、: {p}");
    }

    #[test]
    fn carrier_uses_source_registry_en_join() {
        let mut cfg = Config::default();
        cfg.language.source = "en".into();
        cfg.glossaries.push(GlossaryBook {
            name: "x".into(),
            source_lang: "en".into(),
            entries: vec![
                entry("MeetingCast", &[], "", ""),
                entry("Deepgram", &[], "", ""),
            ],
        });
        cfg.active_glossary = Some("x".into());
        let p = cfg.whisper_initial_prompt().unwrap();
        assert!(p.starts_with("This recording may contain"), "en carrier: {p}");
        assert!(p.contains("MeetingCast, Deepgram"), "en join \", \": {p}");
    }
}
