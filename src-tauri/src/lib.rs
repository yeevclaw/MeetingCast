use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

mod config;
mod sidecar;
mod translator;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev: seed env from prototype/.env so config.seed_from_dotenv can pick it up.
    let env_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("prototype/.env"))
        .unwrap_or_default();
    let _ = dotenvy::from_path(&env_path);

    let mut cfg = config::load();
    config::seed_from_dotenv(&mut cfg);
    let shared_config: config::SharedConfig = Arc::new(Mutex::new(cfg));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage::<sidecar::SharedManager>(Arc::new(Mutex::new(sidecar::SidecarManager::new())))
        .manage(shared_config)
        .invoke_handler(tauri::generate_handler![
            sidecar::start_stt,
            sidecar::stop_stt,
            translator::translate,
            config::get_config,
            config::set_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
