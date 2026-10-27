#!/usr/bin/env bash
# Cheaper-model tool-call adherence test (feeds the cost comparison).
# Runs the REAL Hermes loop (not a raw-API curl) for each model, N times, on the deterministic
# 3-file fixture. A "clean completion" = the agent executed the tool loop and wrote exactly "3".
# A model can pass a raw tool call and still emit textual tool calls under Hermes' prompt, so the
# loop — not the raw API — is the right test. Goal: find the cheapest model that reliably drives it.
# Backs up and restores ~/.hermes/config.yaml.
set -uo pipefail   # not -e: we want to tally per-run failures, not abort.

HERMES="${HERMES_BIN:-${HERMES_DIR:-$HOME/hermes-agent}/.venv/bin/hermes}"
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
CFG="$HOME/.hermes/config.yaml"; BAK="$(mktemp)"; cp "$CFG" "$BAK"
trap 'cp "$BAK" "$CFG"; rm -f "$BAK"' EXIT

MODELS=("Qwen/Qwen3-235B-A22B-Instruct-2507" "Qwen/Qwen3-Next-80B-A3B-Instruct" "Qwen/Qwen3-32B")
RUNS="${RUNS:-3}"

for M in "${MODELS[@]}"; do
  printf 'model:\n  provider: huggingface\n  default: %s\n  context_length: 131072\n  max_tokens: 8192\n' "$M" > "$CFG"
  pass=0
  for i in $(seq 1 "$RUNS"); do
    WORK="$(mktemp -d)"; touch "$WORK/a.py" "$WORK/b.py" "$WORK/c.py" "$WORK/x.txt"; R="$WORK/r.txt"
    ( cd "$WORK" && timeout 240 "$HERMES" \
        -z "Using the terminal tool only: count the .py files in the current directory and write just that integer to $R, then read it back." \
        -t terminal --yolo ) >"$WORK/log" 2>&1
    got="$(tr -d '[:space:]' < "$R" 2>/dev/null || true)"
    if [[ "$got" == "3" ]]; then pass=$((pass+1)); echo "  $M run $i: ok"; else echo "  $M run $i: FAIL(got='${got:-<no file>}')"; fi
    rm -rf "$WORK"
  done
  echo "==> $M : $pass/$RUNS clean loop completions"
  echo
done
