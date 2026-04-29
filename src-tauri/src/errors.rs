use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

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
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}
