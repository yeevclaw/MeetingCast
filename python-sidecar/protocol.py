"""Stdio JSON-RPC protocol for the MeetingCast STT sidecar.

Each direction is line-delimited JSON over stdin/stdout. One JSON object per line.

Rust → Python (commands):
    {"type": "start", "backend": "local"|"openai",
     "source": {"type": "mic"} | {"type": "wav", "path": "..."},
     "language": "zh",                 -- canonical code (session/meta/local/openai)
     "initial_prompt": "..."?,         -- source-language glossary context
     "keywords": ["..."]?,             -- canonical terms; OpenAI live only
     "detect_language": false?}        -- reserved for future auto-detect; ignored
    {"type": "stop"}
    {"type": "shutdown"}

Python → Rust (events):
    {"type": "ready"}                                    -- on startup
    {"type": "started"}                                  -- after start command accepted
    {"type": "transcript", "text": "...", "is_final": bool, "t_start": float, "t_end": float}
    {"type": "stopped", "reason": "..."}                 -- after stop command. `stop` is graceful:
                                                          --  the audio source ends, buffered speech is
                                                          --  flushed (local: ≥0.5 s → final, boundary
                                                          --  "pause"; cloud: final commit, ≤2 s for the
                                                          --  result), THEN `stopped`; hard-cancelled
                                                          --  after 2.5 s.
                                                          -- Exactly once per run, with "reason":
                                                          --  "requested" (stop / shutdown command),
                                                          --  "source_ended" (demo WAV played to the end),
                                                          --  "error" (setup failed / stt error / cloud
                                                          --  gave up / mic stream ended on its own).
    {"type": "error", "message": "..."}                  -- cloud give-up after reconnects: error (繁中)
                                                          --  then stopped
    {"type": "level", "rms": float}                      -- every ~250 ms while capturing; linear RMS of
                                                          --  the last ~250 ms of audio, clipped to 0..1
    {"type": "warning", "message": "...", "code": "..."?, "device": "..."?}
                                                          -- code ∈ {reconnecting, reconnected,
                                                          --  mic_stalled (no frames ≥3 s), mic_resumed,
                                                          --  device_fallback (+ "device": name opened)}
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
