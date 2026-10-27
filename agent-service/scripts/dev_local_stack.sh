#!/usr/bin/env bash
# Long-running local agent-service stack, for testing the aipotluck.org chat frontend against a
# REAL agent without touching prod. `make run`/`make proxy` are one-shot-per-terminal; this backgrounds
# both under one Ctrl-C-to-stop, mirroring dogfood.py's env but never tearing down after one task.
#
# Prod is untouched by construction: prod's AGENT_SERVICE_URL is a Vercel env var pointing at the
# deployed Fly instance; this stack is two local processes on local ports that nothing prod-side reads.
#
# Usage:
#   doppler run --project agent-service --config prd -- scripts/dev_local_stack.sh
#   PROVIDER_CSCS_TOKEN=... AGENT_ACP=1 scripts/dev_local_stack.sh   # also exercise ACP (see api/app.py _use_acp)
#
# Then in aipotluck.org/web/.env.local:
#   AGENT_SERVICE_URL=http://127.0.0.1:8731
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${PROVIDER_CSCS_TOKEN:?set PROVIDER_CSCS_TOKEN — run via \`doppler run\` (agent-service/prd)}"
export PROVIDER_CSCS_TOKEN
export PROXY_ADMIN_KEY="${PROXY_ADMIN_KEY:-devlocaladmin}"
# Matches dogfood.py, which sets this too. It de-streams tool-call requests for endpoints that only run
# their tool-call parser on the non-streaming path. CSCS does not need it — the deployed
# gateway runs without it — so this is belt-and-braces for local runs against other upstreams.
export PROXY_DESTREAM="${PROXY_DESTREAM:-1}"
# proxy.py's own default upstream is the HF router, which won't serve the model named below whatever
# credential you hand it, so the chain has to be set explicitly — dogfood.py overrides it the same way.
# Named-provider chain rather than the legacy MODEL_UPSTREAM_* pair, matching what the deployed gateway
# uses. MODEL_UPSTREAM_TOKEN is deliberately NOT exported: _load_providers() falls back to it only
# when the named chain resolves empty, which would silently serve a different model than the one below.
export MODEL_PROVIDERS="${MODEL_PROVIDERS:-cscs}"
export PROVIDER_CSCS_BASE="${PROVIDER_CSCS_BASE:-https://api.swissai.svc.cscs.ch/v1}"
export AGENT_MODEL_PROXY_URL="http://127.0.0.1:8732"
# Apertus-1.5-70B. The released weights are swiss-ai/Apertus-v1.5-70B (Apache-2.0); this
# apertus-ai/ id is the persistent k8s deployment on CSCS, the only route serving 1.5 without an
# expires_at (the swiss-ai/ entries are short-lived SLURM jobs). scripts/dogfood.py check_model_live()
# fails loud if this id leaves the catalog.
export AGENT_MODEL="${AGENT_MODEL:-apertus-ai/Apertus-v1.5-70B}"   # dogfood.py MODES["apertus15"]
export AGENT_MODEL_PROVIDER="huggingface"
export AGENT_TOOLSETS="${AGENT_TOOLSETS:-coding}"
export AGENT_BEST_OF="${AGENT_BEST_OF:-3}"
export AGENT_AUTH_DISABLED=1              # dev only — no bearer token needed from the local frontend
export AGENT_MODERATION_DISABLED="${AGENT_MODERATION_DISABLED:-1}"  # dev only, mirrors dogfood.py's start_app()
export AGENT_ACP="${AGENT_ACP:-0}"         # set to 1 to also exercise the ACP transport
export AGENT_DB_PATH="${AGENT_DB_PATH:-/tmp/agent-service-dev-stack.db}"  # isolate from ~/.agent-service/tasks.db

# HERMES_BIN: dogfood.py and api/app.py both default to ~/hermes-agent/..., which does not exist on
# every dev machine (this repo has seen both layouts) — probe both known layouts instead of guessing
# a single hardcoded path, and fail loud with a clear message rather than a confusing later "MISSING".
if [[ -z "${HERMES_BIN:-}" ]]; then
  for candidate in "$HOME/hermes-agent/.venv/bin/hermes" "$HOME/Documents/hermes-agent/.venv/bin/hermes"; do
    if [[ -x "$candidate" ]]; then
      HERMES_BIN="$candidate"
      break
    fi
  done
fi
: "${HERMES_BIN:?hermes binary not found under ~/hermes-agent -- set HERMES_BIN explicitly}"
export HERMES_BIN

cleanup() {
  trap - EXIT INT TERM   # disarm first — kill 0 below signals this process too; without this it re-enters itself
  echo
  echo "stopping…"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_healthy() {
  local url="$1" name="$2" tries=40
  for ((i = 0; i < tries; i++)); do
    if curl -sf -o /dev/null "$url/healthz" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: $name did not become healthy at $url within $((tries / 2))s — see the make output above for why" >&2
  return 1
}

make proxy &
wait_healthy "http://127.0.0.1:8732" "proxy"
make run &
wait_healthy "http://127.0.0.1:8731" "app"

echo
echo "== agent-service dev stack up =="
echo "  app  : http://127.0.0.1:8731"
echo "  proxy: http://127.0.0.1:8732"
echo "  model: $AGENT_MODEL  acp=$AGENT_ACP"
echo
echo "Point aipotluck.org/web/.env.local at:"
echo "  AGENT_SERVICE_URL=http://127.0.0.1:8731"
echo
echo "Ctrl-C to stop both."
wait -n                                  # returns as soon as EITHER process exits, for any reason
echo "one of the two processes exited — stopping the other" >&2
