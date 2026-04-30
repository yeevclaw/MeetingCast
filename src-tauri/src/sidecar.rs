use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

use crate::config::SharedConfig;
use crate::errors;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_BACKOFF_SECS: u64 = 2;
const STDERR_TAIL_LINES: usize = 50;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarEvent {
    Ready,
    Started,
    Stopped,
    ModelLoading,
    ModelReady,
    /// Per-stage progress for startup prewarm (model load + mic init etc.)
    /// so the frontend can render a checklist instead of a single spinner.
    Prewarm {
        step: String,
        state: String,
        #[serde(default)]
        message: Option<String>,
    },
    Transcript {
        text: String,
        is_final: bool,
        t_start: f64,
        t_end: f64,
    },
    Error {
        message: String,
    },
}

pub struct SidecarManager {
    stdin: Option<ChildStdin>,
    last_start: Option<Value>,
    restart_attempts: u32,
    starting: bool,
    intentional_stop: bool,
    stderr_tail: VecDeque<String>,
    /// True between the moment the child emits its first `ready` event and
    /// the moment it exits. Lets the frontend distinguish "warming up the
    /// PyInstaller bundle (~10s)" from "ready to record".
    ready: bool,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            stdin: None,
            last_start: None,
            restart_attempts: 0,
            starting: false,
            intentional_stop: false,
            stderr_tail: VecDeque::with_capacity(STDERR_TAIL_LINES),
            ready: false,
        }
    }
}

pub type SharedManager = Arc<Mutex<SidecarManager>>;

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

const SIDECAR_BIN_NAME: &str = "stt_engine";

/// Resolve which binary to spawn for the STT sidecar.
/// Production (bundled): the PyInstaller binary that Tauri's externalBin
/// places alongside the main executable as `stt_engine-<target-triple>`
/// (or sometimes the bare `stt_engine` after bundling). Falls back to the
/// dev venv for `pnpm tauri dev` / `cargo run`.
///
/// Returns (program, leading_args). Leading args are arguments inserted
/// before any caller-supplied args — used to pass the script path when
/// running via the dev-mode Python interpreter.
fn locate_sidecar() -> Result<(PathBuf, Vec<String>), String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri's externalBin places the binary in the same directory as
            // the main exe. The filename may or may not have the target-
            // triple suffix depending on bundling stage; check both.
            let target_triple = format!(
                "{}-apple-darwin",
                if cfg!(target_arch = "aarch64") {
                    "aarch64"
                } else {
                    "x86_64"
                }
            );
            for candidate in [
                dir.join(SIDECAR_BIN_NAME),
                dir.join(format!("{}-{}", SIDECAR_BIN_NAME, target_triple)),
            ] {
                if candidate.exists() {
                    return Ok((candidate, vec![]));
                }
            }
        }
    }

    // Dev fallback: prototype/.venv/bin/python + python-sidecar/stt_engine.py
    let root = project_root();
    let python = root.join("prototype/.venv/bin/python");
    let script = root.join("python-sidecar/stt_engine.py");
    if !python.exists() {
        return Err(format!(
            "sidecar binary not found in app bundle and dev venv missing: {}",
            python.display()
        ));
    }
    if !script.exists() {
        return Err(format!("sidecar script not found: {}", script.display()));
    }
    Ok((python, vec![script.to_string_lossy().to_string()]))
}

type SpawnFut = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

fn spawn_inner(app: AppHandle, mgr: SharedManager, cfg_arc: SharedConfig) -> SpawnFut {
    Box::pin(spawn_inner_body(app, mgr, cfg_arc))
}

async fn spawn_inner_body(
    app: AppHandle,
    mgr: SharedManager,
    cfg_arc: SharedConfig,
) -> Result<(), String> {
    let (program, leading_args) = locate_sidecar()?;
    let root = project_root();

    let deepgram_key = {
        let cfg = cfg_arc.lock().await;
        cfg.api.deepgram_api_key.clone()
    };

    let mut cmd = Command::new(&program);
    for arg in &leading_args {
        cmd.arg(arg);
    }
    cmd.current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !deepgram_key.is_empty() {
        cmd.env("DEEPGRAM_API_KEY", deepgram_key);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("spawn sidecar: {e}");
        errors::record("sidecar_spawn_failed", &msg, None);
        msg
    })?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    {
        let mut m = mgr.lock().await;
        m.stdin = Some(stdin);
        m.starting = false;
        m.intentional_stop = false;
        m.stderr_tail.clear();
    }

    // stdout: parse JSON events
    let app_o = app.clone();
    let mgr_o = mgr.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<SidecarEvent>(&line) {
                Ok(event) => {
                    if matches!(event, SidecarEvent::Ready) {
                        mgr_o.lock().await.ready = true;
                    }
                    emit_event(&app_o, event);
                }
                Err(e) => eprintln!("[sidecar] invalid json: {line:?} ({e})"),
            }
        }
    });

    // stderr: accumulate ring buffer + log
    let mgr_e = mgr.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[sidecar stderr] {line}");
            let mut m = mgr_e.lock().await;
            m.stderr_tail.push_back(line);
            while m.stderr_tail.len() > STDERR_TAIL_LINES {
                m.stderr_tail.pop_front();
            }
        }
    });

    // watchdog: wait for child exit, decide restart or stop
    let app_w = app.clone();
    let mgr_w = mgr.clone();
    let cfg_w = cfg_arc.clone();
    tokio::spawn(async move {
        let exit = child.wait().await;
        let exit_repr = format!("{:?}", exit);

        let (intentional, attempts, last_start, tail) = {
            let mut m = mgr_w.lock().await;
            m.stdin = None;
            m.starting = false;
            m.ready = false;
            (
                m.intentional_stop,
                m.restart_attempts,
                m.last_start.clone(),
                m.stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n"),
            )
        };

        if intentional {
            let _ = app_w.emit("stt:stopped", ());
            return;
        }

        // Unintentional exit = crash
        let next_attempt = attempts + 1;
        errors::record(
            "sidecar_crash",
            &format!("exit: {exit_repr}"),
            Some(serde_json::json!({
                "attempt": next_attempt,
                "stderr_tail": tail,
                "last_start": last_start,
            })),
        );
        let _ = app_w.emit(
            "stt:crashed",
            serde_json::json!({
                "attempt": next_attempt,
                "max": MAX_RESTART_ATTEMPTS,
                "stderr_tail": tail,
            }),
        );

        if next_attempt > MAX_RESTART_ATTEMPTS {
            errors::record(
                "sidecar_fatal",
                "max restart attempts reached",
                Some(serde_json::json!({ "attempts": next_attempt })),
            );
            let _ = app_w.emit("stt:fatal", "辨識引擎連續崩潰，請檢查 errors.log");
            let mut m = mgr_w.lock().await;
            m.restart_attempts = 0;
            m.starting = false;
            return;
        }

        {
            let mut m = mgr_w.lock().await;
            m.restart_attempts = next_attempt;
            m.starting = true;
        }
        tokio::time::sleep(Duration::from_secs(RESTART_BACKOFF_SECS)).await;
        {
            let mut m = mgr_w.lock().await;
            if m.intentional_stop || m.last_start.is_none() {
                m.starting = false;
                let _ = app_w.emit("stt:stopped", ());
                return;
            }
        }
        match spawn_inner(app_w.clone(), mgr_w.clone(), cfg_w.clone()).await {
            Ok(()) => {
                // Re-issue last start command so user picks up where they left off
                if let Some(cmd) = last_start {
                    let mut m = mgr_w.lock().await;
                    if let Some(stdin) = m.stdin.as_mut() {
                        let line = format!("{cmd}\n");
                        let _ = stdin.write_all(line.as_bytes()).await;
                        let _ = stdin.flush().await;
                    }
                }
                let _ = app_w.emit(
                    "stt:restored",
                    serde_json::json!({ "attempt": next_attempt }),
                );
            }
            Err(e) => {
                {
                    let mut m = mgr_w.lock().await;
                    m.starting = false;
                }
                errors::record("sidecar_respawn_failed", &e, None);
                let _ = app_w.emit("stt:fatal", e);
            }
        }
    });

    Ok(())
}

fn emit_event(app: &AppHandle, event: SidecarEvent) {
    let _ = match &event {
        SidecarEvent::Transcript { .. } => app.emit("transcript", &event),
        SidecarEvent::Started => app.emit("stt:started", ()),
        SidecarEvent::Stopped => app.emit("stt:stopped", ()),
        SidecarEvent::Ready => app.emit("stt:ready", ()),
        SidecarEvent::ModelLoading => app.emit("stt:model_loading", ()),
        SidecarEvent::ModelReady => app.emit("stt:model_ready", ()),
        SidecarEvent::Prewarm { step, state, message } => app.emit(
            "stt:prewarm",
            serde_json::json!({
                "step": step,
                "state": state,
                "message": message,
            }),
        ),
        SidecarEvent::Error { message } => {
            errors::record("sidecar_protocol_error", message, None);
            app.emit("stt:error", message)
        }
    };
}

#[tauri::command]
pub async fn start_stt(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
    backend: String,
    source: Value,
    language: Option<String>,
) -> Result<(), String> {
    let need_spawn = {
        let mut m = state.lock().await;
        m.restart_attempts = 0;
        m.intentional_stop = false;
        if m.stdin.is_none() {
            if m.starting {
                return Err("sidecar is starting".into());
            }
            m.starting = true;
            true
        } else {
            false
        }
    };
    if need_spawn {
        if let Err(e) =
            spawn_inner(app.clone(), state.inner().clone(), config.inner().clone()).await
        {
            let mut m = state.lock().await;
            m.starting = false;
            return Err(e);
        }
    }

    let deepgram_api_key = {
        let cfg = config.lock().await;
        cfg.api.deepgram_api_key.clone()
    };
    let cmd = serde_json::json!({
        "type": "start",
        "backend": backend,
        "source": source,
        "language": language.unwrap_or_else(|| "zh".into()),
        "api": {
            "deepgram_api_key": deepgram_api_key,
        },
    });
    {
        let mut m = state.lock().await;
        if let Some(stdin) = m.stdin.as_mut() {
            let line = format!("{cmd}\n");
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write stdin: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("flush stdin: {e}"))?;
            m.last_start = Some(cmd.clone());
            let _ = app.emit("session:reset", ());
        } else {
            return Err("sidecar still not running".into());
        }
    }
    Ok(())
}

/// Spawn the sidecar daemon if it is not already running, without sending a
/// `start` command. Used at app launch to amortize the ~10s PyInstaller cold
/// start against the user's idle time before they click 開始錄音.
pub async fn prewarm(
    app: AppHandle,
    mgr: SharedManager,
    cfg: SharedConfig,
) -> Result<(), String> {
    let need_spawn = mgr.lock().await.stdin.is_none();
    if !need_spawn {
        return Ok(());
    }
    spawn_inner(app, mgr, cfg).await
}

#[tauri::command]
pub async fn prewarm_sidecar(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
) -> Result<(), String> {
    prewarm(app, state.inner().clone(), config.inner().clone()).await
}

/// Whether the sidecar has emitted its initial `ready` event and can accept
/// a `start` command without first paying the cold-start cost.
#[tauri::command]
pub async fn sidecar_ready(state: tauri::State<'_, SharedManager>) -> Result<bool, String> {
    Ok(state.lock().await.ready)
}

#[tauri::command]
pub async fn stop_stt(state: tauri::State<'_, SharedManager>) -> Result<(), String> {
    let mut m = state.lock().await;
    m.intentional_stop = true;
    m.last_start = None;
    let cmd = serde_json::json!({"type": "stop"});
    if let Some(stdin) = m.stdin.as_mut() {
        let line = format!("{cmd}\n");
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.flush().await;
    }
    Ok(())
}
