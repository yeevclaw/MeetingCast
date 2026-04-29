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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub api: ApiConfig,
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
