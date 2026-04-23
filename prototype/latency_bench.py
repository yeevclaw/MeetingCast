"""Latency benchmark for Phase 1 pipeline.

Takes one or more WAV files, runs VAD to segment, then runs each segment
through local STT + parallel Claude translation, collecting per-stage
latencies and printing a Markdown report.

Usage:
  .venv/bin/python latency_bench.py samples/weather_90s.wav
  .venv/bin/python latency_bench.py samples/weather_90s.wav samples/zh_short.wav --output docs/LATENCY.md
"""
import argparse
import asyncio
import os
import statistics
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

from stt import get_backend
from translator import Translator
from vad import VADSegmenter, load_wav_float32


@dataclass
class SegmentRun:
    source: str
    index: int
    t_start: float
    duration: float
    text_zh: str
    stt_ms: float
    en_first_token_ms: float
    en_total_ms: float
    vi_first_token_ms: float
    vi_total_ms: float

    @property
    def end_to_end_en_ms(self) -> float:
        return self.stt_ms + self.en_first_token_ms

    @property
    def end_to_end_vi_ms(self) -> float:
        return self.stt_ms + self.vi_first_token_ms


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    k = (len(values) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(values) - 1)
    return values[f] + (values[c] - values[f]) * (k - f)


def stats(values: list[float]) -> dict:
    if not values:
        return {"p50": 0, "p95": 0, "max": 0, "mean": 0, "n": 0}
    return {
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": max(values),
        "mean": statistics.mean(values),
        "n": len(values),
    }


def segment_to_wav(seg_audio: np.ndarray, sr: int) -> str:
    tf = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tf.close()
    with wave.open(tf.name, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((seg_audio * 32768).astype(np.int16).tobytes())
    return tf.name


async def run_segment(stt, translator: Translator, seg_path: str) -> tuple[float, str, dict]:
    t0 = time.perf_counter()
    tr = stt.transcribe_file(seg_path)
    stt_ms = (time.perf_counter() - t0) * 1000
    text_zh = tr.text

    if not text_zh:
        return stt_ms, text_zh, {"en_first": 0, "en_total": 0, "vi_first": 0, "vi_total": 0}

    results = await translator.translate_both(text_zh)
    return stt_ms, text_zh, {
        "en_first": results["en"].first_token_ms,
        "en_total": results["en"].total_ms,
        "vi_first": results["vi"].first_token_ms,
        "vi_total": results["vi"].total_ms,
    }


async def bench(wav_paths: list[str]) -> tuple[list[SegmentRun], float]:
    print("loading silero-vad + mlx-whisper ...", flush=True)
    vad = VADSegmenter()
    stt = get_backend("local")
    translator = Translator()

    # Warm up mlx-whisper with any short sample so first real run isn't skewed.
    # Use the first source's first segment (tiny overhead vs biased P50).
    first_audio, first_sr = load_wav_float32(wav_paths[0])
    first_segs = vad.segment(first_audio)
    if first_segs:
        warm_path = segment_to_wav(first_segs[0].audio, first_sr)
        t_w = time.perf_counter()
        stt.transcribe_file(warm_path)
        warmup_ms = (time.perf_counter() - t_w) * 1000
        os.unlink(warm_path)
        print(f"warm-up: {warmup_ms:.0f} ms\n")

    runs: list[SegmentRun] = []
    bench_t0 = time.perf_counter()

    for path in wav_paths:
        audio, sr = load_wav_float32(path)
        segments = vad.segment(audio)
        print(f"{path}: {len(audio)/sr:.1f}s → {len(segments)} segments")

        for i, seg in enumerate(segments):
            seg_path = segment_to_wav(seg.audio, sr)
            try:
                stt_ms, text, tr = await run_segment(stt, translator, seg_path)
            finally:
                os.unlink(seg_path)

            runs.append(SegmentRun(
                source=Path(path).name,
                index=i + 1,
                t_start=seg.t_start,
                duration=seg.duration,
                text_zh=text,
                stt_ms=stt_ms,
                en_first_token_ms=tr["en_first"],
                en_total_ms=tr["en_total"],
                vi_first_token_ms=tr["vi_first"],
                vi_total_ms=tr["vi_total"],
            ))
            print(
                f"  seg {i+1:>2} dur={seg.duration:>5.2f}s "
                f"stt={stt_ms:>5.0f}ms  en={tr['en_first']:>5.0f}ms  vi={tr['vi_first']:>5.0f}ms"
            )

    total_ms = (time.perf_counter() - bench_t0) * 1000
    return runs, total_ms


def render_report(runs: list[SegmentRun], total_bench_ms: float) -> str:
    stt = stats([r.stt_ms for r in runs])
    en_first = stats([r.en_first_token_ms for r in runs])
    vi_first = stats([r.vi_first_token_ms for r in runs])
    en_total = stats([r.en_total_ms for r in runs])
    vi_total = stats([r.vi_total_ms for r in runs])
    e2e_en = stats([r.end_to_end_en_ms for r in runs])
    e2e_vi = stats([r.end_to_end_vi_ms for r in runs])

    out = []
    out.append("# Phase 1 延遲基準報告\n")
    out.append(f"- 樣本數：{len(runs)} 段（來自 VAD 切句）")
    out.append(f"- 資料來源：{', '.join(sorted({r.source for r in runs}))}")
    out.append(f"- Pipeline：mlx-whisper large-v3-turbo (Metal) + Claude Haiku 4.5 streaming")
    out.append(f"- 總耗時：{total_bench_ms/1000:.1f}s（含網路 RTT）\n")

    out.append("## 各階段延遲（ms）\n")
    out.append("| 階段 | P50 | P95 | Max | Mean |")
    out.append("|------|----:|----:|----:|-----:|")
    for name, s in [
        ("STT", stt),
        ("翻譯首 token (en)", en_first),
        ("翻譯首 token (vi)", vi_first),
        ("翻譯完成 (en)", en_total),
        ("翻譯完成 (vi)", vi_total),
        ("**端到端首 token (en)**", e2e_en),
        ("**端到端首 token (vi)**", e2e_vi),
    ]:
        out.append(f"| {name} | {s['p50']:.0f} | {s['p95']:.0f} | {s['max']:.0f} | {s['mean']:.0f} |")
    out.append("")

    out.append("## 每段原始數據\n")
    out.append("| # | src | start | dur | stt | en首 | vi首 | en全 | vi全 | 中文 |")
    out.append("|--:|-----|------:|----:|----:|-----:|-----:|-----:|-----:|------|")
    for i, r in enumerate(runs, 1):
        text = r.text_zh[:40] + ("..." if len(r.text_zh) > 40 else "")
        out.append(
            f"| {i} | {r.source} | {r.t_start:.1f}s | {r.duration:.1f}s | "
            f"{r.stt_ms:.0f} | {r.en_first_token_ms:.0f} | {r.vi_first_token_ms:.0f} | "
            f"{r.en_total_ms:.0f} | {r.vi_total_ms:.0f} | {text} |"
        )

    out.append("")
    out.append("## 解讀\n")
    target = 2500
    e2e_p50 = max(e2e_en["p50"], e2e_vi["p50"])
    e2e_p95 = max(e2e_en["p95"], e2e_vi["p95"])
    vad_silence = 400
    perceived_p50 = e2e_p50 + vad_silence
    perceived_p95 = e2e_p95 + vad_silence
    verdict_p50 = "✅ 達標" if perceived_p50 < target else "⚠️ 超標"
    verdict_p95 = "✅ 達標" if perceived_p95 < target else "⚠️ 超標"
    out.append(f"- 端到端首 token P50 = **{e2e_p50:.0f} ms**")
    out.append(f"- 加 VAD 尾端靜音 {vad_silence}ms → 使用者感知延遲 P50 ≈ **{perceived_p50:.0f} ms** {verdict_p50}（目標 {target}ms）")
    out.append(f"- 加 VAD 尾端靜音 {vad_silence}ms → 使用者感知延遲 P95 ≈ **{perceived_p95:.0f} ms** {verdict_p95}")
    return "\n".join(out)


def main():
    load_dotenv(Path(__file__).parent / ".env")
    parser = argparse.ArgumentParser(description="Phase 1 pipeline latency benchmark")
    parser.add_argument("wavs", nargs="+", help="WAV files (16kHz mono 16-bit)")
    parser.add_argument("--output", help="write markdown report to this path")
    args = parser.parse_args()

    for p in args.wavs:
        if not Path(p).exists():
            raise SystemExit(f"not found: {p}")

    runs, total_ms = asyncio.run(bench(args.wavs))
    report = render_report(runs, total_ms)
    print("\n" + "=" * 80)
    print(report)

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(report + "\n", encoding="utf-8")
        print(f"\n報告寫入 {args.output}")


if __name__ == "__main__":
    main()
