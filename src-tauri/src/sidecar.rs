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

use crate::config::{Config, SharedConfig};
use crate::errors;
use crate::interp;
use crate::languages;
use crate::session::{self, SharedRecorder};
use crate::traces;
use crate::translator::TranslationContext;

fn prepare_transcript(cfg: &Config, text: &str, is_final: bool) -> String {
    let normalized = cfg.text_normalizer().normalize(&cfg.language.source, text);
    if is_final {
        cfg.apply_glossary_aliases(&normalized)
    } else {
        normalized
    }
}

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_BACKOFF_SECS: u64 = 2;
const STDERR_TAIL_LINES: usize = 50;
/// How long `stop_stt` waits for the sidecar's `stopped` after sending
/// `stop`. The sidecar flushes buffered speech into final transcripts before
/// acknowledging, and those finals must reach interp / the frontend while
/// the session is still open.
const STOP_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// An `error` this recent is quoted in the `stt:interrupted` message when the
/// sidecar then stops on its own.
const INTERRUPT_ERROR_WINDOW: Duration = Duration::from_secs(10);
/// After recognition ends without a user stop (`stopped` not requested,
/// `stt:fatal`), the frontend gets this long to drain pending translations
/// and call `stop_stt` itself. If it hasn't, Rust closes the session it
/// captured when the timer was armed (never a newer one).
const UNREQUESTED_STOP_CLOSE_GRACE: Duration = Duration::from_secs(15);

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
    /// Exactly once per run. `reason`: `requested` (stop command),
    /// `source_ended` (demo / WAV file finished normally) or `error` (setup
    /// failed, stt error, cloud gave up). Absent on old sidecars → treated
    /// as `error` when un-requested.
    Stopped {
        #[serde(default)]
        reason: Option<String>,
    },
    ModelLoading,
    ModelReady,
    /// Startup progress of one run, for the console's 啟動中 checklist:
    /// `mic_ready` (first audio captured) and `stt_connected` (cloud only:
    /// first websocket up). Forwarded as `stt:stage` with the bare name.
    Stage {
        stage: String,
    },
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
        /// Set on the model step's `progress` when the weights were already
        /// cached locally (no download) — lets the UI show a "已在本機" hint
        /// instead of a silent spinner. Additive/optional for compatibility.
        #[serde(default)]
        cached: Option<bool>,
    },
    Transcript {
        text: String,
        is_final: bool,
        t_start: f64,
        t_end: f64,
        /// Segment boundary kind on finals (`clause` / `forced` keep the
        /// incremental-translation group open, `sentence` / `pause` close
        /// it). Absent on interims and on sidecars predating the field —
        /// consumers treat `None` as `sentence`. Skipped on serialize when
        /// absent so the frontend payload is byte-identical for old sidecars.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boundary: Option<String>,
        /// Incremental mode only: the id of the sentence group this segment
        /// belongs to — the frontend keys UI rows and utterances by it
        /// instead of by `t_start`. Never sent by the sidecar; filled in by
        /// the stdout reader after handing the segment to `interp`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
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
        /// Machine-readable kind for warnings the UI reacts to (status chip,
        /// banner) rather than just toasting: `reconnecting` / `reconnected`
        /// / `mic_stalled` / `mic_resumed` / `device_fallback`. Absent on
        /// plain warnings. Forwarded as `stt:signal`.
        #[serde(default)]
        code: Option<String>,
        /// `device_fallback` only: the device actually opened.
        #[serde(default)]
        device: Option<String>,
    },
    /// Input level (RMS, 0..1) about every 250 ms while capturing. Forwarded
    /// as `stt:level` with the bare number; never logged — it's a meter feed.
    Level {
        rms: f64,
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
    /// OS pid of the live child, so `restart_sidecar` can SIGKILL a process
    /// that ignores `shutdown` (e.g. a prewarm thread wedged inside CoreAudio
    /// after the mic was unplugged — Python's asyncio.run waits for executor
    /// threads and never exits).
    pid: Option<u32>,
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
    /// Session time base across auto-restarts (see `SessionClock`).
    clock: SessionClock,
    /// Fulfilled by the stdout reader on the sidecar's `stopped`, so a
    /// user stop can wait for the flush of buffered speech. Its presence
    /// also marks a `stopped` as requested; dropped by the watchdog when the
    /// child dies so the waiter never hangs on a corpse.
    stop_waiter: Option<oneshot::Sender<()>>,
    /// Most recent sidecar `error` message, quoted in `stt:interrupted`.
    last_error: Option<(String, Instant)>,
    /// Pending backend close after an un-requested stop / fatal (see
    /// `arm_close_fallback`). Aborted by `start_stt` / `stop_stt`; the task
    /// itself is also generation-safe (captured session id).
    close_fallback: Option<JoinHandle<()>>,
    /// True while a `start_stt` call is running (spawn + start command +
    /// session open), so a second one can't slip in before `last_start` is set.
    start_in_flight: bool,
}

/// Returned by `start_stt` when a run is already starting or capturing. The
/// frontend treats it as a no-op (it means "already doing what you asked").
pub const ALREADY_RECORDING: &str = "already_recording";

/// A run is starting or capturing: a start is in flight, or the last start
/// is still live (sidecar up, or being respawned by the watchdog). A second
/// start then must not open a new session — before this guard it finalized
/// the live one and left an empty duplicate on disk.
fn capture_active(m: &SidecarManager) -> bool {
    m.start_in_flight || (m.last_start.is_some() && (m.stdin.is_some() || m.starting))
}

/// How an un-requested `stopped` is surfaced to the frontend.
#[derive(Debug, PartialEq, Eq)]
enum UnrequestedStop {
    /// Demo / WAV file played to the end — `stt:source_ended`, not an error.
    SourceEnded,
    /// Recognition broke (`error` or no reason from an old sidecar) —
    /// `stt:interrupted` with a 繁中 message.
    Interrupted,
    /// Sidecar says it was asked to stop although no waiter was armed —
    /// nothing to tell the user beyond `stt:stopped`.
    Quiet,
}

fn classify_unrequested_stop(reason: Option<&str>) -> UnrequestedStop {
    match reason {
        Some("source_ended") => UnrequestedStop::SourceEnded,
        Some("requested") => UnrequestedStop::Quiet,
        _ => UnrequestedStop::Interrupted,
    }
}

/// Session-relative time base across sidecar restarts. A respawned sidecar
/// starts its clock at 0, which made post-restore transcripts reuse
/// `t_start` values (the utterance / group id) of rows already on screen and
/// on disk. On restore the offset jumps to the furthest `t_end` seen, and
/// every later transcript is shifted by it.
#[derive(Debug, Default, Clone, PartialEq)]
struct SessionClock {
    offset: f64,
    max_t_end: f64,
    /// Set on restore, cleared by the first transcript after it — proof the
    /// respawned sidecar actually works, so the crash budget can reset.
    awaiting_stable: bool,
}

/// Gap added on top of the last `t_end` at a restore, so a first post-restore
/// segment starting at 0.0 can't land on the exact id of a pre-crash one
/// whose `t_start == t_end` (synthetic cloud timestamps).
const RESTORE_EPSILON: f64 = 0.01;

impl SessionClock {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn on_restore(&mut self) {
        self.offset = self.max_t_end + RESTORE_EPSILON;
        self.awaiting_stable = true;
    }

    /// Shift one transcript's times onto the session clock. Returns the
    /// shifted pair and whether this is the first transcript since a restore.
    fn apply(&mut self, t_start: f64, t_end: f64) -> (f64, f64, bool) {
        let (s, e) = (t_start + self.offset, t_end + self.offset);
        if e > self.max_t_end {
            self.max_t_end = e;
        }
        (s, e, std::mem::take(&mut self.awaiting_stable))
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            stdin: None,
            pid: None,
            last_start: None,
            restart_attempts: 0,
            starting: false,
            intentional_stop: false,
            stderr_tail: VecDeque::with_capacity(STDERR_TAIL_LINES),
            ready: false,
            pending_devices: None,
            last_activity_at: None,
            idle_watcher: None,
            clock: SessionClock::default(),
            stop_waiter: None,
            last_error: None,
            close_fallback: None,
            start_in_flight: false,
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
/// The discriminator is "are we running from inside a real `.app` bundle?",
/// NOT "does a dev venv exist?". The old check keyed on venv existence, which
/// is broken on a dev machine: an installed `.app` there would still find the
/// repo's venv and spawn `prototype/.venv/bin/python`. That python lives
/// OUTSIDE the app bundle, so macOS TCC never attributes the app's microphone
/// grant to it (responsible-process mismatch) → sounddevice fails at device
/// enumeration with the misleading "Error querying device -1". It also meant
/// the bundled binary path could never be exercised on a machine that has the
/// repo, so a shipped regression would go unnoticed until a friend's fresh Mac.
///
/// Priority:
///   1. Release (`current_exe` is inside `*.app/Contents/MacOS/`): the bundled
///      binary (`stt_engine` or `stt_engine-<triple>`) next to the main exe.
///      Always — the dev venv is deliberately ignored here even if present.
///   2. Dev (`pnpm tauri dev` / `cargo run`, exe under `target/`): the dev venv
///      (`prototype/.venv/bin/python` + `python-sidecar/stt_engine.py`) so we
///      pick up live Python edits and never get shadowed by the stale
///      PyInstaller copy Tauri's externalBin re-stages into `target/debug/`.
///
/// Returns (program, leading_args, cwd). Leading args are inserted before any
/// caller-supplied args — the script path when running via the dev-mode Python
/// interpreter. The cwd comes back from here (rather than always being
/// `project_root()`) because in a release `.app` installed on a remote user's
/// Mac, `project_root()` is the developer's build-time path embedded by
/// `env!("CARGO_MANIFEST_DIR")` — that path doesn't exist on the user's
/// machine, and `Command::current_dir(<missing>)` makes posix_spawn fail with
/// ENOENT after fork (surfaces as "spawn sidecar: No such file or directory").
fn locate_sidecar() -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    let exe = std::env::current_exe().ok();
    let in_app_bundle = exe
        .as_deref()
        .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false);

    if !in_app_bundle {
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
    }

    if let Some(exe) = exe {
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
        "sidecar not found: in_app_bundle={in_app_bundle}, no bundled binary alongside the main exe and no dev venv at prototype/.venv"
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

    let openai_key = {
        let cfg = cfg_arc.lock().await;
        cfg.api.openai_api_key.clone()
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
        m.pid = child.id();
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
                        SidecarEvent::Transcript { text, is_final, t_start, t_end, boundary, .. } => {
                            // Both cloud and local prompts are advisory. Normalize
                            // previews as well as finals before any UI/translation
                            // consumer; final aliases still see the original text.
                            let (text, incremental) = {
                                let cfg = cfg_o.lock().await;
                                (
                                    prepare_transcript(&cfg, &text, is_final),
                                    cfg.incremental_enabled(),
                                )
                            };
                            // Session clock: shift onto the pre-restore time
                            // base; the first transcript after a restore also
                            // proves the respawn healthy → reset the budget.
                            let (t_start, t_end) = {
                                let mut m = mgr_o.lock().await;
                                let (s, e, stable) = m.clock.apply(t_start, t_end);
                                if stable {
                                    m.restart_attempts = 0;
                                }
                                (s, e)
                            };
                            if !is_final {
                                emit_event(
                                    &app_o,
                                    SidecarEvent::Transcript {
                                        text,
                                        is_final,
                                        t_start,
                                        t_end,
                                        boundary,
                                        utterance_id: None,
                                    },
                                );
                                continue;
                            }
                            let rewritten = text;
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
                            // Incremental mode: the engine owns translation +
                            // persistence for this segment; the frontend only
                            // renders. Sentence mode: unchanged, the frontend
                            // invokes `translate` per final.
                            let utterance_id = if incremental && !rewritten.trim().is_empty() {
                                Some(
                                    interp::on_final_segment(
                                        &app_o,
                                        &rewritten,
                                        t_start,
                                        t_end,
                                        boundary.as_deref(),
                                    )
                                    .await,
                                )
                            } else {
                                None
                            };
                            emit_event(
                                &app_o,
                                SidecarEvent::Transcript {
                                    text: rewritten,
                                    is_final,
                                    t_start,
                                    t_end,
                                    boundary,
                                    utterance_id,
                                },
                            );
                        }
                        // Persist to traces.jsonl only. No frontend event and
                        // no idle-clock reset (see the Diag variant docs).
                        SidecarEvent::Diag { gate, t_start, detail } => {
                            traces::record_diag(&gate, t_start, detail);
                        }
                        SidecarEvent::Error { message } => {
                            mgr_o.lock().await.last_error = Some((message.clone(), Instant::now()));
                            emit_event(&app_o, SidecarEvent::Error { message });
                        }
                        // `stopped` either acknowledges a user stop (wake the
                        // waiter in stop_stt) or — with no stop requested and
                        // a session running — means the run ended on its own:
                        // the demo file finished (`source_ended`) or the
                        // sidecar gave up (`error`: cloud out of reconnects,
                        // audio device gone). Tell the frontend, which drains
                        // pending translations and calls `stop_stt`; a 15 s
                        // fallback closes the session if it doesn't.
                        SidecarEvent::Stopped { reason } => {
                            let (waiter, unexpected, last_err) = {
                                let mut m = mgr_o.lock().await;
                                let waiter = m.stop_waiter.take();
                                let unexpected = waiter.is_none()
                                    && !m.intentional_stop
                                    && m.last_start.is_some();
                                if unexpected {
                                    m.last_start = None;
                                    m.last_activity_at = None;
                                    if let Some(h) = m.idle_watcher.take() {
                                        h.abort();
                                    }
                                }
                                let last_err = m
                                    .last_error
                                    .take()
                                    .filter(|(_, at)| at.elapsed() < INTERRUPT_ERROR_WINDOW)
                                    .map(|(msg, _)| msg);
                                (waiter, unexpected, last_err)
                            };
                            if let Some(tx) = waiter {
                                let _ = tx.send(());
                            }
                            emit_event(&app_o, SidecarEvent::Stopped { reason: reason.clone() });
                            if unexpected {
                                match classify_unrequested_stop(reason.as_deref()) {
                                    UnrequestedStop::SourceEnded => {
                                        let _ = app_o.emit("stt:source_ended", ());
                                    }
                                    UnrequestedStop::Interrupted => {
                                        let msg = interrupted_message(last_err.as_deref());
                                        errors::record("stt_interrupted", &msg, None);
                                        let _ = app_o.emit("stt:interrupted", msg);
                                    }
                                    UnrequestedStop::Quiet => {}
                                }
                                arm_close_fallback(&app_o, &mgr_o, "unrequested_stop").await;
                            }
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
            m.pid = None;
            m.starting = false;
            m.ready = false;
            // Crash teardown: drop the idle watcher so it doesn't keep
            // ticking against a dead session. The reincarnated child gets
            // a fresh watcher via the re-issued start command below.
            m.last_activity_at = None;
            if let Some(h) = m.idle_watcher.take() {
                h.abort();
            }
            // Wake a stop_stt waiting for `stopped` — it won't come now.
            m.stop_waiter = None;
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
            {
                let mut m = mgr_w.lock().await;
                m.restart_attempts = 0;
                m.starting = false;
                m.last_start = None;
            }
            // Don't leave the session "recording" with no engine behind it:
            // the frontend stops it on `stt:fatal`; the fallback covers a
            // frontend that can't.
            let _ = app_w.emit("stt:fatal", "辨識引擎連續崩潰，請檢查 errors.log");
            arm_close_fallback(&app_w, &mgr_w, "fatal").await;
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
                    // The new child's clock starts at 0 — continue the
                    // session's time base instead (see SessionClock).
                    m.clock.on_restore();
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
                    m.last_start = None;
                }
                errors::record("sidecar_respawn_failed", &e, None);
                let _ = app_w.emit("stt:fatal", e);
                arm_close_fallback(&app_w, &mgr_w, "fatal").await;
            }
        }
    });

    Ok(())
}

fn emit_event(app: &AppHandle, event: SidecarEvent) {
    let _ = match &event {
        SidecarEvent::Transcript { .. } => app.emit("transcript", &event),
        SidecarEvent::Started => app.emit("stt:started", ()),
        SidecarEvent::Stopped { .. } => app.emit("stt:stopped", ()),
        SidecarEvent::Ready => app.emit("stt:ready", ()),
        SidecarEvent::ModelLoading => app.emit("stt:model_loading", ()),
        SidecarEvent::ModelReady => app.emit("stt:model_ready", ()),
        SidecarEvent::Stage { stage } => app.emit("stt:stage", stage),
        SidecarEvent::Prewarm { step, state, message, downloaded_bytes, total_bytes, cached } => {
            if state == "error" {
                errors::record(
                    "sidecar_prewarm_error",
                    message.as_deref().unwrap_or("unknown"),
                    Some(serde_json::json!({ "step": step })),
                );
            }
            app.emit(
            "stt:prewarm",
            serde_json::json!({
                "step": step,
                "state": state,
                "message": message,
                "downloaded_bytes": downloaded_bytes,
                "total_bytes": total_bytes,
                "cached": cached,
            }),
        )
        }
        SidecarEvent::Warning { message, code, device } => {
            let r = app.emit("stt:warning", message);
            if let Some(payload) = signal_payload(message, code.as_deref(), device.as_deref()) {
                let _ = app.emit("stt:signal", payload);
            }
            r
        }
        SidecarEvent::Level { rms } => app.emit("stt:level", rms),
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

/// `stt:signal` payload for a coded warning: `{code, message}` plus
/// `device` when the sidecar named one. `None` for a plain (uncoded) warning.
fn signal_payload(message: &str, code: Option<&str>, device: Option<&str>) -> Option<Value> {
    let code = code?;
    let mut payload = serde_json::json!({ "code": code, "message": message });
    if let Some(d) = device {
        payload["device"] = Value::String(d.to_string());
    }
    Some(payload)
}

/// User-facing text for `stt:interrupted`, quoting the sidecar's last error
/// when one arrived just before it stopped.
fn interrupted_message(last_error: Option<&str>) -> String {
    let base = "辨識連線中斷，本場已自動保存。可按開始重新接續。";
    match last_error.map(str::trim).filter(|e| !e.is_empty()) {
        Some(e) => format!("{base}（{e}）"),
        None => base.to_string(),
    }
}

/// Arm the backend close after recognition ended without a user stop. The
/// session id is captured NOW; when the grace period runs out the task closes
/// that session only if it is still the active one and the frontend never
/// called `stop_stt` (which closes it and aborts this task). A newer meeting
/// started in between is never touched.
async fn arm_close_fallback(app: &AppHandle, mgr: &SharedManager, why: &'static str) {
    let recorder = app.state::<SharedRecorder>().inner().clone();
    let Some(captured) = session::active_session_id(&recorder).await else {
        return;
    };
    let app_f = app.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(UNREQUESTED_STOP_CLOSE_GRACE).await;
        if close_session_if(&app_f, &captured).await {
            errors::record(
                "session_close_fallback",
                "frontend did not call stop_stt within 15 s; Rust closed the session",
                Some(serde_json::json!({ "session_id": captured, "why": why })),
            );
        }
    });
    if let Some(prev) = mgr.lock().await.close_fallback.replace(handle) {
        prev.abort();
    }
}

/// Abort a pending close fallback (user stop / new start owns teardown now).
fn abort_close_fallback(m: &mut SidecarManager) {
    if let Some(h) = m.close_fallback.take() {
        h.abort();
    }
}

/// Flush the incremental engine and finalize `session_id` — only if it is
/// still the active session (generation check before the flush and again,
/// atomically, at the close). Emits `session:closed` when it closed one.
async fn close_session_if(app: &AppHandle, session_id: &str) -> bool {
    let recorder = app.state::<SharedRecorder>().inner().clone();
    if session::active_session_id(&recorder).await.as_deref() != Some(session_id) {
        return false;
    }
    interp::flush(app).await;
    match session::stop_session_if(&recorder, session_id).await {
        Some(id) => {
            let _ = app.emit("session:closed", id);
            true
        }
        None => false,
    }
}

/// Send `stop` and wait — bounded by `STOP_DRAIN_TIMEOUT` — for the
/// sidecar's `stopped`. The sidecar flushes buffered speech first, so late
/// finals are processed by the stdout reader (interp / frontend) before the
/// caller closes the session. Only waits when a session was actually
/// running; the idle watcher handle is left to the caller (the idle fallback
/// runs *inside* that task and must not abort itself).
async fn send_stop_and_wait(mgr: &SharedManager) {
    let rx = {
        let mut m = mgr.lock().await;
        let running = m.last_start.is_some() && m.stdin.is_some();
        m.intentional_stop = true;
        m.last_start = None;
        m.last_activity_at = None;
        let rx = if running {
            let (tx, rx) = oneshot::channel();
            m.stop_waiter = Some(tx);
            Some(rx)
        } else {
            None
        };
        if let Some(stdin) = m.stdin.as_mut() {
            let _ = stdin.write_all(b"{\"type\":\"stop\"}\n").await;
            let _ = stdin.flush().await;
        }
        rx
    };
    if let Some(rx) = rx {
        if tokio::time::timeout(STOP_DRAIN_TIMEOUT, rx).await.is_err() {
            errors::record(
                "sidecar_stop_timeout",
                "no `stopped` within 3 s of `stop`; closing the session anyway",
                None,
            );
        }
        mgr.lock().await.stop_waiter = None;
    }
}

#[tauri::command]
pub async fn start_stt(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    config: tauri::State<'_, SharedConfig>,
    recorder: tauri::State<'_, SharedRecorder>,
    ctx: tauri::State<'_, TranslationContext>,
    backend: String,
    source: Value,
    language: Option<String>,
) -> Result<(), String> {
    {
        let mut m = state.lock().await;
        if capture_active(&m) {
            return Err(ALREADY_RECORDING.into());
        }
        m.start_in_flight = true;
    }
    let mut guard = StartInFlight(Some(state.inner().clone()));
    let r = start_stt_inner(app, &state, &config, &recorder, &ctx, backend, source, language).await;
    state.lock().await.start_in_flight = false;
    guard.0 = None;
    r
}

/// Clears `start_in_flight` if `start_stt_inner` never returns normally (a
/// panic unwinds the command future), so one bad start can't refuse every
/// later one with `already_recording`. Disarmed on the normal path, which
/// clears the flag itself without waiting for a spawned task.
struct StartInFlight(Option<SharedManager>);

impl Drop for StartInFlight {
    fn drop(&mut self) {
        if let Some(mgr) = self.0.take() {
            let cleared = match mgr.try_lock() {
                Ok(mut m) => {
                    m.start_in_flight = false;
                    true
                }
                Err(_) => false,
            };
            if !cleared {
                tokio::spawn(async move {
                    mgr.lock().await.start_in_flight = false;
                });
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn start_stt_inner(
    app: AppHandle,
    state: &tauri::State<'_, SharedManager>,
    config: &tauri::State<'_, SharedConfig>,
    recorder: &tauri::State<'_, SharedRecorder>,
    ctx: &tauri::State<'_, TranslationContext>,
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

    // Warm the LLM connection while the sidecar spins up (fire-and-forget).
    crate::translator::warm_up(app.clone());

    let need_spawn = {
        let mut m = state.lock().await;
        m.restart_attempts = 0;
        m.intentional_stop = false;
        abort_close_fallback(&mut m);
        m.clock.reset();
        m.last_error = None;
        m.stop_waiter = None;
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

    let (openai_api_key, initial_prompt, keywords, idle_minutes, openai_delay, incremental) = {
        let cfg = config.lock().await;
        (
            cfg.api.openai_api_key.clone(),
            cfg.whisper_initial_prompt(),
            cfg.stt_keywords(),
            cfg.idle_auto_stop_minutes,
            cfg.stt.openai_delay.clone(),
            cfg.incremental_enabled(),
        )
    };
    let cmd = serde_json::json!({
        "type": "start",
        "backend": backend,
        "source": source,
        "language": language_str,
        "detect_language": false,
        "initial_prompt": initial_prompt,
        "keywords": keywords,
        "api": {
            "openai_api_key": openai_api_key,
        },
        // Per-backend tuning. `segmentation: fine` asks the openai splitter
        // for clause-level early finals, which only make sense when the
        // incremental engine stitches them back into groups; the sentence
        // translator gets today's sentence-level cuts.
        "stt": {
            "delay": openai_delay,
            "segmentation": if incremental { "fine" } else { "sentence" },
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
            interp::reset(&app).await;
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
                let recorder_w = recorder.inner().clone();
                let app_w = app.clone();
                m.idle_watcher = Some(tokio::spawn(idle_watch_loop(
                    app_w,
                    mgr_w,
                    recorder_w,
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
    let pid = {
        let mut m = state.lock().await;
        // Reset restart_attempts so the watchdog doesn't refuse the new spawn
        // on the basis of stale crash counts from before the user hit retry.
        m.restart_attempts = 0;
        m.request_shutdown().await;
        m.pid
    };
    // Wait for the child to exit cleanly (the watchdog clears `stdin` once it
    // has reaped it). A graceful exit normally takes well under a second, but
    // a prewarm thread stuck in CoreAudio can hold the process open forever,
    // so after a grace period we SIGKILL it. Never fall through to `prewarm`
    // while the old child is alive: `prewarm` would see `stdin.is_some()`,
    // do nothing, and the UI would wait for a spawn that never happens.
    if !wait_for_exit(state.inner(), Duration::from_secs(3)).await {
        if let Some(pid) = pid {
            errors::record(
                "sidecar_restart_force_kill",
                &format!("sidecar pid {pid} ignored shutdown for 3s; sending SIGKILL"),
                None,
            );
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
        if !wait_for_exit(state.inner(), Duration::from_secs(3)).await {
            return Err("辨識引擎沒有結束，無法重新啟動；請關閉並重新開啟 App".into());
        }
    }
    prewarm(app, state.inner().clone(), config.inner().clone()).await
}

/// Poll until the watchdog has reaped the child (`stdin == None`) or the
/// deadline passes. Returns true when the child is gone.
async fn wait_for_exit(state: &SharedManager, max: Duration) -> bool {
    let deadline = Instant::now() + max;
    loop {
        if state.lock().await.stdin.is_none() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Whether the sidecar has emitted its initial `ready` event and can accept
/// a `start` command without first paying the cold-start cost.
#[tauri::command]
pub async fn sidecar_ready(state: tauri::State<'_, SharedManager>) -> Result<bool, String> {
    Ok(state.lock().await.ready)
}

/// First half of a user stop: halt capture and wait (≤ 3 s) for the sidecar
/// to flush its last finals, but keep the session open. Sentence mode needs
/// this split — the frontend persists each utterance only after its
/// translation lands, so it drains those before calling `stop_stt`.
#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, SharedManager>) -> Result<(), String> {
    {
        let mut m = state.lock().await;
        if let Some(h) = m.idle_watcher.take() {
            h.abort();
        }
    }
    send_stop_and_wait(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn stop_stt(
    app: AppHandle,
    state: tauri::State<'_, SharedManager>,
    recorder: tauri::State<'_, SharedRecorder>,
) -> Result<Option<String>, String> {
    {
        let mut m = state.lock().await;
        if let Some(h) = m.idle_watcher.take() {
            h.abort();
        }
        abort_close_fallback(&mut m);
    }
    // Wait (≤ 3 s) for the sidecar to flush buffered speech and ack with
    // `stopped`, so those last finals land while the session is open.
    send_stop_and_wait(state.inner()).await;
    // Finalize meta.json on stop. The frontend may still flush a few
    // pending utterances after this — those are silently dropped because
    // the recorder slot is already empty (see session_append_utterance).
    // That's the right tradeoff: a meta.json with one fewer count is
    // better than racing the file write with concurrent appends.
    // Incremental mode: close the open sentence group and wait (bounded) for
    // its final translation calls so the last row lands before meta.json is
    // finalized. No-op in sentence mode (no open group, no workers).
    interp::flush(&app).await;
    // Return the just-closed session id so the frontend can kick off
    // opt-in post-session work (auto-summary); `None` = nothing was open.
    Ok(session::stop_session(recorder.inner()).await)
}

/// Per-session idle watcher: polls `last_activity_at` and emits the
/// `stt:idle_timeout` event when the configured threshold elapses without
/// any speech-bearing final transcripts. The frontend gets first chance to
/// flush pending translations and call `stop_stt`; a delayed Rust fallback
/// enforces teardown when the control window or its listener is gone.
async fn idle_watch_loop(
    app: AppHandle,
    mgr: SharedManager,
    recorder: SharedRecorder,
    idle_minutes: u32,
) {
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
            // Generation guard: the fallback below may only close the session
            // that was idle, never a meeting started after this fired.
            let captured = session::active_session_id(&recorder).await;
            let _ = app.emit("stt:idle_timeout", idle_minutes);
            {
                // Clear our own clock so a late-arriving final can't re-arm
                // the watcher before the frontend stop_stt lands.
                mgr.lock().await.last_activity_at = None;
            }

            // Give the control window time to flush pending translations and
            // call stop_stt. If that window was closed or its JS listener is
            // gone, enforce the cost-safety guarantee in Rust instead of
            // leaving a cloud/realtime session running indefinitely.
            tokio::time::sleep(Duration::from_secs(5)).await;
            let fallback_stop = mgr.lock().await.last_start.is_some()
                && captured.is_some()
                && session::active_session_id(&recorder).await == captured;
            if let (true, Some(captured)) = (fallback_stop, captured) {
                send_stop_and_wait(&mgr).await;
                close_session_if(&app, &captured).await;
                errors::record(
                    "idle_timeout_fallback",
                    "frontend did not stop the session within 5 seconds; Rust forced stop",
                    Some(serde_json::json!({ "idle_minutes": idle_minutes })),
                );
            }
            mgr.lock().await.idle_watcher = None;
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
    // Dev builds only: in a release build project_root() is the build
    // machine's checkout, and probing it under ~/Documents can raise a macOS
    // folder-permission prompt.
    if cfg!(debug_assertions) {
        let dev = project_root().join("prototype/samples/weather_90s.wav");
        if dev.exists() {
            return Ok(dev.to_string_lossy().to_string());
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_stt_boundary_normalizes_before_aliases_and_preserves_official_names() {
        let mut cfg = Config::default();
        cfg.glossaries.push(crate::config::GlossaryBook {
            name: "test".into(),
            source_lang: "zh".into(),
            entries: vec![crate::config::GlossaryEntry {
                term: "开发平台".into(),
                aliases: vec!["開花平台".into()],
                ..Default::default()
            }],
        });
        cfg.active_glossary = Some("test".into());
        assert_eq!(prepare_transcript(&cfg, "开花平台的会议", false), "開花平臺的會議");
        assert_eq!(prepare_transcript(&cfg, "开花平台的会议", true), "开发平台的會議");
        for is_final in [false, true] {
            assert_eq!(prepare_transcript(&cfg, "开发平台的会议", is_final), "开发平台的會議");
        }
        cfg.glossaries[0].entries[0].term = "台積電".into();
        assert_eq!(prepare_transcript(&cfg, "开花平台的会议", true), "台積電的會議");
        cfg.language.source = "ja".into();
        for is_final in [false, true] {
            assert_eq!(prepare_transcript(&cfg, "日本語の会議", is_final), "日本語の会議");
        }
    }

    #[test]
    fn clock_is_identity_until_a_restore() {
        let mut c = SessionClock::default();
        assert_eq!(c.apply(1.0, 2.5), (1.0, 2.5, false));
        assert_eq!(c.apply(3.0, 7.25), (3.0, 7.25, false));
        assert_eq!(c.max_t_end, 7.25);
    }

    #[test]
    fn clock_continues_time_base_after_restore() {
        let mut c = SessionClock::default();
        c.apply(0.0, 4.0);
        c.apply(4.5, 9.0);
        c.on_restore();
        // Respawned sidecar restarts at 0 → shifted past everything seen.
        let (s, e, stable) = c.apply(0.0, 1.5);
        assert!(s > 9.0 && (s - 9.0 - RESTORE_EPSILON).abs() < 1e-9, "{s}");
        assert!((e - (9.0 + RESTORE_EPSILON + 1.5)).abs() < 1e-9, "{e}");
        assert!(stable, "first transcript after restore marks it stable");
        let (_, _, again) = c.apply(2.0, 3.0);
        assert!(!again, "only the first one");
    }

    #[test]
    fn clock_offsets_accumulate_across_two_restores() {
        let mut c = SessionClock::default();
        c.apply(0.0, 10.0);
        c.on_restore();
        c.apply(0.0, 5.0); // → ~15.01
        c.on_restore();
        let (s, _, _) = c.apply(0.0, 1.0);
        assert!((s - (15.0 + 2.0 * RESTORE_EPSILON)).abs() < 1e-9, "{s}");
        c.reset();
        assert_eq!(c, SessionClock::default());
    }

    #[test]
    fn restore_with_no_transcripts_yet_still_avoids_zero_collision() {
        let mut c = SessionClock::default();
        c.on_restore();
        let (s, _, stable) = c.apply(0.0, 0.0);
        assert!(s > 0.0);
        assert!(stable);
    }

    #[test]
    fn parses_level_and_coded_warnings() {
        let ev: SidecarEvent = serde_json::from_str(r#"{"type":"level","rms":0.42}"#).unwrap();
        assert!(matches!(ev, SidecarEvent::Level { rms } if (rms - 0.42).abs() < 1e-9));

        let plain: SidecarEvent =
            serde_json::from_str(r#"{"type":"warning","message":"hi"}"#).unwrap();
        assert!(matches!(plain, SidecarEvent::Warning { code: None, device: None, .. }));

        let coded: SidecarEvent = serde_json::from_str(
            r#"{"type":"warning","message":"fell back","code":"device_fallback","device":"MacBook Mic"}"#,
        )
        .unwrap();
        let SidecarEvent::Warning { message, code, device } = coded else { panic!() };
        let payload = signal_payload(&message, code.as_deref(), device.as_deref()).unwrap();
        assert_eq!(payload["code"], "device_fallback");
        assert_eq!(payload["message"], "fell back");
        assert_eq!(payload["device"], "MacBook Mic");
    }

    #[test]
    fn parses_stage_event() {
        let ev: SidecarEvent =
            serde_json::from_str(r#"{"type":"stage","stage":"stt_connected"}"#).unwrap();
        assert!(matches!(ev, SidecarEvent::Stage { stage } if stage == "stt_connected"));
    }

    #[tokio::test]
    async fn start_in_flight_guard_clears_on_unwind() {
        let mgr: SharedManager = Arc::new(Mutex::new(SidecarManager::new()));
        mgr.lock().await.start_in_flight = true;
        {
            let _g = StartInFlight(Some(mgr.clone()));
            // dropped without disarming = the panic / cancellation path
        }
        assert!(!mgr.lock().await.start_in_flight);
    }

    #[test]
    fn capture_active_blocks_duplicate_starts() {
        let mut m = SidecarManager::new();
        assert!(!capture_active(&m), "idle: start allowed");
        m.start_in_flight = true;
        assert!(capture_active(&m), "a start in flight blocks a second one");
        m.start_in_flight = false;
        // Live run being respawned by the watchdog (stdin gone, starting set).
        m.last_start = Some(serde_json::json!({"type": "start"}));
        m.starting = true;
        assert!(capture_active(&m));
        // App-launch prewarm spawn: starting, but no run yet.
        m.last_start = None;
        assert!(!capture_active(&m));
        // Run ended (stop / fatal clear last_start) and the engine is gone.
        m.starting = false;
        m.last_start = Some(serde_json::json!({"type": "start"}));
        assert!(!capture_active(&m), "stale last_start without a live engine");
    }

    #[test]
    fn signal_payload_only_for_coded_warnings() {
        assert!(signal_payload("x", None, None).is_none());
        let p = signal_payload("重新連線中", Some("reconnecting"), None).unwrap();
        assert!(p.get("device").is_none());
        assert_eq!(p["code"], "reconnecting");
    }

    #[test]
    fn interrupted_message_quotes_last_error() {
        let base = interrupted_message(None);
        assert!(base.contains("本場已自動保存"));
        assert_eq!(interrupted_message(Some("  ")), base);
        let with = interrupted_message(Some("stt error: ws closed"));
        assert!(with.starts_with(&base) && with.contains("stt error: ws closed"));
    }

    #[test]
    fn stopped_reason_parses_and_defaults() {
        let ev: SidecarEvent = serde_json::from_str(r#"{"type":"stopped"}"#).unwrap();
        assert!(matches!(ev, SidecarEvent::Stopped { reason: None }));
        let ev: SidecarEvent =
            serde_json::from_str(r#"{"type":"stopped","reason":"source_ended"}"#).unwrap();
        match ev {
            SidecarEvent::Stopped { reason } => assert_eq!(reason.as_deref(), Some("source_ended")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unrequested_stop_classification() {
        assert_eq!(classify_unrequested_stop(Some("source_ended")), UnrequestedStop::SourceEnded);
        assert_eq!(classify_unrequested_stop(Some("error")), UnrequestedStop::Interrupted);
        // Old sidecar without a reason → treated as an interruption.
        assert_eq!(classify_unrequested_stop(None), UnrequestedStop::Interrupted);
        assert_eq!(classify_unrequested_stop(Some("weird")), UnrequestedStop::Interrupted);
        assert_eq!(classify_unrequested_stop(Some("requested")), UnrequestedStop::Quiet);
    }
}
