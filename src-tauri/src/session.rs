use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::errors;

/// One persisted line in transcript.jsonl. `incomplete = true` means the
/// session was stopped before one of the translations finished — the empty
/// string fields are intentional, not a bug.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredUtterance {
    pub id: String,
    pub t_start: f64,
    pub t_end: f64,
    #[serde(default)]
    pub zh: String,
    #[serde(default)]
    pub en: String,
    #[serde(default)]
    pub vi: String,
    #[serde(default)]
    pub incomplete: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionMeta {
    pub session_id: String,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub duration_secs: u64,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub incomplete_count: usize,
    #[serde(default)]
    pub has_summary_zh: bool,
    #[serde(default)]
    pub has_summary_en: bool,
    #[serde(default)]
    pub has_summary_vi: bool,
}

pub struct SessionRecorder {
    pub session_id: String,
    dir: PathBuf,
    started_at_wall: DateTime<Utc>,
    backend: String,
    language: String,
    device: String,
    count: usize,
    incomplete_count: usize,
}

pub type SharedRecorder = Arc<Mutex<Option<SessionRecorder>>>;

pub fn new_recorder() -> SharedRecorder {
    Arc::new(Mutex::new(None))
}

pub fn sessions_dir() -> PathBuf {
    errors::config_dir().join("sessions")
}

pub fn session_dir(id: &str) -> PathBuf {
    sessions_dir().join(id)
}

impl SessionRecorder {
    /// Create a new session directory and write its initial meta.json. Uses
    /// local time for the directory name so the user can recognize meetings
    /// at a glance in Finder.
    pub fn start(backend: String, language: String, device: String) -> Result<Self, String> {
        let started_at_wall = Utc::now();
        let session_id = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
        let dir = session_dir(&session_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir session: {e}"))?;

        // Touch transcript.jsonl so empty sessions still have an
        // identifiable file (rather than just a stray meta.json).
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("transcript.jsonl"))
            .map_err(|e| format!("touch transcript: {e}"))?;

        let recorder = Self {
            session_id: session_id.clone(),
            dir,
            started_at_wall,
            backend,
            language,
            device,
            count: 0,
            incomplete_count: 0,
        };
        recorder.write_meta(None)?;
        Ok(recorder)
    }

    /// Append one finalized utterance. Always flushes — a 5–8s gap between
    /// utterances dwarfs the syscall cost, and crash safety matters more.
    /// Also rewrites meta.json so list_sessions reflects the current count
    /// while a session is still recording (otherwise the history list shows
    /// "0 句" until stop_stt finalizes).
    pub fn append(&mut self, u: &StoredUtterance) -> Result<(), String> {
        let line = serde_json::to_string(u).map_err(|e| format!("serialize utterance: {e}"))?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("transcript.jsonl"))
            .map_err(|e| format!("open transcript: {e}"))?;
        writeln!(f, "{line}").map_err(|e| format!("write transcript: {e}"))?;
        self.count += 1;
        if u.incomplete {
            self.incomplete_count += 1;
        }
        // Best-effort meta refresh; failures are non-fatal because the next
        // append (or stop_session) will retry with the same updated counts.
        let _ = self.write_meta(None);
        Ok(())
    }

    /// Finalize meta.json with the end timestamp + counts. Called from
    /// stop_stt; safe to call even if no utterances were appended.
    pub fn finalize(&self) -> Result<(), String> {
        let ended_at = Utc::now();
        let duration = (ended_at - self.started_at_wall).num_seconds().max(0) as u64;
        self.write_meta(Some((ended_at, duration)))
    }

    fn write_meta(&self, ended: Option<(DateTime<Utc>, u64)>) -> Result<(), String> {
        let meta = SessionMeta {
            session_id: self.session_id.clone(),
            started_at: self.started_at_wall.to_rfc3339(),
            ended_at: ended.map(|(t, _)| t.to_rfc3339()),
            duration_secs: ended.map(|(_, d)| d).unwrap_or(0),
            backend: self.backend.clone(),
            language: self.language.clone(),
            device: self.device.clone(),
            count: self.count,
            incomplete_count: self.incomplete_count,
            has_summary_zh: self.dir.join("summary.zh.md").exists(),
            has_summary_en: self.dir.join("summary.en.md").exists(),
            has_summary_vi: self.dir.join("summary.vi.md").exists(),
        };
        let json =
            serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize meta: {e}"))?;
        std::fs::write(self.dir.join("meta.json"), json).map_err(|e| format!("write meta: {e}"))?;
        Ok(())
    }
}

/// Read meta.json from disk for a given session. Used by list_sessions and
/// the history modal — keeps file format authoritative even after a crash.
pub fn read_meta(session_id: &str) -> Result<SessionMeta, String> {
    let path = session_dir(session_id).join("meta.json");
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
    serde_json::from_str::<SessionMeta>(&content).map_err(|e| format!("parse meta: {e}"))
}

/// Re-read meta.json, refresh has_summary_* booleans from file existence,
/// write back. Called after generate_summary so the history list reflects
/// the new summary without requiring an app restart.
pub fn touch_meta_summary_flags(session_id: &str) -> Result<(), String> {
    let mut meta = read_meta(session_id)?;
    let dir = session_dir(session_id);
    meta.has_summary_zh = dir.join("summary.zh.md").exists();
    meta.has_summary_en = dir.join("summary.en.md").exists();
    meta.has_summary_vi = dir.join("summary.vi.md").exists();
    let json = serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(dir.join("meta.json"), json).map_err(|e| format!("write meta: {e}"))?;
    Ok(())
}

pub fn read_transcript(session_id: &str) -> Result<Vec<StoredUtterance>, String> {
    let path = session_dir(session_id).join("transcript.jsonl");
    let f = File::open(&path).map_err(|e| format!("open transcript: {e}"))?;
    let mut out = Vec::new();
    for (i, line) in BufReader::new(f).lines().enumerate() {
        let line = line.map_err(|e| format!("read line {i}: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<StoredUtterance>(&line) {
            Ok(u) => out.push(u),
            Err(e) => errors::record(
                "session_transcript_parse",
                &format!("line {i}: {e}"),
                Some(serde_json::json!({ "session_id": session_id, "line": line })),
            ),
        }
    }
    // Lines are appended in translation-completion order, which can race
    // across utterances (en/vi finishing at different times for adjacent
    // sentences). Sort by t_start so callers — UI display and summary
    // generation — see the actual chronological flow of the meeting.
    out.sort_by(|a, b| a.t_start.partial_cmp(&b.t_start).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[tauri::command]
pub async fn session_append_utterance(
    state: tauri::State<'_, SharedRecorder>,
    utterance: StoredUtterance,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    let Some(rec) = guard.as_mut() else {
        // No active session — silently drop. Happens if the frontend flushes
        // pending utterances after stop_stt has already finalized.
        return Ok(());
    };
    if let Err(e) = rec.append(&utterance) {
        errors::record(
            "session_append_failed",
            &e,
            Some(serde_json::json!({ "session_id": rec.session_id })),
        );
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<SessionMeta>, String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut metas = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read sessions dir: {e}"))?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        match read_meta(&name) {
            Ok(meta) => metas.push(meta),
            Err(e) => errors::record(
                "session_list_skip",
                &format!("{name}: {e}"),
                None,
            ),
        }
    }
    // Newest first by started_at (RFC3339 sorts lexicographically).
    metas.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(metas)
}

#[tauri::command]
pub async fn get_session_transcript(
    session_id: String,
) -> Result<Vec<StoredUtterance>, String> {
    read_transcript(&session_id)
}

#[tauri::command]
pub async fn get_session_meta(session_id: String) -> Result<SessionMeta, String> {
    read_meta(&session_id)
}

#[tauri::command]
pub async fn delete_session(
    state: tauri::State<'_, SharedRecorder>,
    session_id: String,
) -> Result<(), String> {
    // Refuse to delete the currently-active session — would corrupt the
    // recorder's in-memory state and leave subsequent appends pointing at a
    // missing file.
    if let Some(rec) = state.lock().await.as_ref() {
        if rec.session_id == session_id {
            return Err("無法刪除目前進行中的會議".into());
        }
    }
    let dir = session_dir(&session_id);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("delete session: {e}"))
}

#[tauri::command]
pub async fn open_session_folder(session_id: String) -> Result<(), String> {
    let dir = session_dir(&session_id);
    if !dir.exists() {
        return Err("session folder not found".into());
    }
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

fn format_relative_time(secs: f64) -> String {
    let total = secs.max(0.0).floor() as u64;
    let m = total / 60;
    let s = total % 60;
    format!("{:02}:{:02}", m, s)
}

fn format_local_started(rfc3339: &str) -> String {
    DateTime::parse_from_rfc3339(rfc3339)
        .ok()
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| rfc3339.to_string())
}

fn format_duration_min_sec(secs: u64) -> String {
    let m = secs / 60;
    let s = secs % 60;
    if m == 0 {
        format!("{s} 秒")
    } else if s == 0 {
        format!("{m} 分鐘")
    } else {
        format!("{m} 分 {s} 秒")
    }
}

/// Build a zh-only Markdown transcript with relative timestamps and a
/// metadata header. Written into the session directory; user grabs it via
/// "在 Finder 開啟" or just shares the file.
#[tauri::command]
pub async fn export_session_markdown(session_id: String) -> Result<String, String> {
    let meta = read_meta(&session_id)?;
    let utterances = read_transcript(&session_id)?;

    let mut md = String::new();
    md.push_str(&format!(
        "# 會議記錄 {}\n\n",
        format_local_started(&meta.started_at)
    ));
    md.push_str(&format!(
        "- 時長：{}\n",
        format_duration_min_sec(meta.duration_secs)
    ));
    md.push_str(&format!("- 句數：{}\n", meta.count));
    let backend_label = if meta.backend == "cloud" {
        "雲端 Deepgram"
    } else {
        "本地 mlx-whisper"
    };
    md.push_str(&format!("- 辨識：{backend_label}\n"));
    if !meta.device.is_empty() {
        md.push_str(&format!("- 麥克風：{}\n", meta.device));
    }
    if meta.incomplete_count > 0 {
        md.push_str(&format!(
            "- 未完成翻譯：{} 句（停止錄音時翻譯尚未完成）\n",
            meta.incomplete_count
        ));
    }
    md.push_str("\n## 逐字稿\n\n");

    if utterances.is_empty() {
        md.push_str("（無）\n");
    } else {
        for u in &utterances {
            let zh = u.zh.trim();
            if zh.is_empty() {
                continue;
            }
            md.push_str(&format!("- `{}` {}\n", format_relative_time(u.t_start), zh));
        }
    }

    let path = session_dir(&session_id).join("transcript.md");
    std::fs::write(&path, md).map_err(|e| format!("write transcript.md: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Reveal a file in Finder with `open -R`. Used after export so the user
/// sees the freshly-written markdown highlighted.
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

/// Reveal `summary.{target}.md` for a given session. Frontend doesn't know
/// the absolute session_dir path, so we resolve it server-side. Validates
/// `target` against the known set to refuse arbitrary file names.
#[tauri::command]
pub async fn reveal_session_summary(session_id: String, target: String) -> Result<(), String> {
    if !matches!(target.as_str(), "zh" | "en" | "vi") {
        return Err(format!("invalid target: {target}"));
    }
    let path = session_dir(&session_id).join(format!("summary.{target}.md"));
    if !path.exists() {
        return Err("summary file not found".into());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

/// Begin a new session and store the recorder in shared state. If a prior
/// recorder is still present (e.g. user clicked stop and immediately start
/// without the watchdog firing), finalize it first so its meta.json has an
/// end time before we overwrite the slot.
pub async fn start_session(
    state: &SharedRecorder,
    backend: String,
    language: String,
    device: String,
) -> Result<String, String> {
    let mut guard = state.lock().await;
    if let Some(prev) = guard.as_ref() {
        let _ = prev.finalize();
    }
    let rec = SessionRecorder::start(backend, language, device)?;
    let id = rec.session_id.clone();
    *guard = Some(rec);
    Ok(id)
}

/// Finalize the active session (write end time + counts) and clear the slot.
/// Returns the just-closed session id (so callers like `stop_stt` can trigger
/// post-session work such as auto-summary), or `None` if no session was active.
pub async fn stop_session(state: &SharedRecorder) -> Option<String> {
    let mut guard = state.lock().await;
    if let Some(rec) = guard.take() {
        let id = rec.session_id.clone();
        if let Err(e) = rec.finalize() {
            errors::record(
                "session_finalize_failed",
                &e,
                Some(serde_json::json!({ "session_id": rec.session_id })),
            );
        }
        Some(id)
    } else {
        None
    }
}
