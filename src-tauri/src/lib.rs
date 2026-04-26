use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

mod sidecar;
mod translator;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev: load API keys from prototype/.env. Phase 6 settings UI replaces this.
    let env_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("prototype/.env"))
        .unwrap_or_default();
    let _ = dotenvy::from_path(&env_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage::<sidecar::SharedManager>(Arc::new(Mutex::new(sidecar::SidecarManager::new())))
        .invoke_handler(tauri::generate_handler![
            sidecar::start_stt,
            sidecar::stop_stt,
            translator::translate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
