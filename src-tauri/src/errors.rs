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

/// Deep-link into macOS System Settings → Privacy & Security → Microphone
/// so the user can grant MeetingCast mic access without hunting for the pane.
#[tauri::command]
pub async fn open_mic_settings() -> Result<(), String> {
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
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
    // One pre-built buffer, one `write_all`: `writeln!` formats in pieces and
    // can issue several writes, which interleave when two tasks log at once.
    let mut buf = line;
    buf.push('\n');
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(buf.as_bytes());
    }
}

/// Write `contents` to `path` atomically: write a sibling temp file, fsync it,
/// then rename over the target. A crash or a concurrent reader mid-write sees
/// either the old file or the new one — never a truncated half. The temp name
/// is unique per call so two writers to the same file can't clobber each
/// other's temp.
pub fn write_atomic(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = path.with_file_name(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("meetingcast-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name() != "meta.json")
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
