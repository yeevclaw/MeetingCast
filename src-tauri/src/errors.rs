use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct ErrorRecord<'a> {
    timestamp: String,
    category: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<Value>,
}

pub fn log_path() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("MeetingCast/errors.log"))
        .unwrap_or_else(|| PathBuf::from("errors.log"))
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("MeetingCast"))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
pub async fn open_config_folder() -> Result<(), String> {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_errors_log() -> Result<(), String> {
    let path = log_path();
    if !path.exists() {
        // Create an empty file so the system has something to open.
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path);
    }
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open: {e}"))?;
    Ok(())
}

/// Rotate the log file when it exceeds this size. Keeps one prior file as
/// `errors.log.1` so the user can still inspect history; older rotations are
/// dropped. 10 MB is plenty for tens of thousands of JSON-line records but
/// small enough to open quickly in a text editor.
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// If the log has grown past LOG_ROTATE_BYTES, rename it to `<path>.1`,
/// overwriting any existing rotation. Best-effort: any IO failure is
/// silently ignored — the next `record` call will append to whatever file
/// state we ended up in.
fn maybe_rotate(path: &PathBuf) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() < LOG_ROTATE_BYTES {
        return;
    }
    let rotated = path.with_extension("log.1");
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, &rotated);
}

/// Append one JSON-lines record to the user-scoped error log. Best-effort:
/// if the file cannot be opened, fall back to stderr. Never panics.
pub fn record(category: &str, message: &str, context: Option<Value>) {
    let rec = ErrorRecord {
        timestamp: Utc::now().to_rfc3339(),
        category,
        message,
        context,
    };
    let Ok(line) = serde_json::to_string(&rec) else {
        return;
    };
    eprintln!("[meetingcast error] {line}");
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    maybe_rotate(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}
