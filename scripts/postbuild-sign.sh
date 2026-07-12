#!/usr/bin/env bash
# Post-`pnpm tauri build` re-sign + repackage.
#
# WHY THIS EXISTS: `pnpm tauri build` re-signs the bundled sidecar and clobbers
# the stable identifier that build-sidecar.sh set (com.tpisoftware.meetingcast
# .stt_engine) with a per-build PyInstaller hash (stt_engine-<40hex>). macOS TCC
# keys the microphone grant by code-signing identifier and only propagates the
# parent app's grant to a helper whose identifier is a sub-identifier of the
# parent bundle ID. A hash identifier is NOT a sub-identifier → the sidecar
# never inherits the mic grant → sounddevice fails at device enumeration with
# "Error querying device -1" on a fresh Mac.
#
# This script re-signs inside-out so the sidecar carries the stable identifier
# again, re-seals the .app, then rebuilds the .dmg from the fixed bundle.
#
# Run order: version bump → build-sidecar.sh (if Python changed) → pnpm tauri
# build → THIS SCRIPT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="$ROOT/src-tauri/target/release/bundle/macos/MeetingCast.app"
ENTS="$ROOT/src-tauri/Entitlements.plist"
APP_ID="com.tpisoftware.meetingcast"
SIDECAR_ID="com.tpisoftware.meetingcast.stt_engine"

[[ -d "$APP" ]] || { echo "App bundle not found: $APP — run 'pnpm tauri build' first" >&2; exit 1; }
[[ -f "$ENTS" ]] || { echo "Entitlements not found: $ENTS" >&2; exit 1; }

VERSION="$(grep -m1 '"version"' "$ROOT/src-tauri/tauri.conf.json" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
ARCH="$(uname -m)"; case "$ARCH" in arm64) RUST_ARCH="aarch64" ;; x86_64) RUST_ARCH="x86_64" ;; *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; esac

echo "==> Re-signing sidecar with stable identifier ($SIDECAR_ID)"
# Inside-out: sidecar first. Keep --options runtime + entitlements so we only
# swap the identifier, not the hardened-runtime flags or the 5 mic/JIT keys
# that tauri build established.
codesign --force --sign - \
  --identifier "$SIDECAR_ID" \
  --options runtime \
  --entitlements "$ENTS" \
  "$APP/Contents/MacOS/stt_engine"

echo "==> Re-sealing outer app bundle ($APP_ID)"
# Signing the bundle re-hashes CodeResources over the just-re-signed sidecar;
# it does NOT re-sign the already-signed nested binary, so the identifier above
# survives. No --deep (deprecated) — inside-out is the correct idiom.
codesign --force --sign - \
  --identifier "$APP_ID" \
  --options runtime \
  --entitlements "$ENTS" \
  "$APP"

echo "==> Verifying signatures"
codesign --verify --deep --strict --verbose=2 "$APP"
got_sidecar_id="$(codesign -dvv "$APP/Contents/MacOS/stt_engine" 2>&1 | sed -nE 's/^Identifier=//p')"
[[ "$got_sidecar_id" == "$SIDECAR_ID" ]] \
  || { echo "FAIL: sidecar identifier is '$got_sidecar_id', expected '$SIDECAR_ID'" >&2; exit 1; }
# `codesign -d --entitlements -` prints the human-readable form ([Key] ...),
# not XML (<key>), so count [Key] lines. `|| true` keeps a zero match from
# tripping pipefail before the assertion below can report it cleanly.
ent_keys="$(codesign -d --entitlements - "$APP/Contents/MacOS/stt_engine" 2>&1 | grep -c '\[Key\]' || true)"
[[ "$ent_keys" -ge 5 ]] \
  || { echo "FAIL: sidecar has $ent_keys entitlement keys, expected >= 5" >&2; exit 1; }
echo "    sidecar identifier: $got_sidecar_id ($ent_keys entitlement keys) OK"

echo "==> Rebuilding .dmg from the re-signed app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
DMG_OUT="$DMG_DIR/MeetingCast_${VERSION}_${RUST_ARCH}.dmg"
STAGING="$DMG_DIR/.staging"
rm -rf "$STAGING" "$DMG_OUT"
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "MeetingCast" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG_OUT" >/dev/null
rm -rf "$STAGING"

echo "==> Done: $DMG_OUT"
du -h "$DMG_OUT" | awk '{print "    size: "$1}'
