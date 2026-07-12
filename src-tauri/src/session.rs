use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::errors;
use crate::languages;

/// One persisted line in transcript.jsonl (schema v2). `src` is the source-
/// language transcript; `translations` maps each target language code to its
/// rendered text. `incomplete = true` means the session was stopped before a
/// translation finished — a missing/empty entry is intentional, not a bug.
///
/// Legacy v1 rows carried flat `{zh, en, vi}` fields; those are kept as
/// deserialize-only mirrors so old transcript.jsonl files stay readable, and
/// `normalize()` folds them into `src` / `translations`. New writes are v2-only.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredUtterance {
    pub id: String,
    pub t_start: f64,
    pub t_end: f64,
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
    #[serde(default)]
    pub incomplete: bool,
    /// Reserved for future auto-detect mode — the language Whisper detected
    /// for this utterance. Omitted from serialization while None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    // ---- Legacy v1 fields: deserialize-only, never re-serialized. ----
    #[serde(default, skip_serializing)]
    pub zh: String,
    #[serde(default, skip_serializing)]
    pub en: String,
    #[serde(default, skip_serializing)]
    pub vi: String,
}

impl StoredUtterance {
    /// Fold a legacy v1 row (`{zh, en, vi}`) into the v2 shape (`src` +
    /// `translations`). Idempotent: a row already in v2 form (empty legacy
    /// fields) is left untouched. Run on every read and before every write so
    /// mixed-vintage transcript.jsonl files stay readable and new writes are
    /// v2-only.
    pub fn normalize(&mut self) {
        if self.src.is_empty() && !self.zh.is_empty() {
            self.src = std::mem::take(&mut self.zh);
        }
        if !self.en.is_empty() && !self.translations.contains_key("en") {
            self.translations
                .insert("en".to_string(), std::mem::take(&mut self.en));
        }
        if !self.vi.is_empty() && !self.translations.contains_key("vi") {
            self.translations
                .insert("vi".to_string(), std::mem::take(&mut self.vi));
        }
        // Drop any remaining legacy remnants (e.g. a stale zh when src was
        // already populated) so re-serialization is pure v2.
        self.zh.clear();
        self.en.clear();
        self.vi.clear();
    }
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
    /// Registry codes of every `summary.{code}.md` present on disk (v2). The
    /// three legacy bools below are kept serialized and derived from this so a
    /// downgraded 0.1.x app still reads summary availability.
    #[serde(default)]
    pub has_summaries: Vec<String>,
    #[serde(default)]
    pub has_summary_zh: bool,
    #[serde(default)]
    pub has_summary_en: bool,
    #[serde(default)]
    pub has_summary_vi: bool,
}

impl SessionMeta {
    /// Set `has_summaries` and derive the legacy has_summary_* bools from it so
    /// both representations stay consistent on every write.
    fn set_summaries(&mut self, codes: Vec<String>) {
        self.has_summary_zh = codes.iter().any(|c| c == "zh");
        self.has_summary_en = codes.iter().any(|c| c == "en");
        self.has_summary_vi = codes.iter().any(|c| c == "vi");
        self.has_summaries = codes;
    }

    /// Reconstruct `has_summaries` from the legacy bools when reading a pre-v2
    /// meta.json (where `has_summaries` defaults to empty). No-op once the list
    /// is populated, so a real "no summaries" v2 meta is not re-derived.
    fn backfill_summaries(&mut self) {
        if !self.has_summaries.is_empty() {
            return;
        }
        if self.has_summary_zh {
            self.has_summaries.push("zh".into());
        }
        if self.has_summary_en {
            self.has_summaries.push("en".into());
        }
        if self.has_summary_vi {
            self.has_summaries.push("vi".into());
        }
    }
}

/// Scan a session dir for `summary.{code}.md` across every registry language,
/// returning the codes that exist in registry order. Feeds
/// `SessionMeta::set_summaries`.
fn scan_summaries(dir: &Path) -> Vec<String> {
    languages::all()
        .iter()
        .filter(|l| dir.join(format!("summary.{}.md", l.code)).exists())
        .map(|l| l.code.clone())
        .collect()
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

/// Validate an externally supplied session id before it is joined to the
/// sessions directory. Tauri commands are an IPC boundary: even though the
/// React UI only sends ids returned by `list_sessions`, a compromised webview
/// must not be able to use `../` to read or delete arbitrary user files.
pub fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalid session id".into());
    }
    Ok(())
}

impl SessionRecorder {
    /// Create a new session directory and write its initial meta.json. Uses
    /// local time for the directory name so the user can recognize meetings
    /// at a glance in Finder.
    pub fn start(backend: String, language: String, device: String) -> Result<Self, String> {
        let started_at_wall = Utc::now();
        let parent = sessions_dir();
        std::fs::create_dir_all(&parent).map_err(|e| format!("mkdir sessions: {e}"))?;
        let base = Local::now().format("%Y-%m-%d_%H-%M-%S-%6f").to_string();
        let (session_id, dir) = (0..1000)
            .find_map(|suffix| {
                let id = if suffix == 0 {
                    base.clone()
                } else {
                    format!("{base}-{suffix}")
                };
                let dir = session_dir(&id);
                match std::fs::create_dir(&dir) {
                    Ok(()) => Some(Ok((id, dir))),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(e) => Some(Err(format!("mkdir session: {e}"))),
                }
            })
            .transpose()?
            .ok_or_else(|| "could not allocate a unique session id".to_string())?;

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
        // Normalize before writing so an old-frontend {zh,en,vi} payload is
        // transparently folded into v2 — disk is v2-only from now on.
        let mut u = u.clone();
        u.normalize();
        let line = serde_json::to_string(&u).map_err(|e| format!("serialize utterance: {e}"))?;
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
        let mut meta = SessionMeta {
            session_id: self.session_id.clone(),
            started_at: self.started_at_wall.to_rfc3339(),
            ended_at: ended.map(|(t, _)| t.to_rfc3339()),
            duration_secs: ended.map(|(_, d)| d).unwrap_or(0),
            backend: self.backend.clone(),
            language: self.language.clone(),
            device: self.device.clone(),
            count: self.count,
            incomplete_count: self.incomplete_count,
            ..Default::default()
        };
        meta.set_summaries(scan_summaries(&self.dir));
        let json =
            serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize meta: {e}"))?;
        std::fs::write(self.dir.join("meta.json"), json).map_err(|e| format!("write meta: {e}"))?;
        Ok(())
    }
}

/// Read meta.json from disk for a given session. Used by list_sessions and
/// the history modal — keeps file format authoritative even after a crash.
pub fn read_meta(session_id: &str) -> Result<SessionMeta, String> {
    validate_session_id(session_id)?;
    let path = session_dir(session_id).join("meta.json");
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
    let mut meta =
        serde_json::from_str::<SessionMeta>(&content).map_err(|e| format!("parse meta: {e}"))?;
    meta.backfill_summaries();
    Ok(meta)
}

/// Re-read meta.json, refresh the summary availability (has_summaries + the
/// legacy bools) from file existence, write back. Called after generate_summary
/// so the history list reflects the new summary without an app restart.
pub fn touch_meta_summary_flags(session_id: &str) -> Result<(), String> {
    let mut meta = read_meta(session_id)?;
    let dir = session_dir(session_id);
    meta.set_summaries(scan_summaries(&dir));
    let json = serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(dir.join("meta.json"), json).map_err(|e| format!("write meta: {e}"))?;
    Ok(())
}

pub fn read_transcript(session_id: &str) -> Result<Vec<StoredUtterance>, String> {
    validate_session_id(session_id)?;
    let path = session_dir(session_id).join("transcript.jsonl");
    let f = File::open(&path).map_err(|e| format!("open transcript: {e}"))?;
    let mut out = Vec::new();
    for (i, line) in BufReader::new(f).lines().enumerate() {
        let line = line.map_err(|e| format!("read line {i}: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<StoredUtterance>(&line) {
            Ok(mut u) => {
                // Fold legacy {zh,en,vi} rows into v2 so callers see one shape.
                u.normalize();
                out.push(u);
            }
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
    validate_session_id(&session_id)?;
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
    validate_session_id(&session_id)?;
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
    validate_session_id(&session_id)?;
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
    let lang_label = languages::get(&meta.language)
        .map(|l| l.zh_ui_name.as_str())
        .unwrap_or(meta.language.as_str());
    md.push_str(&format!("- 語言：{lang_label}\n"));
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
            let src = u.src.trim();
            if src.is_empty() {
                continue;
            }
            md.push_str(&format!("- `{}` {}\n", format_relative_time(u.t_start), src));
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
    validate_session_id(&session_id)?;
    if !languages::is_valid(&target) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_validation_rejects_path_traversal() {
        for bad in ["", "../config.toml", "a/b", "a\\b", ".", "會議"] {
            assert!(validate_session_id(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn session_id_validation_accepts_generated_shape() {
        assert!(validate_session_id("2026-07-12_14-30-45-123456").is_ok());
        assert!(validate_session_id("2026-07-12_14-30-45-123456-2").is_ok());
    }

    fn parse(line: &str) -> StoredUtterance {
        serde_json::from_str(line).expect("parse utterance")
    }

    #[test]
    fn legacy_row_normalizes_into_v2() {
        let mut u = parse(
            r#"{"id":"u1","t_start":0.0,"t_end":1.0,"zh":"你好","en":"Hi","vi":"Chào","incomplete":false}"#,
        );
        u.normalize();
        assert_eq!(u.src, "你好");
        assert_eq!(u.translations.get("en").map(String::as_str), Some("Hi"));
        assert_eq!(u.translations.get("vi").map(String::as_str), Some("Chào"));
        // Legacy fields drained.
        assert!(u.zh.is_empty() && u.en.is_empty() && u.vi.is_empty());
    }

    #[test]
    fn v2_roundtrip_has_no_legacy_keys_and_omits_none_lang() {
        let mut u =
            parse(r#"{"id":"u1","t_start":0.0,"t_end":1.0,"zh":"你好","en":"Hi","vi":"Chào"}"#);
        u.normalize();
        let json = serde_json::to_string(&u).unwrap();
        let map = serde_json::from_str::<serde_json::Value>(&json).unwrap();
        let obj = map.as_object().unwrap();
        // v2 top-level keys only; no legacy zh/en/vi; lang omitted while None.
        assert!(obj.contains_key("src") && obj.contains_key("translations"));
        assert!(!obj.contains_key("zh"));
        assert!(!obj.contains_key("en"));
        assert!(!obj.contains_key("vi"));
        assert!(!obj.contains_key("lang"));
        // Round-trips back to the same v2 content.
        let back = parse(&json);
        assert_eq!(back.src, "你好");
        assert_eq!(back.translations.get("en").map(String::as_str), Some("Hi"));
    }

    #[test]
    fn normalize_is_idempotent_on_v2_rows() {
        let mut u = parse(
            r#"{"id":"u1","t_start":0.0,"t_end":1.0,"src":"你好","translations":{"en":"Hi"}}"#,
        );
        u.normalize();
        let once = serde_json::to_string(&u).unwrap();
        u.normalize();
        let twice = serde_json::to_string(&u).unwrap();
        assert_eq!(once, twice);
        assert_eq!(u.src, "你好");
        assert_eq!(u.translations.get("en").map(String::as_str), Some("Hi"));
    }

    #[test]
    fn lang_serializes_when_some() {
        let mut u = parse(r#"{"id":"u1","t_start":0.0,"t_end":1.0,"src":"やあ","lang":"ja"}"#);
        u.normalize();
        let json = serde_json::to_string(&u).unwrap();
        let map = serde_json::from_str::<serde_json::Value>(&json).unwrap();
        assert_eq!(map.get("lang").and_then(|v| v.as_str()), Some("ja"));
    }

    #[test]
    fn meta_legacy_bools_backfill_has_summaries() {
        let mut meta = serde_json::from_str::<SessionMeta>(
            r#"{"session_id":"s","started_at":"t","has_summary_zh":true,"has_summary_en":true}"#,
        )
        .unwrap();
        assert!(meta.has_summaries.is_empty());
        meta.backfill_summaries();
        assert_eq!(meta.has_summaries, vec!["zh".to_string(), "en".to_string()]);
    }

    #[test]
    fn meta_set_summaries_keeps_both_representations_consistent() {
        let mut meta = SessionMeta::default();
        // ja has no legacy bool mirror — it lives only in has_summaries.
        meta.set_summaries(vec!["zh".into(), "ja".into()]);
        assert!(meta.has_summary_zh);
        assert!(!meta.has_summary_en);
        assert!(!meta.has_summary_vi);
        assert_eq!(meta.has_summaries, vec!["zh".to_string(), "ja".to_string()]);

        // A populated has_summaries survives a read-path backfill unchanged.
        let json = serde_json::to_string(&meta).unwrap();
        let mut back = serde_json::from_str::<SessionMeta>(&json).unwrap();
        back.backfill_summaries();
        assert_eq!(back.has_summaries, vec!["zh".to_string(), "ja".to_string()]);
        assert!(back.has_summary_zh && !back.has_summary_en);
    }
}
