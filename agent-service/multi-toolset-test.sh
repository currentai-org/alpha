#!/usr/bin/env bash
# Multi-toolset reliability test (a launch-gate check for a cheaper mixture-of-experts model).
# The worry: a LARGER tool schema (more toolsets = bigger system prompt) is exactly what made
# Llama-3.3-70B hallucinate tool-calls. This loads 6 toolsets and gives a task that forces 4
# DISTINCT tools (todo -> code_execution -> file -> terminal), then asserts the real result.
# Offline only (no web/browser) — stresses schema size without live-egress risk.
# Uses whatever model ~/.hermes/config.yaml points at. RUNS=N (default 3).
set -uo pipefail

HERMES="${HERMES_BIN:-${HERMES_DIR:-$HOME/hermes-agent}/.venv/bin/hermes}"
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
MODEL="$(rg -o 'default:\s*\K\S+' "$HOME/.hermes/config.yaml" 2>/dev/null || echo '?')"
TOOLSETS="terminal,file,code_execution,todo,memory,skills"
RUNS="${RUNS:-3}"
EXPECT="56088"   # 123 * 456

echo "model: $MODEL | toolsets: $TOOLSETS | runs: $RUNS"
pass=0
for i in $(seq 1 "$RUNS"); do
  WORK="$(mktemp -d)"; OUT="$WORK/out.txt"
  ( cd "$WORK" && timeout 300 "$HERMES" \
      -z "Do these steps in order: (1) use the todo tool to record a 2-item plan; (2) use the code_execution tool to compute 123 * 456; (3) use the file tool to write ONLY that number (nothing else) to $OUT ; (4) use the terminal tool to read $OUT back and report it." \
      -t "$TOOLSETS" --yolo ) >"$WORK/log" 2>&1
  got="$(tr -d '[:space:]' < "$OUT" 2>/dev/null || true)"
  if [[ "$got" == "$EXPECT" ]]; then
    pass=$((pass+1)); echo "  run $i: ok"
  else
    echo "  run $i: FAIL(got='${got:-<no file>}')"; echo "    last log line: $(tail -1 "$WORK/log" 2>/dev/null | cut -c1-160)"
  fi
  rm -rf "$WORK"
done
echo "==> $MODEL : $pass/$RUNS clean multi-toolset completions"
