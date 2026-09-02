"""Pure configuration helpers for OpenAI Realtime transcription.

Kept dependency-free so the session contract can be unit-tested without
loading torch, silero-vad, MLX, or opening a billable API connection.
"""

from __future__ import annotations

from typing import Any, Iterable


LIVE_TRANSCRIBE_MODEL = "gpt-live-transcribe"
LEGACY_REALTIME_WHISPER_MODEL = "gpt-realtime-whisper"
TARGET_RATE = 24_000
MAX_KEYWORDS = 30

# The `zh-tw` language hint alone does NOT make gpt-live-transcribe emit
# Traditional characters (measured 2026-09-02: simplified output on a 90s
# Taiwanese weather clip). A short Traditional-Chinese carrier sentence in the
# prompt fixed it (reference similarity 0.69 → 0.88). Prepended to whatever
# glossary context the config layer supplies.
ZH_TW_SCRIPT_PROMPT = "以下為繁體中文的會議內容，請以繁體中文輸出。"

# gpt-live-transcribe `delay` levels, fastest first. `minimal` measured ~1.1s
# delta lag vs ~2.5s for `low` with no visible accuracy change on the same clip.
DELAY_LEVELS = ("minimal", "low", "medium", "high", "xhigh")
DEFAULT_DELAY = "minimal"


def _language_hints(language: str) -> list[str]:
    """Return the model's expected-language hints for a source language.

    The live model supports regional Chinese locale codes. MeetingCast's `zh`
    source means Traditional Chinese, so `zh-tw` is more precise than a bare
    `zh`. Other current source languages already use supported ISO 639-1 codes.
    """

    normalized = language.strip().lower()
    if normalized == "zh":
        return ["zh-tw"]
    return [normalized] if normalized else []


def sanitize_keywords(keywords: Iterable[str] | None) -> list[str]:
    """Normalize glossary terms for the Realtime `keywords` field.

    OpenAI rejects keywords containing angle brackets or line breaks. Invalid
    terms are omitted rather than rewritten, because changing a proper noun
    would make the hint actively misleading. Duplicates are removed while
    preserving order, and the existing MeetingCast glossary cap is retained.
    """

    out: list[str] = []
    seen: set[str] = set()
    for raw in keywords or ():
        term = str(raw).strip()
        if not term or any(ch in term for ch in ("<", ">", "\r", "\n")):
            continue
        if term in seen:
            continue
        seen.add(term)
        out.append(term)
        if len(out) >= MAX_KEYWORDS:
            break
    return out


def build_session_payload(
    *,
    model: str = LIVE_TRANSCRIBE_MODEL,
    language: str,
    prompt: str | None = None,
    keywords: Iterable[str] | None = None,
    delay: str = DEFAULT_DELAY,
) -> dict[str, Any]:
    """Build a Realtime transcription `session.update` event.

    Explicit use of the previous model keeps its legacy minimal schema. This
    is a rollback seam for developers; production defaults to the live model.
    """

    if model == LEGACY_REALTIME_WHISPER_MODEL:
        return {
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": TARGET_RATE},
                        "transcription": {
                            "model": model,
                            "language": language,
                        },
                    },
                },
            },
        }

    if delay not in DELAY_LEVELS:
        delay = DEFAULT_DELAY
    transcription: dict[str, Any] = {"model": model, "delay": delay}
    language_hints = _language_hints(language)
    if language_hints:
        transcription["languages"] = language_hints
    clean_prompt = (prompt or "").strip()
    if language_hints == ["zh-tw"]:
        clean_prompt = (ZH_TW_SCRIPT_PROMPT + " " + clean_prompt).strip()
    if clean_prompt:
        transcription["prompt"] = clean_prompt
    clean_keywords = sanitize_keywords(keywords)
    if clean_keywords:
        transcription["keywords"] = clean_keywords

    return {
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": TARGET_RATE},
                    "transcription": transcription,
                    # MeetingCast keeps its existing local Silero VAD and
                    # explicitly commits each utterance boundary.
                    "turn_detection": None,
                },
            },
        },
    }
