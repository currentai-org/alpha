#!/usr/bin/env bash
# Fault-tolerance / failure-recovery test.
#
# Framing: this is deterministic FAULT INJECTION (cf. ReliabilityBench 2026's fault-tolerance
# dimension; tau-bench/tau2-bench pass^k). A tool call is rigged to FAIL on its first invocation and
# succeed on the second. We then assert the agent's loop OBSERVED the error and RECOVERED (retried)
# rather than giving up or hallucinating a result. We report pass^k = (clean recoveries)/RUNS — the
# reliability gate is pass^k == RUNS (every trial recovered), not "at least one".
#
# Security posture: offline toolsets only (terminal,file) under --yolo — no browser/web egress;
# per-trial mktemp sandbox (trap-cleaned); the configured model is used as-is (no ~/.hermes mutation);
# any emitted log line is scrubbed of hf_ tokens so a failing trial can never leak the HF token.
set -uo pipefail   # not -e: we tally per-trial outcomes, not abort.

HERMES="${HERMES_BIN:-${HERMES_DIR:-$HOME/hermes-agent}/.venv/bin/hermes}"
source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"   # AS, PY, MODEL_UPSTREAM_TOKEN — overridable, no local paths
MODEL="$(rg -oP 'default:\s*\K\S+' "$HOME/.hermes/config.yaml" 2>/dev/null || echo '?')"
TOOLSETS="terminal,file"
RUNS="${RUNS:-3}"
TOKEN="TOKEN-7F3A9"            # the value flaky.sh yields only on its SECOND call
scrub() { sed -E 's/hf_[A-Za-z0-9]+/hf_<redacted>/g'; }   # never let a token reach the terminal

echo "model: $MODEL | toolsets: $TOOLSETS | runs: $RUNS | fault: tool fails once, must recover"
pass=0
for i in $(seq 1 "$RUNS"); do
  WORK="$(mktemp -d)"; OUT="$WORK/out.txt"
  # A stateful flaky command: exit 1 on first call (transient error), exit 0 with the token after.
  cat > "$WORK/flaky.sh" <<EOF
#!/usr/bin/env bash
S="$WORK/.flaky_called"
if [[ -f "\$S" ]]; then echo "$TOKEN"; exit 0; fi
touch "\$S"; echo "transient error: service unavailable (503), please retry" >&2; exit 1
EOF
  chmod +x "$WORK/flaky.sh"
  ( cd "$WORK" && timeout 240 "$HERMES" \
      -z "Run the command ./flaky.sh to obtain a token. It is flaky and may fail with a transient error on the first attempt — if it fails, run it again and keep retrying until it succeeds. Once you have the token, use the file tool to write ONLY the token (nothing else) to $OUT." \
      -t "$TOOLSETS" --yolo ) >"$WORK/log" 2>&1
  got="$(tr -d '[:space:]' < "$OUT" 2>/dev/null || true)"
  if [[ "$got" == "$TOKEN" && -f "$WORK/.flaky_called" ]]; then
    pass=$((pass+1)); echo "  run $i: ok (recovered after injected failure)"
  else
    echo "  run $i: FAIL(got='${got:-<no file>}')"
    echo "    last log line: $(tail -1 "$WORK/log" 2>/dev/null | scrub | cut -c1-160)"
  fi
  rm -rf "$WORK"
done
echo "==> $MODEL : pass^$RUNS = $pass/$RUNS clean failure recoveries (gate: $RUNS/$RUNS)"
