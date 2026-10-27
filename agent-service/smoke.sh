#!/usr/bin/env bash
# Reproducible smoke test for the Public AI agent service.
# Asserts: a Hermes agent completes a multi-step tool task with a REAL file side-effect
# through the dev transport (HF Inference Providers). This is the green baseline that
# proves the loop works end-to-end.
#
# Deterministic by construction: runs against a fixed 3-file fixture, asserts the agent
# writes exactly "3". (Counting a whole repo incl. .venv is not reproducible.)
#
# Usage:  ./smoke.sh        (MODEL_UPSTREAM_TOKEN from env — run via `doppler run` if not already set)
# Exit 0 = pass, non-zero = fail.
set -euo pipefail

HERMES_DIR="${HERMES_DIR:-$HOME/hermes-agent}"
PINNED_SHA="1e5ff4a5778f3a888059e1f4b8019b6490859274"   # tag v2026.6.5-390-g1e5ff4a57

# 1. Token (NEVER printed). Real env only.
[[ -n "${MODEL_UPSTREAM_TOKEN:-}" ]] || { echo "FAIL: MODEL_UPSTREAM_TOKEN not set — run via \`doppler run\` (agent-service/prd)"; exit 1; }
export MODEL_UPSTREAM_TOKEN

# 2. Hermes installed + config present.
[[ -x "$HERMES_DIR/.venv/bin/hermes" ]] || { echo "FAIL: hermes not installed at $HERMES_DIR/.venv (run: uv pip install -e .)"; exit 1; }
[[ -f "$HOME/.hermes/config.yaml" ]] || { echo "FAIL: ~/.hermes/config.yaml missing — cp config.yaml.example ~/.hermes/config.yaml"; exit 1; }

# 3. Fork SHA check (warn, don't fail — drift is a signal, not a stop).
ACTUAL_SHA="$(git -C "$HERMES_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
[[ "$ACTUAL_SHA" == "$PINNED_SHA" ]] || echo "WARN: hermes-agent at ${ACTUAL_SHA:0:12}, pinned ${PINNED_SHA:0:12} — behavior may differ."

# 4. Deterministic fixture.
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
touch "$WORK/alpha.py" "$WORK/beta.py" "$WORK/gamma.py" "$WORK/readme.txt"
RESULT="$WORK/result.txt"

# 5. Run one multi-step task: count -> write -> read-back.
echo "Running agent (up to 300s)…"
( cd "$WORK" && timeout 300 "$HERMES_DIR/.venv/bin/hermes" \
    -z "Using the terminal tool only: count how many files ending in .py exist in the current directory (non-recursive is fine), then write just that integer (nothing else) to $RESULT . Then read the file back and report its contents." \
    -t terminal --yolo ) >"$WORK/run.log" 2>&1 \
  || { echo "FAIL: hermes exited non-zero"; tail -8 "$WORK/run.log"; exit 1; }

# 6. Assert the real side-effect.
[[ -f "$RESULT" ]] || { echo "FAIL: no result file — the tool loop did not execute to completion"; tail -8 "$WORK/run.log"; exit 1; }
GOT="$(tr -d '[:space:]' < "$RESULT")"
if [[ "$GOT" == "3" ]]; then
  echo "PASS: agent counted 3 .py files and wrote them via real tool execution. Loop green."
  exit 0
else
  echo "FAIL: expected '3', got '$GOT' (loop ran but produced wrong result)"; exit 1
fi
