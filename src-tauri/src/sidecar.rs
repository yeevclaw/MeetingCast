use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::config::SharedConfig;
use crate::errors;
use crate::languages;
use crate::session::{self, SharedRecorder};
use crate::traces;
use crate::translator::TranslationContext;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_BACKOFF_SECS: u64 = 2;
const STDERR_TAIL_LINES: usize = 50;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioDevice {
    pub name: String,
    #[serde(default)]
    pub channels: u32,
}

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
        /// Bytes fetched so far — only present on `state == "progress"` for
        /// the model-download step. Additive/optional so old and new sidecars
        /// stay wire-compatible in both directions.
        #[serde(default)]
        downloaded_bytes: Option<u64>,
        #[serde(default)]
        total_bytes: Option<u64>,
    },
    Transcript {
        text: String,
        is_final: bool,
        t_start: f64,
        t_end: f64,
    },
    /// Response to a `list_devices` command — consumed by the matching
    /// oneshot in `list_audio_devices`, never forwarded to the frontend
    /// as a Tauri event.
    Devices {
        devices: Vec<AudioDevice>,
    },
    /// Soft warning the sidecar wants to surface to the user without
    /// aborting the session — e.g. mic device fallback. Distinct from
    /// `Error` so the UI can render it as a non-fatal toast.
    Warning {
        message: String,
    },
    Error {
        message: String,
    },
    /// A local-backend hallucination-gate skip. Recorded to traces.jsonl for
    /// offline tuning — deliberately NOT forwarded to the frontend, and (being
    /// a non-transcript) it must never reset the idle-activity clock.
    Diag {
        gate: String,
        #[serde(default)]
        t_start: Option<f64>,
        #[serde(default)]
        detail: Option<serde_json::Value>,
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
    /// One-shot for the most recent `list_devices` request. The stdout reader
    /// fulfils it when it sees a `devices` event; old senders are dropped
    /// (resolving with an error on the awaiting side) if a second request
    /// arrives before the first response.
    pending_devices: Option<oneshot::Sender<Vec<AudioDevice>>>,
    /// Wall-clock time of the most recent non-empty final transcript. `Some`
    /// only between a successful `start_stt` and the next `stop_stt` (or the
    /// idle watcher firing). The watcher compares `now - last_activity_at`
    /// against the configured idle threshold; the stdout reader resets it on
    /// every speech-bearing final, so background noise alone can't keep an
    /// expensive cloud session alive after the user walked away.
    last_activity_at: Option<Instant>,
    /// Task handle of the per-session idle watcher. Aborted on stop so it
    /// doesn't keep ticking after the session ends and then auto-stop a
    /// session that's already finished.
    idle_watcher: Option<JoinHandle<()>>,
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
            pending_devices: None,
            last_activity_at: None,
            idle_watcher: None,
        }
    }

    /// Mark the next exit as intentional (so the watchdog doesn't try to
    /// restart) and write a shutdown command into the child's stdin. Used
    /// by lib.rs's RunEvent::ExitRequested hook for a graceful quit.
    pub async fn request_shutdown(&mut self) {
        self.intentional_stop = true;
        self.last_activity_at = None;
        if let Some(h) = self.idle_watcher.take() {
            h.abort();
        }
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
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
///
/// Priority:
///   1. Dev venv (`prototype/.venv/bin/python` + `python-sidecar/stt_engine.py`)
///      — if both exist, prefer them. This means dev mode (`pnpm tauri dev` /
///      `cargo run`) always picks up live Python edits and never gets shadowed
///      by a stale PyInstaller copy that Tauri's externalBin re-staged into
///      `target/debug/`. In a release `.app` bundle these paths don't resolve
///      (there is no project tree next to the executable), so this branch is
///      naturally inert in production.
///   2. Bundled binary (`stt_engine` or `stt_engine-<triple>` next to the
///      main executable) — production fallback.
///
/// Returns (program, leading_args). Leading args are arguments inserted
/// before any caller-supplied args — used to pass the script path when
/// running via the dev-mode Python interpreter.
/// Resolve the sidecar program + leading args + working directory to use
/// when spawning. The cwd has to come back from this function (rather than
/// always being `project_root()` like before) because in a release `.app`
/// installed on a remote user's Mac, `project_root()` is the developer's
/// build-time path embedded by `env!("CARGO_MANIFEST_DIR")` — that path
/// doesn't exist on the user's machine, and `Command::current_dir(<missing>)`
/// makes posix_spawn fail with ENOENT after fork (surfaces as the misleading
/// "spawn sidecar: No such file or directory"). Returning a real cwd in
/// each branch fixes that.
fn locate_sidecar() -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    let root = project_root();
    let python = root.join("prototype/.venv/bin/python");
    let script = root.join("python-sidecar/stt_engine.py");
    if python.exists() && script.exists() {
        // Dev mode: cwd = repo root so any relative `prototype/samples/...`
        // path passed by the UI for WAV demo mode resolves correctly.
        return Ok((
            python,
            vec![script.to_string_lossy().to_string()],
            root,
        ));
    }

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
                    // Production: cwd = the binary's own folder
                    // (`Contents/MacOS/`). It's guaranteed to exist on the
                    // user's machine (we just resolved it) and stt_engine
                    // doesn't depend on cwd for any of its own paths.
                    return Ok((candidate, vec![], dir.to_path_buf()));
                }
            }
        }
    }

    Err(format!(
        "sidecar not found: neither dev venv ({}) nor a bundled binary alongside the main exe is present",
        python.display()
    ))
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
    let (program, leading_args, cwd) = locate_sidecar()?;

    let (deepgram_key, openai_key) = {
        let cfg = cfg_arc.lock().await;
        (cfg.api.deepgram_api_key.clone(), cfg.api.openai_api_key.clone())
    };

    let mut cmd = Command::new(&program);
    for arg in &leading_args {
        cmd.arg(arg);
    }
    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !deepgram_key.is_empty() {
        cmd.env("DEEPGRAM_API_KEY", deepgram_key);
    }
    if !openai_key.is_empty() {
        cmd.env("OPENAI_API_KEY", openai_key);
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
    let cfg_o = cfg_arc.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<SidecarEvent>(&line) {
                Ok(event) => {
                    match event {
                        SidecarEvent::Ready => {
                            mgr_o.lock().await.ready = true;
                            emit_event(&app_o, SidecarEvent::Ready);
                        }
                        // `devices` is RPC-style — route it to whoever is awaiting
                        // the oneshot. Don't emit a Tauri event for it.
                        SidecarEvent::Devices { devices } => {
                            if let Some(tx) = mgr_o.lock().await.pending_devices.take() {
                                let _ = tx.send(devices);
                            }
                        }
                        // Apply alias substitution ONLY to final transcripts —
                        // interim previews change every chunk so the cost would
                        // be paid for output the user barely sees, and a partial
                        // alias inside an interim might trigger a wrong rewrite
                        // that stabilizes once the full word is recognized.
                        SidecarEvent::Transcript { text, is_final, t_start, t_end } if is_final => {
                            let rewritten = cfg_o.lock().await.apply_glossary_aliases(&text);
                            // Reset the idle watcher's activity clock on any
                            // speech-bearing final. Empty transcripts (which
                            // some backends emit on noise) deliberately do NOT
                            // reset — that's the entire point of the auto-stop
                            // (the user walked away, all we hear is fan noise).
                            if !rewritten.trim().is_empty() {
                                let mut m = mgr_o.lock().await;
                                if m.last_activity_at.is_some() {
                                    m.last_activity_at = Some(Instant::now());
                                }
                            }
                            emit_event(
                                &app_o,
                                SidecarEvent::Transcript {
                                    text: rewritten,
                                    is_final,
                                    t_start,
                                    t_end,
                                },
                            );
                        }
                        // Persist to traces.jsonl only. No frontend event and
                        // no idle-clock reset (see the Diag variant docs).
                        SidecarEvent::Diag { gate, t_start, detail } => {
                            traces::record_diag(&gate, t_start, detail);
                        }
                        other => emit_event(&app_o, other),
                    }
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
            // Crash teardown: drop the idle watcher so it doesn't keep
            // ticking against a dead session. The reincarnated child gets
            // a fresh watcher via the re-issued start command below.
            m.last_activity_at = None;
            if let Some(h) = m.idle_watcher.take() {
                h.abort();
            }
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
        SidecarEvent::Prewarm { step, state, message, downloaded_bytes, total_bytes } => app.emit(
            "stt:prewarm",
            serde_json::json!({
                "step": step,
                "state": state,
                "message": message,
                "downloaded_bytes": downloaded_bytes,
                "total_bytes": total_bytes,
            }),
        ),
        SidecarEvent::Warning { message } => app.emit("stt:warning", message),
        SidecarEvent::Error { message } => {
            errors::record("sidecar_protocol_error", message, None);
            app.emit("stt:error", message)
        }
        // Routed via the oneshot in the stdout reader — should never reach here.
        SidecarEvent::Devices { .. } => Ok(()),
        // Recorded to traces.jsonl in the stdout reader — never emitted.
        SidecarEvent::Diag { .. } => Ok(()),
    };
}

#[tauri::command]
pub async fn start_stt(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
    recorder: tauri::State<'_, SharedRecorder>,
    ctx: tauri::State<'_, TranslationContext>,
    backend: String,
    mut source: Value,
    language: Option<String>,
) -> Result<(), String> {
    // Resolve + validate the source language before spawning anything: default
    // to the configured source, an explicit override wins, and an
    // out-of-registry code fails fast rather than reaching the sidecar.
    let language_str = match language {
        Some(l) => l,
        None => config.lock().await.language.source.clone(),
    };
    if !languages::is_valid(&language_str) {
        return Err(format!("unsupported source language: {language_str}"));
    }
    // Per-language Deepgram code from the registry — an additive protocol
    // field the cloud backend prefers; local/openai backends ignore it.
    let deepgram_language = languages::get(&language_str)
        .map(|l| l.deepgram_code.clone())
        .unwrap_or_else(|| language_str.clone());

    // If source.type == "mic" and the caller didn't specify a device,
    // backfill from config so the user's persisted preference is honored
    // even when the frontend forgets to pass it.
    if source.get("type").and_then(|v| v.as_str()) == Some("mic")
        && source.get("device").is_none()
    {
        let device = config.lock().await.audio.input_device.clone();
        if !device.is_empty() {
            if let Some(obj) = source.as_object_mut() {
                obj.insert("device".into(), Value::String(device));
            }
        }
    }

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

    let (deepgram_api_key, openai_api_key, initial_prompt, idle_minutes) = {
        let cfg = config.lock().await;
        (
            cfg.api.deepgram_api_key.clone(),
            cfg.api.openai_api_key.clone(),
            cfg.whisper_initial_prompt(),
            cfg.idle_auto_stop_minutes,
        )
    };
    let cmd = serde_json::json!({
        "type": "start",
        "backend": backend,
        "source": source,
        "language": language_str,
        "deepgram_language": deepgram_language,
        "detect_language": false,
        "initial_prompt": initial_prompt,
        "api": {
            "deepgram_api_key": deepgram_api_key,
            "openai_api_key": openai_api_key,
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
            // Clear the rolling translation context so a source-language switch
            // (or any fresh start) doesn't carry stale prior-utterance pairs.
            ctx.lock().await.clear();
            let _ = app.emit("session:reset", ());
            // Reset the idle clock and (re)start the per-session watcher. If
            // a previous watcher is somehow still alive (shouldn't happen
            // after a clean stop_stt, but covers the watchdog-restart path),
            // abort it first so we don't have two timers racing.
            m.last_activity_at = Some(Instant::now());
            if let Some(h) = m.idle_watcher.take() {
                h.abort();
            }
            if idle_minutes > 0 {
                let mgr_w = state.inner().clone();
                let app_w = app.clone();
                m.idle_watcher = Some(tokio::spawn(idle_watch_loop(
                    app_w,
                    mgr_w,
                    idle_minutes,
                )));
            }
        } else {
            return Err("sidecar still not running".into());
        }
    }

    // Open a recording session right after the start command goes through.
    // We'd rather record the user's intent timestamp than wait for the first
    // utterance — duration matches what the wall clock UI shows.
    let device = source
        .get("device")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let session_id =
        session::start_session(recorder.inner(), backend, language_str, device).await?;
    let _ = app.emit("session:opened", session_id);
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
    let need_spawn = {
        let mut m = mgr.lock().await;
        if m.stdin.is_some() || m.starting {
            false
        } else {
            m.starting = true;
            true
        }
    };
    if !need_spawn {
        return Ok(());
    }
    if let Err(e) = spawn_inner(app, mgr.clone(), cfg).await {
        mgr.lock().await.starting = false;
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn prewarm_sidecar(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
) -> Result<(), String> {
    prewarm(app, state.inner().clone(), config.inner().clone()).await
}

/// Tear down the current sidecar (intentional, no auto-restart) and spawn a
/// fresh one. Used by the frontend to retry after a prewarm step errored —
/// e.g. model snapshot download interrupted by a flaky network.
#[tauri::command]
pub async fn restart_sidecar(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
) -> Result<(), String> {
    {
        let mut m = state.lock().await;
        // Reset restart_attempts so the watchdog doesn't refuse the new spawn
        // on the basis of stale crash counts from before the user hit retry.
        m.restart_attempts = 0;
        m.request_shutdown().await;
    }
    // Wait briefly for the child to exit cleanly. Polling stdin == None is
    // the cheapest signal that the watchdog has reaped it. Cap at 1 s — if
    // the child is wedged we'd rather force-spawn anyway than block forever.
    for _ in 0..20 {
        if state.lock().await.stdin.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    prewarm(app, state.inner().clone(), config.inner().clone()).await
}

/// Whether the sidecar has emitted its initial `ready` event and can accept
/// a `start` command without first paying the cold-start cost.
#[tauri::command]
pub async fn sidecar_ready(state: tauri::State<'_, SharedManager>) -> Result<bool, String> {
    Ok(state.lock().await.ready)
}

#[tauri::command]
pub async fn stop_stt(
    state: tauri::State<'_, SharedManager>,
    recorder: tauri::State<'_, SharedRecorder>,
) -> Result<Option<String>, String> {
    {
        let mut m = state.lock().await;
        m.intentional_stop = true;
        m.last_start = None;
        m.last_activity_at = None;
        if let Some(h) = m.idle_watcher.take() {
            h.abort();
        }
        let cmd = serde_json::json!({"type": "stop"});
        if let Some(stdin) = m.stdin.as_mut() {
            let line = format!("{cmd}\n");
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }
    // Finalize meta.json on stop. The frontend may still flush a few
    // pending utterances after this — those are silently dropped because
    // the recorder slot is already empty (see session_append_utterance).
    // That's the right tradeoff: a meta.json with one fewer count is
    // better than racing the file write with concurrent appends.
    // Return the just-closed session id so the frontend can kick off
    // opt-in post-session work (auto-summary); `None` = nothing was open.
    Ok(session::stop_session(recorder.inner()).await)
}

/// Per-session idle watcher: polls `last_activity_at` and emits the
/// `stt:idle_timeout` event when the configured threshold elapses without
/// any speech-bearing final transcripts. The frontend listens for the event
/// and calls `stop_stt` — keeping the actual teardown in one place rather
/// than duplicating session::stop_session + stdin commands here.
async fn idle_watch_loop(app: AppHandle, mgr: SharedManager, idle_minutes: u32) {
    let threshold = Duration::from_secs(60 * idle_minutes as u64);
    // Poll at 30s or 1/4 of the threshold, whichever is smaller. Cap at the
    // floor so very short thresholds (e.g. 1 min) still get a useful check
    // cadence without spamming the mutex.
    let poll = std::cmp::min(Duration::from_secs(30), threshold / 4)
        .max(Duration::from_secs(5));
    loop {
        tokio::time::sleep(poll).await;
        let elapsed = {
            let m = mgr.lock().await;
            match m.last_activity_at {
                Some(t) => Instant::now().duration_since(t),
                // None means stop_stt already cleared us — exit cleanly
                None => return,
            }
        };
        if elapsed >= threshold {
            let _ = app.emit("stt:idle_timeout", idle_minutes);
            // Clear our own state so a late-arriving final can't re-arm
            // the watcher before the frontend stop_stt lands. The frontend
            // is responsible for the actual session teardown.
            let mut m = mgr.lock().await;
            m.last_activity_at = None;
            m.idle_watcher = None;
            return;
        }
    }
}

/// Resolve the bundled demo WAV (weather_90s.wav) to an absolute path.
///
/// Release builds carry it as a Tauri resource — `../`-relative resource
/// paths land under `Resources/_up_/` inside the .app bundle. Dev builds
/// fall back to the repo-relative copy via `project_root()` (the same
/// notion of the repo root `locate_sidecar` uses for the dev venv).
/// Returning an absolute path (instead of the old hardcoded relative one)
/// matters because the release sidecar's cwd is `Contents/MacOS/`, where
/// a relative `prototype/samples/...` path resolves to nothing.
#[tauri::command]
pub async fn demo_wav_path(app: AppHandle) -> Result<String, String> {
    if let Ok(p) = app
        .path()
        .resolve("_up_/prototype/samples/weather_90s.wav", BaseDirectory::Resource)
    {
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    let dev = project_root().join("prototype/samples/weather_90s.wav");
    if dev.exists() {
        return Ok(dev.to_string_lossy().to_string());
    }
    Err("demo wav not found: neither the bundled resource nor the dev-tree copy exists".into())
}

/// Ask the sidecar to enumerate input-capable audio devices via sounddevice.
/// The sidecar replies with a `devices` event; the stdout reader routes the
/// payload back through the oneshot installed here. Returns an empty list
/// if the sidecar is still warming up — callers should retry once `ready`.
#[tauri::command]
pub async fn list_audio_devices(
    state: tauri::State<'_, SharedManager>,
) -> Result<Vec<AudioDevice>, String> {
    let (tx, rx) = oneshot::channel();
    {
        let mut m = state.lock().await;
        if m.stdin.is_none() {
            return Err("sidecar not running".into());
        }
        // Drop any prior pending request — the awaiter will see a channel-
        // closed error, which the UI treats as a transient failure.
        m.pending_devices = Some(tx);
        let line = "{\"type\":\"list_devices\"}\n";
        let stdin = m.stdin.as_mut().ok_or("no stdin")?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin: {e}"))?;
    }
    match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(devices)) => Ok(devices),
        Ok(Err(_)) => Err("sidecar dropped response".into()),
        Err(_) => Err("list_devices timeout".into()),
    }
}
