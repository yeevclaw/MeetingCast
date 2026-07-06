use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::Mutex;

mod config;
mod errors;
mod keycheck;
mod session;
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
        .manage(translator::new_context())
        .manage(session::new_recorder())
        .invoke_handler(tauri::generate_handler![
            sidecar::start_stt,
            sidecar::stop_stt,
            sidecar::prewarm_sidecar,
            sidecar::restart_sidecar,
            sidecar::sidecar_ready,
            sidecar::list_audio_devices,
            sidecar::demo_wav_path,
            translator::translate,
            translator::clear_translation_context,
            translator::generate_summary,
            translator::read_summary,
            config::get_config,
            config::set_config,
            keycheck::validate_anthropic_key,
            keycheck::validate_deepgram_key,
            errors::open_config_folder,
            errors::open_errors_log,
            errors::open_mic_settings,
            session::session_append_utterance,
            session::list_sessions,
            session::get_session_transcript,
            session::get_session_meta,
            session::delete_session,
            session::open_session_folder,
            session::export_session_markdown,
            session::reveal_in_finder,
            session::reveal_session_summary,
        ])
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(toggle_shortcut.clone()) {
                errors::record(
                    "global_shortcut_register",
                    &format!("failed to register Cmd+Shift+M: {e}"),
                    None,
                );
            }

            // Pre-warm the sidecar at launch so the user doesn't pay the
            // PyInstaller bundle cold-start (~10s) when they click 開始錄音.
            // The frontend shows a "preparing" overlay while we wait for the
            // child's first `ready` event. Use Tauri's async runtime since
            // setup() is a sync context — tokio::spawn would panic here.
            let app_handle = app.handle().clone();
            let mgr: sidecar::SharedManager = app.state::<sidecar::SharedManager>().inner().clone();
            let cfg: config::SharedConfig = app.state::<config::SharedConfig>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::prewarm(app_handle.clone(), mgr, cfg).await {
                    errors::record("sidecar_prewarm_failed", &e, None);
                    // Surface the failure to the frontend — without this the
                    // prewarm overlay's spawn row spins forever because the
                    // sidecar never comes up to emit its own prewarm events.
                    let _ = app_handle.emit(
                        "stt:prewarm",
                        serde_json::json!({ "step": "spawn", "state": "error", "message": e }),
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                // Best-effort graceful shutdown: ask the sidecar to wind down
                // its STT loop and exit cleanly. Without this, kill_on_drop
                // sends SIGKILL the moment the manager is dropped, which can
                // leave CoreAudio holding the mic for a few seconds and
                // skips any cleanup the Python child wanted to do.
                let mgr_state: tauri::State<sidecar::SharedManager> =
                    app.state::<sidecar::SharedManager>();
                let mgr = mgr_state.inner().clone();
                tauri::async_runtime::block_on(async move {
                    // 500 ms cap — we don't want to hang the app on quit
                    // even if the sidecar is wedged.
                    let _ = tokio::time::timeout(Duration::from_millis(500), async {
                        mgr.lock().await.request_shutdown().await;
                    })
                    .await;
                });
            }
        });
}
