use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::errors::config_dir;

/// One per-request record of an Anthropic API call — latency, token usage,
/// cache activity, and final disposition. Written as JSON-lines so it's cheap
/// to append and easy to grep / feed into a spreadsheet when profiling cost or
/// perceived latency. Distinct from `errors.log`: traces record *every* call
/// (including successes), errors record only failures.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TraceRecord {
    /// RFC3339 timestamp of when the call finished.
    pub ts: String,
    /// "translate" | "summary".
    pub kind: String,
    /// Utterance id (translate) or session id (summary).
    pub id: String,
    /// Target language ("en" / "vi" / "zh").
    pub target: String,
    /// Model id the request was sent to.
    pub model: String,
    /// Time to first content_block_delta, ms. None if no content streamed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// Wall-clock from request start to call end, ms.
    pub total_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Number of retries performed (0 = succeeded on first attempt).
    pub retries: u32,
    /// "ok" | "error" | "filtered" | "empty".
    pub outcome: String,
    /// Glossary terms present in the source whose required target translation
    /// was missing from the delivered output. Observe-only — recorded for
    /// review but never blocks or rewrites the translation. `None` when the
    /// check found no violations or wasn't run (summaries, filtered replies).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glossary_violations: Option<Vec<String>>,
}

pub fn trace_path() -> PathBuf {
    config_dir().join("traces.jsonl")
}

/// Rotate the trace file when it exceeds this size. Keeps one prior file as
/// `traces.jsonl.1`; older rotations are dropped. Same policy as errors.log.
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// If the trace log has grown past LOG_ROTATE_BYTES, rename it to `<path>.1`,
/// overwriting any existing rotation. Best-effort: any IO failure is silently
/// ignored.
fn maybe_rotate(path: &PathBuf) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() < LOG_ROTATE_BYTES {
        return;
    }
    let rotated = path.with_extension("jsonl.1");
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, &rotated);
}

/// Append one JSON-lines trace record. Best-effort: never panics, silently
/// drops the record on any IO / serialization failure.
pub fn record(rec: TraceRecord) {
    let Ok(line) = serde_json::to_string(&rec) else {
        return;
    };
    append_line(&line);
}

/// One STT hallucination-gate skip forwarded by the sidecar. Shares
/// traces.jsonl (and its rotation) with the API-call `TraceRecord` — the
/// `kind` field ("stt_diag") disambiguates the two record shapes on read.
/// Observe-only: recorded for offline gate tuning, never surfaced in the UI.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct DiagRecord {
    ts: String,
    /// Always "stt_diag".
    kind: String,
    /// Which gate skipped the segment (min_speech / rms_floor / consistency /
    /// segment_confidence / hallucination_phrase / single_char_dominance).
    gate: String,
    /// Utterance start time in seconds, when the gate site knows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    t_start: Option<f64>,
    /// Small dict of the numbers that triggered the skip (no audio data).
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

/// Append one STT gate-skip diagnostic to traces.jsonl. Best-effort, same as
/// `record`.
pub fn record_diag(gate: &str, t_start: Option<f64>, detail: Option<serde_json::Value>) {
    let rec = DiagRecord {
        ts: Utc::now().to_rfc3339(),
        kind: "stt_diag".into(),
        gate: gate.to_string(),
        t_start,
        detail,
    };
    let Ok(line) = serde_json::to_string(&rec) else {
        return;
    };
    append_line(&line);
}

/// Shared append path used by both record writers: ensure dir, rotate if
/// oversized, append one line. Best-effort — any IO failure is dropped.
fn append_line(line: &str) {
    let path = trace_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    maybe_rotate(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TraceRecord {
        TraceRecord {
            ts: "2026-07-06T00:00:00+00:00".into(),
            kind: "translate".into(),
            id: "12.5".into(),
            target: "en".into(),
            model: "claude-haiku-4-5".into(),
            ttft_ms: Some(210),
            total_ms: 640,
            input_tokens: Some(120),
            output_tokens: Some(18),
            cache_creation_input_tokens: Some(0),
            cache_read_input_tokens: Some(96),
            stop_reason: Some("end_turn".into()),
            retries: 1,
            outcome: "ok".into(),
            glossary_violations: None,
        }
    }

    #[test]
    fn serializes_all_populated_fields() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"kind\":\"translate\""));
        assert!(json.contains("\"ttft_ms\":210"));
        assert!(json.contains("\"stop_reason\":\"end_turn\""));
        assert!(json.contains("\"retries\":1"));
        assert!(json.contains("\"outcome\":\"ok\""));
    }

    #[test]
    fn round_trips_and_omits_none_options() {
        let rec = TraceRecord {
            ttft_ms: None,
            input_tokens: None,
            output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            stop_reason: None,
            ..sample()
        };
        let json = serde_json::to_string(&rec).unwrap();
        // Option::None fields are skipped, not emitted as null.
        assert!(!json.contains("ttft_ms"));
        assert!(!json.contains("stop_reason"));
        assert!(!json.contains("glossary_violations"));
        // Required fields always present.
        assert!(json.contains("\"total_ms\":640"));
        let back: TraceRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "translate");
        assert_eq!(back.total_ms, 640);
        assert!(back.ttft_ms.is_none());
    }

    #[test]
    fn diag_record_serializes_with_kind_and_omits_none() {
        let rec = DiagRecord {
            ts: "2026-07-06T00:00:00+00:00".into(),
            kind: "stt_diag".into(),
            gate: "rms_floor".into(),
            t_start: None,
            detail: Some(serde_json::json!({ "rms": 0.001, "threshold": 0.005 })),
        };
        let json = serde_json::to_string(&rec).unwrap();
        assert!(json.contains("\"kind\":\"stt_diag\""));
        assert!(json.contains("\"gate\":\"rms_floor\""));
        assert!(json.contains("\"rms\":0.001"));
        // None fields are skipped, not emitted as null.
        assert!(!json.contains("t_start"));
        let back: DiagRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.gate, "rms_floor");
        assert!(back.t_start.is_none());
        assert!(back.detail.is_some());
    }
}
