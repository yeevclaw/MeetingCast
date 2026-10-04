"""Small, dependency-free helpers shared by the local and cloud STT backends.

Kept free of torch / silero / MLX imports so the pure logic (cut-point
picking, segment joining) can be unit-tested without loading any model.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path


class ProbTap:
    """Transparent proxy around a silero VAD model that remembers the last
    speech probability it produced.

    silero's VADIterator calls `model(x, sr).item()` internally and only
    returns start/end events, never the probability. Calling the model a
    second time ourselves would advance its recurrent state twice and corrupt
    the VAD, so instead we hand VADIterator this proxy and read `.last` after
    each call."""

    def __init__(self, model):
        self.model = model
        self.last: float = 0.0

    def __call__(self, x, sr):
        out = self.model(x, sr)
        try:
            self.last = float(out.item())
        except Exception:  # noqa: BLE001 — never break the VAD over a probe
            pass
        return out

    def reset_states(self, *args, **kwargs):
        return self.model.reset_states(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self.model, name)


def pick_cut_index(
    probs: Sequence[float],
    lookback: int,
    rms: Sequence[float] | None = None,
) -> int:
    """Choose where to force-cut an over-long utterance.

    `probs[i]` is the VAD speech probability of window i (rms[i] its energy,
    optional). Only the last `lookback` windows are candidates. Returns the
    index i to cut AFTER — the head is windows[:i + 1], the remainder
    windows[i + 1:] is carried into the next utterance.

    Picks the window with the lowest speech probability (the most pause-like
    moment: a breath, a word gap); ties broken by lower RMS, then by the
    LATEST index so the head stays as long as possible. Returns -1 for an
    empty input."""
    n = len(probs)
    if n == 0:
        return -1
    lo = max(0, n - max(1, lookback))

    def key(i: int):
        energy = float(rms[i]) if rms is not None and i < len(rms) else 0.0
        return (float(probs[i]), energy, -i)

    return min(range(lo, n), key=key)


# script_profile values (shared/languages.json) whose text is written without
# spaces between words — Whisper segment texts must be joined with "" there.
_UNSPACED_SCRIPTS = {"han", "japanese"}
# Fallback when the registry file isn't reachable (the PyInstaller bundle does
# not ship shared/); mirrors the registry's script_profile for these codes.
_UNSPACED_FALLBACK = {"zh", "ja"}
_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "shared" / "languages.json"
_registry_cache: dict[str, str] | None = None


def _script_profiles() -> dict[str, str]:
    global _registry_cache
    if _registry_cache is None:
        try:
            entries = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
            _registry_cache = {
                str(e["code"]): str(e.get("script_profile", "")) for e in entries
            }
        except Exception:  # noqa: BLE001 — bundled sidecar: no registry file
            _registry_cache = {}
    return _registry_cache


def segment_joiner(language: str) -> str:
    """Separator for joining Whisper segment texts: "" for scripts written
    without inter-word spaces (zh / ja), " " otherwise."""
    code = (language or "").strip().lower().split("-")[0]
    profile = _script_profiles().get(code)
    if profile:
        return "" if profile in _UNSPACED_SCRIPTS else " "
    return "" if code in _UNSPACED_FALLBACK else " "
