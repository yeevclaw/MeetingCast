"""Stdio JSON-RPC protocol for the MeetingCast STT sidecar.

Each direction is line-delimited JSON over stdin/stdout. One JSON object per line.

Rust → Python (commands):
    {"type": "start", "backend": "local"|"cloud",
     "source": {"type": "mic"} | {"type": "wav", "path": "..."},
     "language": "zh"}
    {"type": "stop"}
    {"type": "shutdown"}

Python → Rust (events):
    {"type": "ready"}                                    -- on startup
    {"type": "started"}                                  -- after start command accepted
    {"type": "transcript", "text": "...", "is_final": bool, "t_start": float, "t_end": float}
    {"type": "stopped"}                                  -- after stop command
    {"type": "error", "message": "..."}
"""
