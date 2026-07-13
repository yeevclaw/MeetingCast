"""Stdio JSON-RPC protocol for the MeetingCast STT sidecar.

Each direction is line-delimited JSON over stdin/stdout. One JSON object per line.

Rust → Python (commands):
    {"type": "start", "backend": "local"|"openai",
     "source": {"type": "mic"} | {"type": "wav", "path": "..."},
     "language": "zh",                 -- canonical code (session/meta/local/openai)
     "detect_language": false?}        -- reserved for future auto-detect; ignored
    {"type": "stop"}
    {"type": "shutdown"}

Python → Rust (events):
    {"type": "ready"}                                    -- on startup
    {"type": "started"}                                  -- after start command accepted
    {"type": "transcript", "text": "...", "is_final": bool, "t_start": float, "t_end": float}
    {"type": "stopped"}                                  -- after stop command
    {"type": "error", "message": "..."}
    {"type": "prewarm", "step": "model"|"mic", "state": "start"|"progress"|"done"|"error",
     "message": "..."?,                                  -- present when state == "error"
     "downloaded_bytes": int?, "total_bytes": int?}      -- present when state == "progress"
                                                          -- (model download only; missing dir → 0,
                                                          --  downloaded clamped ≤ 99% of total until done)
    {"type": "diag", "gate": "...", "t_start": float|null, "detail": {...}}
                                                          -- local backend only: one per gate skip.
                                                          -- gate ∈ {min_speech, rms_floor, consistency,
                                                          --  segment_confidence, hallucination_phrase,
                                                          --  single_char_dominance}. detail carries the
                                                          --  relevant numbers (no audio). Rust records
                                                          --  these to traces.jsonl; not shown in the UI.
"""
