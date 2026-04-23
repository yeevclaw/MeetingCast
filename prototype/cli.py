import argparse
import asyncio
import sys
import time
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

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


async def run_vad_demo(wav_path: str, translate: bool):
    print(f"--- VAD demo: {wav_path} ---")
    print("loading audio + silero-vad ...", flush=True)
    audio, sr = load_wav_float32(wav_path)
    total_sec = len(audio) / sr
    vad = VADSegmenter()
    t_vad = time.perf_counter()
    segments = vad.segment(audio)
    vad_ms = (time.perf_counter() - t_vad) * 1000
    print(f"audio {total_sec:.1f}s → {len(segments)} 段 (VAD 耗時 {vad_ms:.0f} ms)\n")

    stt = get_backend("local")
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


async def run_mic_sim(backend_name: str, wav_path: str, translate: bool):
    stt = get_backend(backend_name)

    t_stream_start = time.perf_counter()
    t_first_interim: float | None = None
    t_first_final: float | None = None
    final_texts: list[str] = []

    chunks = wav_chunks(wav_path, chunk_ms=100, realtime=True)

    print(f"backend: {backend_name} (streaming)  |  file: {wav_path}")
    print("--- 即時辨識（WAV 以 100ms chunk 實時餵入，模擬麥克風）---\n")

    async for transcript in stt.stream(chunks):
        elapsed_ms = (time.perf_counter() - t_stream_start) * 1000
        if not transcript.is_final:
            if t_first_interim is None:
                t_first_interim = elapsed_ms
            # overwrite the current line with interim
            print(f"\r{DIM}[{elapsed_ms:>5.0f}ms interim]{RESET} {transcript.text}\033[K", end="", flush=True)
        else:
            if t_first_final is None:
                t_first_final = elapsed_ms
            print(f"\r{GREEN}[{elapsed_ms:>5.0f}ms  FINAL ]{RESET} {transcript.text}\033[K")
            final_texts.append(transcript.text)

    total_ms = (time.perf_counter() - t_stream_start) * 1000
    print()
    print("--- 量測 ---")
    print(f"首個 interim : {t_first_interim:.0f} ms" if t_first_interim else "首個 interim : (none)")
    print(f"首個 final   : {t_first_final:.0f} ms" if t_first_final else "首個 final   : (none)")
    print(f"stream 總時長: {total_ms:.0f} ms")

    full_text = "".join(final_texts)
    if translate and full_text:
        print()
        await run_translate(full_text)


def main():
    load_dotenv(Path(__file__).parent / ".env")

    parser = argparse.ArgumentParser(description="Phase 1 pipeline runner")
    parser.add_argument(
        "--backend",
        choices=["local", "cloud"],
        default="local",
        help="local = mlx-whisper; cloud = Deepgram",
    )
    parser.add_argument(
        "--file",
        default=str(Path(__file__).parent / "samples" / "zh_short.wav"),
    )
    parser.add_argument("--language", default="zh")
    parser.add_argument("--warmup", action="store_true", help="local only")
    parser.add_argument("--translate", action="store_true", help="translate to en + vi")
    parser.add_argument("--text", help="skip STT, translate this text")
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
    args = parser.parse_args()

    if args.vad_demo:
        if not Path(args.vad_demo).exists():
            sys.exit(f"file not found: {args.vad_demo}")
        asyncio.run(run_vad_demo(args.vad_demo, args.translate))
        return

    if args.mic_sim:
        if not Path(args.mic_sim).exists():
            sys.exit(f"file not found: {args.mic_sim}")
        asyncio.run(run_mic_sim(args.backend, args.mic_sim, args.translate))
        return

    if args.text:
        print(f"--- 原文 ---\n{args.text}")
        asyncio.run(run_translate(args.text))
        return

    if not Path(args.file).exists():
        sys.exit(f"file not found: {args.file}")

    print(f"backend: {args.backend}  |  file: {args.file}")
    t_init = time.perf_counter()
    stt = get_backend(args.backend, language=args.language)
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
