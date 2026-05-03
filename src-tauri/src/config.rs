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
            model: default_model(),
        }
    }
}

/// One glossary entry. Keys in the [glossary] map are the canonical
/// source-language (zh) terms. `aliases` is a list of common Whisper
/// mistranscriptions of that term (e.g. "紫微斗數" often comes out as
/// "紫薇斗數"); these get string-replaced back to the canonical form before
/// the transcript is emitted to the UI. The per-target translation is taken
/// from `en` / `vi` — empty means "no override, model decides".
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GlossaryEntry {
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub en: String,
    #[serde(default)]
    pub vi: String,
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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub api: ApiConfig,
    #[serde(default)]
    pub audio: AudioConfig,
    /// BTreeMap so config.toml round-trips with stable key order.
    #[serde(default)]
    pub glossary: BTreeMap<String, GlossaryEntry>,
}

impl Config {
    /// Build the Chinese-language initial_prompt fed to mlx-whisper's decoder.
    /// The canonical term keys are joined with 、 inside a leading carrier
    /// sentence ("本段語音可能包含以下術語：…。") — Whisper's prompt-conditioning
    /// works best when the prompt is grammatically natural, not a bare list.
    /// Capped at 30 terms because the decoder prompt is hard-limited to ~224
    /// BPE tokens and longer prompts tend to make the decoder hallucinate
    /// continuations of the prompt itself.
    /// Aliases are deliberately excluded — they're mistranscriptions we want
    /// to bias AGAINST, not toward; they're applied via post-hoc substitution.
    pub fn apply_glossary_aliases(&self, text: &str) -> String {
        if self.glossary.is_empty() {
            return text.to_string();
        }
        // Sort aliases by length descending so longer matches win — without
        // this, a short alias that's a substring of a longer one (rare but
        // possible: "AI" inside "AI助理") would clobber the longer match.
        let mut pairs: Vec<(&String, &String)> = self
            .glossary
            .iter()
            .flat_map(|(term, entry)| entry.aliases.iter().map(move |a| (a, term)))
            .filter(|(a, _)| !a.is_empty())
            .collect();
        pairs.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let mut out = text.to_string();
        for (alias, canonical) in pairs {
            if alias != canonical {
                out = out.replace(alias.as_str(), canonical.as_str());
            }
        }
        out
    }

    pub fn whisper_initial_prompt(&self) -> Option<String> {
        if self.glossary.is_empty() {
            return None;
        }
        let terms: Vec<&str> = self
            .glossary
            .keys()
            .take(30)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
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
}

pub type SharedConfig = Arc<Mutex<Config>>;

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("MeetingCast/config.toml"))
        .unwrap_or_else(|| PathBuf::from("config.toml"))
}

pub fn load() -> Config {
    let path = config_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| toml::from_str::<Config>(&s).ok())
        .unwrap_or_default()
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
