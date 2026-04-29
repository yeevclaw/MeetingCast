use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::Mutex;

mod config;
mod errors;
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

    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyM);
    let handler_shortcut = toggle_shortcut.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &handler_shortcut {
                        let _ = app.emit("hotkey:toggle", ());
                    }
                })
                .build(),
        )
        .manage::<sidecar::SharedManager>(Arc::new(Mutex::new(sidecar::SidecarManager::new())))
        .manage(shared_config)
        .invoke_handler(tauri::generate_handler![
            sidecar::start_stt,
            sidecar::stop_stt,
            translator::translate,
            config::get_config,
            config::set_config,
            errors::open_config_folder,
            errors::open_errors_log,
        ])
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(toggle_shortcut.clone()) {
                errors::record(
                    "global_shortcut_register",
                    &format!("failed to register Cmd+Shift+M: {e}"),
                    None,
                );
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
