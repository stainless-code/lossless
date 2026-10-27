#!/usr/bin/env bash
#
# Headless e2e probes for deepseek-lossless.
#
# Runs probe 1 (shipped headless profile + model overlay), probe 2 (plain
# base + headless overlay), and probe 3 (lossless bundle pong + sidecar
# list). Each dsh call is guarded with `timeout 60`. Takes no arguments,
# exits nonzero on the first failure, and prints EXIT codes plus sidecar
# paths. Probes export DSH_HOME=/tmp/e2e-dsh so sidecars land in
# /tmp/e2e-dsh/lossless.
#
# Usage: ./packages/deepseek/test/e2e/run-e2e.sh
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAYS_DIR="$E2E_DIR/overlays"
OUT_DIR="/tmp"
export DSH_HOME="/tmp/e2e-dsh"
SIDECAR_DIR="$DSH_HOME/lossless"
TASK="reply with exactly: pong"

export DSH_PERMISSION_MODE=danger-full-access

if ! command -v dsh >/dev/null 2>&1; then
  echo "FAIL: dsh not found on PATH" >&2
  exit 1
fi

mkdir -p "$SIDECAR_DIR" || exit 1
cd "$OUT_DIR" || exit 1

check_pong() {
  local label="$1"
  local file="$2"
  if grep -qF '{"type":"final","text":"pong"}' "$file" 2>/dev/null; then
    echo "$label: pong OK ($file)"
  else
    echo "$label: FAIL: no pong final event in $file" >&2
    exit 1
  fi
}

echo "--- probe 1: shipped headless profile + model overlay ---"
timeout 60 dsh --profile headless --patch "$OVERLAYS_DIR/model-overlay.yml" --json "$TASK" > "$OUT_DIR/e2e-probe1.json"
rc=$?
echo "probe1 EXIT=$rc"
[ "$rc" -eq 0 ] || { echo "probe1: FAIL: dsh exited $rc" >&2; exit 1; }
check_pong "probe1" "$OUT_DIR/e2e-probe1.json"

echo "--- probe 2: plain base + headless overlay ---"
timeout 60 dsh --profile lossless-plain --patch "$OVERLAYS_DIR/headless-overlay.yml" headless --json "$TASK" > "$OUT_DIR/e2e-probe2.json"
rc=$?
echo "probe2 EXIT=$rc"
[ "$rc" -eq 0 ] || { echo "probe2: FAIL: dsh exited $rc" >&2; exit 1; }
check_pong "probe2" "$OUT_DIR/e2e-probe2.json"

echo "--- probe 3: lossless bundle pong ---"
timeout 60 dsh --profile lossless-e2e headless --json "$TASK" > "$OUT_DIR/e2e-lossless.json"
rc=$?
echo "probe3 EXIT=$rc"
[ "$rc" -eq 0 ] || { echo "probe3: FAIL: dsh exited $rc" >&2; exit 1; }
check_pong "probe3" "$OUT_DIR/e2e-lossless.json"

echo "--- sidecars in $SIDECAR_DIR ---"
shopt -s nullglob
sidecars=("$SIDECAR_DIR"/*.sqlite)
shopt -u nullglob
if [ "${#sidecars[@]}" -eq 0 ]; then
  echo "probe3: FAIL: no sidecar sqlite files in $SIDECAR_DIR" >&2
  exit 1
fi
printf '%s\n' "${sidecars[@]}"

echo "ALL PROBES PASSED"
