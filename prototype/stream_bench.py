#!/usr/bin/env python3
"""Streaming-pipeline bench: real-time WAV → gpt-live-transcribe → segments → Haiku.

Measures what the sentence-level `latency_bench.py` cannot: the live path.
  (a) segment length / boundary distribution coming out of the splitter
  (b) STT delta lag: when a source char appears on screen vs. when it was
      spoken (reference word timings from local mlx-whisper, aligned by
      difflib — a few hundred ms of alignment noise is expected)
  (c) per-segment translation first-token latency (TTFT) and total
  (d) end-to-end "speaker finished the segment → first target token" and
      "speaker started the segment → first target token"

COST SAFETY. Billable: OpenAI live transcription for the WAV's duration plus
one Haiku streaming call per final segment. The estimate is printed first and
nothing is sent without --yes (or an interactive 'y').

API keys: env ANTHROPIC_API_KEY / OPENAI_API_KEY, falling back to the app's
config.toml (the prototype/.env keys may be stale).

Run (cwd = prototype/):
  .venv/bin/python stream_bench.py samples/weather_90s.wav --yes
  .venv/bin/python stream_bench.py samples/weather_90s.wav --no-translate --yes
"""
from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from audio_stream import wav_chunks  # noqa: E402

PUNCT_RE = re.compile(r"[\s。，、；：？！,.;:?!\"'“”‘’()（）\[\]【】…—\-]+")
CONFIG_TOML = Path.home() / "Library/Application Support/MeetingCast/config.toml"
PROMPT_FILE = HERE.parent / "src-tauri" / "prompts" / "translate_system.txt"
REGISTRY = HERE.parent / "shared" / "languages.json"
CACHE_DIR = HERE / ".bench_cache"

# USD per 1M tokens (input, output) — same as eval/run_eval.py
HAIKU_PRICE = (1.0, 5.0)
EST_IN_TOKENS, EST_OUT_TOKENS = 600, 60
# OpenAI live transcription is billed per audio minute; the exact rate isn't
# pinned here — this is a generous placeholder for the estimate line only.
EST_TRANSCRIBE_USD_PER_MIN = 0.01


def load_keys() -> None:
    load_dotenv(HERE / ".env")
    if CONFIG_TOML.exists():
        for line in CONFIG_TOML.read_text(encoding="utf-8").splitlines():
            m = re.match(r'^(anthropic_api_key|openai_api_key)\s*=\s*"([^"]*)"', line)
            if m and m.group(2):
                env = m.group(1).upper()
                # config.toml wins when the env key is empty OR when both exist
                # and the env one is known-stale — simplest rule: prefer config.
                os.environ[env] = m.group(2)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    vs = sorted(values)
    k = (len(vs) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(vs) - 1)
    return vs[f] + (vs[c] - vs[f]) * (k - f)


def stats(values: list[float]) -> dict:
    values = [v for v in values if v == v]  # drop NaN
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": max(values),
        "mean": statistics.mean(values),
    }


def fmt(s: dict, unit: str = "ms") -> str:
    if s.get("n", 0) == 0:
        return "n/a"
    return f"P50 {s['p50']:.0f} / P95 {s['p95']:.0f} / max {s['max']:.0f} {unit} (n={s['n']})"


# ---------------------------------------------------------------- reference
def reference_chars(wav: Path, language: str) -> list[tuple[str, float]]:
    """(char, spoken_at_sec) for every non-punctuation char in the WAV, from
    mlx-whisper word timestamps. Cached per file (local, free, ~10s cold)."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache = CACHE_DIR / f"{wav.stem}.{language}.ref.json"
    if cache.exists():
        return [tuple(x) for x in json.loads(cache.read_text())]
    import mlx_whisper  # heavy import — only when needed
    from stt.local import MLXWhisperSTT

    print("[ref] transcribing with mlx-whisper word_timestamps=True ...", flush=True)
    result = mlx_whisper.transcribe(
        str(wav),
        path_or_hf_repo=MLXWhisperSTT.MODEL_REPO,
        language=language,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    chars: list[tuple[str, float]] = []
    for seg in result["segments"]:
        for w in seg.get("words", []):
            clean = PUNCT_RE.sub("", w["word"])
            if not clean:
                continue
            start, end = float(w["start"]), float(w["end"])
            n = len(clean)
            for i, ch in enumerate(clean):
                # a char is "spoken" when its share of the word ends
                chars.append((ch, start + (end - start) * (i + 1) / n))
    cache.write_text(json.dumps(chars, ensure_ascii=False))
    print(f"[ref] {len(chars)} chars, audio ends ~{chars[-1][1]:.1f}s", flush=True)
    return chars


def strip_with_map(text: str) -> tuple[str, list[int]]:
    """Remove punctuation/whitespace; return (clean, clean_idx -> orig_idx)."""
    clean, idx = [], []
    for i, ch in enumerate(text):
        if PUNCT_RE.match(ch):
            continue
        clean.append(ch)
        idx.append(i)
    return "".join(clean), idx


def align(hyp_clean: str, ref_clean: str) -> dict[int, int]:
    """hyp_clean idx -> ref_clean idx for chars in matching blocks."""
    sm = difflib.SequenceMatcher(None, hyp_clean, ref_clean, autojunk=False)
    out: dict[int, int] = {}
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            out[a + k] = b + k
    return out


# --------------------------------------------------------------- translation
def render_system(source: str, target: str) -> str:
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    by = {e["code"]: e for e in reg}
    tpl = PROMPT_FILE.read_text(encoding="utf-8")
    return (
        tpl.replace("{source_lang}", by[source]["zh_ui_name"])
        .replace("{lang}", by[target]["prompt_name"])
        .replace("{glossary_section}", "")
    )


async def translate_ttft(client, system: str, text: str, model: str) -> dict:
    t0 = time.perf_counter()
    ttft = None
    out = []
    async with client.messages.stream(
        model=model,
        max_tokens=256,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": text}],
    ) as stream:
        async for delta in stream.text_stream:
            if ttft is None and delta.strip():
                ttft = (time.perf_counter() - t0) * 1000
            out.append(delta)
    return {
        "ttft_ms": ttft if ttft is not None else float("nan"),
        "total_ms": (time.perf_counter() - t0) * 1000,
        "text": "".join(out).strip(),
    }


# ---------------------------------------------------------------------- main
async def run(args) -> dict:
    wav = Path(args.wav)
    ref = reference_chars(wav, args.language)
    ref_clean = "".join(c for c, _ in ref)
    ref_t = [t for _, t in ref]

    from stt.openai_realtime import OpenAILiveTranscribeSTT

    stt = OpenAILiveTranscribeSTT(
        language=args.language,
        delay=args.delay,
        initial_prompt=args.prompt or None,
        segmentation=args.segmentation,
    )
    client = None
    system = None
    if not args.no_translate:
        import anthropic

        client = anthropic.AsyncAnthropic()
        system = render_system(args.language, args.target)

    finals: list[dict] = []          # one per final segment
    char_arrival: dict[int, float] = {}  # idx in concatenated hyp (raw) -> arrival s
    hyp_raw = ""                     # finals concatenated (raw)
    prev_view = ""                   # finals + current interim, last seen
    tasks: list[asyncio.Task] = []

    print(f"[stream] {wav.name} real-time → {stt.model} (lang={args.language}, delay={args.delay}) ...", flush=True)
    t0 = time.perf_counter()
    async for tr in stt.stream(wav_chunks(str(wav), chunk_ms=100, realtime=True)):
        arrival = time.perf_counter() - t0
        view = hyp_raw + (tr.text if tr.is_final else tr.text)
        if tr.is_final:
            view = hyp_raw + tr.text
        # record first-appearance time for chars new in this view
        if view.startswith(prev_view):
            for i in range(len(prev_view), len(view)):
                char_arrival.setdefault(i, arrival)
        else:
            # interim drifted; rewind to the common prefix
            common = 0
            for a, b in zip(prev_view, view):
                if a != b:
                    break
                common += 1
            for i in list(char_arrival):
                if i >= common:
                    del char_arrival[i]
            for i in range(common, len(view)):
                char_arrival[i] = arrival
        prev_view = view

        if tr.is_final:
            seg = {
                "i": len(finals),
                "arrival_s": arrival,
                "boundary": tr.boundary or "sentence",
                "text": tr.text,
                "chars": len(PUNCT_RE.sub("", tr.text)),
                "raw_start": len(hyp_raw),
                "raw_end": len(hyp_raw) + len(tr.text),
            }
            hyp_raw += tr.text
            finals.append(seg)
            print(f"  [{arrival:6.2f}s] {seg['boundary']:8s} {seg['chars']:2d}字  {tr.text}", flush=True)
            if client is not None and seg["chars"] >= 2:
                tasks.append(asyncio.create_task(translate_ttft(client, system, tr.text, args.model)))
                seg["task_idx"] = len(tasks) - 1
    stream_total = time.perf_counter() - t0
    if tasks:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for seg in finals:
            k = seg.get("task_idx")
            if k is None:
                continue
            r = results[k]
            if isinstance(r, Exception):
                seg["translate_error"] = str(r)[:200]
            else:
                seg.update({"ttft_ms": r["ttft_ms"], "total_ms": r["total_ms"], "translation": r["text"]})

    # ---- alignment: hyp (finals only) vs reference
    hyp_clean, hyp_map = strip_with_map(hyp_raw)
    a2r = align(hyp_clean, ref_clean)
    matched = len(a2r) / max(1, len(hyp_clean))
    raw2clean = {orig: ci for ci, orig in enumerate(hyp_map)}

    delta_lags = []
    for ci, ri in a2r.items():
        arr = char_arrival.get(hyp_map[ci])
        if arr is not None:
            delta_lags.append((arr - ref_t[ri]) * 1000)

    for seg in finals:
        # last / first matched char inside this segment
        cis = [raw2clean[o] for o in range(seg["raw_start"], seg["raw_end"]) if o in raw2clean]
        last = next((a2r[c] for c in reversed(cis) if c in a2r), None)
        first = next((a2r[c] for c in cis if c in a2r), None)
        seg["spoken_end_s"] = ref_t[last] if last is not None else None
        seg["spoken_start_s"] = ref_t[first] if first is not None else None
        seg["final_lag_ms"] = (seg["arrival_s"] - ref_t[last]) * 1000 if last is not None else float("nan")
        if "ttft_ms" in seg and last is not None:
            seg["e2e_end_ms"] = seg["final_lag_ms"] + seg["ttft_ms"]
            seg["e2e_start_ms"] = (seg["arrival_s"] - ref_t[first]) * 1000 + seg["ttft_ms"]

    lens = [s["chars"] for s in finals]
    summary = {
        "wav": wav.name,
        "delay": args.delay,
        "prompt": args.prompt,
        "audio_s": ref_t[-1] if ref_t else None,
        "stream_total_s": stream_total,
        "segments": len(finals),
        "alignment_coverage": matched,
        "len": stats([float(x) for x in lens]),
        "len_in_5_15": sum(1 for x in lens if 5 <= x <= 15) / max(1, len(lens)),
        "len_lt_5": sum(1 for x in lens if x < 5) / max(1, len(lens)),
        "len_gt_15": sum(1 for x in lens if x > 15) / max(1, len(lens)),
        "boundaries": {b: sum(1 for s in finals if s["boundary"] == b) for b in ("clause", "forced", "sentence", "pause")},
        "delta_lag_ms": stats(delta_lags),
        "final_lag_ms": stats([s["final_lag_ms"] for s in finals]),
        "ttft_ms": stats([s["ttft_ms"] for s in finals if "ttft_ms" in s]),
        "total_ms": stats([s["total_ms"] for s in finals if "total_ms" in s]),
        "e2e_end_ms": stats([s["e2e_end_ms"] for s in finals if "e2e_end_ms" in s]),
        "e2e_start_ms": stats([s["e2e_start_ms"] for s in finals if "e2e_start_ms" in s]),
        "translate_errors": sum(1 for s in finals if "translate_error" in s),
    }
    return {"summary": summary, "segments": finals}


def report(res: dict) -> str:
    s = res["summary"]
    lines = [
        f"## Streaming bench — {s['wav']} ({s['audio_s']:.0f}s audio, {s['segments']} segments, alignment coverage {s['alignment_coverage']:.0%}, delay={s['delay']})",
        "",
        "| 指標 | 值 |",
        "|---|---|",
        f"| 片段長度（字） | {fmt(s['len'], '字')} |",
        f"| 片段落在 5–15 字 | {s['len_in_5_15']:.0%}（<5: {s['len_lt_5']:.0%}, >15: {s['len_gt_15']:.0%}） |",
        f"| boundary 分佈 | {s['boundaries']} |",
        f"| STT delta 落後（字說出 → 字上螢幕） | {fmt(s['delta_lag_ms'])} |",
        f"| 片段 final 落後（最後一字說出 → final 到達） | {fmt(s['final_lag_ms'])} |",
        f"| 翻譯首 token TTFT | {fmt(s['ttft_ms'])} |",
        f"| 翻譯完成 | {fmt(s['total_ms'])} |",
        f"| **端到端：片段最後一字說出 → 譯文首字** | **{fmt(s['e2e_end_ms'])}** |",
        f"| **端到端：片段第一字說出 → 譯文首字** | **{fmt(s['e2e_start_ms'])}** |",
        "",
        "| # | 到達 s | boundary | 字 | 說出區間 s | final 落後 ms | TTFT ms | 源文 | 譯文 |",
        "|--:|--:|---|--:|---|--:|--:|---|---|",
    ]
    for g in res["segments"]:
        span = (
            f"{g['spoken_start_s']:.1f}–{g['spoken_end_s']:.1f}"
            if g.get("spoken_end_s") is not None and g.get("spoken_start_s") is not None
            else "?"
        )
        lag = f"{g['final_lag_ms']:.0f}" if g.get("final_lag_ms") == g.get("final_lag_ms") else "?"
        ttft = f"{g['ttft_ms']:.0f}" if g.get("ttft_ms") is not None and g.get("ttft_ms") == g.get("ttft_ms") else ""
        lines.append(
            f"| {g['i']} | {g['arrival_s']:.2f} | {g['boundary']} | {g['chars']} | {span} | {lag} | {ttft} | {g['text']} | {g.get('translation', g.get('translate_error', ''))} |"
        )
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wav")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--target", default="en")
    ap.add_argument("--model", default="claude-haiku-4-5")
    ap.add_argument("--no-translate", action="store_true")
    ap.add_argument("--delay", default="minimal", help="gpt-live-transcribe delay level (minimal / low / medium / high / xhigh)")
    ap.add_argument("--segmentation", default="fine", choices=["fine", "sentence"], help="early-final splitter mode")
    ap.add_argument("--prompt", default="", help="gpt-live-transcribe context prompt (e.g. a Traditional-Chinese sentence to steer script)")
    ap.add_argument("--out", help="write JSON + markdown next to this path stem")
    ap.add_argument("--yes", action="store_true", help="skip the spend confirmation")
    args = ap.parse_args()

    load_keys()
    import wave

    with wave.open(args.wav, "rb") as w:
        dur_min = w.getnframes() / w.getframerate() / 60
    est_segments = int(dur_min * 60 / 3)  # ~one segment per 3s of speech
    haiku_usd = 0 if args.no_translate else est_segments * (
        EST_IN_TOKENS * HAIKU_PRICE[0] + EST_OUT_TOKENS * HAIKU_PRICE[1]
    ) / 1e6
    print(
        f"[cost] audio {dur_min:.1f} min transcription (~${dur_min * EST_TRANSCRIBE_USD_PER_MIN:.3f}) "
        f"+ ~{0 if args.no_translate else est_segments} Haiku calls (~${haiku_usd:.3f})"
    )
    if not args.yes and input("proceed? [y/N] ").strip().lower() != "y":
        sys.exit("aborted")

    res = asyncio.run(run(args))
    md = report(res)
    print("\n" + md)
    if args.out:
        out = Path(args.out)
        out.with_suffix(".json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
        out.with_suffix(".md").write_text(md)
        print(f"\n[saved] {out.with_suffix('.json')} / {out.with_suffix('.md')}")


if __name__ == "__main__":
    main()
