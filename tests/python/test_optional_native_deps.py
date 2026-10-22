"""Collection must succeed even when native STT packages are unavailable."""

import subprocess
import sys
from pathlib import Path


def test_collection_without_native_dependencies():
    repo = Path(__file__).resolve().parents[2]
    # Use a fresh interpreter so installed/cached native modules cannot mask
    # missing dependencies, including on a developer's Mac.
    script = """
import importlib.abc
import sys
import pytest

class MissingNative(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {
            'mlx', 'mlx_whisper', 'torch', 'silero_vad', 'sounddevice'
        }:
            raise ModuleNotFoundError(fullname, name=fullname)

sys.meta_path.insert(0, MissingNative())
raise SystemExit(pytest.main([
    '-q', '-o', 'addopts=',
    'tests/python/test_hallucination_gates.py',
    'tests/python/test_sentence_split.py',
    'tests/python/test_stt_robustness.py',
    'tests/python/test_language_registry.py',
    'tests/python/test_openai_transcription_config.py',
]))
"""
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=repo,
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "3 skipped" in result.stdout
    assert "passed" in result.stdout
