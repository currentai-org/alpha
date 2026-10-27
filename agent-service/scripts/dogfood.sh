#!/usr/bin/env bash
# Local dogfood entrypoint — drive the real agent service end-to-end against a real upstream.
# Thin wrapper over scripts/dogfood.py.
#
#   scripts/dogfood.sh apertus15               # the shipped default (Apertus-1.5-70B on CSCS, best-of-3)
#   scripts/dogfood.sh mistral                 # Mistral-Small-4-119B, the prior default — comparison baseline
#   scripts/dogfood.sh qwen                    # Qwen3.5-122B (open-weight fallback comparison)
#   scripts/dogfood.sh apertus15 "<your task>" --expect-file r.txt --expect-contains 3
#
# apertus15 needs PROVIDER_CSCS_BASE + PROVIDER_CSCS_TOKEN in the environment. The Infomaniak token the
# other two modes use is read by dogfood.py from IK_TOKEN or the gitignored token file — never printed.
# The interactive Qwen TUI is separate (needs a TTY + its own config):
#   ~/.hermes/config.yaml pointed at Infomaniak Qwen, then:  hermes --tui
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYBIN:-$HOME/hermes-agent/.venv/bin/python}"
[[ -x "$PY" ]] || { echo "FAIL: python not found at $PY (set PYBIN)"; exit 1; }
exec "$PY" "$HERE/dogfood.py" "$@"
