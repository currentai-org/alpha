#!/usr/bin/env bash
# Long-horizon / context-growth reliability test (a launch-gate check).
#
# 2026 SOTA framing: long-horizon agent reliability (cf. "Beyond pass@1: A Reliability Science Framework
# for Long-Horizon LLM Agents", 2026; tau-bench pass^k). A sequential accumulator forces >=12 dependent
# tool turns whose growing tool output pushes the transcript PAST 32k tokens — directly probing the
# Hermes >=64k context floor (served-context <64k is blocker #4). Each step depends on the
# prior running total, so the model cannot shortcut; it must carry state across a long, growing context.
# We report pass^k = (correct totals)/RUNS; the gate is pass^k == RUNS.
#
# Security posture: offline toolsets only (terminal,file) under --yolo — no egress; per-trial mktemp
# sandbox (trap-cleaned); configured model used as-is (no ~/.hermes mutation); logs scrubbed of hf_ tokens.
#
# Cost note: the agentic loop re-sends the growing transcript each turn, so billed tokens scale super-
# linearly with turns. RUNS defaults to 2 (a meaningful pass^2 without a large bill); set RUNS=8 for a
# tau-bench-style pass^8 when you want a stronger reliability signal and accept the cost.
set -uo pipefail

HERMES="${HERMES_BIN:-${HERMES_DIR:-$HOME/hermes-agent}/.venv/bin/hermes}"
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
MODEL="$(rg -oP 'default:\s*\K\S+' "$HOME/.hermes/config.yaml" 2>/dev/null || echo '?')"
TOOLSETS="terminal,file"
RUNS="${RUNS:-2}"
NFILES=12
PAD_LINES=120                 # ~120 lines/file * ~20 words ≈ 2.4k words ≈ 3.2k tokens; *12 ≈ 38k cumulative
EXPECT=546                    # sum_{n=1..12} (n*7) = 7*78 = 546
scrub() { sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }

echo "model: $MODEL | toolsets: $TOOLSETS | runs: $RUNS | $NFILES sequential steps, transcript grows past 32k"
pass=0
for i in $(seq 1 "$RUNS"); do
  WORK="$(mktemp -d)"; OUT="$WORK/total.txt"
  for n in $(seq 1 "$NFILES"); do
    f="$(printf '%s/step%02d.txt' "$WORK" "$n")"
    { for j in $(seq 1 "$PAD_LINES"); do
        echo "Line $j of context padding for step $n: the quick brown fox jumps over the lazy dog repeatedly to grow the running transcript and probe the model's effective context window floor under load."
      done
      echo "VALUE=$(( n * 7 ))"
    } > "$f"
  done
  ( cd "$WORK" && timeout 480 "$HERMES" \
      -z "Files step01.txt through step$(printf '%02d' "$NFILES").txt each contain exactly one line of the form 'VALUE=<integer>' among padding lines. Process the files strictly in order from 01 to $(printf '%02d' "$NFILES"): for each file, read it, extract its VALUE integer, add it to a running total, and append a line 'after step NN: total=<running total>' to progress.log. Do them one at a time — do not skip ahead. After all $NFILES files are processed, use the file tool to write ONLY the final total integer (nothing else) to $OUT." \
      -t "$TOOLSETS" --yolo ) >"$WORK/log" 2>&1
  got="$(tr -d '[:space:]' < "$OUT" 2>/dev/null || true)"
  steps="$(wc -l < "$WORK/progress.log" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "$got" == "$EXPECT" ]]; then
    pass=$((pass+1)); echo "  run $i: ok (total=$got, $steps step-lines logged)"
  else
    echo "  run $i: FAIL(got='${got:-<no file>}', expected=$EXPECT, $steps step-lines logged)"
    echo "    last log line: $(tail -1 "$WORK/log" 2>/dev/null | scrub | cut -c1-160)"
  fi
  rm -rf "$WORK"
done
echo "==> $MODEL : pass^$RUNS = $pass/$RUNS clean long-horizon completions (gate: $RUNS/$RUNS)"
