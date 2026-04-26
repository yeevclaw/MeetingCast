use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarEvent {
    Ready,
    Started,
    Stopped,
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
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self { child: None, stdin: None }
    }

    /// Resolve project root from src-tauri/'s manifest dir, used to locate
    /// the dev-mode Python venv and sidecar script.
    fn project_root() -> PathBuf {
        // CARGO_MANIFEST_DIR points at src-tauri/; parent is project root.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub async fn spawn(&mut self, app: AppHandle) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }

        let root = Self::project_root();
        let python = root.join("prototype/.venv/bin/python");
        let script = root.join("python-sidecar/stt_engine.py");

        if !python.exists() {
            return Err(format!("python venv not found: {}", python.display()));
        }
        if !script.exists() {
            return Err(format!("sidecar script not found: {}", script.display()));
        }

        let mut cmd = Command::new(&python);
        cmd.arg(&script)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        // Stdout: parse JSON events, fan out to Tauri events
        let app_clone = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<SidecarEvent>(&line) {
                    Ok(event) => emit_event(&app_clone, event),
                    Err(e) => eprintln!("[sidecar] invalid json: {line:?} ({e})"),
                }
            }
        });

        // Stderr: log only (tqdm progress, Python warnings)
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[sidecar stderr] {line}");
            }
        });

        self.child = Some(child);
        self.stdin = Some(stdin);
        Ok(())
    }

    pub async fn send(&mut self, msg: &serde_json::Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "sidecar not running".to_string())?;
        let line = format!("{}\n", msg);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin: {e}"))?;
        Ok(())
    }
}

fn emit_event(app: &AppHandle, event: SidecarEvent) {
    let _ = match &event {
        SidecarEvent::Transcript { .. } => app.emit("transcript", &event),
        SidecarEvent::Started => app.emit("stt:started", ()),
        SidecarEvent::Stopped => app.emit("stt:stopped", ()),
        SidecarEvent::Ready => app.emit("stt:ready", ()),
        SidecarEvent::Error { message } => app.emit("stt:error", message),
    };
}

pub type SharedManager = Arc<Mutex<SidecarManager>>;

#[tauri::command]
pub async fn start_stt(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    backend: String,
    source: serde_json::Value,
    language: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.spawn(app.clone()).await?;
    let cmd = serde_json::json!({
        "type": "start",
        "backend": backend,
        "source": source,
        "language": language.unwrap_or_else(|| "zh".into()),
    });
    mgr.send(&cmd).await
}

#[tauri::command]
pub async fn stop_stt(state: tauri::State<'_, SharedManager>) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.send(&serde_json::json!({"type": "stop"})).await
}
