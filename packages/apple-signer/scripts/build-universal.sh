#!/usr/bin/env bash
# Build a universal (arm64 + x86_64) Swift helper and place the signed binary
# at bin/apple-signer. Runs on macOS only.
#
# Why universal: the binary is ~180 KB per arch, so ~360 KB universal. That's
# cheap enough to ship one file instead of orchestrating per-arch optional-dep
# packages. The lipo step fuses two arch-specific builds into one Mach-O.
#
# Signing: ad-hoc (`codesign -s -`) by default. When a Developer ID cert is
# provisioned, set APPLE_SIGNER_IDENTITY to the identity string and this script
# will sign with it instead.
set -euo pipefail

cd "$(dirname "$0")/.."

NATIVE_DIR="native"
BIN_OUT="bin/apple-signer"
ENTITLEMENTS="$NATIVE_DIR/apple-signer.entitlements"
IDENTITY="${APPLE_SIGNER_IDENTITY:--}"

mkdir -p bin

pushd "$NATIVE_DIR" >/dev/null

echo "→ swift build arm64"
swift build --configuration release --arch arm64 >/dev/null
ARM64_BIN="$(swift build --configuration release --arch arm64 --show-bin-path)/apple-signer"

echo "→ swift build x86_64"
swift build --configuration release --arch x86_64 >/dev/null
X64_BIN="$(swift build --configuration release --arch x86_64 --show-bin-path)/apple-signer"

popd >/dev/null

echo "→ lipo -create → $BIN_OUT"
lipo -create "$ARM64_BIN" "$X64_BIN" -output "$BIN_OUT"

echo "→ codesign (identity: $IDENTITY)"
codesign --force --sign "$IDENTITY" --entitlements "$ENTITLEMENTS" "$BIN_OUT"

echo "✓ built universal binary at $BIN_OUT"
file "$BIN_OUT"
