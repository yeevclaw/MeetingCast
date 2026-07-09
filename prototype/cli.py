"""Phase 1 pipeline runner.

（legacy Phase 1 工具：翻譯固定 zh→en+vi，正式多語走 Tauri app / eval CLI）
"""
import argparse
import asyncio
import sys
import time
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

from audio_capture import mic_chunks
from audio_stream import wav_chunks
from stt import get_backend
from translator import Translator
from vad import VADSegmenter, load_wav_float32


COLORS = {"en": "\033[36m", "vi": "\033[35m"}
RESET = "\033[0m"
DIM = "\033[2m"
GREEN = "\033[32m"


def on_chunk(target: str, chunk: str):
    print(f"{COLORS[target]}[{target}]{RESET}{chunk}", end="", flush=True)


async def run_translate(text: str):
    translator = Translator()
    print(f"--- 並行翻譯 ---")
    results = await translator.translate_both(text, on_chunk=on_chunk)
    print("\n")
    print(f"--- 結果 ---")
    for target, m in results.items():
        print(f"[{target}] {m.text}")
        print(f"     首 token: {m.first_token_ms:.0f} ms  |  完成: {m.total_ms:.0f} ms")
    return results


async def run_vad_demo(wav_path: str, translate: bool, initial_prompt: str | None = None):
    print(f"--- VAD demo: {wav_path} ---")
    print("loading audio + silero-vad ...", flush=True)
    audio, sr = load_wav_float32(wav_path)
    total_sec = len(audio) / sr
    vad = VADSegmenter()
    t_vad = time.perf_counter()
    segments = vad.segment(audio)
    vad_ms = (time.perf_counter() - t_vad) * 1000
    print(f"audio {total_sec:.1f}s → {len(segments)} 段 (VAD 耗時 {vad_ms:.0f} ms)\n")

    stt = get_backend("local", initial_prompt=initial_prompt)
    translator = Translator() if translate else None

    # Warm up mlx-whisper once so first segment isn't skewed
    if segments:
        print("warming up mlx-whisper ...", flush=True)
        t_w = time.perf_counter()
        stt.transcribe_file(wav_path)
        print(f"warm-up: {(time.perf_counter() - t_w) * 1000:.0f} ms\n")

    import tempfile, wave

    print(f"{'seg':>3} {'start':>7} {'dur':>6} {'stt_ms':>7} {'首token':>9}  text")
    print("-" * 100)

    for i, seg in enumerate(segments):
        # Write segment to temp wav for mlx-whisper (accepts path)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp_path = tf.name
        with wave.open(tmp_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((seg.audio * 32768).astype(np.int16).tobytes())

        t0 = time.perf_counter()
        tr = stt.transcribe_file(tmp_path)
        stt_ms = (time.perf_counter() - t0) * 1000

        first_tok = ""
        if translator and tr.text:
            t1 = time.perf_counter()
            ft_ms_en = None
            async for _chunk in translator.translate_stream(tr.text, "en"):
                if ft_ms_en is None:
                    ft_ms_en = (time.perf_counter() - t1) * 1000
                    break  # only measure first token
            first_tok = f"{ft_ms_en:.0f}ms" if ft_ms_en else "n/a"

        print(
            f"{i+1:>3} {seg.t_start:>6.2f}s {seg.duration:>5.2f}s "
            f"{stt_ms:>6.0f}ms {first_tok:>8}  {tr.text}"
        )

        import os
        os.unlink(tmp_path)


async def run_streaming(chunks, backend_name: str, translate: bool, label: str, initial_prompt: str | None = None, language: str = "zh"):
    kwargs: dict = {"language": language}
    if backend_name in ("local", "openai"):
        kwargs["initial_prompt"] = initial_prompt
    stt = get_backend(backend_name, **kwargs)
    translator = Translator() if translate else None

    t0 = time.perf_counter()
    t_first_interim: float | None = None
    t_first_final: float | None = None
    translation_tasks: list[asyncio.Task] = []

    print(f"backend: {backend_name} (streaming)  |  source: {label}\n")

    try:
        async for transcript in stt.stream(chunks):
            elapsed_ms = (time.perf_counter() - t0) * 1000
            if not transcript.is_final:
                if t_first_interim is None:
                    t_first_interim = elapsed_ms
                print(
                    f"\r{DIM}[{elapsed_ms:>5.0f}ms interim]{RESET} {transcript.text}\033[K",
                    end="", flush=True,
                )
            else:
                if t_first_final is None:
                    t_first_final = elapsed_ms
                print(
                    f"\r{GREEN}[{elapsed_ms:>5.0f}ms  FINAL ]{RESET} {transcript.text}\033[K"
                )
                if translator and transcript.text:
                    task = asyncio.create_task(
                        translator.translate_both(transcript.text, on_chunk=on_chunk)
                    )
                    translation_tasks.append(task)
    finally:
        if translation_tasks:
            print("\n[ 等待最後翻譯完成... ]")
            await asyncio.gather(*translation_tasks, return_exceptions=True)
            print()

    total_ms = (time.perf_counter() - t0) * 1000
    print("\n--- 量測 ---")
    print(f"首個 interim : {t_first_interim:.0f} ms" if t_first_interim else "首個 interim : (none)")
    print(f"首個 final   : {t_first_final:.0f} ms" if t_first_final else "首個 final   : (none)")
    print(f"stream 總時長: {total_ms:.0f} ms")


def main():
    load_dotenv(Path(__file__).parent / ".env")

    parser = argparse.ArgumentParser(description="Phase 1 pipeline runner")
    parser.add_argument(
        "--backend",
        choices=["local", "cloud", "openai"],
        default="local",
        help="local = mlx-whisper; cloud = Deepgram; openai = gpt-realtime-whisper",
    )
    parser.add_argument(
        "--file",
        default=str(Path(__file__).parent / "samples" / "zh_short.wav"),
    )
    parser.add_argument("--language", default="zh")
    parser.add_argument("--warmup", action="store_true", help="local only")
    parser.add_argument(
        "--translate",
        action="store_true",
        help="translate to en + vi（legacy Phase 1 工具：翻譯固定 zh→en+vi，正式多語走 Tauri app / eval CLI）",
    )
    parser.add_argument("--text", help="skip STT, translate this text")
    parser.add_argument(
        "--mic",
        action="store_true",
        help="capture from system microphone and stream through pipeline (Ctrl+C to stop)",
    )
    parser.add_argument(
        "--mic-sim",
        metavar="WAV",
        help="stream this WAV file as if it were a live microphone (real-time pacing)",
    )
    parser.add_argument(
        "--vad-demo",
        metavar="WAV",
        help="batch-segment WAV with silero-vad, transcribe each segment via local STT, optionally translate",
    )
    parser.add_argument(
        "--prompt-terms",
        metavar="TERMS",
        help="comma-separated list of terms to bias Whisper decoder (local backend only); "
             "e.g. --prompt-terms '紫微斗數,TPI Software,MeetingCast'",
    )
    args = parser.parse_args()

    initial_prompt = None
    if args.prompt_terms:
        terms = [t.strip() for t in args.prompt_terms.split(",") if t.strip()]
        if terms:
            initial_prompt = "本段語音可能包含以下術語：" + "、".join(terms) + "。"
            print(f"[initial_prompt] {initial_prompt}", file=sys.stderr)

    if args.vad_demo:
        if not Path(args.vad_demo).exists():
            sys.exit(f"file not found: {args.vad_demo}")
        asyncio.run(run_vad_demo(args.vad_demo, args.translate, initial_prompt))
        return

    if args.mic_sim:
        if not Path(args.mic_sim).exists():
            sys.exit(f"file not found: {args.mic_sim}")
        chunks = wav_chunks(args.mic_sim, chunk_ms=100, realtime=True)
        asyncio.run(run_streaming(chunks, args.backend, args.translate, args.mic_sim, initial_prompt, language=args.language))
        return

    if args.mic:
        print("[ 麥克風錄音中，Ctrl+C 停止 ]\n")
        chunks = mic_chunks(sample_rate=16000, chunk_ms=100)
        try:
            asyncio.run(run_streaming(chunks, args.backend, args.translate, "microphone", initial_prompt, language=args.language))
        except KeyboardInterrupt:
            print("\nstopped.")
        return

    if args.text:
        print(f"--- 原文 ---\n{args.text}")
        asyncio.run(run_translate(args.text))
        return

    if not Path(args.file).exists():
        sys.exit(f"file not found: {args.file}")

    print(f"backend: {args.backend}  |  file: {args.file}")
    t_init = time.perf_counter()
    backend_kwargs: dict = {"language": args.language}
    if args.backend in ("local", "openai"):
        backend_kwargs["initial_prompt"] = initial_prompt
    stt = get_backend(args.backend, **backend_kwargs)
    print(f"init: {(time.perf_counter() - t_init) * 1000:.0f} ms")

    if args.warmup and args.backend == "local":
        print("warm-up ...", flush=True)
        t_w = time.perf_counter()
        stt.transcribe_file(args.file)
        print(f"warm-up: {(time.perf_counter() - t_w) * 1000:.0f} ms")

    print("transcribing ...", flush=True)
    t0 = time.perf_counter()
    result = stt.transcribe_file(args.file)
    stt_ms = (time.perf_counter() - t0) * 1000
    print(f"\n中文: {result.text}")
    print(f"STT 耗時: {stt_ms:.0f} ms")

    if args.translate:
        asyncio.run(run_translate(result.text))


if __name__ == "__main__":
    main()
