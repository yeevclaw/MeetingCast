import argparse
import asyncio
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from audio_stream import wav_chunks
from stt import get_backend
from translator import Translator


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
    args = parser.parse_args()

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
