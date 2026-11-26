#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT_DIR/native/virtual-display-helper.m"
OUT_DIR="$ROOT_DIR/bin"
OUT="$OUT_DIR/virtual-display-helper"

mkdir -p "$OUT_DIR"

COMMON_FLAGS=(
  -O2
  -fobjc-arc
  -Wall
  -Wextra
  -framework Foundation
  -framework CoreGraphics
  -framework AppKit
)

# Build universal binary (arm64 + x86_64) when supported; fall back to native arch.
if clang "${COMMON_FLAGS[@]}" -arch arm64 -arch x86_64 "$SRC" -o "$OUT" 2>/dev/null; then
  echo "Built universal (arm64 + x86_64): $OUT"
else
  clang "${COMMON_FLAGS[@]}" "$SRC" -o "$OUT"
  echo "Built native ($(uname -m)): $OUT"
fi

chmod 755 "$OUT"
codesign --force --sign - "$OUT" 2>/dev/null || true
file "$OUT"
