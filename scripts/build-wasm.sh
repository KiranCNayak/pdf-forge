#!/usr/bin/env bash
# Build the Go engine to WebAssembly and stage it for the web app.
#
# Output goes to web/public/wasm/ and is gitignored — it is a build artifact.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT="$ROOT/web/public/wasm"

mkdir -p "$OUT"

echo "building engine → wasm"
cd "$ROOT/engine"
GOOS=js GOARCH=wasm go build \
  -trimpath \
  -ldflags="-s -w" \
  -o "$OUT/engine.wasm" \
  ./cmd/wasm

# wasm_exec.js moved from misc/wasm/ to lib/wasm/ in Go 1.24. Check both so this
# script keeps working across toolchain versions.
GOROOT=$(go env GOROOT)
if [ -f "$GOROOT/lib/wasm/wasm_exec.js" ]; then
  # -f because the module cache stores it read-only, so a plain cp fails on rebuild
  cp -f "$GOROOT/lib/wasm/wasm_exec.js" "$OUT/" && chmod u+w "$OUT/wasm_exec.js"
elif [ -f "$GOROOT/misc/wasm/wasm_exec.js" ]; then
  cp -f "$GOROOT/misc/wasm/wasm_exec.js" "$OUT/" && chmod u+w "$OUT/wasm_exec.js"
else
  echo "error: wasm_exec.js not found under $GOROOT" >&2
  exit 1
fi

raw=$(wc -c < "$OUT/engine.wasm" | tr -d ' ')
gz=$(gzip -9 -c "$OUT/engine.wasm" | wc -c | tr -d ' ')

printf 'engine.wasm  %6.2f MB raw  %6.2f MB gzip' \
  "$(echo "scale=4; $raw/1048576" | bc)" \
  "$(echo "scale=4; $gz/1048576" | bc)"

# Brotli is what Cloudflare Pages actually serves, so report it when available.
if command -v brotli >/dev/null 2>&1; then
  br=$(brotli -q 11 -c "$OUT/engine.wasm" | wc -c | tr -d ' ')
  printf '  %6.2f MB brotli' "$(echo "scale=4; $br/1048576" | bc)"
fi
printf '\n'
