import argparse
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from stt import get_backend


def main():
    load_dotenv(Path(__file__).parent / ".env")

    parser = argparse.ArgumentParser(description="Phase 1 STT backend runner")
    parser.add_argument(
        "--backend",
        choices=["local", "cloud"],
        default="local",
        help="local = mlx-whisper; cloud = Deepgram",
    )
    parser.add_argument(
        "--file",
        default=str(Path(__file__).parent / "samples" / "zh_short.wav"),
        help="audio file to transcribe",
    )
    parser.add_argument("--language", default="zh")
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="run once before measurement (local only; cloud has no warm-up)",
    )
    args = parser.parse_args()

    if not Path(args.file).exists():
        sys.exit(f"file not found: {args.file}")

    print(f"backend: {args.backend}  |  file: {args.file}")

    t_init = time.perf_counter()
    stt = get_backend(args.backend, language=args.language)
    print(f"init: {(time.perf_counter() - t_init) * 1000:.0f} ms")

    if args.warmup and args.backend == "local":
        print("warm-up pass ...", flush=True)
        t_w = time.perf_counter()
        stt.transcribe_file(args.file)
        print(f"warm-up: {(time.perf_counter() - t_w) * 1000:.0f} ms")

    print("transcribing (measured) ...", flush=True)
    t0 = time.perf_counter()
    result = stt.transcribe_file(args.file)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    print()
    print(f"結果: {result.text}")
    print(f"推論耗時: {elapsed_ms:.0f} ms")


if __name__ == "__main__":
    main()
