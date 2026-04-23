import argparse
import asyncio
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from stt import get_backend
from translator import Translator


COLORS = {"en": "\033[36m", "vi": "\033[35m"}  # cyan / magenta
RESET = "\033[0m"


def on_chunk(target: str, chunk: str):
    # interleaved terminal output: prefix each chunk so you can see both streams in flight
    print(f"{COLORS[target]}[{target}]{RESET}{chunk}", end="", flush=True)


async def run_translate(text: str):
    translator = Translator()
    print()
    print(f"--- 並行翻譯 ---")
    results = await translator.translate_both(text, on_chunk=on_chunk)
    print("\n")
    print(f"--- 結果 ---")
    for target, m in results.items():
        print(f"[{target}] {m.text}")
        print(f"     首 token: {m.first_token_ms:.0f} ms  |  完成: {m.total_ms:.0f} ms")
    return results


def main():
    load_dotenv(Path(__file__).parent / ".env")

    parser = argparse.ArgumentParser(description="Phase 1 pipeline runner (STT + optional translation)")
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
    parser.add_argument("--warmup", action="store_true", help="local only; skip first inference timing")
    parser.add_argument("--translate", action="store_true", help="also translate to en + vi via Claude")
    parser.add_argument("--text", help="skip STT, translate this text directly")
    args = parser.parse_args()

    # Translate-only mode (no STT): useful for testing translator in isolation
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
