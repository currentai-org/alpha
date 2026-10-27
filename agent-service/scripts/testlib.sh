#!/usr/bin/env bash
# Shared bootstrap for the live integration test scripts (gateway/hardening/load/sandbox/...).
# Source it near the top of a test:  source "$(dirname "${BASH_SOURCE[0]}")/scripts/testlib.sh"
# It exports MODEL_UPSTREAM_TOKEN and sets AS (repo root), PY (python), and REAL_TOKEN. Everything is
# overridable via env so the suite runs on any checkout — no hardcoded local paths:
#   AGENT_REPO         repo root                       (default: derived from this file's location)
#   AGENT_PY           python for app/proxy             (default: $AGENT_REPO/.venv/bin/python)
#   MODEL_UPSTREAM_TOKEN  must already be in the env — run via `doppler run` (agent-service/prd)
AGENT_REPO="${AGENT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AS="$AGENT_REPO"
PY="${AGENT_PY:-$AGENT_REPO/.venv/bin/python}"

REAL_TOKEN="${MODEL_UPSTREAM_TOKEN:-}"
[[ -n "$REAL_TOKEN" ]] || {
  echo "FAIL: no MODEL_UPSTREAM_TOKEN — run via \`doppler run\` (agent-service/prd)" >&2
  exit 1
}
export MODEL_UPSTREAM_TOKEN="$REAL_TOKEN"
