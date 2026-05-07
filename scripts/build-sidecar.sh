#!/usr/bin/env bash
# Bundle python-sidecar/stt_engine.py + all its runtime deps (mlx-whisper,
# silero-vad, deepgram-sdk, sounddevice, numpy, torch, etc.) into a single
# self-contained binary that Tauri can ship as externalBin alongside the
# main app, removing the dev-mode dependency on prototype/.venv at runtime.
#
# Output path matches Tauri's externalBin naming convention:
#   src-tauri/binaries/stt_engine-<target-triple>
#
# Usage: ./scripts/build-sidecar.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/prototype/.venv"
if [[ ! -x "$VENV/bin/pyinstaller" ]]; then
  echo "PyInstaller not found in $VENV. Run:" >&2
  echo "  $VENV/bin/pip install pyinstaller" >&2
  exit 1
fi

# Detect target triple in Tauri's expected format.
ARCH="$(uname -m)"        # arm64 / x86_64
case "$ARCH" in
  arm64)  RUST_ARCH="aarch64" ;;
  x86_64) RUST_ARCH="x86_64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
TARGET_TRIPLE="${RUST_ARCH}-apple-darwin"

OUT_DIR="$ROOT/src-tauri/binaries"
OUT_NAME="stt_engine-${TARGET_TRIPLE}"
mkdir -p "$OUT_DIR"

BUILD_DIR="$ROOT/python-sidecar/build"
DIST_DIR="$ROOT/python-sidecar/dist"
SPEC_DIR="$ROOT/python-sidecar/build"

echo "==> Cleaning previous build"
rm -rf "$BUILD_DIR" "$DIST_DIR"

# MLX 0.20's mlx/_os_warning.py runs at import time:
#   tuple(map(int, platform.mac_ver()[0].split(".")))
# Inside the PyInstaller-bundled binary on some Sequoia machines,
# platform.mac_ver()[0] comes back as the empty string (sw_vers
# subprocess + stdio rebinding race), and int("") raises ValueError —
# crashing the prewarm thread before anything useful can be loaded.
# Friend's M4 Sequoia 15.5 fresh install hit this; dev (Tahoe) doesn't
# because mac_ver() resolves correctly there. Replace the check with a
# no-op; minimum macOS is enforced at the bundle layer
# (tauri.conf.json::bundle.macOS.minimumSystemVersion).
echo "==> Patching mlx/_os_warning.py (defangs PyInstaller mac_ver race)"
MLX_OS_WARN="$VENV/lib/python3.13/site-packages/mlx/_os_warning.py"
if [[ -f "$MLX_OS_WARN" ]]; then
  cat > "$MLX_OS_WARN" <<'PYEOF'
# Patched by scripts/build-sidecar.sh — the original platform.mac_ver()
# parse crashes on PyInstaller bundles where mac_ver returns "". Bundle
# layer enforces minimumSystemVersion already.
PYEOF
fi

echo "==> Running PyInstaller (this can take a few minutes the first time)"
cd "$ROOT/python-sidecar"

"$VENV/bin/pyinstaller" \
  --onefile \
  --name stt_engine \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR" \
  --specpath "$SPEC_DIR" \
  --paths "$ROOT/prototype" \
  --hidden-import audio_capture \
  --hidden-import audio_stream \
  --hidden-import vad \
  --hidden-import stt \
  --hidden-import stt.local \
  --hidden-import stt.cloud \
  --hidden-import stt.base \
  --collect-all mlx_whisper \
  --collect-all mlx \
  --collect-all silero_vad \
  --collect-all sounddevice \
  --collect-all soundfile \
  --collect-all deepgram \
  --collect-all huggingface_hub \
  --collect-all torch \
  --collect-all torchaudio \
  --noconfirm \
  stt_engine.py

if [[ ! -f "$DIST_DIR/stt_engine" ]]; then
  echo "Build failed: $DIST_DIR/stt_engine missing" >&2
  exit 1
fi

mv "$DIST_DIR/stt_engine" "$OUT_DIR/$OUT_NAME"
chmod +x "$OUT_DIR/$OUT_NAME"

# Re-sign with an identifier that lives under the parent bundle ID. Without
# this PyInstaller's default ad-hoc identifier (stt_engine-<random-hex>) is
# treated by macOS TCC as a SEPARATE app, so granting microphone permission
# to MeetingCast would not propagate to the sidecar — the user would see the
# permission prompt again at first 開始錄音 click. With a sub-identifier of
# the parent bundle ID, both binaries share one mic permission grant.
codesign --force --sign - \
  --identifier com.tpisoftware.meetingcast.stt_engine \
  "$OUT_DIR/$OUT_NAME"

SIZE="$(du -h "$OUT_DIR/$OUT_NAME" | awk '{print $1}')"
echo "==> Built $OUT_DIR/$OUT_NAME ($SIZE)"
echo "==> Smoke test"
echo '{"type":"shutdown"}' | "$OUT_DIR/$OUT_NAME" || {
  echo "Smoke test failed" >&2
  exit 1
}
echo "==> OK. Now run: pnpm tauri build"
